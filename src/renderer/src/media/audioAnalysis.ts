/**
 * audioAnalysis.ts —— 工程级音频分析数据（可视化/效果预设的驱动信号）。
 *
 * 分工：
 *  - **算法**全部来自 `media/audioAlgorithms.ts`（内置算法库，纯函数、可单测、对外暴露）——
 *    本文件不重复实现 FFT/包络/节拍，只负责"按工程帧率把算法结果打成逐帧可 O(1) 取样的数据"。
 *  - **线程**：主线程离线渲染一次混音 → 算好 → 预览直接用、导出 transfer 进 Worker（同一条数据 → 预览≡导出）。
 *
 * 数据布局（帧对齐）：
 *   wave[frame * WAVE_SAMPLES + i]   波形快照 -1..1
 *   freq[frame * FREQ_BINS + i]      频谱幅度 0..1（对数频段，逐段归一化）
 *   level[frame]                     电平 0..1（RMS + 对数压缩）
 *   onset[frame]                     起音强度 0..1
 *   spawnPrefix[frame]               到该帧累计发射粒子数（粒子出生帧反查）
 *   beats / bpm                      节拍帧与 BPM 估计（自相关）
 */
import type { Project } from '../model/timeline'
import {
  mixToMono, magnitudeSpectrum, bandEdges, bandsFromSpectrum, normalizeBandsInPlace,
  rmsEnvelope, normalizeInPlace, smoothEnvelope, onsetStrength, estimateBeats, frameSlice,
  type BeatResult
} from './audioAlgorithms'

/** 每帧波形样本数（1920 宽、4px 步进约 480 点，512 足够） */
export const WAVE_SAMPLES = 512
/** 每帧频谱 bin 数（对数频段 30Hz..16kHz） */
export const FREQ_BINS = 256
/** FFT 窗口（48kHz 下 1024 点 ≈ 21ms） */
const FFT_SIZE = 1024

export interface PresetAudioData {
  fps: number
  frames: number
  waveSamples: number
  freqBins: number
  wave: Float32Array
  freq: Float32Array
  level: Float32Array
  /** 逐帧起音强度 0..1（打击/重音处为峰值） */
  onset: Float32Array
  spawnPrefix: Int32Array
  /** 节拍估计（自相关） */
  bpm: number
  bpmConfidence: number
  beats: Int32Array
}

/** 空数据（无音频时的兜底：波形为直线、频谱为 0、仍会发射少量粒子） */
export function emptyAudioData(fps: number, frames: number): PresetAudioData {
  const level = new Float32Array(frames)
  level.fill(0.25)
  const prefix = new Int32Array(frames + 1)
  for (let f = 0; f < frames; f++) prefix[f + 1] = prefix[f] + Math.max(1, Math.round(level[f] * 6))
  return {
    fps,
    frames,
    waveSamples: WAVE_SAMPLES,
    freqBins: FREQ_BINS,
    wave: new Float32Array(frames * WAVE_SAMPLES),
    freq: new Float32Array(frames * FREQ_BINS),
    level,
    onset: new Float32Array(frames),
    spawnPrefix: prefix,
    bpm: 0,
    bpmConfidence: 0,
    beats: new Int32Array(0)
  }
}

