/**
 * decodeSources.ts —— WebCodecs 预解码会话：模块级共享缓存 + 每导出句柄(manager)。
 *
 * 目标（用户："预热的彻底一点，预热一次背景视频就能一直复用" + 高 decode/低 encode/encode 收尾才飙）：
 *  - **彻底预热**：打开解码会话真正 await（waitReady 给足 30s），不靠几秒轮询就放弃——大源
 *    (数百 MB ES)建 AU 索引本就耗时，一次预热值得等。
 *  - **一次预热、永久复用**：同一源(绝对路径)的解码会话(ffmpeg demux 出的 ES + AU 索引 + warm VideoDecoder)
 *    存模块级共享缓存，跨多次导出甚至跨工程复用，绝不重复 demux/重建索引/重建解码器。
 *
 * 使用姿势（导出 loop）：
 *   const mgr = new DecodeSourceManager(fps)        // 每导出一个轻句柄
 *   mgr.registerSrc(eff, path); await mgr.prepare(paths)  // 命中共享缓存即秒回；无则开(等就绪)
 *   renderer.attachDecode(mgr)                      // 渲染视频层优先查 provider
 *   ... 逐帧 ...
 *   renderer.detachDecode(); mgr.dispose()          // dispose 只清句柄，**保留共享会话**供下次复用
 *
 * 安全：任一源 demux 失败 / 非 H.264 / 无 WebCodecs / 打开失败 → 该源 null 回退 `<video>`，不 throw。
 * AU 映射：工程 sourceFrame → 秒=sourceFrame/projectFps → AU=round(秒×sourceFps)，与 <video> 对齐。
 */

import { H264DecodeProvider } from './decoder.ts'
import { avnRangeReader } from './esRangeReader.ts'

/** 一个视频源的解码会话（供 PixiRenderer 消费） */
export interface DecodeSession {
  /** 源绝对路径 */
  path: string
  /** 源视频帧率（AU 映射用） */
  sourceFps: number
  provider: H264DecodeProvider
}

type DemuxImpl = (p: string) => Promise<{ ok: boolean; es: import('../../../../main/decodeMedia').DecodeMediaMeta | null }>

// ===== 模块级共享缓存（跨导出复用；应用会话内常驻） =====
interface SharedEntry {
  path: string
  /** 已就绪会话（null=未成功/已剔除） */
  session: DecodeSession | null
  /** 进行中的打开（去重并发） */
  opening: Promise<DecodeSession | null> | null
  /** 最近一次尝试失败原因（诊断） */
  lastError: string | null
}

/** 共享缓存 key = 源绝对路径。同一背景视频只 demux+建解码一次，之后导出直接命中。 */
const sharedCache = new Map<string, SharedEntry>()

const _defaultDemux: DemuxImpl = (p) => window.api.decodeDemux(p)

/** 真正的打开动作：demux → 建 provider → waitReady（给足 30s）。失败返回 null（不缓存成功态）。 */
async function _buildSession(path: string, projectFps: number, demux: DemuxImpl): Promise<DecodeSession | null> {
  const demuxRes = await demux(path)
  if (!demuxRes?.ok || !demuxRes.es) return null
  const { esPath, esLen, sourceFps, width, height } = demuxRes.es
  if (!esPath || !esLen) return null
  if (typeof (globalThis as Record<string, unknown>).VideoDecoder !== 'function') return null

  const esUrl = `avn-file://${encodeURIComponent(esPath)}`
  const provider = new H264DecodeProvider({
    reader: avnRangeReader(esUrl),
    info: { esLen, sourceFps: sourceFps || projectFps, width, height, codec: '' }, // codec 从 ES 头自推导
    lookaheadFrames: 24,
    maxFrames: 48,
    // ⚠ 不翻转：Pixi v8 Sprite 以"图片顶行在上"绘制 ImageBitmap，与 <video> 一致；flipY 是 elah 底-left 约定会上下颠倒。
    frameConverter: (frame) => createImageBitmap(frame)
  })
  // 耐心等打开落定（含全 ES 建索引 + configure），30s 给大源
  const ready = await provider.waitReady(30000)
  if (!ready) {
    console.warn('[DecodeSource] provider open not ready:', path, provider.openError ?? provider.status)
    provider.dispose()
    return null
  }
  return { path, sourceFps: sourceFps || projectFps, provider }
}

