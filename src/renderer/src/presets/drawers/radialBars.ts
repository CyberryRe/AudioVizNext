/**
 * drawers/radialBars.ts —— 环形频谱柱（可视化预设）。
 * 柱体自中心向外辐射；`followCircle=true` 时对齐同帧圆形图片预设（env.followCircle）。
 *
 * **跟随 = 逐顶点投影**：圆形若贴了 3D 长方体的某个面，宿主会给出 `env.followProject`
 * （把 stage 坐标投到圆形所在的那个面上）。本绘制器把**每一个轮廓点**都过一遍它，
 * 于是环与圆处在同一套单应性里 → 严格同面（同构），而不是只在画面上对齐。
 * 投影是单应性、直线段投影后仍是直线，所以柱体轮廓（含圆角采样点）逐点投影即可。
 *
 * ⚠ 改这里的几何/参数时，`scripts/make-demo-presets.mjs` 里的发布包副本要同步
 *   （该脚本生成的 `plugins/radial-bars.avnpre` 现在直接引用本 drawer，通常无需再同步）。
 */
import { freqValue, type PresetAudioData } from '../../media/audioAnalysis'
import { mixColor } from '../../model/timeline'
import { str, bool, type PresetCtx, type PresetMeta, type PresetRenderEnv } from '../types'
import { paramAt } from '../keyframes'

/** 柱样式：尖角 / 圆角 / 胶囊 */
type BarStyle = 'sharp' | 'round' | 'pill'

/** 局部极坐标 → 局部直角坐标（圆心为原点、未自转） */
function pol(r: number, th: number): { x: number; y: number } {
  return { x: Math.cos(th) * r, y: Math.sin(th) * r }
}

/**
 * 按柱样式算四角圆角半径。全部按「柱长 / 柱宽」自适应 → 短柱、窄柱都不会被圆角吃掉。
 * @param style 柱样式
 * @param len   柱长（径向）
 * @param wIn   内端切向半宽
 * @param wOut  外端切向半宽
 */
function cornerRadii(style: BarStyle, len: number, wIn: number, wOut: number): { rcIn: number; rcOut: number } {
  if (style === 'sharp' || len <= 0.5) return { rcIn: 0, rcOut: 0 }
  const rcOut = style === 'pill' ? Math.min(len * 0.5, wOut) : Math.min(len * 0.5, wOut) * 0.6
  const rcIn = style === 'pill' ? Math.min(len * 0.25, wIn) * 0.6 : Math.min(len * 0.25, wIn) * 0.35
  return { rcIn, rcOut }
}

