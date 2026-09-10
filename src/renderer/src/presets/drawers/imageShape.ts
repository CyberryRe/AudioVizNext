/**
 * drawers/imageShape.ts —— 图片类预设的内置绘制器（圆角矩形 / 圆形 / 贴纸）。
 *
 * 圆形边框样式：
 *   - vinyl（黑胶）：程序化同心沟槽 + 反光，无需外部贴图
 *   - color-vinyl（彩胶）：同上，但底色用可编辑渐变（线性角度 / 径向 + 多色标）
 *   - solid / texture / none：纯色描边 / 自定义图片纹理 / 无边框
 *
 * 旋转语义（默认唱片感）：
 *   - **图片**始终随 `spin` 旋转（唱片在转）
 *   - **边框**默认不转；`spinBorder=true` 时才跟随（旧 spinImage 的反义）
 */
import {
  num, str, bool, gradient, paintGradient,
  type GradientValue, type PresetCtx, type PresetMeta, type PresetRenderEnv
} from '../types'

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

/** 环带路径：外圆 + 内圆孔洞。⚠ 必须 moveTo 再画内圆，否则两段 arc 会连成实心扇形把内外都填上 */
function ringPath(ctx: PresetCtx, cx: number, cy: number, rOuter: number, rInner: number): void {
  ctx.beginPath()
  ctx.arc(cx, cy, rOuter, 0, Math.PI * 2)
  if (rInner > 0.5) {
    ctx.moveTo(cx + rInner, cy)
    ctx.arc(cx, cy, rInner, 0, Math.PI * 2, true)
  }
}

/**
 * 程序化唱片环：底色/渐变 + 同心沟槽 + 高光弧。
 * 纯 Canvas2D，预览（含 Offscreen 导出）共用，确定性（沟槽相位不依赖随机）。
 */