/** 取共享会话（幂等 + 并发去重）；无则触发打开并等就绪。失败返回 null。 */
async function openShared(path: string, projectFps: number, demux: DemuxImpl): Promise<DecodeSession | null> {
  let e = sharedCache.get(path)
  if (!e) {
    e = { path, session: null, opening: null, lastError: null }
    sharedCache.set(path, e)
  }
  if (e.session) return e.session
  if (!e.opening) {
    e.opening = _buildSession(path, projectFps, demux)
      .then((s) => { e!.session = s; return s })
      .catch((err) => {
        e!.lastError = String((err as Error)?.message ?? err)
        return null
      })
      .finally(() => { e!.opening = null })
  }
  return e.opening
}

/** 把某源从共享缓存剔除（provider 运行时错误/源删除时调用），下次会重建。 */
export function retireShared(path: string): void {
  const e = sharedCache.get(path)
  if (!e) return
  try { e.session?.provider.dispose() } catch { /* 忽略 */ }
  sharedCache.delete(path)
}

/** 全部共享会话释放（应用会话终结/清空加速缓存）。 */
export function disposeAllShared(): void {
  for (const e of sharedCache.values()) {
    try { e.session?.provider.dispose() } catch { /* 忽略 */ }
  }
  sharedCache.clear()
}

export function sharedCacheSize(): number {
  return sharedCache.size
}

// ===== 每导出的轻句柄 =====
export class DecodeSourceManager {
  private _pathOf = new Map<string, string>() // src(effective) → path（渲染层反查）
  private _demuxImpl: DemuxImpl
  private _projectFps: number

  constructor(projectFps: number, demuxImpl?: DemuxImpl) {
    this._projectFps = projectFps
    this._demuxImpl = demuxImpl ?? _defaultDemux
  }

  get projectFps(): number {
    return this._projectFps
  }

  /** 本句柄内建立的 src(effective) → path 反查表（渲染器 layer 用 effective src 查会话） */
  registerSrc(src: string, path: string): void {
    this._pathOf.set(src, path)
  }

  /**
   * 对若干源的绝对路径做"尽力"准备：命中共享缓存秒回；未命中打开并耐心等就绪。
   * 单源失败不影响其余（其余回退 <video>）。返回本次可用会话数。
   */
  async prepare(paths: Iterable<string>): Promise<number> {
    const seen = new Set<string>()
    let ok = 0
    for (const p of paths) {
      if (!p || seen.has(p)) continue
      seen.add(p)
      try {
        const s = await openShared(p, this._projectFps, this._demuxImpl)
        if (s) ok++
      } catch (err) {
        console.warn('[DecodeSource] prepare failed (fallback <video>):', p, (err as Error)?.message)
      }
    }
    console.log(`[DecodeSource] 本次可用 ${ok}/${seen.size} 个 WebCodecs 会话（共享缓存共 ${sharedCacheSize()}）`)
    return ok
  }

  /** 由 effective src 取会话（无则 null → 外层走 <video>）。仅就绪会话返回。 */
  sessionForSrc(src: string): DecodeSession | null {
    const path = this._pathOf.get(src)
    if (!path) return null
    const e = sharedCache.get(path)
    return e?.session ?? null
  }

  sessionForPath(path: string): DecodeSession | null {
    const e = sharedCache.get(path)
    return e?.session ?? null
  }

  /** 工程 sourceFrame → 源 AU 索引。 */
  auForFrame(sec: DecodeSession, sourceFrame: number, projectFps = this._projectFps): number {
    if (!projectFps || projectFps <= 0) return sourceFrame
    const secs = sourceFrame / projectFps
    return Math.max(0, Math.round(secs * (sec.sourceFps || projectFps)))
  }

  /**
   * 导出收尾：只清本句柄反查表，**保留共享会话**（下次导出直接复用）。
   * 真正释放调用 disposeAllShared()/retireShared(path)。
   */
  dispose(): void {
    this._pathOf.clear()
  }
}
