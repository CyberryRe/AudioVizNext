/**
 * audioAlgorithms.ts —— **内置音频分析算法库**（纯函数，无副作用，可单测）。
 *
 * 目的：波形/频谱/电平/节拍这些"通用算法"只实现一次，供三方调用，避免每个可视化样式各造轮子：
 *   - 预设 drawer（`presets/drawers/*.ts`）直接 import；
 *   - 第三方预设脚本通过白名单 api 调用（见 `presets/registry.ts` 的 PRESET_SCRIPT_API）；
 *   - 渲染层组件（预览/导出/将来的时间轴波形显示）用同一套，保证结果一致。
 *
 * 约定：
 *   - 输入样本一律 **mono Float32Array（-1..1）**；多声道请先自行混单（`mixToMono`）。
 *   - 时间单位是**秒**，帧相关函数显式传 `fps`，不猜。
 *   - 所有函数不改输入（标了 InPlace 的除外）。
 */

// ============================================================================
// 基础工具
// ============================================================================

/** 多声道混单（等权平均；单声道直接返回原数组） */
export function mixToMono(channels: Float32Array[], length?: number): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const n = length ?? channels[0].length
  const out = new Float32Array(n)
  for (let c = 0; c < channels.length; c++) {
    const src = channels[c]
    for (let i = 0; i < n; i++) out[i] += src[i] ?? 0
  }
  const inv = 1 / channels.length
  for (let i = 0; i < n; i++) out[i] *= inv
  return out
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Hann 窗（FFT 前加窗减少频谱泄漏） */
export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

// ============================================================================
// FFT / 频谱
// ============================================================================

/**
 * 原地迭代式 radix-2 FFT（长度必须是 2 的幂）。不引入依赖。
 * 输入实部/虚部，输出频域实部/虚部（未归一化）。
 */
export function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length
  if (n !== im.length || (n & (n - 1)) !== 0) throw new Error('fftInPlace: 长度必须是 2 的幂且 re/im 等长')
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k]
        const uIm = im[i + k]
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe
        re[i + k] = uRe + vRe
        im[i + k] = uIm + vIm
        re[i + k + len / 2] = uRe - vRe
        im[i + k + len / 2] = uIm - vIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

/** 幅度谱：返回长度 fftSize/2 的幅度数组（已加窗、未归一化） */
export function magnitudeSpectrum(samples: Float32Array, fftSize = 1024, window?: Float32Array): Float32Array {
  const n = fftSize
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  const w = window ?? hannWindow(n)
  for (let i = 0; i < n; i++) re[i] = (samples[i] ?? 0) * (w[i] ?? 1)
  fftInPlace(re, im)
  const half = n >> 1
  const mag = new Float32Array(half)
  for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k])
  return mag
}

/** 频段边界（对数或线性），返回长度 bins+1 的 FFT bin 索引 */
export function bandEdges(
  sampleRate: number,
  fftSize: number,
  bins: number,
  fMin = 30,
  fMax = 16000,
  log = true
): Int32Array {
  const binHz = sampleRate / fftSize
  const nyq = sampleRate / 2 - binHz
  const hi = Math.max(fMin * 2, Math.min(fMax, nyq))
  const edges = new Int32Array(bins + 1)
  for (let b = 0; b <= bins; b++) {
    const f = log ? fMin * Math.pow(hi / fMin, b / bins) : fMin + ((hi - fMin) * b) / bins
    edges[b] = Math.max(1, Math.round(f / binHz))
  }
  return edges
}

/** 按频段边界聚合幅度谱（每段取平均） */
export function bandsFromSpectrum(mag: Float32Array, edges: Int32Array): Float32Array {
  const bins = edges.length - 1
  const out = new Float32Array(bins)
  for (let b = 0; b < bins; b++) {
    const k0 = edges[b]
    const k1 = Math.max(k0 + 1, edges[b + 1])
    let sum = 0
    let n = 0
    for (let k = k0; k < Math.min(k1, mag.length); k++) { sum += mag[k]; n++ }
    out[b] = n > 0 ? sum / n : 0
  }
  return out
}

/** 每个频段按整条序列的峰值归一化（0..1），可加 gamma（<1 提亮低端） */
export function normalizeBandsInPlace(bands: Float32Array, bins: number, gamma = 1): Float32Array {
  const frames = Math.floor(bands.length / bins)
  const max = new Float32Array(bins)
  for (let f = 0; f < frames; f++) {
    for (let b = 0; b < bins; b++) {
      const v = bands[f * bins + b]
      if (v > max[b]) max[b] = v
    }
  }
  for (let b = 0; b < bins; b++) {
    const inv = max[b] > 1e-9 ? 1 / max[b] : 0
    for (let f = 0; f < frames; f++) {
      const i = f * bins + b
      const v = clamp01(bands[i] * inv)
      bands[i] = gamma === 1 ? v : Math.pow(v, gamma)
    }
  }
  return bands
}

