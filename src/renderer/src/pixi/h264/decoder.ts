/**
 * decoder.ts —— WebCodecs H.264 预解码 + ImageBitmap 帧缓存（渲染层）。
 *
 * 目的（对应"高 decode / 低 encode / encode 收尾才飙高"瓶颈，参考 elah VideoDecoderManager/
 * StreamingFrameProducer/FrameCache）：
 *  - 用 WebCodecs `VideoDecoder` 把 ffmpeg 拆出的 H.264 Annex-B 裸流**单调、超实时**解码，
 *    替代导出/预览时 `<video>` 元素"每帧 seek + 等 seeking"的慢路径（paused 只能解当前帧）。
 *  - 解出的 `VideoFrame` 立即拷贝为 `ImageBitmap` 并 close 原帧 → 归还解码器 ~16 槽输出池；
 *    缓存持有的是普通内存(ImageBitmap)，可超池预解码一个"lookahead 窗口"而不会耗尽池。
 *  - 解码器连续 feed 时保持 warm（绝不逐请求 flush，flush 会强制下一包必须是关键帧）。
 *  - 背压：`decodeQueueSize>=4` 时让出一次事件循环，避免 QuotaExceededError 崩解码器。
 *
 * 与 elah 的差异：elah 用 mediabunny demux（浏览器内 WASM 拆 MP4 出带时间戳的包）；
 * 我们用**主进程 ffmpeg 先把源抽成一根 .h264 Annex-B 裸流(temp 文件)** + 本仓 esUtils.ts
 * 在纯字节层建 AU 索引，再按需 Range 读回 ES 字节段喂 VideoDecoder。零新 WASM 依赖。
 *
 * 解码依赖浏览器 WebCodecs(`VideoDecoder`)与 `createImageBitmap`，无法在纯 Node 真跑；
 * 但 feed/窗口/缓存/背压等**决策逻辑**全部可经注入的 mock 在纯 Node 单测锁定
 * （test/decodeProvider.test.mjs），真实 GUI 只负责把字节交给真实解码器。
 */

import { indexAccessUnits, extractParamSets, codecStringFromSps, findNals, type AccessUnit, type NalRef } from './esUtils.ts'

/** 从 Annex-B ES 读回一段字节的注入式读取器（渲染层经 avn-file:// Range fetch 实现）。 */
export interface EsRangeReader {
  /** 读取 [start, end) 字节（半开），返回 Uint8Array */
  read(start: number, end: number): Promise<Uint8Array>
}

/** 解码配置：由主进程 demux 产出时给出 */
export interface DecodeSourceInfo {
  /** ES 总字节长度 */
  esLen: number
  /** 源视频帧率（用于秒→帧索引换算）；可为 0（由 AU 数推断时用 project fps 映射） */
  sourceFps: number
  /** 源宽高（ImageBitmap 尺寸，仅诊断） */
  width: number
  height: number
  /** WebCodecs codec 串，如 avc1.640032 */
  codec: string
  /** avcC description（Uint8Array）或 null（走 in-band SPS） */
  description?: Uint8Array | null
}

export interface DecoderOptions {
  reader: EsRangeReader
  info: DecodeSourceInfo
  /**
   * 解码 lookahead（超前预解码帧数，内存换速度）。默认 24：让解码器持续灌帧、
   * 把延迟摊薄，GPU decode 保持 busy（不再"每帧 seek 一次"）。
   */
  lookaheadFrames?: number
  /** 缓存上限帧数。默认 48（ImageBitmap 是普通内存，可较大） */
  maxFrames?: number
  /** 每帧拷贝为 ImageBitmap 的函数（默认 createImageBitmap；测试注入 stub） */
  frameConverter?: (frame: VideoFrame) => Promise<ImageBitmap>
  /** 是否可用真实 VideoDecoder（GUI 外 false → 直接走 miss，绝不崩） */
  available?: boolean
  onStatus?: (s: { state: string; cacheSize: number; misses: number }) => void
}

