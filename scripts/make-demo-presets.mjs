// 生成第三方生态演示用 .avnpre（可导入的分发包）
// 运行：node scripts/make-demo-presets.mjs
//
// 两个包演示两条扩展路径：
//   - spectrum-bars.avnpre：**脚本实现**（`implementation.type = "script"`，包内自带 JS）
//   - radial-bars.avnpre：**引用内置 drawer**（数据包；声明直接取自内置 preset.json，
//     所以内置版与分发包永远一致 —— 环形柱要跟随圆形的 3D 面，靠的就是内置 drawer 的逐顶点投影）
//
// ⚠ radial-bars 已是**内置预设**（presets/visualizations/radial-bars/preset.json），
//   不需要导入即可用；这个 .avnpre 只用于分发给别的工程/机器。
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

/** 读内置声明（presets/<分类>/<id>/preset.json）并挂上实现方式 */
function fromBuiltinJson(rel, implementation) {
  const preset = JSON.parse(readFileSync(join(root, rel), 'utf8'))
  return { ...preset, implementation }
}

// —— 脚本源（作用域：ctx, env, params, meta, api；见 docs/preset-authoring.md）——
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

/** 频谱柱（脚本实现示例） */
const spectrumPreset = {
  format: 'avnpreset',
  version: 1,
  id: 'spectrum-bars',
  name: '频谱柱状图',
  category: 'visualization',
  clipType: 'visual',
  kind: 'visual',
  drawer: 'spectrum-bars',
  durationFrames: 300,
  color: '#2a9d8f',
  desc: '横置柱状频谱：柱体沿水平方向排列、高度随频谱起伏，支持镜像与双色。',
  params: [
    { key: 'posX', label: '位置 X', type: 'number', group: '布局', min: -0.5, max: 0.5, step: 0.005, default: 0, percent: true },
    { key: 'posY', label: '位置 Y', type: 'number', group: '布局', min: -0.5, max: 0.5, step: 0.005, default: 0.18, percent: true },
    { key: 'scaleX', label: '缩放 X', type: 'number', group: '布局', min: 0.1, max: 4, step: 0.01, default: 1, link: 'scaleY' },
    { key: 'scaleY', label: '缩放 Y', type: 'number', group: '布局', min: 0.1, max: 4, step: 0.01, default: 1, link: 'scaleX' },
    { key: 'barCount', label: '柱数量', type: 'number', group: '柱体', min: 8, max: 128, step: 1, default: 48, keyframe: true },
    { key: 'barGap', label: '柱间隙', type: 'number', group: '柱体', min: 0, max: 0.8, step: 0.01, default: 0.35, percent: true },
    { key: 'maxHeight', label: '最大高度', type: 'number', group: '柱体', min: 0.1, max: 1, step: 0.01, default: 0.55, percent: true, keyframe: true },
    { key: 'minHeight', label: '最小高度', type: 'number', group: '柱体', min: 0, max: 0.2, step: 0.005, default: 0.02, percent: true },
    { key: 'radius', label: '圆角', type: 'number', group: '柱体', min: 0, max: 1, step: 0.05, default: 0.5, percent: true },
    { key: 'gamma', label: '频谱增益', type: 'number', group: '柱体', min: 0.4, max: 3, step: 0.05, default: 1.3 },
    { key: 'mirror', label: '上下镜像', type: 'bool', group: '柱体', default: false },
    { key: 'colorA', label: '颜色 A（低频）', type: 'color', group: '颜色', default: '#3fe0ff' },
    { key: 'colorB', label: '颜色 B（高频）', type: 'color', group: '颜色', default: '#a29bfe' },
    { key: 'glow', label: '辉光', type: 'number', group: '颜色', min: 0, max: 1, step: 0.05, default: 0.45, percent: true }
  ],
  implementation: { type: 'script', language: 'js', source: spectrumScript }
}
// —— 环形频谱柱：声明直接来自内置 preset.json（单一事实源），实现引用内置 drawer ——
const radialPreset = fromBuiltinJson('presets/visualizations/radial-bars/preset.json', {
  type: 'builtin',
  drawer: 'radial-bars'
})

writeFileSync(join(outDir, 'spectrum-bars.avnpre'), pack(spectrumPreset), 'utf8')
writeFileSync(join(outDir, 'radial-bars.avnpre'), pack(radialPreset), 'utf8')
console.log('Wrote plugins/spectrum-bars.avnpre (script) and plugins/radial-bars.avnpre (builtin drawer)')
