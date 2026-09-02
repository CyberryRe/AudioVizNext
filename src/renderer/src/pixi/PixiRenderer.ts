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
import { Application, Container, Sprite, Text, Assets, Texture, BlurFilter } from 'pixi.js'
// CSP 不允许 unsafe-eval 时，需引入 unsafe-eval 模块做 side-effect：
// 它覆盖渲染器的 _unsafeEvalCheck 并用避免 eval 的 polyfill 替代（Electron/Chrome 扩展等严格 CSP 环境）
import 'pixi.js/unsafe-eval'
import type { Project } from '../model/timeline'
import { resolveTimeline, parseLrc, lrcIndexAt, lrcGlide, mixColor } from '../model/timeline'
import type { ActiveVideoClip, ActiveImageClip, ActiveTextClip, LyricStyle } from '../model/timeline'

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

// karaoke 滚动窗口：当前行前后各 2 行
const KARAOKE_WINDOW = 2
// 一行最多复用槽位（2*2+1）
const MAX_ROWS = KARAOKE_WINDOW * 2 + 1

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
  // 当前是否已挂载 canvas
  private mounted = false

  // —— 连续渲染循环（Pixi 视频纹理依赖：视频元素就绪是异步事件，React 帧不变就不会调 render，
  //    导致视频 canplay 后永远不被拉进纹理。故内部跑 rAF 持续渲染，保证异步媒体出现/纹理刷新）。 ——
  private _raf = 0
  private _running = false
  private _latestFrame = 0
  private _latestProject: Project | null = null
  private _latestFps = 30
  // 时间轴是否正在播放（决定视频元素：播放时自由前进、暂停时精确停帧跟随）
  private _playing = false

  constructor(private host: HTMLElement) {
    this.canvasHost = host
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
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2)
    })
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
      const dirty = this._latestFrame !== lastPaintedFrame || this._hasAsyncWork()
      // 帧变化或有异步媒体(视频纹理/图片加载)待处理时才真正渲染；否则静默省 CPU
      if (dirty) {
        this.render(this._latestFrame, this._latestProject, this._latestFps)
        lastPaintedFrame = this._latestFrame
      }
      this._raf = requestAnimationFrame(loop)
    }
    this._raf = requestAnimationFrame(loop)
  }

  /** 是否有异步待处理工作（视频未就绪/正在 seek/在播、图片加载中）——决定是否需要持续渲染等待媒体落定 */
  private _hasAsyncWork(): boolean {
    for (const el of this.videoEls.values()) {
      // 仍在加载 → 就绪后需立即拉进纹理
      if (el.readyState < 2) return true
      // 正在 seek（暂停停帧/播放校准时）→ seek 完成前需持续渲染以抓取目标帧
      if (el.seeking) return true
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

  /** 适配：canvas 尺寸跟随画幅真实分辨率；外部用 CSS objectFit 缩放显示 */
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
      ...scene.texts.map((t) => this.toLayer(t, clipMap))
    ].filter((l): l is Layer => !!l)
    layers.sort((a, b) => a.z - b.z)

    // 需要保留的 id 集合，用于回收已消失的层
    const liveIds = new Set<string>()

    for (const l of layers) {
      liveIds.add(l.id)
      if (l.src) {
        // 媒体层（视频/图片）
        let sp = this.sprites.get(l.id)
        if (!sp) {
          sp = new Sprite()
          this.sprites.set(l.id, sp)
          this.root.addChild(sp)
        }
        const isVideo = this.videoEls.has(l.src)
        // 视频帧同步：把视频元素当作时间轴的"奴隶"，跟随目标源秒（帧→秒映射见 syncVideo 注释），
        // 绝不让它脱离时间轴自行循环播放。
        if (isVideo) this.syncVideo(l.src, l.sourceFrame, fps)
        const tex = this.textureFor(l.src)
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
          // 视频/图片适配画幅：contain（完整显示，不被遮罩裁剪），缩放补满画幅
          const sw = sp.texture.width, sh = sp.texture.height
          const scale = Math.max(project.stage.width / sw, project.stage.height / sh)
          const sx = (l.transform?.scaleX ?? 1)
          const sy = (l.transform?.scaleY ?? 1)
          const dx = (l.transform?.x ?? 0) * project.stage.width
          const dy = (l.transform?.y ?? 0) * project.stage.height
          sp.width = sw * scale * sx
          sp.height = sh * scale * sy
          sp.anchor.set(0.5)
          sp.position.set(project.stage.width / 2 + dx, project.stage.height / 2 + dy)
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
        tl.isLyric = l.isLyric
        this.applyText(tl, l, project, fps)
        // 移除残留精灵
        this.releaseSprite(l.id, liveIds)
      }
    }

    // 回收不再活跃的层
    this.retire(liveIds)

    this.app.render()
  }

  /** 将 Clip 抽象为 Layer（回查原始 clip 拿 isLyrics/lyrics 样式） */
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
    const low = src.toLowerCase()
    if (/\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/.test(low) || src.startsWith('data:image')) {
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
    let el = this.videoEls.get(src)
    if (!el) {
      el = document.createElement('video')
      el.src = src
      el.muted = true
      el.loop = true
      el.preload = 'auto'
      el.playsInline = true
      // 注意：不加 crossOrigin——avn-file:// 是自定义协议，CORS 模式反而会让视频加载失败
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
      // （metadata 已到但 VideoSource 异步初始化未完成），会缓存一张 width=0 的坏纹理，
      // 之后永远命中它导致画面不出现。因此先取缓存，发现 width<1 且元素本身已就绪时，
      // 销毁坏缓存并以 skipCache 强制重建一张新纹理。
      tex = Texture.from(el)
      if (tex && (tex.width < 1 || tex.height < 1) && el.videoWidth >= 1 && el.videoHeight >= 1) {
        // 源 resize 事件应已使纹理更新；此处兜底：销毁缓存坏纹理并重建
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
    // 元数据/首帧尚未就绪：sync 不 seek，textureFor 内的 play 兜底会拉起 readyState 到可解码。
    if (el.readyState < 2) return
    const diff = Math.abs(el.currentTime - target)
    if (this._playing) {
      // 播放态：前进；仅明显漂移/跳帧时 seek 校准
      if (el.paused) el.play().catch(() => {})
      if (diff > 0.25) el.currentTime = target
    } else {
      // 暂停态：钉帧，禁止自行前进
      if (!el.paused) el.pause()
      if (diff > 1 / 60) el.currentTime = target
    }
  }

  /**
   * 应用文本样式与内容。
   * - 歌词 clip：karaoke 滚动渲染（当前句居中高亮、前后句跟随，0.4s 平滑让位，切句零跳变），
   *   对齐 AudioViz Studio LyricsLayout（lrcGlide 浮动行位置 + 每行按 glide 插值 字号/颜色/透明度/辉光）。
   * - 普通文本 clip：单行居中。
   * 辉光用模糊副本实现（近似 CSS text-shadow glow）。
   */
  private applyText(tl: TextLayer, l: Layer, project: Project, fps: number): void {
    const s = l.lyrics
    const baseFontSize = (s?.fontSize ?? 48) * (s?.scale ?? 1)
    const align = s?.align ?? 'center'
    const glowOn = s?.glowEnabled ?? true
    const glowColor = s?.glowColor ?? '#00e5ff'
    const mainColor = s?.color ?? '#ffffff'
    // 位置：画幅中心 + 偏移
    const lx = (s?.x ?? 0) * project.stage.width
    const ly = (s?.y ?? 0) * project.stage.height
    tl.root.position.set(project.stage.width / 2 + lx, project.stage.height / 2 + ly)
    tl.root.alpha = l.opacity
    tl.root.rotation = ((s?.rotateZ ?? 0) * Math.PI) / 180

    // 窗口内的行渲染数据：{ index, text, size, color, weight, opacity, glowStrength, y }
    type RowDatum = {
      i: number
      text: string
      size: number
      color: string
      weight: number
      opacity: number
      glow: number // 辉光强度 0..1
      y: number
    }
    let rows: RowDatum[] = []

    if (l.isLyric) {
      // ── karaoke 滚动歌词 ──
      const lines = parseLrc(l.content)
      const sec = l.sourceFrame / fps
      const pos = lrcGlide(lines, sec) // 浮动行位置 = idx + eased
      const cur = lrcIndexAt(lines, sec)
      if (lines.length > 0 && cur >= 0) {
        const glide = Math.max(0, Math.min(1, pos - cur))
        // 行布局参数（对齐 AudioViz Studio）：当前行高亮放大 1.2×，暗行白 45%，行距 1.6×
        const highlightScale = 1.2
        const dimColor = 'rgba(255,255,255,0.45)'
        const spacing = baseFontSize * 1.6
        const start = Math.max(0, cur - KARAOKE_WINDOW)
        const end = Math.min(lines.length - 1, cur + KARAOKE_WINDOW)
        for (let i = start; i <= end; i++) {
          const line = lines[i]
          const t = Math.max(0, 1 - Math.abs(i - pos))
          const isCurrent = i === cur
          const isIncoming = i === cur + 1 && glide > 0
          const hl = isCurrent ? (1 - glide) : (isIncoming ? glide : 0)
          const size = baseFontSize * (0.62 + t * 0.38) * (1 + hl * (highlightScale - 1))
          const y = (i - pos) * spacing
          const color = isCurrent ? mixColor(mainColor, dimColor, glide)
            : isIncoming ? mixColor(dimColor, mainColor, glide)
            : dimColor
          const weight = t > 0.5 ? 700 : 400
          const opacity = isCurrent ? (1 - 0.75 * glide)
            : isIncoming ? (0.25 + 0.75 * glide)
            : (0.25 + t * 0.25)
          // 辉光强度：仅当前/目标行随 hl 增强，其余无辉光（只留暗影由主文本承担）
          const glow = (isCurrent || isIncoming) ? hl : 0
          rows.push({ i, text: line.text || ' ', size, color, weight, opacity, glow, y })
        }
      }
    } else {
      // ── 普通文本 clip：单行 ──
      rows.push({
        i: 0,
        text: l.content || ' ',
        size: baseFontSize,
        color: mainColor,
        weight: 700,
        opacity: 1,
        glow: 1,
        y: 0
      })
    }

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
      const datum = rows[slot]
      if (!datum) {
        slotRow.main.visible = false
        slotRow.glow.visible = false
        continue
      }
      slotRow.main.visible = true
      this.styleTextRow(slotRow.main, datum, align, project, s?.fontFamily, s?.lineHeight)
      // 辉光层（模糊副本）：强度 >0.01 才显示
      if (glowOn && datum.glow > 0.01) {
        this.styleTextRow(slotRow.glow, datum, align, project, s?.fontFamily, s?.lineHeight)
        slotRow.glow.style.fill = glowColor
        const radius = datum.glow * this.glowR(datum.size)
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

  /** 计算辉光半径（对齐 DOM 两圈大辉光的折中）：当前行大字强辉光，暗行弱 */
  private glowR(size: number): number {
    return Math.max(4, size * 0.45)
  }

  /** 给一行 Text 套用样式、内容、位置 */
  private styleTextRow(
    t: Text,
    d: { text: string; size: number; color: string; weight: number; opacity: number; y: number },
    align: string,
    project: Project,
    fontFamily?: string,
    lineHeight?: number
  ): void {
    t.text = d.text
    t.style.fill = d.color
    t.style.fontFamily = fontFamily ?? 'sans-serif'
    t.style.fontSize = d.size
    t.style.fontWeight = d.weight
    t.style.lineHeight = (lineHeight ?? 1.4) * d.size
    t.style.wordWrap = true
    t.style.wordWrapWidth = project.stage.width * 0.9
    t.style.align = align
    // 对齐锚点：左=左缘，右=右缘，中=中心
    t.anchor.set(align === 'left' ? 0 : align === 'right' ? 1 : 0.5, 0.5)
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
  }

  /** 销毁并清理 */
  destroy(): void {
    this.stop()
    for (const el of this.videoEls.values()) el.pause()
    this.videoEls.clear()
    this.sprites.forEach((s) => s.destroy())
    this.sprites.clear()
    this.textLayers.forEach((tl) => tl.root.destroy())
    this.textLayers.clear()
    if (this.app) {
      this.app.destroy(true)
      this.app = null
      this.root = null
      this.mounted = false
    }
  }

  get isMounted(): boolean {
    return this.mounted
  }
}
