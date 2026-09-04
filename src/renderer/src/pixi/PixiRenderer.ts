/**
 * PixiRenderer —— PixiJS v8 渲染管线（预览 + 未来导出共用同一场景）。
 *
 * 职责：
 *  - 持有一个 Pixi `Application`，输出 canvas 挂到 DOM。
 *  - 每次 `render(frame, project)` 调用纯逻辑 `resolveTimeline` 得到 Scene，
 *    再增量更新精灵（视频/图片）与文本（歌词/文字）的层级、位置、透明度、纹理、内容。
 *  - 视频用缓存的 <video> 元素作为纹理源（与 DOM 渲染共用同一播放/定位逻辑），
 *    确保预览 = 导出一致。
 *
 * 说明：Mask（输出画幅）与音频发声不属于 Pixi 视觉层，
 *  Mask 由外层 DOM 叠线框/暗角，音频由 <audio> 元素发声。
 */
import { Application, Container, Sprite, Text, Assets, Texture, ImageSource, BlurFilter, Rectangle } from 'pixi.js'
// CSP 不允许 unsafe-eval 时，需引入 unsafe-eval 模块做 side-effect：
// 它覆盖渲染器的 _unsafeEvalCheck 并用避免 eval 的 polyfill 替代（Electron/Chrome 扩展等严格 CSP 环境）
import 'pixi.js/unsafe-eval'
import type { Project } from '../model/timeline'
import { resolveTimeline } from '../model/timeline'
import type { ActiveVideoClip, ActiveImageClip, ActiveTextClip, LyricStyle } from '../model/timeline'
import { effectiveVideoSrc, initMediaProxy } from './mediaProxy'
import { mediaBox, resolveTextRows, glowRadius, type TextRowDatum } from './layout'
import type { DecodeSourceManager } from './h264/decodeSources'

/** 一个可视层条目（按 zIndex 排，渲染顺序=数组顺序，越靠后越在上层） */
interface Layer {
  id: string
  isLyric: boolean
  z: number
  src: string
  opacity: number
  sourceFrame: number
  transform?: { x?: number; y?: number; scaleX?: number; scaleY?: number }
  content: string
  lyrics?: LyricStyle
}

const STAGE = { width: 1920, height: 1080 }

/** 该 src 是否为图片（按扩展名/前缀判断；决定走 Assets 图片管线 vs 视频纹理管线） */
function looksLikeImage(src: string): boolean {
  const low = src.toLowerCase()
  return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/.test(low) || low.startsWith('data:image')
}

/** 一行歌词的渲染槽（karaoke 滚动：当前句±N 行，每行独立 Text + 辉光副本） */
interface KaraokeRow {
  main: Text
  glow: Text
  blur: BlurFilter
  glowStrength: number
}

/** 一个歌词/文本 clip 的渲染容器：root 负责位置/Z旋转/透明，rows 容纳多行文本 */
interface TextLayer {
  root: Container
  rows: KaraokeRow[]
  isLyric: boolean
}

// karaoke 滚动窗口常数已迁至 layout.ts（KARAOKE_WINDOW），行槽按当前行数动态创建。

export class PixiRenderer {
  private app: Application | null = null
  private root: Container | null = null
  private canvasHost: HTMLElement | null = null

  // 精灵池：key = clip id，避免频繁创建/销毁
  private sprites = new Map<string, Sprite>()
  // 文本层：key = clip id → TextLayer（Container 负责位置/Z旋转/透明；rows 容纳 karaoke 多行歌词）
  private textLayers = new Map<string, TextLayer>()
  // 视频元素缓存：key = src → 复用同一 <video> 做纹理源
  private videoEls = new Map<string, HTMLVideoElement>()
  // 每个视频元素当前应停靠/播放的目标源秒（避免每帧重复 seek 造成卡顿）
  private videoTargetSec = new Map<string, number>()
  // 图片异步加载去重：key = img:src → Promise
  private imageLoading = new Map<string, Promise<unknown>>()
  // 视频首帧就绪诊断去重（每 clip id 打印一次 texture READY 状态）
  private _videoShown = new Set<string>()
  // initMediaProxy 返回的退订函数（销毁时调用）
  private _proxyUnsub: (() => void) | null = null
  // 当前是否已挂载 canvas
  private mounted = false

  // —— WebCodecs 预解码加速（导出期，可加性，见 attachDecode/detachDecode）——
  // 解码会话管理器：附着后，渲染视频层时若某源 provider 已就绪且目标 AU 缓存命中，
  // 就用 ImageBitmap 纹理直接上屏，跳过 <video> 每帧 seek（根治 decode 空闲/encode 收尾才飙）。
  // 任一帧 miss/未就绪 → 自动回退既有 <video> 兜底，绝不影响导出正确性。
  private _decode: DecodeSourceManager | null = null
  // clip id → 当前已用解码纹理（避免每帧重建 GPU 纹理；同 AU 复用）
  private _decodeTex = new Map<string, { au: number; tex: Texture }>()
  // 解码命中/未命中计数（导出用，打印进 [Export-perf] 判断解码路径是否真正接管）
  private _decodeHits = 0
  private _decodeMisses = 0
  // 解码未接管的原因去重打印（诊断 0/0 用）
  private _dbgSeen = new Set<string>()
  private _dbgOnce(reason: string): void {
    if (this._dbgSeen.has(reason)) return
    this._dbgSeen.add(reason)
    console.warn(`[Export-decode] 未接管原因: ${reason}`)
  }
  // 导出期"放弃 <video>"的源集合：某源的 <video> 已被强制退役过（卡死/无法解码），
  // 本导出后续不再为它重建 <video>（否则每帧退役→重建→再卡死=GPU 空转/风扇狂转/主线程卡死）。
  private _videoGiveUp = new Set<string>()
  // 导出模式：为 true 时 captureFrame 会先 await 各解码视频帧的目标 AU 就绪（有界），
  // 而非一 miss 就回退 <video>——让主线程"等"预取管线，而不是拖慢 <video> seek。仅离屏导出设。
  private _awaitDecode = false
  // WebGL context lost（GPU 进程崩溃/驱动重置）标记：置 true 后 captureFrame 应立即中止而非
  // 阻塞在死 GL 上（GPU process exit → 同步 readPixels/extract 会让主线程卡死、"鼠标拖不动"）。
  private _contextLost = false

