/**
 * canvas2dRenderer.ts —— 导出专用 Canvas 2D 渲染器（参考 elah 的 ExportWorker 思路）。
 *
 * 为什么不用 Pixi(WebGL) 做导出：
 *   Pixi 路径每帧要做「解码帧 → new Texture 上传 GPU → extract 回读」两趟 GPU 往返，
 *   既慢，又和 WebCodecs 硬解/NVENC 抢同一块 GPU，是导出慢 + GPU TDR 崩溃的元凶。
 *   改在 2D canvas 上直接 drawImage/drawText，几何与文本排版仍复用 layout.ts
 *   （mediaBox / resolveTextRows），保证「导出 = 预览」像素一致（media 无旋转，文本按 rotateZ）。
 *
 * 已知简化：2D fillText 无 Pixi 的 wordWrapWidth 自动换行（歌词/短文本不受影响；超长普通
 * 文本会有单行超宽差异）。后续如需可在 drawText 里用 measureText 补手动换行。
 */
import type { Project, Clip } from '../model/timeline'
import { resolveTimeline } from '../model/timeline'
import { mediaBox, resolveTextRows, glowRadius } from '../pixi/layout'
import { effectiveVideoSrc } from '../pixi/mediaProxy'
import type { DecodeSourceManager, DecodeSession } from '../pixi/h264/decodeSources'

type Scene = ReturnType<typeof resolveTimeline>
type MediaTransform = { x?: number; y?: number; scaleX?: number; scaleY?: number }

type Layer =
  | { kind: 'video' | 'image'; src: string; opacity: number; transform?: MediaTransform; sourceFrame: number; z: number }
  | { kind: 'text'; id: string; content: string; sourceFrame: number; z: number }

/** 预载工程里所有图片素材为 ImageBitmap（同 elah：素材一次性打开，逐帧复用）。 */
export async function loadImageBitmaps(project: Project): Promise<Map<string, ImageBitmap>> {
  const srcs = new Set<string>()
  for (const track of project.tracks) {
    for (const c of project.clips[track.id] ?? []) {
      if (c.type === 'image' && c.src) srcs.add(c.src)
    }
  }
  const map = new Map<string, ImageBitmap>()
  for (const src of srcs) {
    try {
      const res = await fetch(src)
      if (!res.ok) {
        console.warn('[Export] image fetch failed:', src, res.status)
        continue
      }
      const bmp = await createImageBitmap(await res.blob())
      map.set(src, bmp)
    } catch (e) {
      console.warn('[Export] image decode failed:', src, (e as Error)?.message)
    }
  }
  return map
}

export class Canvas2DExportRenderer {
  private clipMap = new Map<string, Clip>()

  constructor(
    private ctx: CanvasRenderingContext2D,
    private project: Project,
    private fps: number,
    private decodeMgr: DecodeSourceManager,
    private images: Map<string, ImageBitmap>
  ) {
    for (const clips of Object.values(project.clips)) {
      for (const c of clips) this.clipMap.set(c.id, c)
    }
  }

  /** 把工程 sourceFrame 映射到源 AU（含循环回绕取模）。 */
  private auFor(session: DecodeSession, sourceFrame: number): number {
    let au = this.decodeMgr.auForFrame(session, sourceFrame, this.fps)
    const nAus = session.provider.auCount
    if (nAus > 0 && au >= nAus) au = au % nAus
    return au
  }

  /** 推进并等待本帧所有视频层的解码目标（等价 Pixi captureFrame 阶段零：先 await 再画）。 */
  private async awaitVideo(scene: Scene): Promise<void> {
    const waits: Promise<void>[] = []
    for (const v of scene.videos) {
      const session = this.decodeMgr.sessionForSrc(effectiveVideoSrc(v.src))
      if (!session || session.provider.status !== 'ready') continue
      const au = this.auFor(session, v.sourceFrame)
      session.provider.setPlayhead(au)
      waits.push(session.provider.awaitUntil(au, 1500).catch(() => {}))
    }
    await Promise.all(waits)
  }

