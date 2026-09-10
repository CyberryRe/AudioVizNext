// 生成第三方生态演示用 .avnpre（**脚本实现**，可引用内置 drawer 作为回退）
// 运行：node scripts/make-demo-presets.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'plugins')
mkdirSync(outDir, { recursive: true })

function pack(preset) {
  return JSON.stringify(
    {
      format: 'avnpre',
      version: 1,
      createdBy: 'AudioVizNext-demo',
      createdAt: new Date().toISOString(),
      preset
    },
    null,
    2
  )
}

// —— 脚本源：与内置 drawer 同逻辑，证明「只靠 .avnpre 即可扩展」——
// 作用域：ctx, env, params, meta, api（见 docs/preset-authoring.md）

const spectrumScript = `const tRel = env.tRel || 0
const n = Math.max(4, Math.round(api.paramAt(params, env.keyframes, 'barCount', tRel, 48)))
const gap = api.paramAt(params, env.keyframes, 'barGap', tRel, 0.35)
const maxH = api.paramAt(params, env.keyframes, 'maxHeight', tRel, 0.55)
const minH = api.paramAt(params, env.keyframes, 'minHeight', tRel, 0.02)
const crRatio = api.paramAt(params, env.keyframes, 'radius', tRel, 0.5)
const gamma = api.paramAt(params, env.keyframes, 'gamma', tRel, 1.3)
const glow = api.paramAt(params, env.keyframes, 'glow', tRel, 0.45)
const px = api.paramAt(params, env.keyframes, 'posX', tRel, 0)
const py = api.paramAt(params, env.keyframes, 'posY', tRel, 0.18)
const sx = api.paramAt(params, env.keyframes, 'scaleX', tRel, 1)
const sy = api.paramAt(params, env.keyframes, 'scaleY', tRel, 1)
const mirror = params.mirror === true
const colorA = params.colorA || '#3fe0ff'
const colorB = params.colorB || '#a29bfe'
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
const cr = Math.min(bw / 2, maxBar / 2) * crRatio
for (let i = 0; i < n; i++) {
  const v = api.freqValue(env.audio, env.frame, i, n, gamma)
  const bh = Math.max(minBar, v * maxBar)
  const x = -totalW / 2 + i * slot + (slot - bw) / 2
  const mix = n <= 1 ? 0 : i / (n - 1)
  const col = api.mixColor(colorA, colorB, mix)
  if (glow > 0.01) { ctx.shadowColor = col; ctx.shadowBlur = 14 * glow }
  ctx.fillStyle = col
  if (mirror) {
    const hh = bh / 2
    ctx.beginPath()
    if (cr > 0.5) {
      const rr = Math.min(cr, bw / 2, hh)
      ctx.moveTo(x + rr, -hh)
      ctx.arcTo(x + bw, -hh, x + bw, hh, rr)
      ctx.arcTo(x + bw, hh, x, hh, rr)
      ctx.arcTo(x, hh, x, -hh, rr)
      ctx.arcTo(x, -hh, x + bw, -hh, rr)
      ctx.closePath()
    } else ctx.rect(x, -hh, bw, hh * 2)
    ctx.fill()
  } else {
    ctx.beginPath()
    if (cr > 0.5) {
      const rr = Math.min(cr, bw / 2, bh)
      ctx.moveTo(x + rr, -bh)
      ctx.arcTo(x + bw, -bh, x + bw, 0, rr)
      ctx.lineTo(x + bw, 0)
      ctx.lineTo(x, 0)
      ctx.arcTo(x, -bh, x + rr, -bh, rr)
      ctx.closePath()
    } else ctx.rect(x, -bh, bw, bh)
    ctx.fill()
  }
  ctx.shadowBlur = 0
}
ctx.restore()`

