/**
 * drawTextLayer.ts —— 文本/歌词层的 Canvas 2D 绘制（**导出各路径共用**）。
 *
 * 抽出来的原因：导出路径可能有多条（当前 ffmpeg/WebCodecs 路径、以及接入 mediabunny 的新路径），
 * 一旦各自实现一份文字排版，就必然出现「预览 ≠ 导出」的漂移。这里只保留一份实现，
 * 几何与字号全部来自 `layout.resolveTextRows`（与 Pixi 预览同源）。
 */
import type { Clip, Project } from '../model/timeline'
import { resolveTextRows, glowRadius } from '../pixi/layout'

export interface TextLayerInput {
  id: string
  content: string
  sourceFrame: number
}

/**
 * 画一层文本/歌词。
 * @param ctx 目标 2D 上下文（DOM canvas 或 OffscreenCanvas 皆可）
 * @param clip 原始 clip（取 isLyrics / lyrics 样式；缺失时按普通文本）
 */
export function drawTextLayer(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  clip: Clip | undefined,
  layer: TextLayerInput,
  fps: number,
  project: Project
): void {
  const { text: tb, rows } = resolveTextRows(
    !!clip?.isLyrics,
    layer.content,
    layer.sourceFrame,
    fps,
    clip?.lyrics,
    project
  )

  ctx.save()
  ctx.globalAlpha = tb.opacity
  ctx.translate(tb.x, tb.y)
  ctx.rotate(tb.rotation)
  ctx.textBaseline = 'middle'
  for (const d of rows) {
    ctx.globalAlpha = d.opacity
    ctx.font = `${d.weight} ${d.size}px ${tb.fontFamily ?? 'sans-serif'}`
    ctx.fillStyle = d.color
    // Pixi 里 Text.anchor.x = left→0 / center→0.5 / right→1 且 position.x=0，
    // 等价于 Canvas textAlign + fillText(x=0)（相对容器中心的坐标系）。
    ctx.textAlign = tb.align
    if (tb.glowEnabled && d.glow > 0.01) {
      ctx.shadowColor = tb.glowColor
      ctx.shadowBlur = d.glow * glowRadius(d.size)
    } else {
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
    }
    ctx.fillText(d.text || ' ', 0, d.y)
  }
  ctx.restore()
}
