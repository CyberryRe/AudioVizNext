/**
 * drawers/gaussianBlur.ts —— 效果预设「高斯模糊」（**调整层**：作用于其下已合成的画面）。
 *
 * 与旧项目 AudioViz Studio 的 `videoeffect.blur` / `BackgroundEffect.drawBgBlur` 同语义：
 * 它不画自己的内容，而是把**当前画布上已有的合成结果**做一次高斯模糊后按"强度"叠回去
 * （sharp·(1-s) + blurred·s），所以放在哪条轨道决定它影响哪些层（层级 = 轨道 order）。
 *
 * 两个参数（都可关键帧）：
 *   模糊半径 radius(px)  —— 直接作为 `ctx.filter: blur(Npx)` 的半径
 *   模糊强度 strength    —— 模糊副本的不透明度（0 = 不模糊，1 = 完全模糊）
 *
 * 关键帧：通过内置 API `paramAt(params, env.keyframes, key, env.tRel, 默认值)` 取值，
 * 预设无需自己处理插值（见 presets/keyframes.ts）。
 *
 * 实现注意：Canvas2D 允许把画布画到自身（规范要求先把源快照），但为稳妥起见这里显式
 * 拷到一张缓存快照画布再叠回，避免不同实现的差异。
 */
import { paramAt } from '../keyframes'
import { num, str, type PresetCtx, type PresetMeta, type PresetRenderEnv } from '../types'

interface BlurSnapshot {
  canvas: HTMLCanvasElement | OffscreenCanvas
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  w: number
  h: number
}
let snapshot: BlurSnapshot | null = null

function snapshotFor(w: number, h: number): BlurSnapshot | null {
  if (snapshot && snapshot.w === w && snapshot.h === h) return snapshot
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!ctx) return null
    snapshot = { canvas, ctx, w, h }
    return snapshot
  } catch {
    return null
  }
}

export function drawGaussianBlur(
  ctx: PresetCtx,
  env: PresetRenderEnv,
  params: Record<string, unknown>,
  meta: PresetMeta
): void {
  const tRel = env.tRel ?? 0
  const radius = paramAt(params, env.keyframes, 'radius', tRel, num(params, meta, 'radius'))
  const strength = paramAt(params, env.keyframes, 'strength', tRel, num(params, meta, 'strength'))
  const saturation = num(params, meta, 'saturation')
  const darken = num(params, meta, 'darken')

  // 暗角/压暗（0..1）总是生效，便于做"背景虚化 + 压暗"的常见组合
  if (darken > 0.001) {
    ctx.save()
    ctx.globalAlpha = env.opacity * darken
    ctx.fillStyle = str(params, meta, 'darkenColor') || '#000000'
    ctx.fillRect(0, 0, env.width, env.height)
    ctx.restore()
  }

  if (radius <= 0.3 || strength <= 0.002) return

  const snap = snapshotFor(env.width, env.height)
  if (!snap || !snap.ctx) return

  // 1) 快照当前合成结果（此时画布上只有"本层之下"的内容）
  snap.ctx.setTransform(1, 0, 0, 1, 0, 0)
  snap.ctx.globalAlpha = 1
  snap.ctx.filter = 'none'
  snap.ctx.clearRect(0, 0, env.width, env.height)
  snap.ctx.drawImage(ctx.canvas as CanvasImageSource, 0, 0)

  // 2) 带模糊（可加饱和度）叠回：sharp·(1-s) + blurred·s
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = env.opacity * Math.min(1, Math.max(0, strength))
  const filter = saturation > 0.001
    ? `blur(${radius.toFixed(1)}px) saturate(${(100 + saturation * 120).toFixed(0)}%)`
    : `blur(${radius.toFixed(1)}px)`
  ctx.filter = filter
  ctx.drawImage(snap.canvas as CanvasImageSource, 0, 0)
  ctx.filter = 'none'
  ctx.restore()
}