export type DecodeStatus =
  | 'unavailable'   // 无 WebCodecs（纯 Node/降级环境）
  | 'opening'       // 正在打开/建解码器
  | 'ready'         // 可解码
  | 'errored'       // 解码器错误（调用方应回退 <video>）
  | 'disposed'

/** 提供给消费方的当前帧：ImageBitmap 借引用（勿 close） */
export interface ProvidedBitmap {
  bitmap: ImageBitmap
  /** 该帧在 ES 中的 AU 索引 */
  auIndex: number
}

/**
 * WebCodecs H.264 预解码提供者：维持一台 warm VideoDecoder + 单调 feed 窗口 + ImageBitmap 缓存。
 *
 * 用法（导出循环，逐输出帧调用）：
 *   provider.setPlayhead(auIndexNeed)   // 声明当前需要的源 AU；内部按需 burst-feed 超前窗口
 *   const got = provider.current(auIndexNeed)  // 同步查缓存；命中给帧、miss 返回 null
 *   got 为 null 时（解码器刚启动/seek 冷启动未赶上）调用方：
 *     - 预览：沿用旧帧（下一帧会补上）；
 *     - 导出：短暂 await provider.flushPendingUntil(auIndexNeed) 再取，拿不到再回退 <video> 兜底。
 *
 * 时间映射约定（与现有 <video> 同步口径一致）：
 *  AU 索引是"源自身帧号"。渲染层先把工程 sourceFrame(工程帧) → 秒 = sourceFrame/projectFps，
 *  再 × sourceFps 得源 AU 索引 → 喂本 provider。这样 WebCodecs 选帧与 <video>.currentTime
 *  选帧对齐，保住「导出 = 预览」像素一致。
 */
export class H264DecodeProvider {
  private _reader: EsRangeReader
  private _info: DecodeSourceInfo
  private _aus: AccessUnit[] = []
  private _ausBuilt = false
  private _esLen = 0
  private _codec: string

  private _lookahead: number
  private _maxFrames: number
  private _convert: (frame: VideoFrame) => Promise<ImageBitmap>
  private _available: boolean

  // WebCodecs 句柄
  private _decoder: (VideoDecoder & { decodeQueueSize?: number }) | null = null
  private _configured = false
  private _config: VideoDecoderConfig | null = null

  // 状态
  private _status: DecodeStatus = 'unavailable'
  private _cache = new Map<number, ImageBitmap>()
  private _pivot = -1
  private _feedWatermark = -1     // 已喂给解码器的最高 AU
  private _highestDecoded = -1    // 解码器实际吐出的最高 AU
  private _decoderReady = false   // VideoDecoder configure 完成可 decode
  private _openPromise: Promise<void> | null = null
  private _openError: string | null = null

  private _misses = 0
  private _feedGeneration = 0

  constructor(opts: DecoderOptions) {
    this._reader = opts.reader
    this._info = opts.info
    this._esLen = opts.info.esLen
    this._codec = opts.info.codec || 'avc1'
    this._lookahead = opts.lookaheadFrames ?? 24
    this._maxFrames = opts.maxFrames ?? 48
    this._available = opts.available ?? (typeof VideoDecoder !== 'undefined')
    this._convert = opts.frameConverter ?? defaultConverter()
    if (this._available) this._status = 'opening'
    else this._status = 'unavailable'
    // 提前建 AU 索引（纯字节，同步、廉价）
    this._buildIndex = this._buildIndex.bind(this)
    this._openPromise = this._available ? this._open() : null
  }

  get status(): DecodeStatus {
    return this._status
  }
  get openError(): string | null {
    return this._openError
  }
  get cacheSize(): number {
    return this._cache.size
  }
  get misses(): number {
    return this._misses
  }
  get auCount(): number {
    return this._aus.length
  }