  /** 渲染一帧到 ctx。 */
  async render(frame: number): Promise<void> {
    const scene = resolveTimeline(frame, this.project)
    const W = this.project.stage.width
    const H = this.project.stage.height

    await this.awaitVideo(scene)

    // 不透明黑底（标准合成语义：透明区落黑）
    this.ctx.fillStyle = '#000000'
    this.ctx.fillRect(0, 0, W, H)

    const layers: Layer[] = [
      ...scene.videos.map((v) => ({ kind: 'video' as const, src: v.src, opacity: v.opacity, transform: v.transform, sourceFrame: v.sourceFrame, z: v.zIndex })),
      ...scene.images.map((i) => ({ kind: 'image' as const, src: i.src, opacity: i.opacity, transform: i.transform, sourceFrame: i.sourceFrame, z: i.zIndex })),
      ...scene.texts.map((t) => ({ kind: 'text' as const, id: t.id, content: t.content, sourceFrame: t.sourceFrame, z: t.zIndex }))
    ].sort((a, b) => a.z - b.z)

    for (const l of layers) {
      if (l.kind === 'video') {
        const bmp = this.videoBitmap(l)
        if (bmp) this.drawMedia(bmp, l.opacity, l.transform, W, H)
      } else if (l.kind === 'image') {
        const bmp = this.images.get(l.src)
        if (bmp) this.drawMedia(bmp, l.opacity, l.transform, W, H)
      } else {
        this.drawText(l)
      }
    }
  }

  private videoBitmap(l: { src: string; sourceFrame: number }): ImageBitmap | null {
    const session = this.decodeMgr.sessionForSrc(effectiveVideoSrc(l.src))
    if (!session || session.provider.status !== 'ready') return null
    const au = this.auFor(session, l.sourceFrame)
    return session.provider.current(au)?.bitmap ?? null
  }

  private drawMedia(src: ImageBitmap, opacity: number, transform: MediaTransform | undefined, W: number, H: number): void {
    const rect = mediaBox(src.width, src.height, transform, { width: W, height: H })
    this.ctx.save()
    this.ctx.globalAlpha = opacity
    // mediaBox 返回锚点 0.5 的中心坐标 + 已含缩放的宽高；预览媒体不旋转，故按中心放置
    this.ctx.drawImage(src, rect.x - rect.width / 2, rect.y - rect.height / 2, rect.width, rect.height)
    this.ctx.restore()
  }

  private drawText(l: { id: string; content: string; sourceFrame: number }): void {
    const raw = this.clipMap.get(l.id)
    const { text: tb, rows } = resolveTextRows(
      !!raw?.isLyrics,
      l.content,
      l.sourceFrame,
      this.fps,
      raw?.lyrics,
      this.project
    )

    this.ctx.save()
    this.ctx.globalAlpha = tb.opacity
    this.ctx.translate(tb.x, tb.y)
    this.ctx.rotate(tb.rotation)
    this.ctx.textBaseline = 'middle'
    for (const d of rows) {
      this.ctx.globalAlpha = d.opacity
      this.ctx.font = `${d.weight} ${d.size}px ${tb.fontFamily ?? 'sans-serif'}`
      this.ctx.fillStyle = d.color
      // Pixi 里 Text.anchor.x = left→0 / center→0.5 / right→1 且 position.x=0，
      // 等价于 Canvas textAlign + fillText(x=0)（相对容器中心的坐标系）。
      this.ctx.textAlign = tb.align
      if (tb.glowEnabled && d.glow > 0.01) {
        this.ctx.shadowColor = tb.glowColor
        this.ctx.shadowBlur = d.glow * glowRadius(d.size)
      } else {
        this.ctx.shadowColor = 'transparent'
        this.ctx.shadowBlur = 0
      }
      this.ctx.fillText(d.text || ' ', 0, d.y)
    }
    this.ctx.restore()
  }
}