function drawVinylRing(
  ctx: PresetCtx,
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  opts: {
    fill: string | CanvasGradient
    groove: number
    sheen: number
    /** 高光起始角（弧度）。高光**不跟**唱片转，固定在光源侧 */
    sheenAngle: number
    /** 渐变底色旋转角（弧度）。彩胶 spinBorder 时颜色应跟着唱片转 */
    fillRotate?: number
  }
): void {
  if (rOuter - rInner < 1) return
  ctx.save()
  ringPath(ctx, cx, cy, rOuter, rInner)
  // evenodd：双圆可靠掏洞（nonzero 在部分路径方向下会把内圆填实）
  ctx.clip('evenodd')

  // 底色/渐变：可单独旋转（颜色跟唱片转），沟槽/高光仍在未旋转空间
  ctx.save()
  if (opts.fillRotate) ctx.rotate(opts.fillRotate)
  ctx.fillStyle = opts.fill
  ctx.fillRect(cx - rOuter, cy - rOuter, rOuter * 2, rOuter * 2)
  ctx.restore()

  // 沟槽：沿半径均匀的细环，明暗交替模拟 vinyl groove
  const thickness = rOuter - rInner
  const grooveN = Math.max(8, Math.floor(thickness / 2.2))
  const gAmt = Math.max(0, Math.min(1, opts.groove))
  if (gAmt > 0.02) {
    for (let i = 0; i < grooveN; i++) {
      const r = rInner + ((i + 0.5) / grooveN) * thickness
      // 确定性起伏：避免每帧随机导致闪烁
      const wave = 0.5 + 0.5 * Math.sin(i * 1.7)
      const alpha = (0.03 + 0.07 * wave) * gAmt
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`
      ctx.lineWidth = Math.max(0.6, thickness / grooveN * 0.45)
      ctx.stroke()
      // 沟槽暗缝
      ctx.beginPath()
      ctx.arc(cx, cy, r + 0.6, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(0,0,0,${(alpha * 0.55).toFixed(3)})`
      ctx.lineWidth = Math.max(0.5, thickness / grooveN * 0.3)
      ctx.stroke()
    }
  }

  // 内外缘压暗，增强立体（clip 已限制在环带内，不会糊到盘面/画布外）
  const rim = ctx.createRadialGradient(cx, cy, rInner, cx, cy, rOuter)
  rim.addColorStop(0, 'rgba(0,0,0,0.35)')
  rim.addColorStop(0.12, 'rgba(0,0,0,0)')
  rim.addColorStop(0.88, 'rgba(0,0,0,0)')
  rim.addColorStop(1, 'rgba(0,0,0,0.4)')
  ctx.fillStyle = rim
  ctx.fillRect(cx - rOuter, cy - rOuter, rOuter * 2, rOuter * 2)

  // 高光：扇区环带（外弧 + moveTo 内弧，避免连成实心）
  const sheen = Math.max(0, Math.min(1, opts.sheen))
  if (sheen > 0.02) {
    const a0 = opts.sheenAngle
    const a1 = a0 + Math.PI * 0.55
    ctx.beginPath()
    ctx.arc(cx, cy, rOuter, a0, a1)
    ctx.lineTo(cx + Math.cos(a1) * rInner, cy + Math.sin(a1) * rInner)
    ctx.arc(cx, cy, rInner, a1, a0, true)
    ctx.closePath()
    const sg = ctx.createLinearGradient(
      cx + Math.cos(a0) * rOuter, cy + Math.sin(a0) * rOuter,
      cx + Math.cos(a1) * rOuter, cy + Math.sin(a1) * rOuter
    )
    sg.addColorStop(0, `rgba(255,255,255,0)`)
    sg.addColorStop(0.5, `rgba(255,255,255,${(0.22 * sheen).toFixed(3)})`)
    sg.addColorStop(1, `rgba(255,255,255,0)`)
    ctx.fillStyle = sg
    ctx.fill()
  }

  // 外圈细亮边（仅描边环沿，不填内部）
  ctx.beginPath()
  ctx.arc(cx, cy, rOuter - 0.5, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.restore()
}

function vinylFill(
  ctx: PresetCtx,
  style: 'vinyl' | 'color-vinyl',
  baseColor: string,
  grad: GradientValue,
  rOuter: number
): string | CanvasGradient {
  if (style === 'color-vinyl') {
    // 在包围盒上建渐变，clip 后只显示环带
    return paintGradient(ctx, grad, -rOuter, -rOuter, rOuter * 2, rOuter * 2)
  }
  // 黑胶：底色为中心略亮的径向
  const g = ctx.createRadialGradient(0, 0, rOuter * 0.15, 0, 0, rOuter)
  g.addColorStop(0, baseColor)
  g.addColorStop(0.55, baseColor)
  g.addColorStop(1, '#000000')
  return g
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
    const spinRad = (spinDeg * Math.PI) / 180
    // 默认：图片转、边框不转（框随图片旋转 = spinBorder）
    const spinBorder = bool(params, meta, 'spinBorder')

    // 图片本体：始终随 spin 旋转（唱片盘面）
    ctx.save()
    ctx.beginPath()
    ctx.arc(box.x, box.y, radius, 0, Math.PI * 2)
    ctx.clip()
    ctx.translate(box.x, box.y)
    ctx.rotate(spinRad)
    // 圆内画满：用外接正方形，避免非正方形源在旋出时露角
    const side = Math.hypot(box.w, box.h)
    ctx.drawImage(img, -side / 2, -side / 2, side, side)
    ctx.restore()

    // 边框：**向外扩展**，不压缩图片可见圆
    const borderStyle = str(params, meta, 'borderStyle') || 'vinyl'
    const bwFrac = num(params, meta, 'borderWidth')
    const bw = bwFrac * radius
    if (borderStyle !== 'none' && bw > 0.5) {
      // 图片圆 = radius；边框环带 = [radius, radius+bw]
      const rInner = radius
      const rOuter = radius + bw

      if (borderStyle === 'vinyl' || borderStyle === 'color-vinyl') {
        ctx.save()
        ctx.translate(box.x, box.y)
        const isColor = borderStyle === 'color-vinyl'
        // 高光固定在光源侧，不跟转；彩胶渐变在 spinBorder 时跟唱片转
        const sheenAngle = -Math.PI * 0.85
        const fill = vinylFill(
          ctx,
          isColor ? 'color-vinyl' : 'vinyl',
          str(params, meta, 'vinylBase') || '#111111',
          gradient(params, meta, 'colorVinyl'),
          rOuter
        )
        drawVinylRing(ctx, 0, 0, rOuter, rInner, {
          fill,
          groove: isColor ? num(params, meta, 'colorVinylGroove') : num(params, meta, 'vinylGroove'),
          sheen: isColor ? num(params, meta, 'colorVinylSheen') : num(params, meta, 'vinylSheen'),
          sheenAngle,
          // 黑胶底色近似轴对称，旋转无感；彩胶渐变方向应随唱片
          fillRotate: isColor && spinBorder ? spinRad : 0
        })
        ctx.restore()
      } else if (borderStyle === 'texture') {
        const texSrc = str(params, meta, 'borderTexture')
        const tex = texSrc ? env.images?.get(texSrc) : undefined
        if (tex) {
          ctx.save()
          ringPath(ctx, box.x, box.y, rOuter, rInner)
          ctx.clip('evenodd')
          ctx.translate(box.x, box.y)
          if (spinBorder) ctx.rotate(spinRad)
          ctx.drawImage(tex, -rOuter, -rOuter, rOuter * 2, rOuter * 2)
          ctx.restore()
        } else {
          // 未绑纹理时回退纯色描边（沿外扩环带中心）
          ctx.save()
          ctx.beginPath()
          ctx.arc(box.x, box.y, radius + bw / 2, 0, Math.PI * 2)
          ctx.strokeStyle = str(params, meta, 'borderColor') || '#8fe9ff'
          ctx.lineWidth = bw
          ctx.stroke()
          ctx.restore()
        }
      } else {
        // solid：外扩描边
        ctx.save()
        ctx.beginPath()
        ctx.arc(box.x, box.y, radius + bw / 2, 0, Math.PI * 2)
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
