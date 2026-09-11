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
import { Application, Container, Sprite, Text, Texture, ImageSource, BlurFilter, Rectangle, RenderTexture, ColorMatrixFilter, Matrix, Mesh, MeshGeometry, type TextStyleFontWeight } from 'pixi.js'
// CSP 不允许 unsafe-eval 时，需引入 unsafe-eval 模块做 side-effect：
// 它覆盖渲染器的 _unsafeEvalCheck 并用避免 eval 的 polyfill 替代（Electron/Chrome 扩展等严格 CSP 环境）
import 'pixi.js/unsafe-eval'
import type { Project } from '../model/timeline'
import { resolveTimeline } from '../model/timeline'
import type { ActiveVideoClip, ActiveImageClip, ActiveTextClip, ActiveVisualClip, ActiveEffectClip, LyricStyle } from '../model/timeline'
import { effectiveVideoSrc, initMediaProxy } from './mediaProxy'
import { mediaBox, resolveTextRows, glowRadius, type TextRowDatum } from './layout'
import { getPreset, drawPreset } from '../presets/registry'
import { paramAt } from '../presets/keyframes'
import { num as numParam, bool as boolParam } from '../presets/types'
import { levelAt, type PresetAudioData } from '../media/audioAnalysis'
import type { PresetImage, PresetMeta } from '../presets/types'
import { mapBlurRadius } from '../presets/drawers/gaussianBlur'
import { findFollowCircle, followProjection } from '../presets/followCircle'
import { resolveLayer3D, affineAt, isLayer3DActive, planPerspectiveGrid, chooseGridSeg, layer3DDrawBox, type Box3D, type Layer3DStyle, type ResolvedLayer3D } from './layer3d'
import { decodeGif, isGifBytes, gifFrameIndex } from '../media/gif'

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
  /** 预设样式 id + 参数（有值时由预设 drawer 绘制，见 presets/registry） */
  presetId?: string
  params?: Record<string, unknown>
  /** 关键帧轨道与 clip 内相对进度（调整层/预设求值用） */
  keyframes?: import('../presets/keyframes').KeyframeTracks
  tRel?: number
  /** clip.type==='image'：强制走图片管线（不靠扩展名猜，blob/编码路径也能命中） */
  isImage?: boolean
  /** GIF 动画速度：每个 GIF 帧占用多少个时间轴帧（默认 1 = 一帧换一帧） */
  gifSpeed?: number
  /** 泛用 3D 层变换（轴+消失点），任意可视 clip 可挂 */
  layer3d?: Layer3DStyle
}

const STAGE = { width: 1920, height: 1080 }

/**
 * 该 src 是否为图片（按扩展名/前缀判断；决定走图片管线 vs 视频纹理管线）。
 * ⚠ 本地素材是 `avn-file://${encodeURIComponent(path)}`，扩展名在解码后的路径末尾，
 * 直接对编码串做正则仍常见，但 Windows 路径编码后更稳妥先 decode 再测。
 */
function looksLikeImage(src: string): boolean {
  if (!src) return false
  if (src.startsWith('data:image')) return true
  let low = src.toLowerCase()
  if (src.startsWith('avn-file://')) {
    try {
      low = decodeURIComponent(src.slice('avn-file://'.length)).toLowerCase()
    } catch {
      /* 保留原串 */
    }
  }
  return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/.test(low)
}