  /**
   * 真正等待打开落定（含 buildIndex 全 ES 扫描 + configure），而非轮询 status。
   * 默认给足 30s——大源(数百 MB ES)建索引可能远超毫秒级；导出「预热一次」即在此等待。
   * resolve=true=ready（可 current/setPlayhead）；false=超时/errored/不可用（调用方回退 <video>）。
   */
  async waitReady(timeoutMs = 30000): Promise<boolean> {
    if (this._status === 'ready') return true
    if (!this._openPromise) return false
    const settled = this._openPromise.then(
      () => this._status === 'ready',
      () => this._status === 'ready'
    )
    if (timeoutMs <= 0) return settled
    const timer = new Promise<boolean>((resolve) => setTimeout(() => resolve(this._status === 'ready'), timeoutMs))
    return Promise.race([settled, timer])
  }

  /**
   * 分块流式建 AU 索引：按 8MB 分块 Range 读回 ES 扫描 NAL start code，避免一次性 fetch 超大源
   * （数百 MB 背景视频）单次分配/传输阻塞；每 chunk 携带上一 chunk 尾 3 字节做跨块 start code 拼接。
   * 结果与一次性整读等价（只留绝对 offset/header，索引廉价）。
   */
  private async _buildIndex(): Promise<void> {
    if (this._ausBuilt) return
    const CHUNK = 8 * 1024 * 1024
    const nals: { offset: number; scLen: number; headerOffset: number; header: number; type: number; length: number }[] = []
    const seen = new Set<number>() // 绝对 offset 去重（跨块 carry 拼接可能重复命中同一 start code）
    let carry = new Uint8Array(0)
    let pos = 0
    const L = this._esLen
    while (pos < L) {
      const end = Math.min(pos + CHUNK, L)
      const chunk = await this._reader.read(pos, end)
      if (chunk.length === 0) break
      const scanBuf = new Uint8Array(carry.length + chunk.length)
      scanBuf.set(carry, 0)
      scanBuf.set(chunk, carry.length)
      const base = pos - carry.length // scanBuf[0] 对应绝对 pos-carryLen
      // 扫描 scanBuf 找 start code；记录只对"绝对 offset 未收录过"的 NAL
      let i = 0
      const SB = scanBuf.length
      while (i < SB - 3) {
        if (scanBuf[i] === 0 && scanBuf[i + 1] === 0) {
          let sc = 0
          if (scanBuf[i + 2] === 1) sc = 3
          else if (scanBuf[i + 2] === 0 && scanBuf[i + 3] === 1) sc = 4
          else { i++; continue }
          const headerOffset = i + sc
          const abs = base + i
          if (headerOffset < SB && !seen.has(abs)) {
            seen.add(abs)
            const header = scanBuf[headerOffset]
            nals.push({ offset: abs, scLen: sc, headerOffset: abs + sc, header, type: header & 0x1f, length: 0 })
          }
          i += sc
        } else i++
      }
      // 保留本 chunk 尾 3 字节给下一块拼接 start code
      carry = chunk.subarray(Math.max(0, chunk.length - 3))
      pos = end
      // 让出事件循环，避免长 ES 阻塞主线程过久
      await new Promise((r) => setTimeout(r, 0))
    }
    // 补长度：末 NAL 到 ES 尾
    for (let n = 0; n < nals.length; n++) {
      nals[n].length = (n + 1 < nals.length ? nals[n + 1].offset : L) - nals[n].offset
    }
    nals.sort((a, b) => a.offset - b.offset)
    this._aus = indexAccessUnits(nals as unknown as NalRef[], L)
    this._ausBuilt = true
    console.log(`[DecodeSource] AU 索引建成：${nals.length} NAL / ${this._aus.length} 帧（ES ${(L / 1048576).toFixed(1)}MB）`)
  }

