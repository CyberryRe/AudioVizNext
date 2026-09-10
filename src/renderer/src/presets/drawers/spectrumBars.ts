/**
 * drawers/spectrumBars.ts —— 横置柱状频谱（可视化预设）。
 * 柱体沿水平方向排列，高度随对数频谱起伏；预览与导出共用。
 */
import { freqValue, type PresetAudioData } from '../../media/audioAnalysis'
import { mixColor } from '../../model/timeline'
import { num, str, bool, type PresetCtx, type PresetMeta, type PresetRenderEnv } from '../types'
import { paramAt } from '../keyframes'

function roundRect(
  ctx: PresetCtx,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

export function drawSpectrumBars(
  ctx: PresetCtx,
  env: PresetRenderEnv,
  params: Record<string, unknown>,
  meta: PresetMeta
): void {
  const tRel = env.tRel ?? 0
  const audio: PresetAudioData | null = env.audio ?? null
  const n = Math.max(4, Math.round(paramAt(params, env.keyframes, 'barCount', tRel, 48)))
  const gap = paramAt(params, env.keyframes, 'barGap', tRel, 0.35)
  const maxH = paramAt(params, env.keyframes, 'maxHeight', tRel, 0.55)
  const minH = paramAt(params, env.keyframes, 'minHeight', tRel, 0.02)
  const radius = paramAt(params, env.keyframes, 'radius', tRel, 0.5)
  const gamma = paramAt(params, env.keyframes, 'gamma', tRel, 1.3)
  const glow = paramAt(params, env.keyframes, 'glow', tRel, 0.45)
  const px = paramAt(params, env.keyframes, 'posX', tRel, 0)
  const py = paramAt(params, env.keyframes, 'posY', tRel, 0.18)
  const sx = paramAt(params, env.keyframes, 'scaleX', tRel, 1)
  const sy = paramAt(params, env.keyframes, 'scaleY', tRel, 1)
  const mirror = bool(params, meta, 'mirror')
  const colorA = str(params, meta, 'colorA') || '#3fe0ff'
  const colorB = str(params, meta, 'colorB') || '#a29bfe'

  const W = env.width
  const H = env.height
  ctx.save()
  ctx.globalAlpha = env.opacity
  ctx.translate(W / 2 + px * W, H / 2 + py * H)
  ctx.scale(sx, sy)

  const totalW = W * 0.92
  const slot = totalW / n
  const bw = Math.max(1, slot * (1 - gap))
  const maxBar = H * maxH
  const minBar = H * minH
  const cr = Math.min(bw / 2, maxBar / 2) * radius

  for (let i = 0; i < n; i++) {
    const v = freqValue(audio, env.frame, i, n, gamma)
    const bh = Math.max(minBar, v * maxBar)
    const x = -totalW / 2 + i * slot + (slot - bw) / 2
    const mix = n <= 1 ? 0 : i / (n - 1)
    const col = mixColor(colorA, colorB, mix)
    if (glow > 0.01) {
      ctx.shadowColor = col
      ctx.shadowBlur = 14 * glow
    }
    ctx.fillStyle = col
    if (mirror) {
      const hh = bh / 2
      if (cr > 0.5) {
        roundRect(ctx, x, -hh, bw, hh * 2, cr)
        ctx.fill()
      } else {
        ctx.fillRect(x, -hh, bw, hh * 2)
      }
    } else {
      if (cr > 0.5) {
        roundRect(ctx, x, -bh, bw, bh, cr)
        ctx.fill()
      } else {
        ctx.fillRect(x, -bh, bw, bh)
      }
    }
    ctx.shadowBlur = 0
  }
  ctx.restore()
}
