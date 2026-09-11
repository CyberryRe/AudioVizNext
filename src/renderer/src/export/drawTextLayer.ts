/**
 * drawTextLayer.ts —— 文本/歌词层的 Canvas 2D 绘制（**导出各路径共用**）。
 *
 * 抽出来的原因：导出路径可能有多条，一旦各自实现一份文字排版，就必然出现「预览 ≠ 导出」的漂移。
 * 几何与字号全部来自 `layout.resolveTextRows`（与 Pixi 预览同源）；
 * 泛用 3D（贴到长方体的某个面）走 `pixi/layer3d.ts`，与预览同一投影。
 */
import type { Clip, Project } from '../model/timeline'
import { resolveTextRows, glowRadius } from '../pixi/layout'
import { resolveLayer3D, affineAt, isLayer3DActive } from '../pixi/layer3d'

export interface TextLayerInput {
  id: string
  content: string
  sourceFrame: number
}

/**
 * 画一层文本/歌词。
 * @param ctx 目标 2D 上下文（DOM canvas 或 OffscreenCanvas 皆可）
 * @param clip 原始 clip（取 isLyrics / lyrics / layer3d 样式）
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

  const cfg = resolveLayer3D(clip?.layer3d, project.stage, project.box3d)
  const use3d = isLayer3DActive(clip?.layer3d) && cfg.enabled
  const rot = tb.rotation
  const cosR = Math.cos(rot)
  const sinR = Math.sin(rot)

  ctx.save()
  ctx.globalAlpha = tb.opacity
  if (!use3d) {
    ctx.translate(tb.x, tb.y)
    ctx.rotate(tb.rotation)
  }
  ctx.textBaseline = 'middle'
  for (const d of rows) {
    ctx.globalAlpha = d.opacity
    ctx.font = `${d.weight} ${d.size}px ${tb.fontFamily ?? 'sans-serif'}`
    ctx.fillStyle = d.color
    ctx.textAlign = tb.align
    if (tb.glowEnabled && d.glow > 0.01) {
      ctx.shadowColor = tb.glowColor
      ctx.shadowBlur = d.glow * glowRadius(d.size)
    } else {
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
    }
    if (use3d) {
      const lx = -d.y * sinR
      const ly = d.y * cosR
      const m = affineAt(tb.x + lx, tb.y + ly, cfg)
      ctx.save()
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f)
      ctx.fillText(d.text || ' ', 0, 0)
      ctx.restore()
    } else {
      ctx.fillText(d.text || ' ', 0, d.y)
    }
  }
  ctx.restore()
}