// ============================================================================
// 波形
// ============================================================================

export interface WaveformPeaks {
  /** 每桶最小值（-1..1） */
  min: Float32Array
  /** 每桶最大值（-1..1） */
  max: Float32Array
  /** 每桶 RMS（0..1） */
  rms: Float32Array
}

/**
 * 把长波形压成 N 桶的 min/max/rms（时间轴波形显示、缩略图用）。
 * 典型用法：`waveformPeaks(samples, 1200)` → 画竖线 `[min,max]`。
 */
export function waveformPeaks(samples: Float32Array, buckets: number): WaveformPeaks {
  const n = Math.max(1, Math.floor(buckets))
  const min = new Float32Array(n)
  const max = new Float32Array(n)
  const rms = new Float32Array(n)
  if (samples.length === 0) return { min, max, rms }
  const per = samples.length / n
  for (let b = 0; b < n; b++) {
    const s0 = Math.floor(b * per)
    const s1 = Math.max(s0 + 1, Math.min(samples.length, Math.floor((b + 1) * per)))
    let lo = Infinity
    let hi = -Infinity
    let sum = 0
    for (let i = s0; i < s1; i++) {
      const v = samples[i]
      if (v < lo) lo = v
      if (v > hi) hi = v
      sum += v * v
    }
    min[b] = Number.isFinite(lo) ? lo : 0
    max[b] = Number.isFinite(hi) ? hi : 0
    rms[b] = Math.sqrt(sum / (s1 - s0))
  }
  return { min, max, rms }
}

/** 按相对位置 t∈[0,1] 线性插值取样波形（0 与 1 分别对应首尾样本） */
export function waveSampleAt(samples: Float32Array, t: number): number {
  if (samples.length === 0) return 0
  const x = clamp01(t) * (samples.length - 1)
  const i = Math.floor(x)
  const f = x - i
  const a = samples[i] ?? 0
  const b = samples[Math.min(samples.length - 1, i + 1)] ?? a
  return lerp(a, b, f)
}

/** 取以 start 为起点的 count 个样本（越界补 0） */
export function frameSlice(samples: Float32Array, start: number, count: number): Float32Array {
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = samples[start + i] ?? 0
  return out
}

// ============================================================================
// 电平 / 包络
// ============================================================================

/** 逐帧 RMS（原始值，未归一化） */
export function rmsEnvelope(samples: Float32Array, sampleRate: number, fps: number, frames: number): Float32Array {
  const out = new Float32Array(Math.max(0, frames))
  if (sampleRate <= 0 || fps <= 0) return out
  const per = sampleRate / fps
  for (let f = 0; f < frames; f++) {
    const s0 = Math.floor(f * per)
    const s1 = Math.min(samples.length, Math.floor((f + 1) * per))
    let sum = 0
    let n = 0
    for (let i = s0; i < s1; i++) { const v = samples[i]; sum += v * v; n++ }
    out[f] = n > 0 ? Math.sqrt(sum / n) : 0
  }
  return out
}

/** 按峰值归一化到 0..1，可加 gamma（<1 提亮） */
export function normalizeInPlace(arr: Float32Array, gamma = 1): Float32Array {
  let peak = 1e-9
  for (let i = 0; i < arr.length; i++) if (arr[i] > peak) peak = arr[i]
  const inv = 1 / peak
  for (let i = 0; i < arr.length; i++) {
    const v = clamp01(arr[i] * inv)
    arr[i] = gamma === 1 ? v : Math.pow(v, gamma)
  }
  return arr
}

/**
 * 起音快 / 释放慢的单极平滑（视觉上不抖）。
 * @param attack 0..1，越大越快跟上（默认 0.55）
 * @param release 0..1，越小越慢回落（默认 0.12）
 */
export function smoothEnvelope(env: Float32Array, attack = 0.55, release = 0.12): Float32Array {
  const out = new Float32Array(env.length)
  let v = 0
  for (let i = 0; i < env.length; i++) {
    const target = env[i]
    v = target > v ? v + (target - v) * attack : v + (target - v) * release
    out[i] = v
  }
  return out
}