  private async _open(): Promise<void> {
    try {
      await this._buildIndex()
      // 裸 'avc1'/'avc3' 或空串都不是 Chromium 接受的完整 codec 串（会被判 ambiguous →
      // "Unknown or ambiguous codec name"）。decodeSources 传进来的是 codec:''，构造函数会回退成
      // 'avc1'——必须从这里用 ES 头部 SPS 推导出完整 avc1.PPCCLL（如 avc1.4d402a），否则
      // configure 必失败、整条 WebCodecs 加速失效回退慢速 <video>。
      let codec = this._codec
      const codecBare = !codec || codec === 'avc1' || codec === 'avc3'
      if (codecBare) {
        const head = await this._readHeadForParams()
        const nals = head ? findNals(head, 0, head.length) : []
        const { spsBody } = extractParamSets(nals, head ?? new Uint8Array(0))
        if (spsBody) codec = codecStringFromSps(spsBody) ?? codec
        this._codec = codec
      }
      if (!codec || codec === 'avc1' || codec === 'avc3') {
        throw new Error('无法从 SPS 推导完整 avc1 codec 串')
      }
      // 我们喂给 VideoDecoder 的是 ffmpeg 抽出的 Annex-B（start code）裸流。按 WebCodecs AVC
      // 规范：不主动构造 description（带 description 会被假定为 "avc" 长度前缀格式），走 annexb
      // 路径，SPS/PPS 已在带内（首个关键帧 AU 前）。这里仅在调用方显式传了 description 时才透传。
      const config: VideoDecoderConfig = {
        codec,
        codedWidth: this._info.width || undefined,
        codedHeight: this._info.height || undefined,
        description: this._info.description ?? undefined,
        optimizeForLatency: true,
        // 关键：导出时 GPU 上同时跑着 WebCodecs 硬解 + Pixi WebGL 渲染 + 逐帧纹理上传 + NVENC，
        // 消费级显卡极易触发驱动 TDR（WebGL CONTEXT_LOST）。把解码卸载到 CPU 软件解码，
        // 让 GPU 专心做渲染/回读/编码，既避免崩溃又让 extract 回读不再被硬解排队拖慢。
        hardwareAcceleration: 'prefer-software'
      }
      this._decoder = new VideoDecoder({
        output: (frame: VideoFrame) => this._onFrame(frame),
        error: (e: DOMException) => this._onError(e)
      }) as VideoDecoder & { decodeQueueSize?: number }
      this._config = config
      this._decoder.configure(config)
      this._configured = true
      this._decoderReady = true
      this._status = 'ready'
    } catch (e) {
      this._openError = String((e as Error)?.message ?? e)
      this._status = 'errored'
    }
  }

  /** 读 ES 头部一小段（通常含首个关键帧 AU 的 SPS/PPS），用于推导完整 avc1 codec 串。 */
  private async _readHeadForParams(): Promise<Uint8Array | null> {
    const readLen = Math.min(this._esLen, 256 * 1024)
    if (readLen < 8) return null
    try {
      return await this._reader.read(0, readLen)
    } catch {
      return null
    }
  }

  /**
   * 声明播放头需要的源 AU 索引（单调向前为主）。按需喂一个 burst 超前窗口。
   * 永不 await（返回立即）。
   */
  setPlayhead(au: number): void {
    if (this._status !== 'ready' || !this._decoderReady || !this._decoder) return
    // 大幅回退（loop 回到源起点 / 时间轴跳到更早 clip）：VideoDecoder 要求喂入的时间戳单调递增，
    // 回退后时间戳从大变小会抛 TypeError → 整个解码路径 errored → 回退 <video>（实测进而诱发 GPU 崩溃）。
    // 故回退时取消在途 feed 并 reset() 解码器，清零时间戳基线；下一包必须是关键帧，而回退目标 AU 的锚点正是关键帧。
    if (au < this._pivot) {
      this._feedGeneration++
      this._feedWatermark = -1
      this._highestDecoded = -1
      this._pivot = -1
      try {
        // reset() 会把解码器置回「unconfigured」态，必须立刻重新 configure，否则下一次
        // decode() 会抛 "Cannot call 'decode' on an unconfigured codec"（这正是 loop 回绕后
        // 解码路径静默死亡、回退 <video> 的根因）。
        this._decoder.reset()
        if (this._config) {
          this._decoder.configure(this._config)
          this._decoderReady = true
        }
      } catch { /* 忽略 reset/configure 失败，后续 decode 若抛错仍会走 errored 回退 */ }
    }
    if (this._pivot !== au) {
      this._pivot = au
      this._evict(au)
    }
    this._feedWindow(au)
  }

