/**
 * make-icon.mjs —— 程序化生成应用图标（无字体、无第三方素材、无字母）。
 *
 * 运行：npm run icon        （产出 resources/icon.ico + resources/icon-256.png）
 *
 * 为什么不用字母 / 不用"圆角方块 + 两字母缩写"：
 *   那是 Adobe 家族图标（Ae/Pr/Ps/Au…）的固定视觉规范，形似既有 **商业外观（trade dress）**
 *   风险，也会让本应用看起来像 Adobe 出的。这里只画抽象图形：等化器柱 + 环形暗示，
 *   配色取项目预设自带的调色板（#3fe0ff → #a29bfe）。
 *
 * 实现：纯 Node 手写 SDF 覆盖度光栅化（圆角矩形/胶囊/圆环/圆），自带 1px 抗锯齿；
 * 输出 RGB24 原始像素喂给 ffmpeg 转 PNG/ICO（不依赖任何图形库）。
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources')
mkdirSync(outDir, { recursive: true })
const tmpDir = join(tmpdir(), 'avn-icon-tmp')
mkdirSync(tmpDir, { recursive: true })

const FFMPEG = process.env.AVS_FFMPEG_PATH ||
  (existsSync(join(root, 'bin', 'ffmpeg.exe')) ? join(root, 'bin', 'ffmpeg.exe') : 'ffmpeg')

// ===== 几何小工具（全部返回 0..1 覆盖度）=====
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
/** 圆角矩形 SDF 的覆盖度（半宽/半高/圆角半径） */
function roundedRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  const d = outside + inside - r
  return clamp01(0.5 - d)
}
/** 圆环覆盖度 */
function ring(px, py, cx, cy, radius, width) {
  const d = Math.abs(Math.hypot(px - cx, py - cy) - radius) - width / 2
  return clamp01(0.5 - d)
}
const lerp = (a, b, t) => a + (b - a) * t
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

const BG_TOP = hex('#111a2e')
const BG_BOT = hex('#0a0f1c')
const CYAN = hex('#3fe0ff')
const VIOLET = hex('#a29bfe')

/** 画一张 size×size 的 RGB24 图（覆盖度合成，1px 抗锯齿） */
function render(size) {
  const S = size
  const buf = Buffer.alloc(S * S * 3)
  // 版式比例（相对边长，保证各尺寸观感一致）
  const pad = S * 0.06
  const tileR = S * 0.24
  const cx = S / 2
  const cy = S / 2
  // 小尺寸（≤32px）用 3 根更粗的柱：5 根在 16px 下会糊成一团
  const small = S <= 32
  const n = small ? 3 : 5
  // 环放大到 0.375S、柱收窄 → 环与柱不互相穿插（相交会显得"打架"，像失误）
  const ringR = S * 0.375
  const ringW = Math.max(1, S * (small ? 0.07 : 0.026))
  const barW = S * (small ? 0.12 : 0.08)
  const gap = S * (small ? 0.065 : 0.045)
  // 柱高按边长比例；立在基线上 → 视觉重心居中，小尺寸也读得出"频谱"
  const heights = (small ? [0.24, 0.38, 0.18] : [0.16, 0.27, 0.38, 0.23, 0.12]).map((h) => h * S)
  const baselineY = cy + S * 0.155
  const totalW = n * barW + (n - 1) * gap
  const x0 = cx - totalW / 2 + barW / 2

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5
      const py = y + 0.5
      // 背板：圆角方块 + 纵向渐变 + 描边
      const tile = roundedRect(px, py, cx, cy, S / 2 - pad, S / 2 - pad, tileR)
      let col = mix(BG_TOP, BG_BOT, py / S)
      // 环形暗示（低透明度，呼应"环形频谱柱"）
      const ringCov = ring(px, py, cx, cy, ringR, ringW) * tile
      if (ringCov > 0) col = mix(col, CYAN, ringCov * 0.30)
      // 等化器柱（圆角胶囊，垂直渐变）
      for (let i = 0; i < n; i++) {
        const bx = x0 + i * (barW + gap)
        const bh = heights[i]
        const by = baselineY - bh / 2
        const cov = roundedRect(px, py, bx, by, barW / 2, bh / 2, barW / 2) * tile
        if (cov > 0) {
          const t = clamp01((py - (baselineY - bh)) / Math.max(1, bh))
          col = mix(col, mix(CYAN, VIOLET, t), cov)
        }
      }
      const i3 = (y * S + x) * 3
      buf[i3] = Math.round(col[0])
      buf[i3 + 1] = Math.round(col[1])
      buf[i3 + 2] = Math.round(col[2])
    }
  }
  return buf
}

function writeRgb(size, file) {
  writeFileSync(file, render(size))
  return file
}

const ff = (args) => execFileSync(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })

// 1) 各尺寸 PNG（直接按目标尺寸光栅化，小图标更锐利）
const sizes = [256, 128, 64, 48, 32, 16]
const pngs = sizes.map((s) => {
  const rgb = writeRgb(s, join(tmpDir, `icon-${s}.rgb`))
  const png = join(tmpDir, `icon-${s}.png`)
  ff(['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${s}x${s}`, '-i', rgb, '-frames:v', '1', png])
  return png
})

// 2) 多尺寸 ICO（把各 PNG 作为独立帧塞进 ico；失败则退回单尺寸 256）
const ico = join(outDir, 'icon.ico')
try {
  const args = ['-y', '-v', 'error']
  for (const p of pngs) args.push('-i', p)
  for (let i = 0; i < pngs.length; i++) args.push('-map', `${i}:v`)
  args.push('-frames:v', '1', ico)
  ff(args)
  console.log(`[icon] 多尺寸 ICO: ${sizes.join('/')}`)
} catch (e) {
  console.warn('[icon] 多尺寸 ICO 失败，退回单尺寸 256：', (e.stderr?.toString?.() ?? e.message ?? '').slice(0, 200))
  ff(['-y', '-v', 'error', '-i', pngs[0], '-frames:v', '1', ico])
}
writeFileSync(join(outDir, 'icon-256.png'), readFileSync(pngs[0]))
console.log(`[icon] 写入 resources/icon.ico 与 resources/icon-256.png（${sizes.join(', ')}）`)