/** 指数滑动平均（通用降噪） */
export function ema(arr: Float32Array, alpha: number): Float32Array {
  const out = new Float32Array(arr.length)
  let v = arr[0] ?? 0
  for (let i = 0; i < arr.length; i++) {
    v = v + (arr[i] - v) * alpha
    out[i] = v
  }
  return out
}

// ============================================================================
// 节拍 / 起音
// ============================================================================

/** 起音强度：能量包络的半波整流正向差分（>0 = 变响） */
export function onsetStrength(env: Float32Array): Float32Array {
  const out = new Float32Array(env.length)
  for (let i = 1; i < env.length; i++) {
    const d = env[i] - env[i - 1]
    out[i] = d > 0 ? d : 0
  }
  return out
}

export interface BeatResult {
  /** 估计 BPM（0 = 无法判断） */
  bpm: number
  /** 0..1 置信度（自相关峰值相对平均的突出程度） */
  confidence: number
  /** 节拍所在帧（从 0 开始，含首拍对齐） */
  beats: Int32Array
}

/**
 * 由能量包络估计节拍（自相关法）。
 * 典型用法：可视化做"每拍脉冲"、时间轴做拍点吸附。
 */
export function estimateBeats(env: Float32Array, fps: number, minBpm = 60, maxBpm = 200): BeatResult {
  const empty: BeatResult = { bpm: 0, confidence: 0, beats: new Int32Array(0) }
  if (env.length < 8 || fps <= 0) return empty
  const onset = smoothEnvelope(onsetStrength(env), 0.8, 0.2)
  let mean = 0
  for (let i = 0; i < onset.length; i++) mean += onset[i]
  mean /= onset.length
  if (mean < 1e-6) return empty

  const lagMin = Math.max(1, Math.round((60 / maxBpm) * fps))
  const lagMax = Math.max(lagMin + 1, Math.round((60 / minBpm) * fps))
  let bestLag = 0
  let bestScore = 0
  let scoreSum = 0
  let scoreCount = 0
  for (let lag = lagMin; lag <= lagMax && lag < onset.length; lag++) {
    let s = 0
    for (let i = lag; i < onset.length; i++) s += onset[i] * onset[i - lag]
    s /= onset.length - lag
    scoreSum += s
    scoreCount++
    if (s > bestScore) { bestScore = s; bestLag = lag }
  }
  if (bestLag === 0 || bestScore <= 0) return empty
  const avg = scoreCount > 0 ? scoreSum / scoreCount : 0
  const confidence = clamp01(avg > 0 ? (bestScore - avg) / bestScore : 0)
  const bpm = (60 * fps) / bestLag

  // 拍点：以 onset 的局部峰为候选，按周期对齐取最近的峰
  const period = bestLag
  const beats: number[] = []
  const thr = mean * 1.2
  let next = 0
  for (let i = 1; i < onset.length - 1; i++) {
    if (onset[i] > thr && onset[i] >= onset[i - 1] && onset[i] >= onset[i + 1] && i >= next) {
      beats.push(i)
      next = i + period * 0.6
    }
  }
  return { bpm, confidence, beats: Int32Array.from(beats) }
}

// ============================================================================
// 便捷打包：一次性算出可视化需要的所有逐帧数据
// ============================================================================

export interface FrameAnalysis {
  fps: number
  frames: number
  /** 逐帧电平 0..1（已归一化+平滑） */
  level: Float32Array
  /** 逐帧起音强度 0..1 */
  onset: Float32Array
  /** 逐帧 BPM 估计（整轨一个值，便于直接读） */
  bpm: number
  bpmConfidence: number
  /** 节拍帧 */
  beats: Int32Array
  /** 整轨波形峰值（buckets 桶），供时间轴/缩略图 */
  peaks: WaveformPeaks
}

/** 从 mono 样本一次性算出"电平 + 起音 + 节拍 + 波形峰值" */
export function analyzeMono(samples: Float32Array, sampleRate: number, fps: number, frames: number, peakBuckets = 1200): FrameAnalysis {
  const level = normalizeInPlace(rmsEnvelope(samples, sampleRate, fps, frames), 0.55)
  const beat = estimateBeats(level, fps)
  const onset = normalizeInPlace(smoothEnvelope(onsetStrength(level), 0.7, 0.25), 0.8)
  return {
    fps,
    frames,
    level,
    onset,
    bpm: beat.bpm,
    bpmConfidence: beat.confidence,
    beats: beat.beats,
    peaks: waveformPeaks(samples, peakBuckets)
  }
}