/** 由 planar Float32 PCM 计算逐帧分析数据（纯函数；导出侧复用已渲染的混音 PCM，零额外解码）。 */
export function analyzePcm(
  channels: Float32Array[],
  sampleRate: number,
  fps: number,
  totalFrames: number
): PresetAudioData {
  const data = emptyAudioData(fps, totalFrames)
  if (!channels.length || sampleRate <= 0 || fps <= 0 || totalFrames <= 0) return data

  const mono = mixToMono(channels)
  const len = mono.length
  const perFrame = sampleRate / fps

  // —— 波形快照（逐帧）——
  let peakSample = 1e-6
  for (let f = 0; f < totalFrames; f++) {
    const start = Math.max(0, Math.min(len - WAVE_SAMPLES, Math.floor(f * perFrame)))
    const slice = frameSlice(mono, start, WAVE_SAMPLES)
    data.wave.set(slice, f * WAVE_SAMPLES)
    for (let i = 0; i < WAVE_SAMPLES; i++) {
      const a = Math.abs(slice[i])
      if (a > peakSample) peakSample = a
    }
  }
  const wGain = 1 / peakSample
  for (let i = 0; i < data.wave.length; i++) data.wave[i] = Math.max(-1, Math.min(1, data.wave[i] * wGain))

  // —— 电平 + 起音 + 节拍（算法库）——
  const level = normalizeInPlace(rmsEnvelope(mono, sampleRate, fps, totalFrames), 0.55)
  data.level.set(level)
  data.onset.set(normalizeInPlace(smoothEnvelope(onsetStrength(level), 0.7, 0.25), 0.8))
  const beat: BeatResult = estimateBeats(level, fps)
  data.bpm = beat.bpm
  data.bpmConfidence = beat.confidence
  data.beats = beat.beats

  // —— 频谱（算法库：加窗 FFT → 对数频段 → 逐段归一化）——
  const win = undefined // magnitudeSpectrum 内部默认 Hann
  const edges = bandEdges(sampleRate, FFT_SIZE, FREQ_BINS)
  for (let f = 0; f < totalFrames; f++) {
    const center = Math.round(f * perFrame)
    const start = Math.max(0, Math.min(len - FFT_SIZE, center - FFT_SIZE / 2))
    const mag = magnitudeSpectrum(frameSlice(mono, start, FFT_SIZE), FFT_SIZE, win)
    const bands = bandsFromSpectrum(mag, edges)
    data.freq.set(bands, f * FREQ_BINS)
  }
  normalizeBandsInPlace(data.freq, FREQ_BINS)

  // —— 粒子发射前缀：每帧发射 max(1, round(level*6)) 颗（与旧项目一致）——
  for (let f = 0; f < totalFrames; f++) {
    data.spawnPrefix[f + 1] = data.spawnPrefix[f] + Math.max(1, Math.round(data.level[f] * 6))
  }
  return data
}

// ===== 取样辅助（帧对齐数据的 O(1) 取值）=====

/** 波形取值：t∈[0,1] 映射到该帧波形样本 */
export function waveValue(data: PresetAudioData | null | undefined, frame: number, t: number): number {
  if (!data || !data.wave.length) return 0
  const f = Math.max(0, Math.min(data.frames - 1, Math.round(frame)))
  const idx = Math.max(0, Math.min(data.waveSamples - 1, Math.floor(t * (data.waveSamples - 1))))
  return data.wave[f * data.waveSamples + idx]
}

/**
 * 频谱取值：index/count 映射到该帧频谱 bin，gamma 低端增益（默认 1.3，与旧项目一致）。
 * ⚠ bin 间必须**线性插值**：对数频段在高频每 bin 跨的 Hz 很宽，若用 floor 取整，
 * 横向等距采样会踩出「锯齿/台阶」副线（用户报的高频锯齿根因）。
 */
export function freqValue(
  data: PresetAudioData | null | undefined,
  frame: number,
  index: number,
  count: number,
  gamma = 1.3
): number {
  if (!data || !data.freq.length || count <= 0) return 0
  const f = Math.max(0, Math.min(data.frames - 1, Math.round(frame)))
  const bins = data.freqBins
  const x = Math.max(0, Math.min(bins - 1, (index / count) * (bins - 1)))
  const i0 = Math.floor(x)
  const i1 = Math.min(bins - 1, i0 + 1)
  const t = x - i0
  const base = f * bins
  const a = data.freq[base + i0]
  const b = data.freq[base + i1]
  const v = a + (b - a) * t
  return Math.pow(Math.max(0, Math.min(1, v)), gamma)
}

/** 某帧电平（越界 → 0.25 静息值） */
export function levelAt(data: PresetAudioData | null | undefined, frame: number): number {
  if (!data || !data.level.length) return 0.25
  return data.level[Math.max(0, Math.min(data.frames - 1, Math.round(frame)))]
}

/** 某帧起音强度（0..1） */
export function onsetAt(data: PresetAudioData | null | undefined, frame: number): number {
  if (!data || !data.onset.length) return 0
  return data.onset[Math.max(0, Math.min(data.frames - 1, Math.round(frame)))]
}