const radialScript = `const tRel = env.tRel || 0
const followOn = params.followCircle !== false
const follow = followOn ? env.followCircle : null
const pad = api.paramAt(params, env.keyframes, 'ringPad', tRel, 0.08)
const px = api.paramAt(params, env.keyframes, 'posX', tRel, 0)
const py = api.paramAt(params, env.keyframes, 'posY', tRel, 0)
const baseR = api.paramAt(params, env.keyframes, 'baseRadius', tRel, 180)
const n = Math.max(8, Math.round(api.paramAt(params, env.keyframes, 'barCount', tRel, 64)))
const barW = api.paramAt(params, env.keyframes, 'barWidth', tRel, 0.55)
const barLen = api.paramAt(params, env.keyframes, 'barLength', tRel, 0.12)
const minLen = api.paramAt(params, env.keyframes, 'minLen', tRel, 0.01)
const gamma = api.paramAt(params, env.keyframes, 'gamma', tRel, 1.3)
const spin = api.paramAt(params, env.keyframes, 'spin', tRel, 0)
const glow = api.paramAt(params, env.keyframes, 'glow', tRel, 0.4)
const colorA = params.colorA || '#ff6b6b'
const colorB = params.colorB || '#ffd93d'
const W = env.width
const H = env.height
const cx = follow ? follow.x : W / 2 + px * W
const cy = follow ? follow.y : H / 2 + py * H
const r0 = follow ? follow.radius * (1 + pad) : baseR
const lenScale = follow ? follow.radius : Math.min(W, H) * 0.35
const maxExtra = lenScale * barLen * 3 + H * barLen * 0.5
const minExtra = Math.max(2, lenScale * minLen)
const rot = spin * Math.PI * 2 * env.timeSec + (follow ? follow.spinRad * 0.15 : 0)
ctx.save()
ctx.globalAlpha = env.opacity
ctx.translate(cx, cy)
ctx.rotate(rot)
if (params.innerRing !== false) {
  ctx.beginPath()
  ctx.arc(0, 0, r0, 0, Math.PI * 2)
  ctx.strokeStyle = api.mixColor(colorA, '#ffffff', 0.15)
  ctx.globalAlpha = env.opacity * 0.55
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.globalAlpha = env.opacity
}
const step = (Math.PI * 2) / n
const half = step * barW * 0.5
for (let i = 0; i < n; i++) {
  const v = api.freqValue(env.audio, env.frame, i, n, gamma)
  const len = Math.max(minExtra, v * maxExtra)
  const a = i * step - Math.PI / 2
  const mix = n <= 1 ? 0 : i / (n - 1)
  const col = api.mixColor(colorA, colorB, mix)
  if (glow > 0.01) { ctx.shadowColor = col; ctx.shadowBlur = 12 * glow }
  ctx.fillStyle = col
  const x0 = Math.cos(a - half) * r0
  const y0 = Math.sin(a - half) * r0
  const x1 = Math.cos(a - half) * (r0 + len)
  const y1 = Math.sin(a - half) * (r0 + len)
  const x2 = Math.cos(a + half) * (r0 + len)
  const y2 = Math.sin(a + half) * (r0 + len)
  const x3 = Math.cos(a + half) * r0
  const y3 = Math.sin(a + half) * r0
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.lineTo(x3, y3)
  ctx.closePath()
  ctx.fill()
  ctx.shadowBlur = 0
}
ctx.restore()`

function fromBuiltinJson(rel, script) {
  const preset = JSON.parse(readFileSync(join(root, rel), 'utf8'))
  return {
    ...preset,
    // 脚本是正式实现；drawer 仅作同 id 内置样式的回退
    implementation: { type: 'script', language: 'js', source: script }
  }
}

writeFileSync(
  join(outDir, 'spectrum-bars.avnpre'),
  pack(fromBuiltinJson('presets/visualizations/spectrum-bars/preset.json', spectrumScript)),
  'utf8'
)
writeFileSync(
  join(outDir, 'radial-bars.avnpre'),
  pack(fromBuiltinJson('presets/visualizations/radial-bars/preset.json', radialScript)),
  'utf8'
)
console.log('Wrote script-based plugins/spectrum-bars.avnpre and plugins/radial-bars.avnpre')
