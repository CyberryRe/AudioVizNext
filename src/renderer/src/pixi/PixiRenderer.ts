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
import { resolveTimeline, parseLrc, lrcLineAt } from '../model/timeline'
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

export class PixiRenderer {
  private app: Application | null = null
  private root: Container | null = null
  private canvasHost: HTMLElement | null = null

  // 精灵池：key = clip id，避免频繁创建/销毁
  private sprites = new Map<string, Sprite>()
  // 文本层：key = clip id → Container（含主文本 + 可选辉光副本）。Container 负责位置/Z旋转/透明度，子 Text 负责样式与内容
  private textLayers = new Map<string, { root: Container; main: Text; glow: Text | null; blur: BlurFilter | null; glowStrength: number }>()
  // 视频元素缓存：key = src → 复用同一 <video> 做纹理源
  private videoEls = new Map<string, HTMLVideoElement>()
  // 图片异步加载去重：key = img:src → Promise
  private imageLoading = new Map<string, Promise<unknown>>()
  // 当前是否已挂载 canvas
  private mounted = false

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

    // 汇聚所有可视层并排序（zIndex 决定层级）
    const layers: Layer[] = [
      ...scene.videos.map((v) => this.toLayer(v)),
      ...scene.images.map((i) => this.toLayer(i)),
      ...scene.texts.map((t) => this.toLayer(t, true))
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
        const tex = this.textureFor(l.src)
        if (tex && sp.texture !== tex) sp.texture = tex
        if (sp.texture?.valid) {
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
          // 视频定位到当前源帧
          this.seekVideo(l.src, l.sourceFrame, fps)
        }
        // 移除残留文本（若曾是该 id 的文本层）
        this.releaseText(l.id, liveIds)
      } else {
        // 文本层（歌词/文字）：Container(位置/旋转/透明) + 主 Text + 可选辉光 Text
        let tl = this.textLayers.get(l.id)
        if (!tl) {
          const root = new Container()
          const main = new Text({ text: '' })
          const glow = new Text({ text: '' })
          root.addChild(glow)
          root.addChild(main)
          tl = { root, main, glow, blur: null, glowStrength: -1 }
          this.textLayers.set(l.id, tl)
          this.root.addChild(root)
        }
        this.applyText(tl, l, project, fps)
        // 移除残留精灵
        this.releaseSprite(l.id, liveIds)
      }
    }

    // 回收不再活跃的层
    this.retire(liveIds)

    this.app.render()
  }

  /** 将 Clip 抽象为 Layer */
  private toLayer(c: ActiveVideoClip | ActiveImageClip | ActiveTextClip, isText = false): Layer | null {
    if (c.type === 'text') {
      return {
        id: c.id, isLyric: true, z: c.zIndex, src: '', opacity: c.opacity,
        sourceFrame: c.sourceFrame, content: c.content, transform: undefined
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
      el.preload = 'metadata'
      el.playsInline = true
      this.videoEls.set(src, el)
    }
    if (el.readyState === 0) el.load()
    // 必须等有实际帧数据（HAVE_CURRENT_DATA, readyState>=2）才返回纹理；
    // 仅元数据(readyState=1)时视频尺寸已可读，但像素数据未就绪，WebGL 拷贝会
    // GL_INVALID_OPERATION: destination level must be defined。
    if (el.readyState < 2 || !el.videoWidth || !el.videoHeight) return null
    const tex = Texture.from(el)
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

  /** 定位视频源帧（非播放时用于精确 seek） */
  private seekVideo(src: string, sourceFrame: number, fps: number): void {
    const el = this.videoEls.get(src)
    if (!el) return
    const target = sourceFrame / fps
    if (Math.abs(el.currentTime - target) > 0.06) el.currentTime = target
  }

  /** 应用文本样式与内容（歌词解析当前句）。辉光用模糊副本实现（近似 CSS text-shadow glow）。 */
  private applyText(
    tl: { root: Container; main: Text; glow: Text | null; blur: BlurFilter | null; glowStrength: number },
    l: Layer,
    project: Project,
    fps: number
  ): void {
    const s = l.lyrics
    const fontSize = (s?.fontSize ?? 48) * (s?.scale ?? 1)
    // 歌词：取当前句；普通文本：取 content
    let text = l.content
    if (l.isLyric) {
      const lines = parseLrc(l.content)
      const sec = l.sourceFrame / fps
      text = lrcLineAt(lines, sec)
    }
    const display = text || ' '

    const applyStyle = (t: Text): void => {
      t.text = display
      t.style.fill = s?.color ?? '#ffffff'
      t.style.fontFamily = s?.fontFamily ?? 'sans-serif'
      t.style.fontSize = fontSize
      t.style.fontWeight = 700
      t.style.lineHeight = fontSize * 1.4
      t.style.wordWrap = true
      t.style.wordWrapWidth = project.stage.width * 0.9
      t.style.align = s?.align ?? 'center'
      // 对齐锚点：左=左缘，右=右缘，中=中心
      const align = s?.align ?? 'center'
      t.anchor.set(align === 'left' ? 0 : align === 'right' ? 1 : 0.5, 0.5)
    }
    applyStyle(tl.main)

    // 辉光：模糊 + 辉光色的副本叠在底层（复用 blur 过滤器，避免每帧重建）
    const glowOn = s?.glowEnabled ?? true
    if (glowOn) {
      if (!tl.glow) { tl.glow = new Text({ text: '' }); tl.root.addChildAt(tl.glow, 0) }
      const g = tl.glow
      applyStyle(g)
      g.style.fill = s?.glowColor ?? '#00e5ff'
      const strength = Math.max(6, fontSize * 0.12)
      if (!tl.blur) { tl.blur = new BlurFilter({ strength }); g.filters = [tl.blur] }
      else if (Math.abs(tl.glowStrength - strength) > 0.5) { tl.blur.strength = strength }
      tl.glowStrength = strength
      g.visible = true
    } else if (tl.glow) {
      tl.glow.visible = false
    }

    // 位置：画幅中心 + 偏移
    const lx = (s?.x ?? 0) * project.stage.width
    const ly = (s?.y ?? 0) * project.stage.height
    tl.root.position.set(project.stage.width / 2 + lx, project.stage.height / 2 + ly)
    tl.root.alpha = l.opacity
    // Z 轴旋转（Pixi 原生 rotation = 平面旋转）；X/Y 轴 3D 旋转暂不支持（需自研透视投影，Phase B）
    tl.root.rotation = ((s?.rotateZ ?? 0) * Math.PI) / 180
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