/** 某帧是否为节拍点（拍点吸附/脉冲特效用） */
export function isBeatFrame(data: PresetAudioData | null | undefined, frame: number, tol = 1): boolean {
  if (!data || data.beats.length === 0) return false
  const f = Math.round(frame)
  for (let i = 0; i < data.beats.length; i++) {
    const d = Math.abs(data.beats[i] - f)
    if (d <= tol) return true
    if (data.beats[i] > f + tol) break
  }
  return false
}

/** 粒子出生帧反查：二分找第一个累计发射量 ≥ p+1 的帧 */
export function birthFrameOf(data: PresetAudioData, p: number, uptoFrame: number): number {
  const prefix = data.spawnPrefix
  let lo = 0
  let hi = Math.max(0, Math.min(uptoFrame, data.frames - 1))
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (prefix[mid + 1] >= p + 1) hi = mid
    else lo = mid + 1
  }
  return lo
}

// ===== 工程级：主线程计算 + 缓存 =====

/** 工程签名：任一音频 clip 的 src/起点/时长/音量变化才重算 */
function signature(project: Project): string {
  const parts: string[] = []
  for (const t of project.tracks) {
    if (t.kind !== 'audio' || t.disabled || t.muted) continue
    for (const c of project.clips[t.id] ?? []) {
      if (c.type !== 'audio' || !c.src || c.disabled) continue
      parts.push(`${c.src}|${c.startFrame}|${c.durationFrames}|${c.sourceStartFrame ?? 0}|${c.volume ?? 1}`)
    }
  }
  return `${project.fps}|${parts.join(';')}`
}

const cache = new Map<string, PresetAudioData>()

/**
 * 计算工程音频分析数据（仅主线程可调：需要 OfflineAudioContext）。
 * 无音频/失败 → 空的静息数据（可视化仍可动），不会抛。
 */
export async function computeAudioData(project: Project): Promise<PresetAudioData> {
  const fps = project.fps || 30
  let totalFrames = 0
  for (const clips of Object.values(project.clips)) {
    for (const c of clips) totalFrames = Math.max(totalFrames, c.startFrame + c.durationFrames)
  }
  if (totalFrames < 1 || typeof OfflineAudioContext === 'undefined') return emptyAudioData(fps, Math.max(1, totalFrames))

  const sig = signature(project)
  if (!sig.split('|').slice(1).join('')) return emptyAudioData(fps, totalFrames)
  const hit = cache.get(sig)
  if (hit) return hit

  const sampleRate = 48000
  const ctx = new OfflineAudioContext(2, Math.ceil((sampleRate * totalFrames) / fps), sampleRate)
  const audioTracks = project.tracks.filter((t) => t.kind === 'audio')
  const anySolo = audioTracks.some((t) => t.solo)
  const enabled = new Set(audioTracks.filter((t) => !t.disabled && !t.muted && (!anySolo || t.solo)).map((t) => t.id))
  const clips = Object.values(project.clips).flat().filter((c) => c.type === 'audio' && c.src && !c.disabled && enabled.has(c.trackId))
  if (!clips.length) return emptyAudioData(fps, totalFrames)

  const decodedBySrc = new Map<string, Promise<AudioBuffer>>()
  for (const clip of clips) {
    try {
      let p = decodedBySrc.get(clip.src!)
      if (!p) {
        p = fetch(clip.src!).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b))
        decodedBySrc.set(clip.src!, p)
      }
      const decoded = await p
      const node = ctx.createBufferSource()
      node.buffer = decoded
      const gain = ctx.createGain()
      gain.gain.value = clip.volume ?? 1
      node.connect(gain).connect(ctx.destination)
      node.start(clip.startFrame / fps, (clip.sourceStartFrame ?? 0) / fps, clip.durationFrames / fps)
    } catch (e) {
      console.warn('[AudioAnalysis] 音频 clip 跳过:', (e as Error)?.message)
    }
  }
  const mixed = await ctx.startRendering()
  const channels: Float32Array[] = []
  for (let c = 0; c < mixed.numberOfChannels; c++) channels.push(new Float32Array(mixed.getChannelData(c)))
  const data = analyzePcm(channels, sampleRate, fps, totalFrames)
  cache.set(sig, data)
  return data
}