  // —— 连续渲染循环（Pixi 视频纹理依赖：视频元素就绪是异步事件，React 帧不变就不会调 render，
  //    导致视频 canplay 后永远不被拉进纹理。故内部跑 rAF 持续渲染，保证异步媒体出现/纹理刷新）。 ——
  private _raf = 0
  private _running = false
  private _latestFrame = 0
  private _latestProject: Project | null = null
  private _latestFps = 30
  // 时间轴是否正在播放（决定视频元素：播放时自由前进、暂停时精确停帧跟随）
  private _playing = false
  // 上一次真正渲染时用的工程引用——工程变化（如新增/删除视频 clip）必须触发一次渲染，
  // 否则暂停且帧不变时新视频元素永远不会被创建（→ 不点播放预览空白）。
  private _lastPaintedProject: Project | null = null
  // 是否让 Pixi Application 的 TickerPlugin 自动渲染（预览=true；离屏导出=false，
  // 导出必须只由显式 render() 驱动，否则其自动 rAF 会在我们的 seek/retire 间隙渲染出
  // "刚被销毁的精灵仍绑定纹理"→ null.geometry 崩溃 + textureSource 绑定告警）。
  private autoRender: boolean
  // 画布 backing 分辨率：预览跟随 devicePixelRatio(≤2) 保证清晰；导出固定 1 ——
  // 只渲染"舞台真实像素"，extract/合成不引入 dpr 依赖的二次缩放（杜绝 dpr≠1 时导出被
  // 放大而变糊、或码率虚高）。分辨率无关 = 画面稳定、清晰度由舞台像素决定。
  private resolution: number

  constructor(
    private host: HTMLElement,
    options?: { autoRender?: boolean; resolution?: number }
  ) {
    this.canvasHost = host
    this.autoRender = options?.autoRender !== false // 默认 true（预览既有行为）
    this.resolution = options?.resolution ?? Math.min(window.devicePixelRatio || 1, 2)
  }

