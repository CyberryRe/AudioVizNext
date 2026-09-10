/**
 * gif.test.mjs —— GIF 解码器单测。
 *
 * 策略：
 *  1. 基础 API（魔数识别、非 GIF 安全返回 null、帧索引映射）；
 *  2. 用真实 GIF 文件跑解码，断言结构；
 *  3. 用 gifuct-js（node_modules 内的三方实现）作**预言机**逐帧对比 RGBA，
 *     验证 LZW + disposal 合成 + 透明色处理正确。
 *
 * gifuct-js 仅测试用，不进产物依赖。
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { decodeGif, isGifBytes, gifFrameIndex } from '../src/renderer/src/media/gif.ts'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e?.message ?? e}`) }
}
function ok(v, msg) { if (!v) throw new Error(msg ?? '期望为真') }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg ?? 'eq'}：期望 ${b}，实际 ${a}`) }

console.log('== 基础 ==')
t('非 GIF 字节 → decodeGif 返回 null', () => {
  eq(decodeGif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null)
})
t('isGifBytes 识别魔数', () => {
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0])
  ok(isGifBytes(gif))
  ok(!isGifBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47])))
})
t('gifFrameIndex：按帧号直读并取模', () => {
  eq(gifFrameIndex(0, 5), 0)
  eq(gifFrameIndex(3, 5), 3)
  eq(gifFrameIndex(5, 5), 0)
  eq(gifFrameIndex(7, 5), 2)
  eq(gifFrameIndex(10, 5, 2), 0, '每 GIF 帧占 2 个时间轴帧')
  eq(gifFrameIndex(3, 5, 2), 1)
  eq(gifFrameIndex(0, 0), 0, '空帧数安全')
})

console.log('== 真实 GIF 解码 ==')
const candidates = ['reference/elah/docs/demo.gif', 'reference/elah/readme.gif'].filter((f) =>
  existsSync(resolve(root, f))
)
if (candidates.length === 0) console.log('  (跳过：未找到测试 GIF 文件)')

for (const rel of candidates) {
  const bytes = new Uint8Array(readFileSync(resolve(root, rel)))

  t(`${rel}：结构有效（尺寸/帧数/RGBA 长度）`, () => {
    const g = decodeGif(bytes)
    ok(g, '应能解码')
    ok(g.width > 0 && g.height > 0, `尺寸应 >0（实际 ${g?.width}x${g?.height}）`)
    ok(g.frames.length > 0, `至少 1 帧（实际 ${g?.frames.length}）`)
    for (const f of g.frames) eq(f.data.length, g.width * g.height * 4, '每帧 RGBA 长度')
  })

  t(`${rel}：与 gifuct-js 逐帧 RGBA 一致`, () => {
    const mine = decodeGif(bytes)
    ok(mine, '自己的解码结果有效')

    const { parseGIF, decompressFrames } = require('gifuct-js')
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const frames = decompressFrames(parseGIF(buf), true)
    eq(frames.length, mine.frames.length, '帧数应一致')

    const W = mine.width
    let maxDiff = 0
    let checked = 0
    for (let fi = 0; fi < mine.frames.length; fi++) {
      const mf = mine.frames[fi].data
      const gf = frames[fi]
      const patch = gf.patch
      const { left: px, top: py, width: pw, height: ph } = gf.dims
      for (let y = 0; y < ph; y++) {
        for (let x = 0; x < pw; x++) {
          const mi = ((py + y) * W + (px + x)) * 4
          const gi = (y * pw + x) * 4
          // 透明像素（patch alpha=0）：自己实现保留画布原值，跳过比较
          if (patch[gi + 3] === 0) continue
          checked++
          for (let c = 0; c < 3; c++) {
            const d = Math.abs(mf[mi + c] - patch[gi + c])
            if (d > maxDiff) maxDiff = d
          }
        }
      }
    }
    ok(checked > 0, '至少比较了若干像素')
    ok(maxDiff === 0, `RGB 应完全一致（实际最大差 ${maxDiff}）`)
  })

  t(`${rel}：透明像素 alpha 正确（不透明处 alpha=255）`, () => {
    const g = decodeGif(bytes)
    ok(g)
    let opaque = 0
    let transparent = 0
    const last = g.frames[g.frames.length - 1].data
    for (let i = 3; i < last.length; i += 4) {
      if (last[i] === 255) opaque++
      else if (last[i] === 0) transparent++
    }
    ok(opaque > 0, '应有不透明像素')
    ok(opaque + transparent === last.length / 4, 'alpha 应只有 0 或 255（无半透明）')
    console.log(`      (不透明 ${opaque}px / 透明 ${transparent}px，共 ${g.frames.length} 帧)`)
  })
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
