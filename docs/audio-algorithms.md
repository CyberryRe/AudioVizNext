# 音频可视化算法 API 使用指南

> `src/renderer/src/media/audioAlgorithms.ts` —— 通用音频分析算法**只实现一次**，
> 组件、预设 drawer、第三方预设脚本共用同一套，避免每个样式各造轮子。
> 全部为纯函数（除标了 `InPlace` 的），单测：`test/audioAlgorithms.test.mjs`（20 项）。

---

## 0. 两条使用路径

| 你是谁 | 怎么用 |
|---|---|
| 渲染层组件 / 内置 drawer | `import { magnitudeSpectrum, waveformPeaks, … } from '../media/audioAlgorithms'` |
| **第三方预设脚本**（`.avnpre`） | `api.dsp.magnitudeSpectrum(…)` + 逐帧取样 `api.waveValue / api.freqValue / api.levelAt / api.onsetAt / api.isBeatFrame` |
| 想要"工程级、按帧打包好"的数据 | `media/audioAnalysis.ts` 的 `computeAudioData(project)`（主线程，带缓存） |

约定：输入样本一律 **mono `Float32Array`（-1..1）**；时间单位是**秒**，帧相关函数显式传 `fps`。

---

## 1. 逐帧数据（最常用，O(1) 取值）

工程音频由主线程离线渲染一次 → 打包成逐帧数据 → 预览直接用、导出 transfer 进 Worker。
**预览与导出拿到的是同一份**，所以可视化逐帧一致。

```ts
const data = await computeAudioData(project)   // PresetAudioData（主线程）
```

| 取样函数 | 返回 | 用途 |
|---|---|---|
| `waveValue(data, frame, t)` | -1..1 | 波形样本；`t∈[0,1]` 映射到该帧 512 个样本 |
| `freqValue(data, frame, i, n, gamma=1.3)` | 0..1 | 频谱幅度；`i/n` 映射到 256 个对数频段（30Hz–16kHz），`gamma` 提亮低端 |
| `levelAt(data, frame)` | 0..1 | 电平（RMS + 对数压缩） |
| `onsetAt(data, frame)` | 0..1 | 起音强度（重音/打击处为峰值） |
| `isBeatFrame(data, frame, tol=1)` | boolean | 是否节拍点（脉冲特效 / 拍点吸附） |
| `birthFrameOf(data, p, uptoFrame)` | number | 粒子出生帧反查（确定性粒子系统用） |
| `data.bpm` / `data.bpmConfidence` / `data.beats` | number / number / Int32Array | 自相关节拍估计 |

底层字段（需要自己扫描时）：
```ts
data.wave   // Float32Array(frames * 512)
data.freq   // Float32Array(frames * 256)
data.level  // Float32Array(frames)
data.onset  // Float32Array(frames)
data.spawnPrefix // Int32Array(frames+1)  每帧发射 max(1, round(level*6)) 的累计量
```

---

## 2. 通用算法

### 2.1 基础
| 函数 | 说明 |
|---|---|
| `mixToMono(channels, length?)` | 多声道等权混单（单声道直通） |
| `hannWindow(n)` | 加窗函数（减少频谱泄漏） |
| `frameSlice(samples, start, count)` | 取一段样本（越界补 0） |
| `clamp01(v)` / `lerp(a,b,t)` | 数值工具 |

### 2.2 FFT / 频谱
| 函数 | 说明 |
|---|---|
| `fftInPlace(re, im)` | 迭代式 radix-2 FFT（长度须为 2 的幂，否则抛错） |
| `magnitudeSpectrum(samples, fftSize=1024, window?)` | 加窗 FFT → 幅度谱（长度 `fftSize/2`） |
| `bandEdges(sampleRate, fftSize, bins, fMin=30, fMax=16000, log=true)` | 频段边界（返回 FFT bin 索引） |
| `bandsFromSpectrum(mag, edges)` | 按频段聚合（每段取平均） |
| `normalizeBandsInPlace(bands, bins, gamma=1)` | **每段**按整轨峰值归一化到 0..1 |

```ts
// 取一帧的 64 段频谱（0..1）
const mag = magnitudeSpectrum(frameSlice(mono, start, 1024), 1024)
const edges = bandEdges(48000, 1024, 64)
const bands = bandsFromSpectrum(mag, edges)
```