  /** 初始化 Pixi Application（WebGL/WebGPU 自动选择；失败则抛错供上层降级到 DOM） */
  async init(): Promise<void> {
    if (this.app) return
    this.app = new Application()
    await this.app.init({
      width: STAGE.width,
      height: STAGE.height,
      backgroundAlpha: 0, // 透明，让外层 DOM 背景/暗角透出
      antialias: true,
      // 关键：不要 autoDensity。autoDensity=true 时 Pixi 每次 resize 都会把 canvas 的 CSS 宽高设成
      // "stage 像素 px"（CanvasSource.resizeCanvas: style.width/height = stage.width/height px），
      // 覆盖掉我们设的 width/height:100%，导致 canvas 以真实像素尺寸钉在遮罩宿主左上角：
      //   - 画布比遮罩宿主大 → 遮罩 overflow:hidden 裁掉画布右/下 → "底部+右侧不显示画面"(21:9 必现)；
      //   - 切分辨率 stage px 变 → canvas CSS 尺寸变 → 宿主(随窗口)不变 → 内容被"被动强制缩放"而漂移。
      // autoDensity=false → Pixi 只改 canvas 像素(backing=stage*resolution)，CSS 尺寸始终 100% 铺满遮罩宿主，
      // 且遮罩宿主宽高比==stage 宽高比(都=序列比例)，画布正好无黑边铺满、整幅 stage 可见 → 内容不再漂移/被裁。
      autoDensity: false,
      resolution: this.resolution,
      // 导出/离屏实例：关闭自动渲染，只由显式 render()/captureFrame 驱动 GPU，
      // 避免 TickerPlugin 在 seek/retire 间隙自动渲染已销毁对象而崩溃。预览保持自动渲染。
      autoStart: this.autoRender
    })
    // 兜底：即便 autoStart 未按预期生效，也显式停掉自动渲染循环，确保只显式驱动
    if (!this.autoRender) {
      try { this.app.ticker?.stop() } catch { /* 忽略 */ }
    }
    this.root = new Container()
    this.app.stage.addChild(this.root)
    // 挂载 canvas 到宿主
    const view = this.app.canvas as HTMLCanvasElement
    view.style.position = 'absolute'
    view.style.left = '0'
    view.style.top = '0'
    view.style.width = '100%'
    view.style.height = '100%'
    view.style.objectFit = 'contain'
    this.canvasHost?.appendChild(view)
    this.mounted = true
    // WebGL context lost 监听：GPU 进程崩溃(exit 34)/驱动重置会触发 webglcontextlost。
    // 置 _contextLost=true 让导出 captureFrame 中止而非阻塞在死 GL（extract 同步 readPixels
    // 在 GPU 死后会让主线程永久卡住 → "鼠标都拖不动")。
    view.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault() // 允许 Pixi/浏览器尝试恢复（即便恢复失败也先不中断事件流）
      if (!this._contextLost) {
        this._contextLost = true
        console.error('[PixiRenderer] WebGL CONTEXT_LOST（GPU 进程崩溃/驱动重置）→ 导出应中止')
      }
    })
    view.addEventListener('webglcontextrestored', () => {
      if (this._contextLost) {
        this._contextLost = false
        console.log('[PixiRenderer] WebGL context restored')
      }
    })
    // 订阅媒体代理就绪：原素材转码完成后，把该源重建为代理（fail-safe，失败继续用原素材）
    this._proxyUnsub = initMediaProxy(({ original }) => {
      // 代理就绪：回收旧 video 元素/纹理，强制下一帧从代理重建
      this._retireVideoSrc(original)
      if (this._latestProject) this.render(this._latestFrame, this._latestProject, this._latestFps)
    })
  }

  /**
   * 记录最新输入并启动内部渲染循环。之后 Pixi 自身每 rAF 渲染一次，
   * 不依赖 React 的 frame 变化——视频/图片异步就绪后下一帧自动出现。
   */
  start(frame: number, project: Project, fps: number, playing = false): void {
    this._latestFrame = frame
    this._latestProject = project
    this._latestFps = fps
    this._playing = playing
    if (this._running) return
    this._running = true
    let lastPaintedFrame = -1
    const loop = (): void => {
      if (!this._running || !this.app || !this._latestProject) return
      // dirty：帧变化 || 工程变化(新增媒体层须创建元素) || 有异步媒体(视频纹理/图片加载)待落定
      const dirty =
        this._latestFrame !== lastPaintedFrame ||
        this._latestProject !== this._lastPaintedProject ||
        this._hasAsyncWork()
      if (dirty) {
        this.render(this._latestFrame, this._latestProject, this._latestFps)
        lastPaintedFrame = this._latestFrame
        this._lastPaintedProject = this._latestProject
      }
      this._raf = requestAnimationFrame(loop)
    }
    this._raf = requestAnimationFrame(loop)
  }

  /**
   * 是否有异步待处理工作——决定是否需要持续渲染：
   *  - 视频仍加载中(readyState<2)：就绪后需立即拉进纹理；
   *  - 正在 seek：seek 完成前需持续渲染以抓取/钉住目标帧；
   *  - 任一视频元素正在播放(非 paused)：正在自由前进，必须持续渲染把它拉回"奴隶"位
   *    （暂停态若某元素失控在播，靠这里每帧 pause 压住，杜绝"暂停后还自动播"）。
   */
  private _hasAsyncWork(): boolean {
    for (const el of this.videoEls.values()) {
      if (el.readyState < 2) return true
      if (el.seeking) return true
      // 正在播放 = 尚未停稳(首帧解码/暂停接管中)，需继续渲染驱动到"暂停+钉帧"为止
      if (!el.paused) return true
    }
    // 有图片仍在异步加载
    if (this.imageLoading.size > 0) return true
    return false
  }

  /** 更新渲染输入（外部 frame/工程/播放状态变化时调用；循环会自动接住） */
  updateInput(frame: number, project: Project, fps: number, playing?: boolean): void {
    this._latestFrame = frame
    this._latestProject = project
    this._latestFps = fps
    if (playing !== undefined) this._playing = playing
  }

  /** 通知时间轴播放/暂停状态变化（供视频元素跟随：播放则前进、暂停则停帧） */
  setPlaying(playing: boolean): void {
    if (this._playing === playing) return
    this._playing = playing
    // 状态翻转必须立刻生效：立即触发一次渲染同步所有视频元素，不等下一帧变化
    if (this._latestProject) this.render(this._latestFrame, this._latestProject, this._latestFps)
  }

  /** 停止内部渲染循环 */
  stop(): void {
    this._running = false
    cancelAnimationFrame(this._raf)
  }

  /** 适配：canvas 逻辑尺寸跟随画幅(stage)。CSS 尺寸恒为 100% 铺满遮罩宿主（autoDensity=false 保证不被覆盖） */
  setStage(w: number, h: number): void {
    if (!this.app) return
    this.app.renderer.resize(w, h)
  }

  /**
   * 附着 WebCodecs 预解码管理器（导出期加速用）。附着后视频层渲染优先查解码缓存。
   * @param mgr 由 DecodeSourceManager.prepare() 建好的会话管理器（可 null 关闭）
   * @param mapSrcToPath 供内部把 layer.src(effective) → 绝对路径注册进管理器；缺省用 manager 已注册映射
   */
  attachDecode(mgr: DecodeSourceManager | null, mapSrcToPath?: (src: string) => string | null): void {
    this._decode = mgr
    this._decodeSrcToPath = mapSrcToPath ?? null
  }

  /** 导出专用：captureFrame 每帧先 await 各解码视频帧就绪（有界），miss 不再即刻回退 <video>。 */
  setAwaitDecode(flag: boolean): void {
    this._awaitDecode = flag
  }

  /** 导出用：本实例解码命中/未命中统计（打印进 [Export-perf]）。 */
  decodeStats(): { hits: number; misses: number } {
    return { hits: this._decodeHits, misses: this._decodeMisses }
  }

  /** WebGL context 是否已丢失（GPU 进程崩溃/驱动重置）。导出据此中止，避免主线程卡死。 */
  isContextLost(): boolean {
    return this._contextLost
  }

  /** 解除预解码附着并清理本实例持有的解码纹理（不销毁 provider，由管理器 dispose 负责） */
  detachDecode(): void {
    this._clearDecodeTextures()
    this._decode = null
    this._decodeSrcToPath = null
  }

  /** 手动按 src 注册路径映射（若未提供 mapSrcToPath 时用） */
  registerDecodeSrc(src: string, path: string | null): void {
    if (this._decode && path) this._decode.registerSrc(src, path)
  }

  // 每层的 effective src → 绝对路径（decodeSources 反查 provider）
  private _decodeSrcToPath: ((src: string) => string | null) | null = null
  private _clearDecodeTextures(): void {
    for (const { tex } of this._decodeTex.values()) {
      try { tex.destroy() } catch { /* 忽略 */ }
    }
    this._decodeTex.clear()
  }

  /**
   * 渲染一帧：解析时间轴 → 增量更新精灵/文本。
   * @param frame 时间轴帧
   * @param project 工程
   * @param fps 帧率（换算源秒）
   */
  render(frame: number, project: Project, fps: number): void {
    if (!this.app || !this.root) return
    const scene = resolveTimeline(frame, project)
    this.setStage(project.stage.width, project.stage.height)

    // 原始 clip 查找表（按 id）：scene 层不含 lyrics/isLyrics 等样式字段，需回查原始 clip
    const clipMap = new Map<string, import('../model/timeline').Clip>()
    for (const clips of Object.values(project.clips)) {
      for (const c of clips) clipMap.set(c.id, c)
    }

    // 汇聚所有可视层并排序（zIndex 决定层级）
    const layers: Layer[] = [
      ...scene.videos.map((v) => this.toLayer(v, clipMap)),
      ...scene.images.map((i) => this.toLayer(i, clipMap)),
      ...scene.texts.map((t) => this.toLayer(t, clipMap))
    ].filter((l): l is Layer => !!l)
    layers.sort((a, b) => a.z - b.z)

    // 需要保留的 id 集合，用于回收已消失的层
    const liveIds = new Set<string>()

    for (const l of layers) {
      liveIds.add(l.id)
      if (l.src) {
        // 媒体层（视频/图片）。视频源可被媒体代理换成转码代理(avn 本地文件)；图片原样走 Assets。
        const isImage = looksLikeImage(l.src)
        // 解码路径一律用原始 clip src(l.src，非代理)：解码会话按原始源建(demux 原始文件)，
        // 用代理查会 miss→回退破代理 <video>。非解码兜底才用 effectiveVideoSrc(代理更稳)。
        const src = isImage ? l.src : l.src
        const proxyEff = isImage ? l.src : effectiveVideoSrc(l.src)
        const isVideo = !isImage
        let sp = this.sprites.get(l.id)
        if (!sp) {
          sp = new Sprite()
          this.sprites.set(l.id, sp)
          this.root.addChild(sp)
        }
        // 关键：渲染层级必须由 zIndex(=轨道序)决定，而非创建/复活顺序。Pixi v8 中 root 不 sortableChildren 时
        // 子节点按 addChild 顺序绘制——若某 clip 在拖拽/移动时被 retire 销毁(暂时不活跃)后又复活重建，会被 addChild
        // 追加到最末 → "最后操作的对象压到最顶"(用户报的 BUG)。设 zIndex 会标记父容器 sortDirty；同值则 no-op 无开销。
        sp.zIndex = l.z
        // —— WebCodecs 预解码视频纹理（可加性）——
        // 若本层源有就绪的 provider 且当前 AU 缓存命中，用 ImageBitmap 纹理上屏并跳过 <video> seek。
        // 返回 true = 本帧已由解码路径处理（sp.texture 已被设为解码纹理）。
        const decodeHandled = isVideo && this._tryDecodeVideo(l, src, proxyEff, sp, fps)
        // 视频帧同步：把视频元素当作时间轴的"奴隶"，跟随目标源秒（帧→秒映射见 syncVideo 注释），
        // 绝不让它脱离时间轴自行循环播放。（解码已处理时跳过——不需要 <video> seek。）
        // 非解码兜底用 proxyEff(代理比原始更稳，Chromium 原生解码更可靠)。
        if (isVideo && !decodeHandled) this.syncVideo(proxyEff, l.sourceFrame, fps)
        const tex = decodeHandled ? sp.texture : this.textureFor(proxyEff)
        if (tex && sp.texture !== tex) sp.texture = tex
        // 就绪判定只认像素尺寸（v8 中 Texture 没有 `.valid` 属性；source resize 后 width/height 即真实像素数）
        const tReady = sp.texture && sp.texture.width >= 1 && sp.texture.height >= 1
        if (tReady) {
          // 视频纹理强制刷新到当前源帧：Pixi v8 对 video 纹理，暂停/seek 后不会自动拉新帧，
          // 必须 update() 才能把 video.currentTime 对应的帧上传到 GPU（否则拖动进度条画面不更新）。
          // 解码路径的 ImageBitmap 纹理是"每新 AU 重建"，无需 update（纹理即当前帧）。
          if (isVideo && !decodeHandled) {
            try {
              sp.texture.update()
            } catch (err) {
              // update() 的 WebGL 错误可能被 Pixi 内部吞掉，这里显式捕获便于诊断
              console.error('[PixiRenderer] texture.update failed:', (err as Error).message)
            }
          }
          // 诊断：视频纹理首帧就绪时打印一次关键状态（用于定位黑屏）
          if (isVideo && !decodeHandled && !this._videoShown.has(l.id)) {
            this._videoShown.add(l.id)
            const vel = this.videoEls.get(l.src)
            console.log(
              `[PixiRenderer] video texture READY: tex=${sp.texture.width}x${sp.texture.height}` +
              ` paused=${vel?.paused} currentTime=${vel?.currentTime?.toFixed(2)}` +
              ` src=${l.src.slice(0, 40)}`
            )
          }
          // 视频/图片适配（语义 = 你的相机比喻，B 方案"缩放只随窗口/缩放，与比例解耦"）：
          // 纯布局函数 mediaBox（layout.ts）负责计算：媒体固定铺满画框高、只水平居中，
          // 宽按源宽高比自然得出。预览与导出共用同一函数 → 像素一致。详见 mediaBox 注释。
          const mb = mediaBox(sp.texture.width, sp.texture.height, l.transform, project.stage)
          sp.width = mb.width
          sp.height = mb.height
          sp.anchor.set(mb.anchorX, mb.anchorY)
          sp.position.set(mb.x, mb.y)
          sp.alpha = l.opacity
          sp.visible = true
        } else {
          // 纹理未就绪（源尚未 resize 出尺寸）：隐藏精灵，避免显示默认 1x1 白块干扰判断；下一帧就绪后自动出现
          sp.visible = false
        }
        // 移除残留文本（若曾是该 id 的文本层）
        this.releaseText(l.id, liveIds)
      } else {
        // 文本层（歌词/文字）：Container(位置/旋转/透明) + 若干行 Text（karaoke 滚动）
        let tl = this.textLayers.get(l.id)
        if (!tl) {
          const root = new Container()
          tl = { root, rows: [], isLyric: l.isLyric }
          this.textLayers.set(l.id, tl)
          this.root.addChild(root)
        }
        // 同媒体层：文本层层级也按 zIndex(=轨道序)而非创建顺序(修复复活后被压到最顶的 BUG)
        tl.root.zIndex = l.z
        tl.isLyric = l.isLyric
        this.applyText(tl, l, project, fps)
        // 移除残留精灵
        this.releaseSprite(l.id, liveIds)
      }
    }

    // 回收不再活跃的层
    this.retire(liveIds)

    // 按 zIndex 显式重排(有 zIndex 变化才真正排序)：层级=轨道序，杜绝"复活重建后压到最顶"
    this.root.sortableChildren = true
    this.root.sortChildren()

    this.app.render()
  }

  /**
   * 确定性导出一帧：渲染到 stage 画布并取出像素 canvas。
   * 与实时预览不同，导出不允许墙钟播放——每帧都让视频"奴隶"精确 seek 到目标源秒(暂停态)，
   * 等待其 seeked 完成、纹理像素就绪后再 render+extract，得到的正是"预览停在 frame 那一刻"的画面。
   *
   * 逐帧重试直到无异步媒体工作(seeking/加载中)；随后再补一次纹理 update + render，
   * 确保视频新帧确实上传到 GPU，再通过 renderer.extract 把整幅 stage 拷成 canvas 返回。
   *
   * 注意：仅用于离屏/隐藏实例(export)，勿与实时预览的 rAF 循环(start)并发调用同一实例。
   */
  async captureFrame(frame: number, project: Project, fps: number): Promise<Uint8ClampedArray | null> {
    if (!this.app || !this.root) return null
    if (this._contextLost) {
      throw new Error('WebGL context lost：GPU 进程已崩溃/驱动重置，导出中止（请关闭远程操控或改用 AVS_GPU_SOFT=1 软渲染）')
    }
    this._latestFrame = frame
    this._latestProject = project
    this._latestFps = fps
    this._playing = false // 导出永远"暂停态"：视频只钉帧、不自由前进

    const waitMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    // —— 导出分阶段计时（仅导出模式累加；[Export-cap] 定位 3fps 卡在哪）——
    let tDecode0 = 0 // 阶段零：await 解码就绪
    let tWait1 = 0   // 阶段一：_hasAsyncWork 空转
    let tWait2 = 0   // 阶段二：残余空转
    let tExtract = 0 // extract.canvas 抽帧（GPU 回读）
    let tRender1 = 0 // 阶段一里 render() 本身耗时（区别于空转等待）

    // 阶段零（仅导出 _awaitDecode 模式）：先推进各解码会话播头到本帧目标 AU 并 await 其就绪（有界）。
    // 这样随后的 render 会命中解码缓存、走 ImageBitmap 快路径，而不是 miss 后回退 <video> seek。
    // 解码器 async 输出在 await 间隙持续超前喂帧 → 逐帧间 decode 保持 busy，encode 不再饿着。
    if (this._awaitDecode) {
      const s = performance.now()
      const targets = this._decodeTargetsFor(frame, project, fps)
      if (targets.size > 0) {
        const waits: Promise<void>[] = []
        for (const { session, au } of targets.values()) {
          const prov = session.provider
          prov.setPlayhead(au) // 声明需求并触发超前 feed
          waits.push(
            prov
              .awaitUntil(au, 1500)
              .then((ok) => { if (!ok) prov.setPlayhead(au) })
              .catch(() => {})
          )
        }
        await Promise.all(waits)
      }
      tDecode0 = performance.now() - s
    }

    // 阶段一：渲染 + 等待所有媒体(视频 seek/解码、图片加载)就绪
    const s1 = performance.now()
    let wait1N = 0
    for (let i = 0; i < 300; i++) {
      const r0 = performance.now()
      this.render(frame, project, fps)
      tRender1 += performance.now() - r0
      if (!this._hasAsyncWork()) break
      await waitMs(10)
      wait1N++
      // 导出模式：卡死(seek/播放)超 15 次(150ms)的 <video> 兜底强制退役，别让单帧空转拖到秒级
      if (i >= 15) this._forceQuietStuckInExport(15, wait1N)
    }
    tWait1 = performance.now() - s1
    // 阶段一空转过多（_hasAsyncWork 恒 true）→ 打印是哪个 video/图片拖住——3fps 卡帧定位
    if (this._awaitDecode && wait1N >= 8) {
      const stuck = Array.from(this.videoEls.entries())
        .filter(([, el]) => (el.readyState < 2) || el.seeking || !el.paused)
        .map(([src, el]) => `${src.slice(-30)}(rs=${el.readyState},seek=${el.seeking},paused=${el.paused})`)
      if (stuck.length) console.warn(`[Export-cap] 阶段一空转 ${wait1N} 次、videoEls=${this.videoEls.size}，卡住的 video:`, stuck.join(' | '))
      else if (this.imageLoading.size) console.warn(`[Export-cap] 阶段一空转 ${wait1N} 次、仍在加载图片=${this.imageLoading.size}`)
    }

    // 阶段二：视频纹理再补一次 update + render，确保 seek 后的实际帧像素已上传到 GPU
    const s2 = performance.now()
    for (const el of this.videoEls.values()) {
      try {
        const t = Texture.from(el)
        if (t) t.update()
      } catch {
        /* 忽略单源纹理更新异常 */
      }
    }
    // 若仍有异步未决，继续让出若干帧，让视频解码完成
    for (let i = 0; i < 30; i++) {
      this.render(frame, project, fps)
      if (!this._hasAsyncWork()) break
      await waitMs(10)
      // 导出模式：卡死 video 超 12 次(120ms)也强制退役
      if (this._awaitDecode && i >= 12) this._forceQuietStuckInExport(12, i + 1)
    }
    tWait2 = performance.now() - s2
    this.render(frame, project, fps)

    // 取出整幅 stage 画布（= 遮罩窗口看到的那一帧；超出 stage 的内容自然被裁掉）。
    // 用 extract.pixels + clearColor 黑底直接取回 RGBA 字节，省掉"canvas → drawImage → getImageData"的二次拷贝。
    let pixels: Uint8ClampedArray | null = null
    try {
      const sX = performance.now()
      const extract = (this.app.renderer as unknown as {
        extract?: {
          pixels: (o: { target: Container; frame: Rectangle; clearColor: string }) => { pixels: Uint8ClampedArray; width: number; height: number }
        }
      }).extract
      if (extract) {
        // 显式 frame 强制按 stage 全尺寸抽取（否则 Pixi 按 root 的 localBounds 抽，非 16:9 素材/
        // 空帧会得到错误尺寸）；clearColor 黑底把透明区合成到不透明黑，直接得到可喂 NV12 的 RGBA。
        const out = extract.pixels({
          target: this.root,
          frame: new Rectangle(0, 0, project.stage.width, project.stage.height),
          clearColor: '#000000'
        })
        pixels = out.pixels
      } else {
        // 退化：读 WebGL canvas 并在 2D 画布上合成黑底取回 RGBA（旧路径）
        const c = (this.app.canvas as HTMLCanvasElement) || null
        if (c) {
          const tmp = document.createElement('canvas')
          tmp.width = c.width
          tmp.height = c.height
          const ctx = tmp.getContext('2d', { willReadFrequently: true })
          if (ctx) {
            ctx.fillStyle = '#000000'
            ctx.fillRect(0, 0, tmp.width, tmp.height)
            ctx.drawImage(c, 0, 0)
            pixels = ctx.getImageData(0, 0, tmp.width, tmp.height).data
          }
        }
      }
      tExtract = performance.now() - sX
    } catch (err) {
      console.error('[PixiRenderer] captureFrame extract failed:', (err as Error).message)
      pixels = null
    }

    // 导出模式累计分阶段耗时（供 [Export-perf] 判定 3fps 卡点）
    if (this._awaitDecode && frame >= 0 && (frame % 60) === 0) {
      const ds = this.decodeStats()
      console.log(
        `[Export-cap] frame=${frame} 解码await=${tDecode0.toFixed(0)}ms ` +
        `渲染=${tRender1.toFixed(0)}ms(其中空转${Math.max(0, tWait1 - tRender1).toFixed(0)}ms) ` +
        `阶段二=${tWait2.toFixed(0)}ms extract=${tExtract.toFixed(0)}ms ` +
        `videoEls=${this.videoEls.size} 解码命中累计=${ds.hits} miss累计=${ds.misses}`
      )
    }
    return pixels
  }
  private toLayer(
    c: ActiveVideoClip | ActiveImageClip | ActiveTextClip,
    clipMap: Map<string, import('../model/timeline').Clip>
  ): Layer | null {
    if (c.type === 'text') {
      const raw = clipMap.get(c.id)
      return {
        id: c.id,
        isLyric: !!raw?.isLyrics,
        z: c.zIndex,
        src: '',
        opacity: c.opacity,
        sourceFrame: c.sourceFrame,
        content: c.content,
        transform: undefined,
        lyrics: raw?.lyrics
      }
    }
    return {
      id: c.id, isLyric: false, z: c.zIndex, src: c.src, opacity: c.opacity,
      sourceFrame: c.sourceFrame, transform: c.transform, content: ''
    }
  }

  /** 获取/复用纹理（视频返回 video 元素纹理） */
  private textureFor(src: string): Texture | null {
    if (!src) return null
    if (looksLikeImage(src)) {
      // 图片：懒加载到 Assets 缓存（blob:/本地路径首次 load，之后复用）
      try {
        const existing = Assets.get(src)
        if (existing) return existing
        // 异步加载，加载完成前返回 null（下一帧自动出现）
        this.loadImage(src).catch(() => {})
        return null
      } catch {
        return null
      }
    }
    // 视频：复用 <video> 元素作为纹理源
    if (this._videoGiveUp.has(src)) return null // 已放弃该源：不再重建 <video>（避免退役→重建死循环）
    let el = this.videoEls.get(src)
    if (!el) {
      el = document.createElement('video')
      // crossOrigin 必须在设 src 之前设置。avn-file:// 是自定义协议，须以 CORS 模式(anonymous)
      // 加载才不会被 WebGL 判为"跨源污染"（否则 texImage2D 抛 SecurityError 视频无法上屏）。
      // 主进程 avn-file 处理器已返回 Access-Control-Allow-Origin: *，与 anonymous 配合即解污染。
      // blob:/data: 同源无需但无害；仅对 http(s) 远程源不设（避免无 CORS 头的演示媒体加载失败）。
      const isRemote = /^https?:\/\//i.test(src)
      if (!isRemote) el.crossOrigin = 'anonymous'
      el.src = src
      el.muted = true
      el.loop = true
      el.preload = 'auto'
      el.playsInline = true
      el.addEventListener('error', () => {
        console.error('[PixiRenderer] video error:', src, el.error?.code, el.error?.message)
      })
      this.videoEls.set(src, el)
      el.play().catch(() => {
        // 自动播放被拦截时静默（Pixi VideoSource 也会尝试 autoplay；此处先发请求保证后续可 seek）
      })
    }
    // 必须有实际帧数据（HAVE_CURRENT_DATA, readyState>=2）且源有尺寸才返回纹理。
    // 仅元数据(readyState=1)时 videoWidth 可读但像素未就绪；此处已 play + render 前先 seek，
    // 故 readyState>=2 即可。就绪判定一律以「像素尺寸 >0」为准（v8 中 Texture 无 `.valid`）。
    if (el.readyState < 2 || !el.videoWidth || !el.videoHeight) {
      if (el.readyState < 2) el.play().catch(() => {})
      return null
    }
    let tex: Texture | null = null
    try {
      // Texture.from 内部以 video 元素为 key 做全局缓存：若首次调用时源尚未 resize
      // （metadata 已到但 VideoSource 异步初始化未完成），会缓存一张 0x0 或 1x1 的占位坏纹理，
      // 之后永远命中它 → 画面不出现 / 只显示单色块（导出时表现为 tex=1x1）。因此取缓存后，
      // 只要纹理像素尺寸与元素实际 videoWidth/videoHeight 不一致，就销毁坏缓存并以 skipCache 重建。
      tex = Texture.from(el)
      if (
        tex &&
        el.videoWidth >= 1 &&
        el.videoHeight >= 1 &&
        (tex.width !== el.videoWidth || tex.height !== el.videoHeight)
      ) {
        try {
          if (tex.destroy) tex.destroy()
        } catch {
          /* 忽略销毁异常 */
        }
        tex = Texture.from(el, true) // skipCache：绕过坏缓存重建
      }
    } catch (err) {
      console.error('[PixiRenderer] Texture.from threw:', (err as Error).message, 'src', src.slice(0, 40))
      return null
    }
    // 二次校验：纹理尚无像素尺寸则放弃本帧，等待下一帧（源 resize 后就绪）自动重试
    if (!tex || tex.width < 1 || tex.height < 1) {
      return null
    }
    return tex
  }

  /** 异步加载图片纹理到 Assets 缓存（带去重） */
  private async loadImage(src: string): Promise<void> {
    const key = `img:${src}`
    if (this.imageLoading.has(key)) return this.imageLoading.get(key)!
    const p = Assets.load(src).then((t) => { this.imageLoading.delete(key); return t })
    this.imageLoading.set(key, p)
    await p
  }

  /** 回收某个视频源的元素与纹理（换代理/清理时用），并从全局 Texture 缓存移除 */
  private _retireVideoSrc(src: string): void {
    const el = this.videoEls.get(src)
    if (!el) { this.videoTargetSec.delete(src); return }
    el.pause()
    try { const t = Texture.from(el); t.destroy() } catch { /* 忽略 */ }
    this.videoEls.delete(src)
    this.videoTargetSec.delete(src)
  }

  /**
   * 尝试用 WebCodecs 预解码缓存为某视频层上当前帧（可加性加速）。
   * - 命中：把 sp.texture 换成 ImageBitmap 纹理，返回 true；
   * - 未附着管理器 / 无 provider / 非 ready / AU 缓存 miss / 纹理构建失败 → false（调用方走 <video> 兜底）。
   * 同 AU 复用已建纹理，跨 AU 才重建（避免每帧 GPU 上传抖动）。
   */
  private _tryDecodeVideo(l: Layer, src: string, proxySrc: string | null, sp: Sprite, fps: number): boolean {
    // 仅导出(_awaitDecode)才诊断"未接管原因"；预览无管理器是正常态，静默走 <video> 兜底，不打噪音。
    const reason0 = (r: string): boolean => {
      if (this._awaitDecode) this._dbgOnce(r)
      return false
    }
    if (!this._decode) return false // 预览：无解码管理器，属正常（仅导出 attachDecode 后有）
    const session = this._sessionForSrc(src)
    if (!session) return reason0('decode:无会话(src=' + src.slice(0, 50) + ', 代理=' + (proxySrc ?? '-').slice(0, 50) + ')')
    const prov = session.provider
    if (prov.status !== 'ready') return reason0('decode:provider非ready(status=' + prov.status + ', openError=' + (prov as { openError?: string }).openError + ')')
    // 计算目标源 AU
    const fpsProj = fps || 30
    let au = this._decode!.auForFrame(session, l.sourceFrame, fpsProj)
    if (!Number.isFinite(au) || au < 0) return reason0('decode:au非法(au=' + au + ',sourceFrame=' + l.sourceFrame + ')')
    const nAus = prov.auCount
    if (nAus < 1) return reason0('decode:auCount=0')
    // 超长(视频循环/拉长填满) clip：sourceFrame 超过素材帧数 → 按 AU 取模回绕，等价于 <video>
    // syncVideo 对 target 秒数 `% duration` 的受控循环（au = round(秒×sourceFps)，模 auCount 对齐素材帧数）。
    if (au >= nAus) au = au % nAus
    // 预解码推进（fire-and-forget：单调喂超前窗口，keep decode busy）
    prov.setPlayhead(au)
    const hit = prov.current(au)
    if (!hit) { // miss → 计数
      this._decodeMisses++
      if (this._awaitDecode) {
        // 导出期：宁可用上一帧解码纹理，也绝不回退 <video>。回退会另起一条 GPU 视频解码器，
        // 与 WebCodecs 解码路径抢同一块 GPU，还会触发"卡死→退役"反复——这正是导出中段
        // WebGL CONTEXT_LOST（GPU TDR）的诱因之一。captureFrame 阶段零已 await 过该 AU，
        // 此处的 miss 属极少数竞态（多为 loop 回绕瞬间），沿用上一帧即可，正确性损失可忽略。
        return true
      }
      return reason0('decode:miss(au=' + au + ',cacheSize=' + prov.cacheSize + ')')
    }
    this._decodeHits++
    // 解码命中：若此前某帧曾为此源创建过 <video>(冷启动兜底)而残留，把它静音停稳，
    // 否则 _hasAsyncWork 会因 el.seeking/未 paused 而让 captureFrame 空转等待、拖慢解码命中的帧。
    // 同时停原始与代理两种 key 的残留元素（兜底 <video> 可能按任一种建的）。
    this._quietVideoFor(src)
    if (proxySrc && proxySrc !== src) this._quietVideoFor(proxySrc)
    // 同 AU 复用纹理
    const prev = this._decodeTex.get(l.id)
    if (prev && prev.au === au) {
      if (sp.texture !== prev.tex) sp.texture = prev.tex
      return true
    }
    try {
      const tex = new Texture({ source: new ImageSource({ resource: hit.bitmap }) })
      if (!tex || tex.width < 1 || tex.height < 1) { tex?.destroy(); return false }
      // 释放旧纹理（若有）
      if (prev) { try { prev.tex.destroy() } catch { /* 忽略 */ } }
      this._decodeTex.set(l.id, { au, tex })
      sp.texture = tex
      return true
    } catch (err) {
      console.warn('[PixiRenderer] decode texture build failed (fallback <video>):', (err as Error)?.message)
      return false
    }
  }

  /** 若某源残留 <video> 元素（冷启动兜底创建），把画面交给解码路径后的收尾：
   *  - 已能停稳(paused/非 seeking) → 仅 pause 保留，_hasAsyncWork 见 paused 便不再等待；
   *  - 卡在 buffering(readyState<2) 或持续 seeking/播放 → 该元素已不被视觉使用、纯属浪费带宽且会
   *    让 _hasAsyncWork() 一直为 true → 彻底 retire（remove+销毁纹理），否则导出 captureFrame 会在
   *    阶段一 wait 循环里空转最多 300×10ms/帧（这正是"decode 命中仍慢、capture 占比 66%"的一个来源）。 */
  private _quietVideoFor(src: string): void {
    const el = this.videoEls.get(src)
    if (!el) return
    try { el.pause() } catch { /* 忽略 */ }
    const wedged =
      (typeof el.readyState === 'number' && el.readyState < 2) ||
      el.seeking === true ||
      el.paused === false
    if (!wedged) return
    this._retireVideoEl(src)
  }

  /** 彻底退役一个 <video> 元素（destroy 纹理 + 移出 videoEls），让 _hasAsyncWork 不再被它拖住。 */
  private _retireVideoEl(src: string): void {
    const el = this.videoEls.get(src)
    if (!el) return
    try { el.pause() } catch { /* 忽略 */ }
    try {
      const t = Texture.from(el)
      if (t) t.destroy()
    } catch { /* 忽略 */ }
    this.videoEls.delete(src)
    this.videoTargetSec.delete(src)
  }

  /**
   * 导出模式（_awaitDecode）阶段一/二空转太久时调用：把"持续 seeking/未暂停 超过 budget"的
   * <video> 强制退役。这类 video 是**非解码覆盖源**的兜底(解码覆盖源已在阶段零 await 就绪、
   * 命中即 _quietVideoFor，不会走到这)。一个卡死的 avn 代理 <video>(如 Chromium 解不动)
   * 会让 _hasAsyncWork 恒 true → 阶段一最多空转 300×10ms/帧(实测 3s) → 整体拖到 3fps。
   * 退役它 = 弃用该帧的 <video> 兜底(显示旧帧/空),而不是让整个导出每帧卡 3 秒。
   * @param budgetIters 该 video 已连续卡住的迭代数阈值
   */
  private _forceQuietStuckInExport(budgetIters: number, spinCount: number): void {
    if (!this._awaitDecode) return
    if (spinCount < budgetIters) return // 还没到阈值，给正常 seek 一点时间
    for (const [src, el] of Array.from(this.videoEls.entries())) {
      const stuck =
        (typeof el.readyState === 'number' && el.readyState < 2) ||
        el.seeking === true ||
        el.paused === false
      if (!stuck) continue
      // 退役 + 标记"放弃"：本次导出不再为它重建 <video>（否则每帧退役→重建→再卡死=GPU 空转/风扇狂转/主线程卡死）
      this._retireVideoEl(src)
      this._videoGiveUp.add(src)
      console.warn(`[Export-decode] 源 <video> 卡死已退役并放弃(本导出不再重建): ${src.slice(-40)}`)
    }
  }

  /** 由层 src(effective) 反查解码会话（需已 registerSrc/传入 mapSrcToPath） */
  private _sessionForSrc(src: string): import('./h264/decodeSources').DecodeSession | null {
    if (!this._decode) return null
    // 优先用外部映射函数拿绝对路径
    if (this._decodeSrcToPath) {
      const p = this._decodeSrcToPath(src)
      if (p) {
        const s = this._decode.sessionForPath(p)
        if (s) return s
      }
      return null
    }
    return this._decode.sessionForSrc(src)
  }

  /**
   * 收集当前帧所有"可走解码路径"的活跃视频层 → { src: { session, au } }。
   * captureFrame(_awaitDecode) 用它先 await 各目标 AU 就绪，让随后的 render 命中解码缓存，
   * 而非一 miss 就回退 <video> seek——把"主线程消费"与"解码预取"解耦（导出提速核心）。
   */
  private _decodeTargetsFor(frame: number, project: Project, fps: number): Map<string, { session: import('./h264/decodeSources').DecodeSession; au: number }> {
    const out = new Map<string, { session: import('./h264/decodeSources').DecodeSession; au: number }>()
    if (!this._decode) return out
    const fpsProj = fps || 30
    try {
      const scene = resolveTimeline(frame, project)
      for (const v of scene.videos) {
        if (looksLikeImage(v.src)) continue
        const eff = effectiveVideoSrc(v.src)
        const session = this._sessionForSrc(eff)
        if (!session) continue
        const prov = session.provider
        if (prov.status !== 'ready' || prov.auCount < 1) continue
        let au = this._decode.auForFrame(session, v.sourceFrame, fpsProj)
        if (!Number.isFinite(au) || au < 0) continue
        if (au >= prov.auCount) au = au % prov.auCount
        // 同层去重（场景里同 src 可能多条，取同 AU 无妨）
        out.set(eff, { session, au })
      }
    } catch { /* resolve 失败忽略，走 <video> 兜底 */ }
    return out
  }

  /**
   * 帧同步视频：把视频元素当作时间轴的"奴隶"，让它停靠/播放到目标源秒，绝不脱离时间轴自由循环。
   *
   * 目标源秒的换算（关键）：resolveTimeline 产出的 sourceFrame 一律以「工程帧率 fps(帧/秒)」为刻度，
   * 故目标源秒 = sourceFrame / fps。这在数学上等价于"素材在真实时间轴上走到第几秒"，
   * 与素材自身的原始帧率(24/25/60)无关——因为预览按墙钟实时推进，素材也按真实时间播放，
   * 二者在"第几秒"对齐即正确；素材帧率只影响解码粒度，不影响应显示的秒位置。
   *
   * 行为分两态：
   *  - 播放态(_playing)：让素材自由前进，只有偏离目标 >0.25s 才 seek 校正（避免每帧 seek 卡顿），
   *    素材在播放时会按自身帧率平滑走帧，帧同步由"墙钟=实时"天然保证。
   *  - 暂停态：素材必须精确钉在目标帧——pause + 亚帧误差内 seek 到 exact 秒（拖动/停帧即时可见）。
   *  - Clip 时长 > 素材时长（拉长填满）：目标秒对 duration 取模回绕 → 受控循环而非自由乱播。
   */
  private syncVideo(src: string, sourceFrame: number, fps: number): void {
    const el = this.videoEls.get(src)
    if (!el) return
    const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0
    let target = sourceFrame / fps
    // 拉长填满：超过素材末尾则回绕（等价于素材自然循环，但受时间轴控制）
    if (dur > 0.2 && target >= dur) {
      target = target % dur
    }
    this.videoTargetSec.set(src, target)
    // 尚未有可解码帧（元数据都没齐）：本帧不 seek 不 pause——让它在解码中爬升，
    // 否则一 pause 就永远没有首帧（→ 暂停时预览空白）。
    if (el.readyState < 2 || !el.videoWidth || !el.videoHeight) {
      if (el.paused) el.play().catch(() => {})
      return
    }
    const diff = Math.abs(el.currentTime - target)
    if (this._playing) {
      // 播放态：前进；仅明显漂移/跳帧时 seek 校准（避免每帧 seek 卡顿）
      if (el.paused) el.play().catch(() => {})
      if (diff > 0.25) el.currentTime = target
    } else {
      // 暂停态：精确钉在目标帧，禁止自行前进。seek 到目标(触发解码该帧)后 pause 冻结，
      // 之后由 _hasAsyncWork 的 seeking 分支持续渲染，直到 seek 完成把帧钉上。
      if (!el.paused) {
        if (diff > 1 / 60) el.currentTime = target
        el.pause()
      } else {
        // 已暂停：仅在偏差仍大时补一次 seek（拖动进度条即时换帧）
        if (diff > 1 / 60 && !el.seeking) el.currentTime = target
      }
    }
  }

  /**
   * 应用文本样式与内容。
   * - 歌词 clip：karaoke 滚动渲染（当前句居中高亮、前后句跟随，0.4s 平滑让位，切句零跳变），
   * - 普通文本 clip：单行居中。
   * 行数据/排版几何全部由纯函数 resolveTextRows(layout.ts) 计算 → 预览与导出共用同一布局，
   * 保证「导出帧 = 预览帧」的像素一致。
   * 辉光用模糊副本实现（近似 CSS text-shadow glow）。
   */
  private applyText(tl: TextLayer, l: Layer, project: Project, fps: number): void {
    const s = l.lyrics
    const { text: tb, rows } = resolveTextRows(
      l.isLyric,
      l.content,
      l.sourceFrame,
      fps,
      s,
      project
    )
    // 层容器：位置/透明度/旋转来自 layout 纯函数（design 归一化）
    tl.root.position.set(tb.x, tb.y)
    tl.root.alpha = l.opacity
    tl.root.rotation = tb.rotation
    const glowOn = tb.glowEnabled

    // 行池复用：最多 MAX_ROWS 个槽位，逐槽更新；多余槽位隐藏
    while (tl.rows.length < Math.max(rows.length, 1)) {
      const main = new Text({ text: '' })
      const glow = new Text({ text: '' })
      const blur = new BlurFilter({ strength: 1 })
      glow.filters = [blur]
      glow.zIndex = 0
      main.zIndex = 1
      tl.root.addChild(glow)
      tl.root.addChild(main)
      tl.rows.push({ main, glow, blur, glowStrength: -1 })
    }
    const slotCount = tl.rows.length
    for (let slot = 0; slot < slotCount; slot++) {
      const slotRow = tl.rows[slot]
      const datum = rows[slot] as TextRowDatum | undefined
      if (!datum) {
        slotRow.main.visible = false
        slotRow.glow.visible = false
        continue
      }
      slotRow.main.visible = true
      this.styleTextRow(slotRow.main, datum, tb)
      // 辉光层（模糊副本）：强度 >0.01 才显示
      if (glowOn && datum.glow > 0.01) {
        this.styleTextRow(slotRow.glow, datum, tb)
        slotRow.glow.style.fill = tb.glowColor
        const radius = datum.glow * glowRadius(datum.size)
        if (Math.abs(slotRow.glowStrength - radius) > 0.5) {
          slotRow.blur.strength = radius
          slotRow.glowStrength = radius
        }
        slotRow.glow.visible = true
      } else {
        slotRow.glow.visible = false
      }
    }
  }

  /** 给一行 Text 套用样式、内容、位置（几何/换行宽度都来自 layout.ts 的 TextBox） */
  private styleTextRow(t: Text, d: TextRowDatum, tb: import('./layout').TextBox): void {
    t.text = d.text
    t.style.fill = d.color
    t.style.fontFamily = tb.fontFamily ?? 'sans-serif'
    t.style.fontSize = d.size
    t.style.fontWeight = d.weight
    t.style.lineHeight = (tb.lineHeight ?? 1.4) * d.size
    t.style.wordWrap = true
    t.style.wordWrapWidth = tb.wordWrapWidth
    t.style.align = tb.align
    // 对齐锚点：左=左缘，右=右缘，中=中心
    t.anchor.set(tb.align === 'left' ? 0 : tb.align === 'right' ? 1 : 0.5, 0.5)
    t.position.set(0, d.y)
    t.alpha = d.opacity
  }

  private releaseText(id: string, live: Set<string>): void {
    if (this.textLayers.has(id) && !live.has(id)) {
      this.textLayers.get(id)?.root.destroy()
      this.textLayers.delete(id)
    }
  }
  private releaseSprite(id: string, live: Set<string>): void {
    if (this.sprites.has(id) && !live.has(id)) {
      this.sprites.get(id)?.destroy()
      this.sprites.delete(id)
    }
  }
  /** 回收本帧不再活跃的层 */
  private retire(live: Set<string>): void {
    for (const [id, sp] of this.sprites) {
      if (!live.has(id)) { sp.destroy(); this.sprites.delete(id) }
    }
    for (const [id, tl] of this.textLayers) {
      if (!live.has(id)) { tl.root.destroy(); this.textLayers.delete(id) }
    }
    // 释放已消失层的解码纹理
    for (const id of Array.from(this._decodeTex.keys())) {
      if (!live.has(id)) {
        const d = this._decodeTex.get(id)
        if (d) { try { d.tex.destroy() } catch { /* 忽略 */ } }
        this._decodeTex.delete(id)
      }
    }
  }

  /** 销毁并清理 */
  destroy(): void {
    this.stop()
    // 兜底：无论 autoRender 与否，都在销毁任何 child/绑定纹理前停掉 Pixi 的自动渲染 ticker。
    // 若此刻还有 ticker 在跑（例如未来误把预览实例拿去导出/复用），销毁中渲染已释放对象
    // 仍会触发 null.geometry 崩溃 + textureSource 绑定告警。这里先停，杜绝销毁窗口期的并发渲染。
    if (this.app?.ticker) {
      try { this.app.ticker.stop() } catch { /* 忽略 */ }
    }
    if (this._proxyUnsub) { this._proxyUnsub(); this._proxyUnsub = null }
    this._clearDecodeTextures()
    this._decode = null
    this._decodeSrcToPath = null
    for (const el of this.videoEls.values()) el.pause()
    this.videoEls.clear()
    this.videoTargetSec.clear()
    this.sprites.forEach((s) => s.destroy())
    this.sprites.clear()
    this.textLayers.forEach((tl) => tl.root.destroy())
    this.textLayers.clear()
    if (this.app) {
      // ⚠ 绝不能 releaseGlobalResources：`TexturePool`/`CanvasPool`/`BigPool` 是 **模块级单例**，
      // 跨所有 Application(预览+导出)共享。若用 destroy(true,true)/destroy({releaseGlobalResources:true})，
      // AbstractRenderer.destroy 会触发 GlobalResourceRegistry.release() → 清空共享 TexturePool 的
      // `_texturePool` 桶(但 `_poolKeyHash` 保留)。此后仍存活的预览渲染器再渲染任意 Text → 归还纹理时
      // `TexturePool.returnTexture` 读 `_texturePool[key]`=undefined → `Cannot read 'push' of undefined`
      // 崩溃 —— 正是"导出一次后再点播放 → 页面直接崩"(Pixi #11694 同源)。
      // 规范做法(官方建议)：releaseGlobalResources:false，只销毁本渲染器自己的 view/系统/pipes/WebGL
      // 上下文(GlContextSystem.destroy→loseContext 已释放 GPU)，共享池留给"最后一个 Application 销毁"再清。
      // 第二参 true：连 stage 的 children 一并销毁(本 root 容器 + 残留)。
      this.app.destroy({ removeView: true, releaseGlobalResources: false }, true)
      this.app = null
      this.root = null
      this.mounted = false
    }
  }

  get isMounted(): boolean {
    return this.mounted
  }
}
