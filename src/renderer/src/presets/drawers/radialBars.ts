/**
 * drawers/radialBars.ts —— 环形频谱柱（可视化预设）。
 * 柱体自中心向外辐射；`followCircle=true` 时对齐同帧圆形图片预设（env.followCircle）。
 */
import { freqValue, type PresetAudioData } from '../../media/audioAnalysis'
import { mixColor } from '../../model/timeline'
import { num, str, bool, type PresetCtx, type PresetMeta, type PresetRenderEnv } from '../types'
import { paramAt } from '../keyframes'

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

  // 跟随圆形且圆形开了 3D 时：把每个绘制点映射进同一套单应性 → 环随圆一起透视变形。
  // 投影作用于**已含平移+自转的 stage 坐标**（逐顶点，而非整层网格）→ 与圆形严格同构。
  const fp = follow ? env.followProject : undefined
  const P = (lx: number, ly: number): { x: number; y: number } => {
    // lx/ly 为「圆心局部坐标」（未自转前的画幅坐标）→ 先转回 stage 空间再投影
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    const sx = cx + lx * cos - ly * sin
    const sy = cy + lx * sin + ly * cos
    return fp ? fp(sx, sy) : { x: sx, y: sy }
  }

  ctx.save()
  ctx.globalAlpha = env.opacity

  if (innerRing) {
    // 内环近似为多边形（受投影后不再是正圆）；段数随半径自适应
    const segs = Math.max(48, Math.min(180, Math.round(r0 * 0.6)))
    ctx.beginPath()
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2
      const p = P(Math.cos(a) * r0, Math.sin(a) * r0)
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    }
    ctx.strokeStyle = mixColor(colorA, '#ffffff', 0.15)
    ctx.globalAlpha = env.opacity * 0.55
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.globalAlpha = env.opacity
  }

  const step = (Math.PI * 2) / n
  const half = step * barW * 0.5
  for (let i = 0; i < n; i++) {
    const v = freqValue(audio, env.frame, i, n, gamma)
    const len = Math.max(minExtra, v * maxExtra)
    const a = i * step - Math.PI / 2
    const mix = n <= 1 ? 0 : i / (n - 1)
    const col = mixColor(colorA, colorB, mix)
    if (glow > 0.01) {
      ctx.shadowColor = col
      ctx.shadowBlur = 12 * glow
    }
    ctx.fillStyle = col
    // 4 个角先算局部坐标，再统一投影 → 投影后仍是四边形（直线保持性）
    const p0 = P(Math.cos(a - half) * r0, Math.sin(a - half) * r0)
    const p1 = P(Math.cos(a - half) * (r0 + len), Math.sin(a - half) * (r0 + len))
    const p2 = P(Math.cos(a + half) * (r0 + len), Math.sin(a + half) * (r0 + len))
    const p3 = P(Math.cos(a + half) * r0, Math.sin(a + half) * r0)
    ctx.beginPath()
    ctx.moveTo(p0.x, p0.y)
    ctx.lineTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p2.y)
    ctx.lineTo(p3.x, p3.y)
    ctx.closePath()
    ctx.fill()
    ctx.shadowBlur = 0
  }
  ctx.restore()
}
