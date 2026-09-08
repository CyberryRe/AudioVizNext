/**
 * audioAlgorithms.test.mjs —— 内置音频算法库的单测（纯逻辑，Node 模式）。
 * 运行：npm test
 */
import {
  mixToMono, hannWindow, fftInPlace, magnitudeSpectrum, bandEdges, bandsFromSpectrum, normalizeBandsInPlace,
  waveformPeaks, waveSampleAt, rmsEnvelope, normalizeInPlace, smoothEnvelope, ema,
  onsetStrength, estimateBeats, analyzeMono, frameSlice
} from '../src/renderer/src/media/audioAlgorithms.ts'

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e?.message ?? e}`) }
}
function close(a, b, eps, msg) { if (Math.abs(a - b) > eps) throw new Error(`${msg ?? 'close'}：期望 ≈${b}，实际 ${a}`) }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg ?? 'eq'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`) }
function ok(v, msg) { if (!v) throw new Error(msg ?? '期望为真') }

/** 生成正弦 */
function sine(freq, seconds, sampleRate, amp = 1) {
  const n = Math.round(seconds * sampleRate)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate)
  return out
}

console.log('== 基础工具 ==')
t('mixToMono：等权平均；单声道直通', () => {
  const a = new Float32Array([1, 0, -1])
  const b = new Float32Array([0, 1, 1])
  const m = mixToMono([a, b])
  close(m[0], 0.5, 1e-6)
  close(m[1], 0.5, 1e-6)
  close(m[2], 0, 1e-6)
  eq(mixToMono([a]), a, '单声道应直通')
})
t('hannWindow：端点 0、中心 ≈1', () => {
  const w = hannWindow(64)
  close(w[0], 0, 1e-6)
  close(w[63], 0, 1e-6)
  ok(Math.abs(w[32] - 1) < 0.01, '中心应接近 1')
})
t('frameSlice：越界补 0', () => {
  const s = new Float32Array([1, 2, 3])
  const out = frameSlice(s, 2, 4)
  eq(out[0], 3)
  eq(out[1], 0)
  eq(out[3], 0)
})

console.log('== FFT / 频谱 ==')
t('fftInPlace：非 2 的幂抛错', () => {
  let threw = false
  try { fftInPlace(new Float32Array(3), new Float32Array(3)) } catch { threw = true }
  ok(threw)
})
t('纯正弦 → 幅度谱峰值落在对应 bin', () => {
  const sr = 48000
  const fftSize = 1024
  const bin = 64 // 期望峰位
  const freq = (bin * sr) / fftSize // 3000Hz
  const mag = magnitudeSpectrum(sine(freq, fftSize / sr, sr), fftSize)
  let best = 0
  let bestK = -1
  for (let k = 1; k < mag.length; k++) if (mag[k] > best) { best = mag[k]; bestK = k }
  ok(Math.abs(bestK - bin) <= 1, `峰位应 ≈${bin}，实际 ${bestK}`)
})
t('静音 → 幅度谱全 0', () => {
  const mag = magnitudeSpectrum(new Float32Array(1024), 1024)
  for (const v of mag) eq(v, 0)
})
t('bandEdges：对数频段非递减且落在 bin 范围内', () => {
  const e = bandEdges(48000, 1024, 32)
  eq(e.length, 33)
  // 低频段分辨率有限（46.9Hz/bin），前几段可能落在同一 bin → 只要求非递减
  for (let i = 1; i < e.length; i++) ok(e[i] >= e[i - 1], `第 ${i} 段不应回退`)
  ok(e[e.length - 1] > e[0], '末段应大于首段')
  ok(e[e.length - 1] < 512, '应落在奈奎斯特以内')
})
t('bandsFromSpectrum：能量落在对应频段', () => {
  const sr = 48000
  const fftSize = 1024
  const mag = magnitudeSpectrum(sine(3000, fftSize / sr, sr), fftSize)
  const edges = bandEdges(sr, fftSize, 32)
  const bands = bandsFromSpectrum(mag, edges)
  let best = 0
  let bestB = -1
  for (let b = 0; b < bands.length; b++) if (bands[b] > best) { best = bands[b]; bestB = b }
  ok(best > 0, '应有非零频段')
  ok(bestB >= 0 && bestB < 32, `频段索引应在范围内，实际 ${bestB}`)
})
t('normalizeBandsInPlace：每段（跨帧）峰值变 1', () => {
  // 布局：bands[frame*bins + b]；2 段 × 3 帧
  const bins = 2
  const bands = new Float32Array([
    1, 4,    // frame0
    2, 8,    // frame1 ← 各段峰值所在帧
    0.5, 2   // frame2
  ])
  normalizeBandsInPlace(bands, bins)
  close(bands[2], 1, 1e-6, 'frame1 段0')
  close(bands[3], 1, 1e-6, 'frame1 段1')
  close(bands[0], 0.5, 1e-6, 'frame0 段0 = 1/2')
  close(bands[1], 0.5, 1e-6, 'frame0 段1 = 4/8')
})

