/**
 * esUtils.test.mjs —— 纯 Node 验证 esUtils.ts 的 ES 解析契约。
 *
 * 无需外部素材：用本机 ffmpeg 现场合成 1s 的 H.264 测试流(testsrc → Annex-B .h264)，
 * 再校验：NAL 扫描、访问单元分组(≈fps)、关键帧识别、codec 串(avc1.xxxxxx)、avcC description。
 *
 * 运行：node --experimental-strip-types test/esUtils.test.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import {
  findNals,
  indexAccessUnits,
  extractParamSets,
  codecStringFromSps,
  buildAvcCDescription,
  NAL,
  isVclSlice
} from '../src/renderer/src/pixi/h264/esUtils.ts'

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`) }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg ?? 'eq'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`) }

// ---- 合成一段 1s @30fps H.264 Annex-B ES ----
const ff = 'D:/Project/AudioVizNext/bin/ffmpeg.exe'
if (!existsSync(ff)) { console.error('跳过：找不到 ffmpeg'); process.exit(0) }
const esPath = join(tmpdir(), `avs_es_${randomBytes(4).toString('hex')}.h264`)
const r = spawnSync(ff, [
  '-y', '-v', 'error',
  '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x180:rate=30',
  '-c:v', 'libx264', '-profile:v', 'high', '-level', '5.0', '-g', '15', '-pix_fmt', 'yuv420p',
  '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', esPath
], { encoding: 'utf8', windowsHide: true })
assert(r.status === 0, `ffmpeg 合成失败: ${r.stderr}`)
const data = new Uint8Array(readFileSync(esPath))

console.log('ES 字节数:', data.length)

t('NAL 扫描：找到多个 NAL 且首尾类型合理', () => {
  const nals = findNals(data)
  // 1s@30fps 无 AUD：≈30 VCL 切片 + SPS/PPS/周期 SEI，至少 32 个
  assert(nals.length >= 32, `应有 ≥32 NAL(30fps*1s)，实际 ${nals.length}`)
  // 首帧应含 SPS/PPS/IDR
  const types = new Set(nals.map((n) => n.type))
  assert(types.has(NAL.SPS), '缺少 SPS(7)')
  assert(types.has(NAL.PPS), '缺少 PPS(8)')
  assert(types.has(NAL.IDR), '缺少 IDR(5)')
  assert(types.has(NAL.NON_IDR), '缺少非 IDR 切片(1)')
})

t('访问单元分组：≈30 AU 且首个 AU 是关键帧', () => {
  const nals = findNals(data)
  const aus = indexAccessUnits(nals, data.length)
  assert(Math.abs(aus.length - 30) <= 2, `AU 数 ${aus.length} 应接近 30`)
  assert(aus.length > 0 && aus[0].isKey, 'AU#0 必须是关键帧(SPS/PPS/SEI/IDR 合并为一 AU)')
  // 关键帧间隔 g=15 @30fps 1s → 恰好 2 个关键帧(帧0与帧15)
  const keys = aus.filter((a) => a.isKey).length
  assert(keys === 2, `关键帧数 ${keys} 应恰为 2（g=15 @30fps 1s：帧0+帧15）`)
})

t('关键帧锚点：单调且首个锚点是关键帧', () => {
  const nals = findNals(data)
  const aus = indexAccessUnits(nals, data.length)
  // 从 esUtils 引入定位函数的行为：从 AU0 起的连续定位，锚点应始终是 <= 目标的最近 IDR
  let lastAnchor = 0
  for (let f = 0; f < aus.length; f++) {
    let anchor = 0
    for (let i = 0; i < aus.length; i++) {
      if (aus[i].isKey) anchor = i
      if (i >= f) break
    }
    anchor = Math.min(anchor, Math.max(0, aus.length - 1))
    assert(anchor <= f, `锚点 ${anchor} 不应超过目标帧 ${f}`)
    assert(anchor >= lastAnchor, `锚点应单调不减：${anchor} < ${lastAnchor}`)
    assert(aus[anchor].isKey, `锚点 AU#${anchor} 必须是关键帧`)
    lastAnchor = anchor
  }
})

t('codec 串推导：High/L5.0 → avc1.640032', () => {
  const nals = findNals(data)
  const { spsBody } = extractParamSets(nals, data)
  assert(spsBody, '应有 SPS')
  const cs = codecStringFromSps(spsBody)
  eq(cs, 'avc1.640032', 'High profile(0x64)+L5.0(0x32) 应得到 avc1.640032')
})

t('avcC description 构造正确（结构 + 长度前缀）', () => {
  const nals = findNals(data)
  const { spsBody, ppsBody } = extractParamSets(nals, data)
  const avcc = buildAvcCDescription(spsBody, ppsBody)
  assert(avcc && avcc.length > 0, '应构造出 avcC')
  eq(avcc[0], 1, 'configurationVersion=1')
  eq(avcc[1], 0x64, 'profile_idc=0x64(High)')
  eq(avcc[3], 0x32, 'level_idc=0x32(L5.0)')
  eq(avcc[4], 0xff, 'lengthSizeMinusOne=3(4字节)')
  // numOfSPS=1; SPS 长度在 [6..7]
  const spsLen = (avcc[6] << 8) | avcc[7]
  eq(avcc[5], 0xe1, 'numOfSPS=1(高位0xe1)')
  const ppsPos = 8 + spsLen
  eq(avcc[ppsPos], 1, 'numOfPPS=1')
  const ppsLen = (avcc[ppsPos + 1] << 8) | avcc[ppsPos + 2]
  eq(ppsPos + 3 + ppsLen, avcc.length, 'avcC 总长 = 头 + SPS + PPS')
})

t('切片判定 isVclSlice', () => {
  assert(isVclSlice(1) && isVclSlice(5), 'type1/5 是切片')
  assert(!isVclSlice(6) && !isVclSlice(7) && !isVclSlice(9), 'SEI/SPS/AUD 不是切片')
})

import { rmSync } from 'node:fs'
try { rmSync(esPath, { force: true }) } catch { /* 忽略 */ }

console.log(`\n${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