/** 一行歌词的渲染槽：holder 承载 3D/2D 变换；Text 只负责字形（改字号不会冲掉变换） */
interface KaraokeRow {
  holder: Container
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
  // 图片异步加载去重：src → Promise（与导出 loadImageBitmaps 同路径：fetch+createImageBitmap）
  private imageLoading = new Map<string, Promise<void>>()
  // 图片纹理缓存：src → Texture（自管，不走 Assets——Assets 对 avn-file:// 自定义协议不稳）
  private imageTextures = new Map<string, Texture>()
  /** GIF 动画帧纹理：src → 每帧一张 Texture（时间轴帧驱动选帧）；静态图不在此表 */
  private gifFrames = new Map<string, Texture[]>()
  /** 3D 透视网格（长方体六面投影）；key = clip id */
  private layer3dMeshes = new Map<string, Mesh>()
  /** 媒体层当前帧的内容盒子（stage 像素，含中心 x/y 与宽高）——3D 附着面 HUD 用；key = clip id */
  private mediaBoxes = new Map<string, { x: number; y: number; w: number; h: number }>()
  /** 预设层当前帧的内容盒（stage 像素，左上原点；贴面时含出血）——HUD 用；key = clip id */
  private presetBoxes = new Map<string, { x: number; y: number; w: number; h: number }>()
  // 视频首帧就绪诊断去重（每 clip id 打印一次 texture READY 状态）
  private _videoShown = new Set<string>()
  /** 音频分析数据（可视化预设用；由 Monitor 计算后 setAudioData 传入） */
  private _audioData: PresetAudioData | null = null
  /** 调整层（高斯模糊）的 GPU 合成资源：下层内容的 RenderTexture + 模糊精灵 */
  private _adjustRT: RenderTexture | null = null
  private _adjustSprite: Sprite | null = null
  private _adjustFilter: BlurFilter | null = null
  private _adjustColor: ColorMatrixFilter | null = null
  /** 预设层离屏画布缓存：同一 clip 复用一张画布 + 纹理，仅在内容 key 变化时重绘 */
  private _presetRenders = new Map<string, {
    canvas: HTMLCanvasElement
    ctx: CanvasRenderingContext2D
    tex: Texture
    key: string
    /** 画布原点对应的 stage 坐标（贴面时画布比画幅大，原点为负） */
    originX: number
    originY: number
  }>()
  /**
   * 上一帧「跟随圆形且圆形启用 3D」的预设层 id 集合。
   * 这类层的 3D 已由 drawer 逐点施加（env.followProject）→ 外层不再叠加自身 3D（避免双重变形）。
   */
  private _followProjectActive = new Set<string>()
  // initMediaProxy 返回的退订函数（销毁时调用）
  private _proxyUnsub: (() => void) | null = null
  // 当前是否已挂载 canvas
  private mounted = false

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
      ...scene.visuals.map((v) => this.toLayer(v, clipMap)),
      ...scene.effects.map((e) => this.toLayer(e, clipMap)),
      ...scene.texts.map((t) => this.toLayer(t, clipMap))
    ].filter((l): l is Layer => !!l)
    layers.sort((a, b) => a.z - b.z)

    // 需要保留的 id 集合，用于回收已消失的层
    const liveIds = new Set<string>()

    for (const l of layers) {
      liveIds.add(l.id)

      // —— 预设样式层（可视化/图片样式）：用与导出完全相同的 drawer 画到离屏 canvas，再作为纹理上屏 ——
      const presetMeta = getPreset(l.presetId)
      // —— 调整层（如高斯模糊）：作用于其下已合成画面，预览端用 RenderTexture + BlurFilter 实现 ——
      if (presetMeta?.adjust) {
        this.applyAdjustLayer(l, presetMeta, layers, frame, project, fps)
        this.releaseText(l.id, liveIds)
        continue
      }
      if (presetMeta) {
        let sp = this.sprites.get(l.id)
        if (!sp) {
          sp = new Sprite()
          this.sprites.set(l.id, sp)
          this.root.addChild(sp)
        }
        sp.zIndex = l.z
        const rendered = this.renderPresetToTexture(l, presetMeta, frame, project, fps)
        if (rendered) {
          if (sp.texture !== rendered.tex) sp.texture = rendered.tex
          sp.alpha = l.opacity
          sp.zIndex = l.z
          // 跟随圆形且圆形启用 3D：环的 3D 已在 drawer 内逐点施加 → 本层自身 3D 不再叠加
          // （用户约定「无脑跟随」：跟随态下忽略环形层自己的附着面设置，避免双重变形）。
          const own3d = this._followProjectActive.has(l.id) ? undefined : l.layer3d
          // 画布/内容盒 = 该层需要绘制的区域（贴面时比画幅大）→ 内容不再被"面的矩形"硬切
          const b = rendered.box
          this.presetBoxes.set(l.id, b)
          this.applySpriteBox3D(sp, l.id, b.x, b.y, b.w, b.h, own3d, project.stage, project.box3d, false, l.opacity)
        } else {
          sp.visible = false
          const meshHide = this.layer3dMeshes.get(l.id)
          if (meshHide) meshHide.visible = false
        }
        this.releaseText(l.id, liveIds)
        continue
      }

      if (l.src) {
        // 媒体层（视频/图片）。视频源可被媒体代理换成转码代理(avn 本地文件)；图片原样走 Assets。
        const isImage = !!(l.isImage || looksLikeImage(l.src))
        // 解码路径一律用原始 clip src(l.src，非代理)：解码会话按原始源建(demux 原始文件)，
        // 用代理查会 miss→回退破代理 <video>。非解码兜底才用 effectiveVideoSrc(代理更稳)。
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
        // 视频帧同步：把视频元素当作时间轴的"奴隶"，跟随目标源秒（帧→秒映射见 syncVideo 注释），
        // 绝不让它脱离时间轴自行循环播放。用 proxyEff(代理比原始更稳，Chromium 原生解码更可靠)。
        if (isVideo) this.syncVideo(proxyEff, l.sourceFrame, fps)
        const tex = this.textureFor(proxyEff, isImage, l.sourceFrame, l.gifSpeed ?? 1)
        if (tex && sp.texture !== tex) sp.texture = tex
        // 就绪判定只认像素尺寸（v8 中 Texture 没有 `.valid` 属性；source resize 后 width/height 即真实像素数）
        const tReady = sp.texture && sp.texture.width >= 1 && sp.texture.height >= 1
        if (tReady) {
          // 视频纹理强制刷新到当前源帧：Pixi v8 对 video 纹理，暂停/seek 后不会自动拉新帧，
          // 必须 update() 才能把 video.currentTime 对应的帧上传到 GPU（否则拖动进度条画面不更新）。
          if (isVideo) {
            try {
              sp.texture.update()
            } catch (err) {
              // update() 的 WebGL 错误可能被 Pixi 内部吞掉，这里显式捕获便于诊断
              console.error('[PixiRenderer] texture.update failed:', (err as Error).message)
            }
          }
          // 诊断：视频纹理首帧就绪时打印一次关键状态（用于定位黑屏）
          if (isVideo && !this._videoShown.has(l.id)) {
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
          this.mediaBoxes.set(l.id, { x: mb.x, y: mb.y, w: mb.width, h: mb.height })
          sp.alpha = l.opacity
          sp.zIndex = l.z
          this.applySpriteBox3D(sp, l.id, mb.x, mb.y, mb.width, mb.height, l.layer3d, project.stage, project.box3d, true, l.opacity)
        } else {
          // 纹理未就绪：隐藏精灵与可能的 3D mesh
          sp.visible = false
          const meshHide = this.layer3dMeshes.get(l.id)
          if (meshHide) meshHide.visible = false
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

  private toLayer(
    c: ActiveVideoClip | ActiveImageClip | ActiveTextClip | ActiveVisualClip | ActiveEffectClip,
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
        lyrics: raw?.lyrics,
        presetId: c.presetId,
        params: c.params,
        keyframes: c.keyframes,
        tRel: c.tRel,
        layer3d: c.layer3d
      }
    }
    if (c.type === 'visual' || c.type === 'effect') {
      return {
        id: c.id, isLyric: false, z: c.zIndex, src: '', opacity: c.opacity,
        sourceFrame: c.sourceFrame, transform: c.transform, content: '',
        presetId: c.presetId, params: c.params, keyframes: c.keyframes, tRel: c.tRel,
        layer3d: c.layer3d
      }
    }
    return {
      id: c.id, isLyric: false, z: c.zIndex, src: c.src, opacity: c.opacity,
      sourceFrame: c.sourceFrame, transform: c.transform, content: '',
      presetId: c.presetId, params: c.params, keyframes: c.keyframes, tRel: c.tRel,
      isImage: c.type === 'image',
      layer3d: c.layer3d
    }
  }

  /** 音频分析数据（可视化预设的驱动信号；由 Monitor 计算后传入） */
  /**
   * 把精灵摆到 stage 上的盒子；clip 选了 3D 附着面时改用 **长方体投影 + 细分网格**。
   *
   * ⚠ 用细分网格而非 4 角 quad：单应性在四边形内部是非线性映射，只投影 4 个角
   * 会在线性插值下把画面折成两个平面（折痕）。段数由 `chooseGridSeg()` 按实际偏差自适应
   * （导出端调同一函数 → 两端几何逐位一致）。
   * ⚠ 本方法负责 visible/alpha：3D 时 sprite 隐藏、mesh 显示，调用方不要再写 sp.visible=true。
   */
  private applySpriteBox3D(
    sp: Sprite,
    clipId: string,
    x: number,
    y: number,
    w: number,
    h: number,
    layer3d: Layer3DStyle | undefined,
    stage: { width: number; height: number },
    box3d: Box3D | undefined,
    centerAnchor: boolean,
    opacity: number
  ): void {
    const boxX0 = centerAnchor ? x - w / 2 : x
    const boxY0 = centerAnchor ? y - h / 2 : y
    // 内容盒 = 源矩形（stage 像素）：贴面时内容盒原样落到该平面上 → 形状锁定、比例不变
    const cfg = resolveLayer3D(layer3d, stage, box3d, { x: boxX0, y: boxY0, w, h })
    const tw = Math.max(1, sp.texture?.width || w)
    const th = Math.max(1, sp.texture?.height || h)
    const sx = w / tw
    const sy = h / th
    const use3d = isLayer3DActive(layer3d) && cfg.enabled

    if (!use3d) {
      const old = this.layer3dMeshes.get(clipId)
      if (old) {
        old.destroy()
        this.layer3dMeshes.delete(clipId)
      }
      sp.visible = true
      sp.alpha = opacity
      if (centerAnchor) sp.anchor.set(0.5, 0.5)
      else sp.anchor.set(0, 0)
      sp.scale.set(sx, sy)
      sp.skew.set(0, 0)
      sp.rotation = 0
      sp.position.set(x, y)
      return
    }

    // 真透视曲面：自适应细分网格（逐顶点投影，消除折痕）
    const seg = chooseGridSeg({ x: boxX0, y: boxY0, w, h }, cfg)
    const grid = planPerspectiveGrid({ x: boxX0, y: boxY0, w, h }, cfg, seg)
    let mesh = this.layer3dMeshes.get(clipId)
    const needRebuild = !mesh || mesh.texture !== sp.texture ||
      mesh.geometry.getBuffer('aPosition')?.data?.length !== grid.positions.length
    if (needRebuild) {
      if (mesh) { mesh.destroy(); this.layer3dMeshes.delete(clipId) }
      const geo = new MeshGeometry({ positions: grid.positions, uvs: grid.uvs, indices: grid.indices })
      mesh = new Mesh({ geometry: geo, texture: sp.texture })
      // 网格顶点绝不能取整到像素中心：细密格子在强透视下会被取整成退化三角形 → 画面出现裂痕
      mesh.roundPixels = false
      this.root!.addChild(mesh)
      this.layer3dMeshes.set(clipId, mesh)
    } else {
      mesh!.geometry.positions = grid.positions
      mesh!.geometry.uvs = grid.uvs
    }
    // 透视后三角形绕序可能翻转 → 必须关背面剔除，否则半幅被 culled
    try {
      mesh!.state.culling = false
    } catch { /* 忽略 */ }
    mesh!.zIndex = sp.zIndex
    mesh!.alpha = opacity
    mesh!.visible = true
    sp.visible = false
  }

  setAudioData(data: PresetAudioData | null): void {
    this._audioData = data
  }

  /**
   * 抓取当前画面（PNG dataURL）——供 E2E 预览截图/调试用。
   * ⚠ 不能直接用 `canvas.toDataURL()`：WebGL 默认不保留绘制缓冲，合成后内容已被清空（会得到空白图）。
   * 走 Pixi 的 `extract.canvas()`（内部 readPixels）才是可靠回读。
   */
  captureDataUrl(): string | null {
    try {
      if (!this.app || !this.root) return null
      const extracted = this.app.renderer.extract.canvas(this.root) as unknown as { toDataURL?: (t?: string) => string }
      if (typeof extracted?.toDataURL === 'function') return extracted.toDataURL('image/png')
      return null
    } catch (e) {
      console.warn('[PixiRenderer] 截图失败:', (e as Error)?.message)
      return null
    }
  }

  /**
   * 某 clip 当前帧的「内容盒子」（stage 像素，左上原点）——3D 附着面 HUD 用。
   * 与渲染严格同源：媒体层用渲染时记下的 mediaBox；预设层用**实际开出的画布盒**（贴面时含出血）；
   * 文本层为整幅画幅。返回 null 表示该 clip 当前帧不可见/无盒子。
   */
  layerSourceBox(clipId: string, project: Project): { x: number; y: number; w: number; h: number } | null {
    const pb = this.presetBoxes.get(clipId)
    if (pb) return { ...pb }
    const mb = this.mediaBoxes.get(clipId)
    if (mb) return { x: mb.x - mb.w / 2, y: mb.y - mb.h / 2, w: mb.w, h: mb.h }
    if (this.textLayers.has(clipId)) return { x: 0, y: 0, w: project.stage.width, h: project.stage.height }
    if (this.sprites.has(clipId)) return { x: 0, y: 0, w: project.stage.width, h: project.stage.height }
    return null
  }

  /**
   * 调整层（adjust）合成：把"本层之下"的内容渲染到 RenderTexture，再用带 BlurFilter 的精灵
   * 按"强度"叠回（sharp·(1-s) + blurred·s）——与导出端 `gaussianBlur` drawer 的语义一致。
   *
   * 参数通过内置关键帧 API `paramAt()` 求值（与 drawer 同一份逻辑）。
   */
  private applyAdjustLayer(
    l: Layer,
    meta: PresetMeta,
    layers: Layer[],
    frame: number,
    project: Project,
    fps: number
  ): void {
    if (!this.app) return
    const w = project.stage.width
    const h = project.stage.height
    const tRel = l.tRel ?? 0
    // 与导出 drawer 同一套 mapBlurRadius：大半径压缩到有效上限，避免环状伪影 / 预览导出不一致
    const radius = mapBlurRadius(paramAt(l.params, l.keyframes, 'radius', tRel, 24))
    const strength = paramAt(l.params, l.keyframes, 'strength', tRel, 1)
    const darken = numParam(l.params ?? {}, meta, 'darken')
    const saturation = numParam(l.params ?? {}, meta, 'saturation')
    const active = strength > 0.002 && (radius > 0.3 || darken > 0.001 || saturation > 0.001)

    if (!active) {
      if (this._adjustSprite) this._adjustSprite.visible = false
      return
    }

    // 资源惰性创建（尺寸随 stage 变化重建）
    if (!this._adjustRT || this._adjustRT.width !== w || this._adjustRT.height !== h) {
      this._adjustSprite?.destroy()
      this._adjustRT?.destroy(true)
      // RT 必须不透明清成黑：透明 clear 会让 BlurFilter 把「画布外/透明边」糊进画面 → 边缘渐变
      this._adjustRT = RenderTexture.create({ width: w, height: h })
      this._adjustFilter = new BlurFilter({ strength: 8, quality: 8 })
      this._adjustColor = new ColorMatrixFilter()
      this._adjustSprite = new Sprite(this._adjustRT)
      this._adjustSprite.anchor.set(0, 0)
      this.root!.addChild(this._adjustSprite)
    }
    const sprite = this._adjustSprite!
    const rt = this._adjustRT!

    // 1) 把本层之下 + 本层之后的层暂时隐藏，只把"之下"渲染进 RT
    //    （之上层若一起进 RT 会出现"模糊残影"叠在自己上面）
    const index = layers.indexOf(l)
    const above = layers.slice(index + 1).map((x) => this.displayObjectFor(x.id)).filter((o): o is Sprite | Container => !!o)
    const prevVisible = above.map((o) => o.visible)
    above.forEach((o) => { o.visible = false })
    sprite.visible = false
    try {
      // 先用不透明黑清屏，再渲染之下内容——消除透明边缘被 blur 放大的「覆盖不够/边缘渐变」
      this.app.renderer.render({
        container: this.root!,
        target: rt,
        clear: true,
        clearColor: 0x000000
      })
    } catch (e) {
      console.warn('[PixiRenderer] 调整层渲染失败:', (e as Error)?.message)
    } finally {
      above.forEach((o, i) => { o.visible = prevVisible[i] })
    }

    // 2) 模糊精灵叠回：BlurFilter(strength=有效半径) + 强度作 alpha
    //    quality 拉高，减轻大 strength 时的环状伪影
    this._adjustFilter!.strength = radius
    this._adjustFilter!.quality = radius > 16 ? 16 : radius > 8 ? 8 : 4
    this._adjustFilter!.padding = Math.min(Math.ceil(radius * 2.5), 96)
    this._adjustColor!.reset()
    if (saturation > 0.001) this._adjustColor!.saturate(saturation * 0.6, false)
    if (darken > 0.001) this._adjustColor!.brightness(1 - darken, false)
    sprite.filters = radius > 0.3
      ? (darken > 0.001 || saturation > 0.001 ? [this._adjustFilter!, this._adjustColor!] : [this._adjustFilter!])
      : (darken > 0.001 || saturation > 0.001 ? [this._adjustColor!] : [])
    sprite.texture = rt
    // 轻微 overscan：把 blur 边缘软边裁出画幅，保证整屏覆盖（约 pad/min 边长，肉眼几乎不可见）
    const over = Math.min(0.04, radius / Math.min(w, h))
    const ow = w * (1 + over * 2)
    const oh = h * (1 + over * 2)
    sprite.width = ow
    sprite.height = oh
    sprite.position.set(-(ow - w) / 2, -(oh - h) / 2)
    sprite.alpha = Math.min(1, Math.max(0, strength)) * l.opacity
    sprite.zIndex = l.z
    sprite.visible = true
    void frame
    void fps
  }

  /** 取某层的显示对象（精灵/文本容器/预设精灵） */
  private displayObjectFor(id: string): Sprite | Container | null {
    return this.sprites.get(id) ?? this.textLayers.get(id)?.root ?? null
  }

  /** 取某 src 的可用图片源（供预设 drawer 的 drawImage 使用；未就绪返回 null） */
  private presetImageSource(src: string): PresetImage | null {
    const tex = this.textureFor(src, true)
    const res = tex?.source?.resource as unknown as PresetImage | undefined
    if (!res || typeof res !== 'object') return null
    const w = Number((res as { width?: number }).width ?? 0)
    const h = Number((res as { height?: number }).height ?? 0)
    return w > 0 && h > 0 ? res : null
  }

  /**
   * 把预设层画到离屏 canvas 并返回纹理 + 该纹理覆盖的 stage 矩形。
   * 与导出走**同一个 drawer**（`presets/registry.drawPreset`），因此预览与导出像素一致；
   * 只有内容 key（帧/参数/尺寸/图片就绪）变化时才重绘，避免每帧无谓重画。
   *
   * ⚠ 画布尺寸 = `layer3DDrawBox`（贴面时比画幅大）：drawer 仍以**画幅坐标系**作画，
   *   ctx 先 translate 到画布内的画幅原点 → 超出画幅的笔触不再被 canvas 裁掉。
   */
  private renderPresetToTexture(
    l: Layer,
    meta: PresetMeta,
    frame: number,
    project: Project,
    fps: number
  ): { tex: Texture; box: { x: number; y: number; w: number; h: number } } | null {
    const w = project.stage.width
    const h = project.stage.height

    const image = l.src ? this.presetImageSource(l.src) : null
    const images = new Map<string, PresetImage>()
    for (const p of meta.params) {
      if (p.type !== 'image') continue
      const v = l.params?.[p.key]
      if (typeof v === 'string' && v) {
        const s = this.presetImageSource(v)
        if (s) images.set(v, s)
      }
    }

    // 圆形图片跟随：环形柱状图等需要；随帧/工程变化
    const followCircle = findFollowCircle(project, frame, (src) => {
      const t = this.imageTextures.get(src)
      if (t && t.width >= 1 && t.height >= 1) return { width: t.width, height: t.height }
      const el = this.videoEls.get(src)
      if (el && el.videoWidth >= 1) return { width: el.videoWidth, height: el.videoHeight }
      return null
    })
    // 跟随圆形且圆形启用 3D 时，构造「映射进圆形 3D 透视」的投影函数（内容盒 = 圆形图片盒）。
    // ⚠ 只有**真正声明了跟随**的非图片层才算跟随方：
    //   ① 圆形图片层自身也会 findFollowCircle 命中自己 → 按 src 排除，否则它自己的 3D 被误抑制；
    //   ② 效果层（高斯模糊等）也可能带 layer3d，但它不消费 followProject → 按「预设是否声明
    //      followCircle 参数」判定，避免误抑制其自身 3D。
    const declaresFollow = meta.params.some((p) => p.key === 'followCircle')
    const isFollower = !l.src && declaresFollow && boolParam(l.params ?? {}, meta, 'followCircle')
    const followProject = followCircle && isFollower
      ? followProjection(followCircle, { width: w, height: h }, project.box3d)
      : undefined
    // 记录给外层：该层 3D 已逐点施加 → 别再叠加自身 3D（缓存命中时也要更新，故放在 key 比较之前）
    if (followProject) this._followProjectActive.add(l.id)
    else this._followProjectActive.delete(l.id)

    // 本层实际生效的 3D（跟随态下自身 3D 被忽略）→ 决定画布要不要出血
    const own3d = followProject ? undefined : l.layer3d
    const box = layer3DDrawBox(own3d, project.stage, project.box3d)

    let rec = this._presetRenders.get(l.id)
    if (!rec || rec.canvas.width !== box.w || rec.canvas.height !== box.h) {
      if (rec) { try { rec.tex.destroy(true) } catch { /* 忽略 */ } }
      const canvas = document.createElement('canvas')
      canvas.width = box.w
      canvas.height = box.h
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      rec = { canvas, ctx, tex: Texture.from(canvas), key: '', originX: box.x, originY: box.y }
      this._presetRenders.set(l.id, rec)
    }
    if (rec.originX !== box.x || rec.originY !== box.y) {
      // 画布原点动了（贴面/换面/深度变化）→ 旧内容失效
      rec.originX = box.x
      rec.originY = box.y
      rec.key = ''
    }

    const key = `${l.presetId}|${JSON.stringify(l.params ?? {})}|${frame}|${w}x${h}|${box.x},${box.y},${box.w},${box.h}|${image ? 'i' : '-'}|${images.size}`
    // ⚠ 缓存 key 必须含**圆形 3D 的全部定义参数**（盒子 + 附着面）：用户改圆的 3D 面或长方体深度时
    //   x/y/radius 不变，仅含这些会让环的渲染结果被旧缓存憋住 → 环不跟随变形。故把 box + layer3d 一并入 key。
    const fcKey = followCircle
      ? `${followCircle.x.toFixed(1)},${followCircle.y.toFixed(1)},${followCircle.radius.toFixed(1)},` +
        `${followCircle.box ? `${followCircle.box.x.toFixed(1)},${followCircle.box.y.toFixed(1)},${followCircle.box.w.toFixed(1)},${followCircle.box.h.toFixed(1)}` : '-'},` +
        `${followProject ? JSON.stringify(followCircle.layer3d ?? null) : '-'},${JSON.stringify(project.box3d ?? null)}`
      : '-'
    const key2 = `${key}|fc:${fcKey}`
    if (rec.key === key2) return { tex: rec.tex, box }

    rec.ctx.setTransform(1, 0, 0, 1, 0, 0)
    rec.ctx.clearRect(0, 0, box.w, box.h)
    // drawer 以画幅坐标系作画：原点落到画布内的画幅左上角
    rec.ctx.translate(-box.x, -box.y)
    drawPreset(rec.ctx, meta, {
      width: w,
      height: h,
      frame,
      fps,
      timeSec: l.sourceFrame / (fps || 30),
      sourceFrame: l.sourceFrame,
      energy: levelAt(this._audioData, frame),
      audio: this._audioData,
      opacity: 1, // 层透明度由 sprite.alpha 施加（与导出的 alpha 相乘等价）
      image,
      images,
      keyframes: l.keyframes,
      tRel: l.tRel ?? 0,
      followCircle,
      followProject
    }, l.params)
    rec.tex.source.update()
    rec.key = key2
    return { tex: rec.tex, box }
  }

  /** 获取/复用纹理（视频返回 video 元素纹理；图片走自管缓存；GIF 返回对应帧纹理） */
  private textureFor(src: string, forceImage = false, sourceFrame = 0, gifSpeed = 1): Texture | null {
    if (!src) return null
    if (forceImage || looksLikeImage(src)) {
      // 与导出 loadImageBitmaps 同路径：fetch + createImageBitmap。
      // Assets.load 对 avn-file:// 自定义协议不稳（CORS/Image 解码），曾致「导出有图、预览全无」。
      const gif = this.gifFrames.get(src)
      if (gif && gif.length > 0) {
        // GIF 动画：时间轴帧驱动选帧（忽略 delay，按帧号直读）→ 预览 ≡ 导出
        const idx = gifFrameIndex(sourceFrame, gif.length, gifSpeed)
        return gif[idx]
      }
      const existing = this.imageTextures.get(src)
      if (existing && existing.width >= 1 && existing.height >= 1) return existing
      if (!this.imageLoading.has(src)) {
        void this.loadImage(src)
      }
      return existing && existing.width >= 1 && existing.height >= 1 ? existing : null
    }
    // 视频：复用 <video> 元素作为纹理源
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
        console.error('[PixiRenderer] video error:', src, el?.error?.code, el?.error?.message)
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

  /**
   * 异步加载图片纹理（带去重）。路径与导出 Worker 的 loadImageBitmaps 一致：
   * `fetch(src)` → blob → `createImageBitmap` → Pixi `ImageSource`/`Texture`。
   * 自定义协议 avn-file:// 已由主进程返回 ACAO:*，CSP connect-src 也放行。
   *
   * GIF 特例：`createImageBitmap` 对 GIF 只取首帧，故先嗅探是否 GIF，若是则用自研
   * `decodeGif` 解出全部帧 → 每帧一张 Texture 存 `gifFrames`，由时间轴帧驱动选帧。
   */
  private loadImage(src: string): Promise<void> {
    const cached = this.imageLoading.get(src)
    if (cached) return cached
    const p = (async () => {
      try {
        const res = await fetch(src)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        const head = new Uint8Array(await blob.slice(0, 6).arrayBuffer())
        if (isGifBytes(head)) {
          const bytes = new Uint8Array(await blob.arrayBuffer())
          const gif = decodeGif(bytes)
          if (gif && gif.frames.length > 1) {
            // 旧帧纹理回收（重导同一路径）
            const old = this.gifFrames.get(src)
            if (old) for (const t of old) { try { t.destroy(true) } catch { /* 忽略 */ } }
            const texs: Texture[] = gif.frames.map((f) => {
              const canvas = document.createElement('canvas')
              canvas.width = gif.width
              canvas.height = gif.height
              const cctx = canvas.getContext('2d')
              const imageData = new ImageData(f.data, gif.width, gif.height)
              cctx?.putImageData(imageData, 0, 0)
              const source = new ImageSource({ resource: canvas, width: gif.width, height: gif.height })
              return new Texture({ source })
            })
            this.gifFrames.set(src, texs)
            console.log(`[PixiRenderer] GIF decoded: ${gif.width}x${gif.height}, ${gif.frames.length} 帧 (时间轴帧驱动)`)
            if (this._latestProject) this.render(this._latestFrame, this._latestProject, this._latestFps)
            return
          }
          // 单帧 GIF 或解码失败 → 按静态图处理（继续走下面路径）
        }
        const bitmap = await createImageBitmap(blob)
        // 覆盖同 src 旧纹理（重导同一路径时避免泄漏）
        const prev = this.imageTextures.get(src)
        if (prev) {
          try { prev.destroy(true) } catch { /* 忽略 */ }
        }
        const source = new ImageSource({ resource: bitmap, width: bitmap.width, height: bitmap.height })
        this.imageTextures.set(src, new Texture({ source }))
      } catch (e) {
        console.error('[PixiRenderer] image load failed:', src.slice(0, 80), (e as Error)?.message)
      } finally {
        this.imageLoading.delete(src)
      }
      // 纹理就绪后立刻补一帧：否则下一 rAF 可能因「帧/工程未变且无 async」判 dirty=false，
      // 精灵停留在 visible=false（图片永不出现）。
      if (this._latestProject) {
        this.render(this._latestFrame, this._latestProject, this._latestFps)
      }
    })()
    this.imageLoading.set(src, p)
    return p
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
    // 文本层：源矩形取整幅画幅（与预设层统一语义）；行在 stage 空间按 H 逐行投影
    const cfg = resolveLayer3D(l.layer3d, project.stage, project.box3d)
    const use3d = isLayer3DActive(l.layer3d) && cfg.enabled
    const l3off = cfg
    // 层容器：未做 3D 时沿用 layout 位置/旋转；3D 时改在 stage 空间逐行投影
    if (use3d) {
      tl.root.position.set(0, 0)
      tl.root.rotation = 0
    } else {
      tl.root.position.set(tb.x, tb.y)
      tl.root.rotation = tb.rotation
    }
    tl.root.alpha = l.opacity
    const glowOn = tb.glowEnabled

    // 行池复用：holder 扛变换，Text 只改字形——高亮改 fontSize 不会冲掉 3D 矩阵
    while (tl.rows.length < Math.max(rows.length, 1)) {
      const holder = new Container()
      const main = new Text({ text: '' })
      const glow = new Text({ text: '' })
      const blur = new BlurFilter({ strength: 1 })
      glow.filters = [blur]
      glow.zIndex = 0
      main.zIndex = 1
      holder.addChild(glow)
      holder.addChild(main)
      tl.root.addChild(holder)
      tl.rows.push({ holder, main, glow, blur, glowStrength: -1 })
    }
    const slotCount = tl.rows.length
    const rot = tb.rotation
    for (let slot = 0; slot < slotCount; slot++) {
      const slotRow = tl.rows[slot]
      const datum = rows[slot] as TextRowDatum | undefined
      if (!datum) {
        slotRow.holder.visible = false
        continue
      }
      slotRow.holder.visible = true
      this.styleTextRow(slotRow.main, datum, tb)
      if (use3d) {
        // 局部 (0, d.y) 先经 2D rotateZ，再在 stage 上投影；矩阵打在 holder 上
        const lx = -datum.y * Math.sin(rot)
        const ly = datum.y * Math.cos(rot)
        const m = affineAt(tb.x + lx, tb.y + ly, l3off)
        slotRow.holder.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, m.e, m.f))
        slotRow.main.position.set(0, 0)
      } else {
        slotRow.holder.position.set(0, 0)
        slotRow.holder.scale.set(1, 1)
        slotRow.holder.skew.set(0, 0)
        slotRow.holder.rotation = 0
        // 2D：容器在歌词中心，行内偏移用 position
        slotRow.holder.position.set(0, 0)
        // 用 holder 做行偏移（与旧逻辑一致：root 在 tb 中心，行 y 相对）
        slotRow.main.position.set(0, datum.y)
      }
      if (glowOn && datum.glow > 0.01) {
        this.styleTextRow(slotRow.glow, datum, tb)
        slotRow.glow.style.fill = tb.glowColor
        const radius = datum.glow * glowRadius(datum.size)
        if (Math.abs(slotRow.glowStrength - radius) > 0.5) {
          slotRow.blur.strength = radius
          slotRow.glowStrength = radius
        }
        if (use3d) {
          slotRow.glow.position.set(0, 0)
        } else {
          slotRow.glow.position.set(0, datum.y)
        }
        slotRow.glow.visible = true
      } else {
        slotRow.glow.visible = false
      }
    }
  }

  /** 给一行 Text 套用样式、内容（位置由 applyText 决定：2D 或 layer3d 矩阵） */
  private styleTextRow(t: Text, d: TextRowDatum, tb: import('./layout').TextBox): void {
    t.text = d.text
    t.style.fill = d.color
    t.style.fontFamily = tb.fontFamily ?? 'sans-serif'
    t.style.fontSize = d.size
    t.style.fontWeight = String(d.weight) as TextStyleFontWeight
    t.style.lineHeight = (tb.lineHeight ?? 1.4) * d.size
    t.style.wordWrap = true
    t.style.wordWrapWidth = tb.wordWrapWidth
    t.style.align = tb.align
    t.anchor.set(tb.align === 'left' ? 0 : tb.align === 'right' ? 1 : 0.5, 0.5)
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
    for (const [id, mesh] of this.layer3dMeshes) {
      if (!live.has(id)) { mesh.destroy(); this.layer3dMeshes.delete(id) }
    }
    for (const [id, tl] of this.textLayers) {
      if (!live.has(id)) { tl.root.destroy(); this.textLayers.delete(id) }
    }
    for (const id of [...this.mediaBoxes.keys()]) {
      if (!live.has(id)) this.mediaBoxes.delete(id)
    }
    for (const id of [...this.presetBoxes.keys()]) {
      if (!live.has(id)) this.presetBoxes.delete(id)
    }
    // 预设层：回收离屏画布与纹理
    for (const [id, rec] of this._presetRenders) {
      if (!live.has(id)) {
        try { rec.tex.destroy(true) } catch { /* 忽略 */ }
        this._presetRenders.delete(id)
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
    for (const el of this.videoEls.values()) el.pause()
    this.videoEls.clear()
    this.videoTargetSec.clear()
    this.sprites.forEach((s) => s.destroy())
    this.sprites.clear()
    this.layer3dMeshes.forEach((m) => m.destroy())
    this.layer3dMeshes.clear()
    this.textLayers.forEach((tl) => tl.root.destroy())
    this.textLayers.clear()
    for (const rec of this._presetRenders.values()) { try { rec.tex.destroy(true) } catch { /* 忽略 */ } }
    this._presetRenders.clear()
    for (const frames of this.gifFrames.values()) {
      for (const t of frames) { try { t.destroy(true) } catch { /* 忽略 */ } }
    }
    this.gifFrames.clear()
    for (const tex of this.imageTextures.values()) { try { tex.destroy(true) } catch { /* 忽略 */ } }
    this.imageTextures.clear()
    this.imageLoading.clear()
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
