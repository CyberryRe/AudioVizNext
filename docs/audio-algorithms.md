# 音频算法 API

`src/renderer/src/media/audioAlgorithms.ts` —— 纯函数，可单测（`test/audioAlgorithms.test.mjs`）。
组件、内置 drawer、第三方脚本共用。

用法：`import { … } from '../media/audioAlgorithms'`，脚本内 `api.dsp.*`。

## 逐帧数据（`audioAnalysis.ts`，O(1) 取值）

主线程 `computeAudioData(project)` 算一次，预览与导出共用同一份。

| 函数 | 返回 | 说明 |
|---|---|---|
| `waveValue(data, frame, t)` | -1..1 | 波形样本，`t∈[0,1]` 映射到该帧 512 个样本 |
| `freqValue(data, frame, i, n, gamma=1.3)` | 0..1 | 频谱幅度，`i/n` 映射到 256 个对数频段（30Hz–16kHz） |
| `levelAt(data, frame)` | 0..1 | 电平（RMS + 对数压缩） |
| `onsetAt(data, frame)` | 0..1 | 起音强度 |
| `isBeatFrame(data, frame, tol=1)` | bool | 是否节拍点 |
| `birthFrameOf(data, p, uptoFrame)` | number | 粒子出生帧反查 |
| `data.bpm` / `.bpmConfidence` / `.beats` | number / number / Int32Array | 节拍估计 |

底层字段：`wave`(frames×512)、`freq`(frames×256)、`level`、`onset`、`spawnPrefix`。

## 算法

### 基础
| 函数 | 说明 |
|---|---|
| `mixToMono(channels, length?)` | 多声道等权混单 |
| `hannWindow(n)` | 加窗函数 |
| `frameSlice(samples, start, count)` | 取一段样本（越界补 0） |
| `clamp01(v)` / `lerp(a,b,t)` | 数值工具 |

### FFT / 频谱
| 函数 | 说明 |
|---|---|
| `fftInPlace(re, im)` | 迭代式 radix-2 FFT（长度须为 2 的幂） |
| `magnitudeSpectrum(samples, fftSize=1024, window?)` | 加窗 FFT → 幅度谱（长度 `fftSize/2`） |
| `bandEdges(sampleRate, fftSize, bins, fMin=30, fMax=16000, log=true)` | 频段边界（FFT bin 索引） |
| `bandsFromSpectrum(mag, edges)` | 按频段聚合（每段平均） |
| `normalizeBandsInPlace(bands, bins, gamma=1)` | 每段按整轨峰值归一化 0..1 |

```ts
const mag = magnitudeSpectrum(frameSlice(mono, start, 1024), 1024)
const bands = bandsFromSpectrum(mag, bandEdges(48000, 1024, 64))
```

### 波形
| 函数 | 说明 |
|---|---|
| `waveformPeaks(samples, buckets)` | 压成 N 桶 `{min, max, rms}` |
| `waveSampleAt(samples, t)` | 按 `t∈[0,1]` 插值取样 |

```ts
const p = waveformPeaks(mono, 1200)   // 时间轴画 [min,max] 竖线
```

### 电平 / 包络
| 函数 | 说明 |
|---|---|
| `rmsEnvelope(samples, sampleRate, fps, frames)` | 逐帧 RMS |
| `normalizeInPlace(arr, gamma=1)` | 峰值归一化 0..1 |
| `smoothEnvelope(env, attack=0.55, release=0.12)` | 起音快 / 释放慢平滑 |
| `ema(arr, alpha)` | 指数滑动平均 |

### 起音 / 节拍
| 函数 | 说明 |
|---|---|
| `onsetStrength(env)` | 半波整流正向差分 |
| `estimateBeats(env, fps, minBpm=60, maxBpm=200)` | 自相关 → `{bpm, confidence, beats}` |
| `analyzeMono(samples, sampleRate, fps, frames, peakBuckets=1200)` | 一次算出 `{level, onset, bpm, bpmConfidence, beats, peaks}` |

## 示例

```js
// 波形线
const amp = 0.35 * env.height
ctx.beginPath()
for (let x = 0; x <= env.width; x += 4)
  ctx.lineTo(x, env.height / 2 + api.waveValue(env.audio, env.frame, x / env.width) * amp)
ctx.stroke()

// 频谱柱
for (let i = 0; i < 64; i++) {
  const h = api.freqValue(env.audio, env.frame, i, 64) * env.height * 0.4
  ctx.fillRect(i * (env.width / 64), env.height / 2 - h, env.width / 64 - 2, h)
}

// 每拍脉冲
const r = 120 * (1 + api.levelAt(env.audio, env.frame) * 0.3 + (api.isBeatFrame(env.audio, env.frame, 2) ? 0.3 : 0))
ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
```

## 说明

- 输入为 mono `Float32Array`（-1..1）；时间单位秒，帧相关函数显式传 `fps`。
- `computeAudioData` 结果按音频 clip 签名缓存；3.5 分钟 @30fps 约 wave 12.9MB + freq 6.5MB。
- 算法只依赖输入样本与参数，无随机/时间戳 → 重复导出逐帧一致。