### 2.3 波形
| 函数 | 说明 |
|---|---|
| `waveformPeaks(samples, buckets)` | 压成 N 桶 `{min,max,rms}`（时间轴波形/缩略图：画 `[min,max]` 竖线） |
| `waveSampleAt(samples, t)` | 按 `t∈[0,1]` 线性插值取样 |

```ts
// 时间轴音频 clip 上画波形
const peaks = waveformPeaks(mono, 1200)
for (let i = 0; i < peaks.min.length; i++) {
  const x = i * (w / peaks.min.length)
  ctx.moveTo(x, midY + peaks.min[i] * halfH)
  ctx.lineTo(x, midY + peaks.max[i] * halfH)
}
```

### 2.4 电平 / 包络
| 函数 | 说明 |
|---|---|
| `rmsEnvelope(samples, sampleRate, fps, frames)` | 逐帧 RMS |
| `normalizeInPlace(arr, gamma=1)` | 峰值归一化 0..1 |
| `smoothEnvelope(env, attack=0.55, release=0.12)` | 起音快 / 释放慢的单极平滑（视觉不抖） |
| `ema(arr, alpha)` | 指数滑动平均 |

### 2.5 节拍 / 起音
| 函数 | 说明 |
|---|---|
| `onsetStrength(env)` | 半波整流正向差分（>0 = 变响） |
| `estimateBeats(env, fps, minBpm=60, maxBpm=200)` | 自相关 → `{bpm, confidence, beats:Int32Array}` |
| `analyzeMono(samples, sampleRate, fps, frames, peakBuckets=1200)` | 一次算出 `{level, onset, bpm, bpmConfidence, beats, peaks}` |

```ts
const r = estimateBeats(level, 30)
console.log(r.bpm, r.confidence, r.beats.length)   // 例：120.0 0.42 24
```

---

## 3. 典型配方

### 3.1 波形线（横向，逐帧）
```js
const amp = 0.35 * env.height
ctx.beginPath()
for (let x = 0; x <= env.width; x += 4) {
  ctx.lineTo(x, env.height / 2 + api.waveValue(env.audio, env.frame, x / env.width) * amp)
}
ctx.stroke()
```

### 3.2 频谱柱
```js
const n = 64
for (let i = 0; i < n; i++) {
  const v = api.freqValue(env.audio, env.frame, i, n)   // 0..1
  const h = v * env.height * 0.4
  ctx.fillRect(i * (env.width / n), env.height / 2 - h, env.width / n - 2, h)
}
```

### 3.3 每拍脉冲
```js
const beat = api.isBeatFrame(env.audio, env.frame, 2)
const level = api.levelAt(env.audio, env.frame)
const r = 120 * (1 + level * 0.3 + (beat ? 0.3 : 0))
ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
```

### 3.4 沿波喷射粒子（确定性）
```js
const prefix = env.audio.spawnPrefix
const p0 = prefix[Math.max(0, env.frame - Math.ceil(2 * env.fps))] - 1
const p1 = prefix[env.frame + 1]
for (let p = p0; p < p1; p++) {
  const bf = api.birthFrameOf(env.audio, p, env.frame)   // 出生帧
  const age = env.timeSec - bf / env.fps
  if (age <= 0 || age > 2) continue
  const t0 = api.hash(p * 13)                            // 确定性随机
  const x0 = t0 * env.width
  const y0 = env.height / 2 + api.waveValue(env.audio, bf, t0) * 140
  const y = y0 - api.hash(p * 19) * 80 * age + 0.5 * 20 * age * age
  ctx.globalAlpha = env.opacity * (1 - age / 2)
  ctx.beginPath(); ctx.arc(x0, y, 2 + api.hash(p * 23) * 3, 0, Math.PI * 2); ctx.fill()
}
```

---

## 4. 性能与确定性

- **只算一次**：工程级数据由 `computeAudioData()` 缓存（签名 = 音频 clip 的 src/起点/时长/音量），
  拖动无关参数不会重算。3.5 分钟 @30fps 约 wave 12.9MB + freq 6.5MB。
- **FFT 成本**：1024 点 × 每帧一次。6300 帧约 0.6–1.2s（主线程一次性），导出端复用主线程结果，Worker 不重复算。
- **确定性**：算法只用输入样本与显式参数，无 `Math.random()`/时间戳 → 同一工程重复导出逐帧一致；
  粒子用 `hash(n)`（sin-hash）保证跨环境同序。
- **别在 drawer 里做重活**：drawer 每帧被调用，重计算请放到 `computeAudioData` 或预设资源里。
