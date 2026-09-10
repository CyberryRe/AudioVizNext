/**
 * drawers/particleWaveform.ts —— 可视化预设「粒子波形」。
 *
 * 忠实对齐旧项目 AudioViz Studio 的同名样式
 * （`D:\Project\AudioViz Studio\renderer\visualizer\styles\particleWave.js`）：
 *   1) **主波形线**：横贯画布，y = 中心 + 波形样本 × 振幅（每 4px 取样一次）；
 *   2) **频谱副线**：由频谱驱动、振幅更小的第二条线（谐波感）；
 *   3) **粒子**：沿波形喷射，带初速度、阻尼与重力，2 秒寿命淡出；
 *      出生位置取"出生帧的波形采样"，出生帧由 `spawnPrefix` 累计发射量反查（**确定性**，
 *      预览与导出逐帧一致）。
 *
 * 与参考实现的差异：数据源由旧项目的字节数组换成我们逐帧分析出的 Float32（`env.audio`），
 * 取样口径保持一致（waveValue / freqValue gamma=1.3 / 每帧发射 max(1, round(level*6))）。
 */
import { mixColor } from '../../model/timeline'
import { birthFrameOf, freqValue, levelAt, waveValue, type PresetAudioData } from '../../media/audioAnalysis'
import { num, str, type PresetCtx, type PresetMeta, type PresetRenderEnv } from '../types'

/** GLSL 风格 sin-hash：同一 p 在任何环境给出同一 [0,1) 随机数 */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

export function drawParticleWaveform(
  ctx: PresetCtx,
  env: PresetRenderEnv,
  params: Record<string, unknown>,
  meta: PresetMeta
): void {
  const W = env.width
  const H = env.height
  const audio: PresetAudioData | null = env.audio ?? null
  const px = num(params, meta, 'posX')
  const py = num(params, meta, 'posY')
  const sx = num(params, meta, 'scaleX')
  const sy = num(params, meta, 'scaleY')
  const amplitude = num(params, meta, 'amplitude')
  const lineGlow = num(params, meta, 'lineGlow')
  const particleGlow = num(params, meta, 'particleGlow')
  const gravity = num(params, meta, 'gravity')
  const particleCount = Math.round(num(params, meta, 'particleCount'))
  const colorA = str(params, meta, 'color') || '#a29bfe'
  const colorB = str(params, meta, 'color2') || '#3fe0ff'

  const frame = env.frame
  const fps = env.fps || 30
  const time = env.timeSec
  const level = audio ? levelAt(audio, frame) : 0.25
  const amp = 0.35 * H * amplitude

  ctx.save()
  ctx.globalAlpha = env.opacity
  // 画布坐标：中心 + 位置偏移；缩放围绕中心
  ctx.translate(W / 2 + px * W, H / 2 + py * H)
  ctx.scale(sx, sy)

  // ---- 主波形线 ----
  ctx.beginPath()
  ctx.moveTo(-W / 2, 0)
  for (let x = -W / 2; x <= W / 2; x += 4) {
    const t = (x + W / 2) / W
    ctx.lineTo(x, waveValue(audio, frame, t) * amp)
  }
  if (lineGlow > 0.01) {
    ctx.shadowColor = colorA
    ctx.shadowBlur = 18 * lineGlow
  }
  ctx.lineWidth = 2.5
  ctx.strokeStyle = colorA
  ctx.stroke()
  ctx.shadowBlur = 0

  // ---- 频谱副线（谐波感） ----
  // freqValue 已做 bin 间线性插值；再在横轴上做 3 点滑动平均，抹掉对数高频段的台阶/锯齿。
  const specN = 256
  const spec = new Float32Array(specN)
  for (let i = 0; i < specN; i++) {
    spec[i] = (freqValue(audio, frame, i, specN) - 0.5) * 2
  }
  const specS = new Float32Array(specN)
  for (let i = 0; i < specN; i++) {
    const a = spec[Math.max(0, i - 1)]
    const b = spec[i]
    const c = spec[Math.min(specN - 1, i + 1)]
    specS[i] = (a + b * 2 + c) * 0.25
  }
  ctx.beginPath()
  ctx.moveTo(-W / 2, 0)
  const stepX = 3
  for (let x = -W / 2; x <= W / 2; x += stepX) {
    const t = (x + W / 2) / W
    const fi = t * (specN - 1)
    const i0 = Math.floor(fi)
    const i1 = Math.min(specN - 1, i0 + 1)
    const ft = fi - i0
    const v = (specS[i0] + (specS[i1] - specS[i0]) * ft) * amp * 0.35
    ctx.lineTo(x, v)
  }
  ctx.lineWidth = 1.2
  ctx.globalAlpha = env.opacity * 0.6
  ctx.strokeStyle = colorB
  ctx.stroke()
  ctx.globalAlpha = env.opacity

  // ---- 沿波喷射的粒子（确定性） ----
  // ⚠ 子采样必须按**绝对粒子 id** 稳定判定。若用 (p-p0)%step，p0 每帧 +1 会换一整套粒子 → 闪烁。
  const maxLife = 2.0
  if (audio && audio.spawnPrefix.length > 1) {
    const prefix = audio.spawnPrefix
    const p0 = prefix[Math.max(0, frame - Math.ceil(maxLife * fps))] - 1
    const p1 = prefix[Math.min(audio.frames, frame + 1)]
    if (p1 > 0 && p1 > p0) {
      // particleCount 20..400 → 稳定保留密度；窗口内发射量随电平变化，用 hash 阈值而非 step
      const density = Math.min(1, Math.max(0.05, particleCount / 80))
      for (let p = Math.max(0, p0); p < p1; p++) {
        if (hash(p * 7) > density) continue
        const bf = birthFrameOf(audio, p, frame)
        const age = time - bf / fps
        if (age <= 0 || age > maxLife) continue

        const t0 = hash(p * 13)
        const x0 = (t0 - 0.5) * W
        const y0 = waveValue(audio, bf, t0) * amp
        const vx = (hash(p * 17) - 0.5) * 60
        const vy = -hash(p * 19) * 80 - 30
        const damp = Math.pow(0.99, age * 60)
        const x = x0 + vx * age * damp
        const y = y0 + vy * age + 0.5 * gravity * age * age
        // 出生淡入 + 寿命淡出：避免粒子「啪」地弹出/消失造成的闪烁感
        const fadeIn = Math.min(1, age / 0.12)
        const alpha = (1 - age / maxLife) * fadeIn
        if (alpha <= 0.02) continue
        const size = (2.2 + hash(p * 23) * 3.5 * (0.5 + level)) * (0.55 + alpha * 0.45)
        const c = mixColor(colorA, colorB, hash(p * 29))

        if (particleGlow > 0.01 && size > 1.2) {
          ctx.shadowColor = c
          ctx.shadowBlur = 8 * particleGlow
        }
        ctx.globalAlpha = env.opacity * alpha * 0.85
        ctx.fillStyle = c
        ctx.beginPath()
        ctx.arc(x, y, Math.max(0.4, size), 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0
      }
    }
  }

  ctx.restore()
}