  /** 同步查缓存当前 AU；命中返回借引用，未命中返回 null。不 close 返回的 bitmap。 */
  current(au: number): ProvidedBitmap | null {
    if (this._status !== 'ready') return null
    const b = this._cache.get(au)
    if (!b) {
      this._misses++
      return null
    }
    return { bitmap: b, auIndex: au }
  }

  /** 借引用查缓存（与 current 同，供提前探测某 AU 是否已在缓存） */
  has(au: number): boolean {
    return this._cache.has(au)
  }

  /**
   * await 直到缓存覆盖 au（解码器赶上来）。用于导出冷启动首帧/seek 后追帧。
   * 返回 true=已就绪可 current()；false=超时/出错（调用方回退 <video>）。
   */
  async awaitUntil(au: number, timeoutMs = 8000): Promise<boolean> {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (this._cache.has(au)) return true
      if (this._status !== 'ready') return false
      this.setPlayhead(au)
      await new Promise((r) => setTimeout(r, 3))
    }
    return false
  }

  /** 释放解码器与缓存（幂等）。 */
  dispose(): void {
    this._feedGeneration++
    this._decoderReady = false
    try { this._decoder?.close() } catch { /* 忽略 */ }
    this._decoder = null
    for (const b of this._cache.values()) { try { b.close() } catch { /* 忽略 */ } }
    this._cache.clear()
    this._status = 'disposed'
  }

  // ------------------------------------------------------------------ feed 核心
  private _feedWindow(N: number): void {
    if (this._status !== 'ready' || !this._decoder || !this._decoderReady) return
    const nAus = this._aus.length
    if (nAus === 0) return
    const high = Math.min(N + this._lookahead, nAus - 1)
    const low = N + Math.floor(this._lookahead / 2)
    // 缓冲仍高于 low-water：先排空再补（滞回，避免稀疏喂导致解码器不吐帧）
    if (this._feedWatermark >= low) return
    const start = Math.max(this._feedWatermark + 1, N)
    if (start > high) return
    // 若 N 前跳了一个关键帧（说明 seek/不连续），需从 N 所在关键帧锚点回喂参考帧
    const anchor = this._keyAnchorAtOrBefore(N)
    const from = Math.min(start, anchor)
    const gen = this._feedGeneration
    this._feedWatermark = high
    void this._feedRange(from, high, gen)
  }

  /** 从关键帧锚点喂 [from..high]，背压受控。 */
  private async _feedRange(from: number, high: number, gen: number): Promise<void> {
    if (this._status !== 'ready') return
    // 读入整段 [aus[from].startOffset, aus[high].endOffset]
    const a0 = this._aus[from]
    const ah = this._aus[high]
    const a1 = high + 1 < this._aus.length ? this._aus[high + 1] : null
    const end = a1 ? a1.startOffset : this._esLen
    let data: Uint8Array
    try {
      data = await this._reader.read(a0.startOffset, Math.min(end, this._esLen))
    } catch {
      return // 读失败：下一 feed 重试
    }
    if (gen !== this._feedGeneration || this._status !== 'ready' || !this._decoder) return
    // 按 AU 边界切成 EncodedVideoChunk
    const localAus: { relStart: number; relEnd: number; idx: number }[] = []
    // 通过全流偏移映射到 data 内相对位置
    for (let idx = from; idx <= high && idx < this._aus.length; idx++) {
      const gStart = this._aus[idx].startOffset - a0.startOffset
      localAus.push({ relStart: gStart, relEnd: 0, idx })
    }
    // relEnd = 下一 AU 全局起点 - a0
    for (let k = 0; k < localAus.length; k++) {
      const nxt = k + 1 < localAus.length
        ? localAus[k + 1].relStart
        : (a1 ? a1.startOffset - a0.startOffset : data.length)
      localAus[k].relEnd = nxt
    }
    for (const la of localAus) {
      if (gen !== this._feedGeneration || this._status !== 'ready' || !this._decoder) return
      const bytes = data.subarray(la.relStart, la.relEnd)
      if (bytes.length < 4) continue
      const ts = Math.round((la.idx) * (1_000_000 / Math.max(this._info.sourceFps || 30, 1)))
      let chunk: EncodedVideoChunk
      try {
        chunk = new EncodedVideoChunk({
          type: this._aus[la.idx].isKey ? 'key' : 'delta',
          timestamp: ts,
          data: bytes
        })
      } catch {
        continue
      }
      const q = this._decoder.decodeQueueSize
      if (typeof q === 'number' && q >= 4) {
        await new Promise((r) => setTimeout(r, 0))
        if (gen !== this._feedGeneration || this._status !== 'ready') return
      }
      try {
        this._decoder.decode(chunk)
      } catch (e) {
        // 解码抛错（多为 configure 后首包非关键帧等）——回退
        this._openError = String((e as Error)?.message ?? e)
        this._status = 'errored'
        return
      }
    }
  }

  private _onFrame(frame: VideoFrame): void {
    if (this._status !== 'ready' && this._status !== 'opening') { frame.close(); return }
    const au = Math.round(frame.timestamp / (1_000_000 / Math.max(this._info.sourceFps || 30, 1)))
    // 拷贝并立即 close
    void this._copyAndCache(frame, au)
  }

  private async _copyAndCache(frame: VideoFrame, au: number): Promise<void> {
    let bmp: ImageBitmap | null = null
    try { bmp = await this._convert(frame) } catch { /* 转换失败丢帧 */ }
    finally { frame.close() }
    if (!bmp) return
    if (this._status !== 'ready') { try { bmp.close() } catch { /* 忽略 */ } return }
    this._cache.set(au, bmp)
    if (au > this._highestDecoded) this._highestDecoded = au
    this._evict(this._pivot)
  }

  private _onError(e: DOMException): void {
    this._openError = e?.message || String(e)
    this._status = 'errored'
    this._decoderReady = false
  }

  /** 从满缓存淘汰离 pivot 最远的帧（优先淘汰已播过的、pivot 之后的排后）。 */
  private _evict(pivot: number): void {
    while (this._cache.size > this._maxFrames) {
      let victim = -1
      let bestDist = -1
      for (const key of this._cache.keys()) {
        const dist = Math.abs(key - pivot)
        if (dist > bestDist) { bestDist = dist; victim = key }
      }
      if (victim < 0) break
      try { this._cache.get(victim)?.close() } catch { /* 忽略 */ }
      this._cache.delete(victim)
    }
  }

  private _keyAnchorAtOrBefore(target: number): number {
    let anchor = 0
    for (let i = 0; i < this._aus.length; i++) {
      if (this._aus[i].isKey) anchor = i
      if (i >= target) break
    }
    return Math.min(anchor, Math.max(0, this._aus.length - 1))
  }
}

/** 默认 ImageBitmap 转换器：flipY 与 WebGL 上传方向抵消（对齐 elah 的 flipY 约定，保证不上下颠倒）。 */
function defaultConverter(): (frame: VideoFrame) => Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'undefined') {
    return (frame) => createImageBitmap(frame, { imageOrientation: 'flipY' })
  }
  return (frame) =>
    Promise.resolve({
      width: frame.displayWidth,
      height: frame.displayHeight,
      close() {}
    } as unknown as ImageBitmap)
}
