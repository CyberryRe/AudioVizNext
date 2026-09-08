/**
 * drawers/imageShape.ts —— 图片类预设的内置绘制器（圆角矩形 / 圆形 / 贴纸）。
 *
 * 三种样式共用一套几何：图片按"铺满画框高"得到基础尺寸，再乘用户缩放、按 posX/posY 偏移，
 * 与 `layout.mediaBox` 的口径一致（保证「预览 ≡ 导出」，且与视频/图片 clip 的观感一致）。
 * 具体形状由 `shape` 参数切换，参数来自 preset.json 的 schema。
 */
import { num, str, bool, type PresetCtx, type PresetMeta, type PresetRenderEnv } from '../types'

/** 图片铺满画框高 → 基础矩形（与 layout.mediaBox 同口径） */
function baseBox(imgW: number, imgH: number, env: PresetRenderEnv, sx: number, sy: number, px: number, py: number) {
  const scaleH = env.height / (imgH || 1)
  const w = imgW * scaleH * sx
  const h = env.height * sy
  const x = env.width / 2 + px * env.width
  const y = env.height / 2 + py * env.height
  return { x, y, w, h }
}

function roundRectPath(ctx: PresetCtx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

export function drawImageShape(
  ctx: PresetCtx,
  env: PresetRenderEnv,
  params: Record<string, unknown>,
  meta: PresetMeta
): void {
  const img = env.image
  if (!img || img.width < 1 || img.height < 1) return

  const shape = str(params, meta, 'shape') || 'sticker'
  const px = num(params, meta, 'posX')
  const py = num(params, meta, 'posY')
  const sx = num(params, meta, 'scaleX')
  const sy = num(params, meta, 'scaleY')
  const box = baseBox(img.width, img.height, env, sx, sy, px, py)

  ctx.save()
  ctx.globalAlpha = env.opacity

  if (shape === 'rounded-rect') {
    const r = num(params, meta, 'radius') * Math.min(box.w, box.h)
    ctx.save()
    roundRectPath(ctx, box.x - box.w / 2, box.y - box.h / 2, box.w, box.h, r)
    ctx.clip()
    ctx.drawImage(img, box.x - box.w / 2, box.y - box.h / 2, box.w, box.h)
    ctx.restore()
    const bw = num(params, meta, 'border') * Math.min(box.w, box.h)
    if (bw > 0.5) {
      ctx.save()
      ctx.strokeStyle = str(params, meta, 'borderColor') || '#ffffff'
      ctx.lineWidth = bw
      roundRectPath(ctx, box.x - box.w / 2 + bw / 2, box.y - box.h / 2 + bw / 2, box.w - bw, box.h - bw, Math.max(0, r - bw / 2))
      ctx.stroke()
      ctx.restore()
    }
  } else if (shape === 'circle') {
    const radius = Math.min(box.w, box.h) / 2
    const spinDeg = num(params, meta, 'spin') * 360 * env.timeSec
    const spinImage = bool(params, meta, 'spinImage')

    // 图片本体（圆形裁切）
    ctx.save()
    ctx.beginPath()
    ctx.arc(box.x, box.y, radius, 0, Math.PI * 2)
    ctx.clip()
    if (spinImage) {
      ctx.translate(box.x, box.y)
      ctx.rotate((spinDeg * Math.PI) / 180)
      ctx.translate(-box.x, -box.y)
    }
    ctx.drawImage(img, box.x - box.w / 2, box.y - box.h / 2, box.w, box.h)
    ctx.restore()

    // 边框（纹理 or 纯色描边）
    const bw = num(params, meta, 'borderWidth') * radius
    if (bw > 0.5) {
      const texSrc = str(params, meta, 'borderTexture')
      const tex = texSrc ? env.images?.get(texSrc) : undefined
      if (tex) {
        // 环形裁切：外圆顺时针 + 内圆逆时针 → 只保留环带
        const rOuter = radius
        const rInner = Math.max(0, radius - bw)
        ctx.save()
        ctx.beginPath()
        ctx.arc(box.x, box.y, rOuter, 0, Math.PI * 2)
        ctx.arc(box.x, box.y, rInner, 0, Math.PI * 2, true)
        ctx.clip()
        // 纹理按外接正方形铺满，并随 spin 旋转
        ctx.translate(box.x, box.y)
        ctx.rotate((spinDeg * Math.PI) / 180)
        ctx.drawImage(tex, -rOuter, -rOuter, rOuter * 2, rOuter * 2)
        ctx.restore()
      } else {
        ctx.save()
        ctx.beginPath()
        ctx.arc(box.x, box.y, radius - bw / 2, 0, Math.PI * 2)
        ctx.strokeStyle = str(params, meta, 'borderColor') || '#8fe9ff'
        ctx.lineWidth = bw
        ctx.stroke()
        ctx.restore()
      }
    }
  } else {
    // 贴纸：保留 PNG 透明通道，静态旋转 + 可选投影
    const rot = (num(params, meta, 'rotation') * Math.PI) / 180
    const shadow = num(params, meta, 'shadow')
    ctx.save()
    ctx.translate(box.x, box.y)
    if (rot !== 0) ctx.rotate(rot)
    if (shadow > 0.01) {
      ctx.shadowColor = str(params, meta, 'shadowColor') || '#000000'
      ctx.shadowBlur = shadow * Math.min(box.w, box.h) * 0.12
      ctx.shadowOffsetY = shadow * Math.min(box.w, box.h) * 0.04
    }
    ctx.drawImage(img, -box.w / 2, -box.h / 2, box.w, box.h)
    ctx.restore()
  }

  ctx.restore()
}
