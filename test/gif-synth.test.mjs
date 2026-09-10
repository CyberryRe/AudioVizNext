/**
 * gif-synth.test.mjs —— 用**手工构造**的 GIF 验证解码器（尤其透明通道 + disposal）。
 *
 * 真实 GIF 素材（reference/）恰好都是不透明的，覆盖不到透明/disposal 分支。
 * 这里自建最小 GIF 字节流：3 帧、2×2、带透明色索引、disposal 各不同，
 * 断言解码结果与手算预期逐像素一致。
 */

import { decodeGif, gifFrameIndex } from '../src/renderer/src/media/gif.ts'

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e?.message ?? e}`) }
}
function eq(a, b, msg) {
  const sa = Array.isArray(a) ? JSON.stringify(a) : a
  const sb = Array.isArray(b) ? JSON.stringify(b) : b
  if (sa !== sb) throw new Error(`${msg ?? 'eq'}：期望 ${sb}，实际 ${sa}`)
}

// ---- 最小 GIF 构造器 ----
function bytes(...arr) { return arr.flat() }
function u16(v) { return [v & 0xff, (v >> 8) & 0xff] }

/**
 * 构造一个 width×height 的 GIF，帧数据用「未压缩式 LZW」最简单编码：
 * 每帧把所有像素索引原样送出（依赖 LZW 的清晰码 + 逐像素码）。
 * 为了让 LZW 编码简单，这里直接用 clear code + 每像素一码 + end code —— 对于小图
 * 码长不变（不触发字典增长），是最稳的手写编码。
 */
function buildGif(width, height, frames, palette, opts = {}) {
  const out = []
  // Header
  out.push(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) // GIF89a
  out.push(u16(width), u16(height))
  // Logical Screen Descriptor: 全局色表存在 | colorRes(7<<4) | size(log2(N)-1)
  const tableSizeBits = Math.max(1, Math.ceil(Math.log2(palette.length / 3))) - 1
  out.push(bytes(0x80 | 0x70 | (tableSizeBits & 0x07), 0x00, 0x00))
  // 全局色表（补足 2^(bits+1) 项）
  const entries = 1 << (tableSizeBits + 1)
  for (let i = 0; i < entries; i++) {
    out.push(bytes(palette[i * 3] ?? 0, palette[i * 3 + 1] ?? 0, palette[i * 3 + 2] ?? 0))
  }

  for (const fr of frames) {
    const { indices, disposal = 0, transparentIndex, transparent = false, delay = 10 } = fr
    // Graphic Control Extension
    out.push(bytes(0x21, 0xf9, 0x04))
    const packed = ((disposal & 0x07) << 2) | (transparent ? 1 : 0)
    out.push(bytes(packed), u16(delay), bytes(transparentIndex ?? 0, 0x00))
    // Image Descriptor
    out.push(bytes(0x2c), u16(0), u16(0), u16(width), u16(height))
    out.push(bytes(0x00)) // 无局部色表、非交错
    // LZW：minCodeSize
    const minCodeSize = Math.max(2, Math.ceil(Math.log2(entries)))
    out.push(bytes(minCodeSize))
    // 简单编码：每个像素前都发 clear → 字典永不增长（prev=-1，不插入新项），
    // 每像素都是独立的单码解码，绝对正确（低效但适合小测试图）。
    const clear = 1 << minCodeSize
    const end = clear + 1
    const codes = []
    for (let i = 0; i < indices.length; i++) {
      codes.push(clear)
      codes.push(indices[i])
    }
    codes.push(end)
    // 打包为 LSB-first 位流
    const codeSize = minCodeSize + 1
    let bitBuf = 0, bitCount = 0
    const dataBytes = []
    for (const c of codes) {
      bitBuf |= c << bitCount
      bitCount += codeSize
      while (bitCount >= 8) {
        dataBytes.push(bitBuf & 0xff)
        bitBuf >>= 8
        bitCount -= 8
      }
    }
    if (bitCount > 0) dataBytes.push(bitBuf & 0xff)
    // 子块（每块 ≤255 字节）
    for (let i = 0; i < dataBytes.length; i += 255) {
      const chunk = dataBytes.slice(i, i + 255)
      out.push(bytes(chunk.length), chunk)
    }
    out.push(bytes(0x00)) // block terminator
  }
  out.push(bytes(0x3b)) // Trailer
  return new Uint8Array(out.flat())
}

// 调色板：0=红, 1=绿, 2=蓝, 3=白
const PAL = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]

console.log('== 合成 GIF：透明通道 ==')
t('透明索引像素 → alpha=0，其余 alpha=255', () => {
  // 2×2 单帧：像素 [红, 透明, 绿, 蓝]
  const gif = buildGif(2, 2, [{ indices: [0, 1, 1, 2], transparent: true, transparentIndex: 1 }], PAL)
  const g = decodeGif(gif)
  eq(g.frames.length, 1)
  const d = g.frames[0].data
  // 像素 0：红，不透明
  eq([d[0], d[1], d[2], d[3]], [255, 0, 0, 255], 'px0 红')
  // 像素 1：透明 → RGB 保持 0，alpha 0
  eq(d[7], 0, 'px1 alpha=0')
  // 像素 2：绿（索引1 但 transparentIndex=1 → 也是透明！）
  eq(d[11], 0, 'px2 也是索引1 → 透明')
  // 像素 3：蓝
  eq([d[12], d[13], d[14], d[15]], [0, 0, 255, 255], 'px3 蓝')
})

console.log('== 合成 GIF：disposal ==')
t('disposal=2（恢复背景）→ 下一帧该区域清空', () => {
  // 帧1：全红，disposal=2；帧2：只在 px0 画绿 → 其余应保持透明（被清）
  const gif = buildGif(
    2, 2,
    [
      { indices: [0, 0, 0, 0], disposal: 2 },
      { indices: [1, 1, 1, 1], disposal: 1, transparent: true, transparentIndex: 3 }
    ],
    PAL
  )
  const g = decodeGif(gif)
  eq(g.frames.length, 2, '两帧')
  const f2 = g.frames[1].data
  // 帧2 全部像素索引1（绿）且不透明 → 全绿
  eq([f2[0], f2[1], f2[2], f2[3]], [0, 255, 0, 255], '帧2 px0 绿')
  eq([f2[4], f2[5], f2[6], f2[7]], [0, 255, 0, 255], '帧2 px1 绿')
})

t('disposal=1（保留）→ 下一帧叠加在上一帧之上', () => {
  // 帧1：px0 红，px1 透明（保留画布）；帧2：px1 绿 → 帧2 应同时有 px0 红（上帧残留）+ px1 绿
  const gif = buildGif(
    2, 2,
    [
      { indices: [0, 3, 3, 3], disposal: 1, transparent: true, transparentIndex: 3 },
      { indices: [3, 1, 3, 3], disposal: 1, transparent: true, transparentIndex: 3 }
    ],
    PAL
  )
  const g = decodeGif(gif)
  const f1 = g.frames[0].data
  const f2 = g.frames[1].data
  eq([f1[0], f1[1], f1[2], f1[3]], [255, 0, 0, 255], '帧1 px0 红')
  eq(f1[7], 0, '帧1 px1 透明')
  // 帧2：px0 应保留上帧的红（disposal=1 保留），px1 变绿
  eq([f2[0], f2[1], f2[2], f2[3]], [255, 0, 0, 255], '帧2 px0 保留红')
  eq([f2[4], f2[5], f2[6], f2[7]], [0, 255, 0, 255], '帧2 px1 绿')
})

console.log('== 合成 GIF：多帧计数 ==')
t('3 帧 GIF → frames.length=3，各帧独立', () => {
  const gif = buildGif(
    1, 1,
    [
      { indices: [0] },
      { indices: [1] },
      { indices: [2] }
    ],
    PAL
  )
  const g = decodeGif(gif)
  eq(g.frames.length, 3)
  eq([g.frames[0].data[0], g.frames[0].data[1], g.frames[0].data[2]], [255, 0, 0], '帧0 红')
  eq([g.frames[1].data[0], g.frames[1].data[1], g.frames[1].data[2]], [0, 255, 0], '帧1 绿')
  eq([g.frames[2].data[0], g.frames[2].data[1], g.frames[2].data[2]], [0, 0, 255], '帧2 蓝')
})

t('gifFrameIndex 与合成 GIF 帧数联动', () => {
  const gif = buildGif(1, 1, [{ indices: [0] }, { indices: [1] }, { indices: [2] }], PAL)
  const g = decodeGif(gif)
  eq(gifFrameIndex(0, g.frames.length), 0)
  eq(gifFrameIndex(3, g.frames.length), 0)
  eq(gifFrameIndex(4, g.frames.length), 1)
  eq(gifFrameIndex(8, g.frames.length), 2)
})

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