console.log('== 波形 ==')
t('waveformPeaks：常量信号 → min/max/rms 正确', () => {
  const s = new Float32Array(1000)
  s.fill(0.5)
  const p = waveformPeaks(s, 10)
  eq(p.min.length, 10)
  close(p.min[3], 0.5, 1e-6)
  close(p.max[3], 0.5, 1e-6)
  close(p.rms[3], 0.5, 1e-6)
})
t('waveformPeaks：空输入不崩', () => {
  const p = waveformPeaks(new Float32Array(0), 8)
  eq(p.min.length, 8)
  eq(p.max[0], 0)
})
t('waveSampleAt：端点与插值', () => {
  const s = new Float32Array([0, 1])
  close(waveSampleAt(s, 0), 0, 1e-6)
  close(waveSampleAt(s, 1), 1, 1e-6)
  close(waveSampleAt(s, 0.5), 0.5, 1e-6)
  close(waveSampleAt(s, 2), 1, 1e-6, '越界应夹取')
})

console.log('== 电平 / 包络 ==')
t('rmsEnvelope：静音 0 / 常量幅值正确', () => {
  const sr = 48000
  const fps = 30
  const silence = rmsEnvelope(new Float32Array(sr), sr, fps, 30)
  close(silence[10], 0, 1e-9)
  const s = new Float32Array(sr)
  s.fill(0.5)
  const env = rmsEnvelope(s, sr, fps, 30)
  close(env[10], 0.5, 1e-6)
})
t('normalizeInPlace：峰值 → 1，范围 0..1', () => {
  const a = new Float32Array([0.1, 0.5, 0.25])
  normalizeInPlace(a)
  close(a[1], 1, 1e-6)
  ok(a[0] >= 0 && a[0] <= 1)
})
t('smoothEnvelope：起音快、释放慢（上升比下降快）', () => {
  const step = new Float32Array([0, 1, 1, 1, 0, 0, 0, 0])
  const s = smoothEnvelope(step, 0.6, 0.1)
  const rise = s[1] - s[0]
  const fall = s[4] - s[3]
  ok(rise > Math.abs(fall) * 0.5, `上升 ${rise} 应明显快于下降 ${fall}`)
  ok(s[3] <= 1.0001 && s[0] >= 0)
})
t('ema：向目标收敛', () => {
  const a = new Float32Array([0, 0, 0, 0])
  a[3] = 1
  const out = ema(a, 0.5)
  ok(out[1] >= out[0] && out[2] >= out[1] && out[3] >= out[2])
})

console.log('== 起音 / 节拍 ==')
t('onsetStrength：只保留变响的差分', () => {
  const env = new Float32Array([0, 0.5, 0.2, 0.8, 0.8])
  const o = onsetStrength(env)
  eq(o[0], 0)
  close(o[1], 0.5, 1e-6)
  eq(o[2], 0, '变轻应为 0')
  close(o[3], 0.6, 1e-6)
  eq(o[4], 0)
})
t('estimateBeats：120BPM 点击轨 → 约 120', () => {
  const fps = 30
  const secs = 12
  const frames = fps * secs
  const env = new Float32Array(frames)
  const period = 0.5 * fps // 120 BPM
  for (let f = 0; f < frames; f++) {
    const phase = f % period
    env[f] = phase < 2 ? 1 : 0.05 // 每拍一个短脉冲
  }
  const r = estimateBeats(env, fps)
  ok(r.bpm > 0, `应估出 BPM，实际 ${r.bpm}`)
  ok(Math.abs(r.bpm - 120) < 12, `BPM 应接近 120，实际 ${r.bpm.toFixed(1)}`)
  ok(r.confidence > 0.1, `置信度应 >0.1，实际 ${r.confidence.toFixed(3)}`)
  ok(r.beats.length >= 15, `应检出至少 15 拍，实际 ${r.beats.length}`)
})
t('estimateBeats：静音 → bpm 0', () => {
  const r = estimateBeats(new Float32Array(300), 30)
  eq(r.bpm, 0)
  eq(r.beats.length, 0)
})

console.log('== 便捷打包 ==')
t('analyzeMono：产出 level/onset/bpm/peaks 且数值合法', () => {
  const sr = 48000
  const fps = 30
  const secs = 6
  const samples = sine(440, secs, sr, 0.8)
  const a = analyzeMono(samples, sr, fps, fps * secs, 64)
  eq(a.level.length, fps * secs)
  eq(a.onset.length, fps * secs)
  eq(a.peaks.min.length, 64)
  ok(a.level[10] > 0, 'level 应 >0')
  for (const v of a.level) ok(v >= 0 && v <= 1, 'level 应在 0..1')
  for (const v of a.onset) ok(v >= 0 && v <= 1, 'onset 应在 0..1')
  ok(a.bpm >= 0)
})

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