export function drawRadialBars(
  ctx: PresetCtx,
  env: PresetRenderEnv,
  params: Record<string, unknown>,
  meta: PresetMeta
): void {
  const tRel = env.tRel ?? 0
  const audio: PresetAudioData | null = env.audio ?? null
  const followOn = bool(params, meta, 'followCircle')
  const follow = followOn ? env.followCircle : null
  const pad = paramAt(params, env.keyframes, 'ringPad', tRel, 0.06)
  const px = paramAt(params, env.keyframes, 'posX', tRel, 0)
  const py = paramAt(params, env.keyframes, 'posY', tRel, 0)
  const baseR = paramAt(params, env.keyframes, 'baseRadius', tRel, 180)
  const n = Math.max(8, Math.round(paramAt(params, env.keyframes, 'barCount', tRel, 64)))
  const barW = paramAt(params, env.keyframes, 'barWidth', tRel, 0.55)
  const barLen = paramAt(params, env.keyframes, 'barLength', tRel, 0.12)
  const minLen = paramAt(params, env.keyframes, 'minLen', tRel, 0.01)
  const gamma = paramAt(params, env.keyframes, 'gamma', tRel, 1.3)
  const spin = paramAt(params, env.keyframes, 'spin', tRel, 0)
  const glow = paramAt(params, env.keyframes, 'glow', tRel, 0.4)
  const colorA = str(params, meta, 'colorA') || '#ff6b6b'
  const colorB = str(params, meta, 'colorB') || '#ffd93d'
  const innerRing = bool(params, meta, 'innerRing')
  const style = (str(params, meta, 'barStyle') || 'round') as BarStyle

  const W = env.width
  const H = env.height
  const cx = follow ? follow.x : W / 2 + px * W
  const cy = follow ? follow.y : H / 2 + py * H
  // 跟随时：从图片圆外侧 pad 起画，避免盖住盘面
  const r0 = follow ? follow.radius * (1 + pad) : baseR
  const lenScale = follow ? follow.radius : Math.min(W, H) * 0.35
  const maxExtra = lenScale * barLen * 3 + H * barLen * 0.5
  const minExtra = Math.max(2, lenScale * minLen)
  const rot = spin * Math.PI * 2 * env.timeSec + (follow ? follow.spinRad * 0.15 : 0)

  // 跟随圆形且圆形开了 3D 时：把每个绘制点映射进同一套单应性 → 环随圆一起透视变形，
  // 落在圆形所贴的**同一个面**上。投影作用于「已含平移+自转的 stage 坐标」（逐顶点）。
  const fp = follow ? env.followProject : undefined
  const P = (lx: number, ly: number): { x: number; y: number } => {
    // lx/ly 为「圆心局部坐标」（未自转）→ 先转回 stage 空间再投影
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    const sx = cx + lx * cos - ly * sin
    const sy = cy + lx * sin + ly * cos
    return fp ? fp(sx, sy) : { x: sx, y: sy }
  }

  ctx.save()
  ctx.globalAlpha = env.opacity

  /** 把一串局部坐标点连成路径（逐点投影） */
  const tracePath = (pts: { x: number; y: number }[]): void => {
    ctx.beginPath()
    for (let i = 0; i < pts.length; i++) {
      const p = P(pts[i].x, pts[i].y)
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    }
    ctx.closePath()
  }

  if (innerRing) {
    // 内环近似为多边形（受投影后不再是正圆）；段数随半径自适应
    const segs = Math.max(48, Math.min(180, Math.round(r0 * 0.6)))
    const ring: { x: number; y: number }[] = []
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2
      ring.push(pol(r0, a))
    }
    tracePath(ring)
    ctx.strokeStyle = mixColor(colorA, '#ffffff', 0.15)
    ctx.globalAlpha = env.opacity * 0.55
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.globalAlpha = env.opacity
  }

  const step = (Math.PI * 2) / n
  const half = step * barW * 0.5
  /** 单根柱的轮廓点缓存（局部坐标）——每帧复用同一数组，避免热路径反复分配 */
  const outline: { x: number; y: number }[] = []
  const pushFillet = (prev: { x: number; y: number }, corner: { x: number; y: number }, next: { x: number; y: number }): void => {
    // 二次贝塞尔圆角（corner 作控制点），采样 4 段足够 1px 级平滑
    for (let k = 1; k <= 4; k++) {
      const t = k / 4
      const mt = 1 - t
      outline.push({
        x: mt * mt * prev.x + 2 * mt * t * corner.x + t * t * next.x,
        y: mt * mt * prev.y + 2 * mt * t * corner.y + t * t * next.y
      })
    }
  }
  const pushArc = (r: number, from: number, to: number): void => {
    const steps = Math.max(1, Math.ceil(Math.abs(to - from) / 0.12))
    for (let k = 1; k <= steps; k++) outline.push(pol(r, from + (to - from) * (k / steps)))
  }

  for (let i = 0; i < n; i++) {
    const v = freqValue(audio, env.frame, i, n, gamma)
    const len = Math.max(minExtra, v * maxExtra)
    const a = i * step - Math.PI / 2
    const mix = n <= 1 ? 0 : i / (n - 1)
    const col = mixColor(colorA, colorB, mix)
    const rOut = r0 + len
    const thL = a - half
    const thR = a + half

    // —— 轮廓（局部坐标）：内弧 → 右缘 → 外弧 → 左缘，四角按 barStyle 圆角 ——
    const sinHalf = Math.abs(Math.sin(half))
    let { rcIn, rcOut } = cornerRadii(style, len, r0 * sinHalf, rOut * sinHalf)
    // 圆角不得吃穿角宽（窄柱/多柱时尤其重要）
    rcIn = Math.min(rcIn, r0 * (thR - thL) * 0.4, len * 0.45)
    rcOut = Math.min(rcOut, rOut * (thR - thL) * 0.4, len * 0.5)
    const dIn = r0 > 1e-3 ? rcIn / r0 : 0
    const dOut = rOut > 1e-3 ? rcOut / rOut : 0

    outline.length = 0
    outline.push(pol(r0, thL + dIn))
    pushArc(r0, thL + dIn, thR - dIn)
    // 圆角半径过小时不插点：此时边端点本身就是角点（= 旧版四边形）
    if (rcIn > 0.3) pushFillet(pol(r0, thR - dIn), pol(r0, thR), pol(r0 + rcIn, thR))
    outline.push(pol(rOut - rcOut, thR))
    if (rcOut > 0.3) pushFillet(pol(rOut - rcOut, thR), pol(rOut, thR), pol(rOut, thR - dOut))
    pushArc(rOut, thR - dOut, thL + dOut)
    if (rcOut > 0.3) pushFillet(pol(rOut, thL + dOut), pol(rOut, thL), pol(rOut - rcOut, thL))
    outline.push(pol(r0 + rcIn, thL))
    if (rcIn > 0.3) pushFillet(pol(r0 + rcIn, thL), pol(r0, thL), pol(r0, thL + dIn))

    if (glow > 0.01) {
      ctx.shadowColor = col
      ctx.shadowBlur = 12 * glow
    }
    ctx.fillStyle = col
    tracePath(outline)
    ctx.fill()
    ctx.shadowBlur = 0
  }
  ctx.restore()
}

/** 供单测/调试：某个样式在该柱尺寸下的圆角半径（不依赖 canvas） */
export function radialBarCornerRadii(style: BarStyle, len: number, wIn: number, wOut: number): { rcIn: number; rcOut: number } {
  return cornerRadii(style, len, wIn, wOut)
}
