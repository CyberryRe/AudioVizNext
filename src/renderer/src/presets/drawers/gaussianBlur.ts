/**
 * drawers/gaussianBlur.ts —— 效果预设「高斯模糊」（**调整层**：作用于其下已合成的画面）。
 *
 * 与旧项目 AudioViz Studio 的 `videoeffect.blur` / `BackgroundEffect.drawBgBlur` 同语义：
 * 它不画自己的内容，而是把**当前画布上已有的合成结果**做一次高斯模糊后按"强度"叠回去
 * （sharp·(1-s) + blurred·s），所以放在哪条轨道决定它影响哪些层（层级 = 轨道 order）。
 *
 * 实现要点（踩过的坑）：
 *  1. **全屏覆盖**：Canvas `filter: blur()` 会采样画布外的透明像素 → 边缘一圈明显渐变。
 *     这里先把内容做「边缘延拓」画进更大的缓冲，模糊后再裁回整幅 → 边缘无渐变。
 *  2. **半径环状伪影**：Chromium 的 blur 是 3-pass box 近似，半径很大时会出现
 *     「忽强忽弱」的环。`mapBlurRadius` 把 UI 半径单调压到有效 0..48px，并用多趟
 *     小半径模糊逼近真高斯，观感随半径单调变糊。
 *  3. 预览端 Pixi BlurFilter 走同一 `mapBlurRadius`，保证预览/导出口径一致。
 */
import { paramAt } from '../keyframes'
import { num, str, type PresetCtx, type PresetMeta, type PresetRenderEnv } from '../types'

/** UI 半径上限（preset.json max）；有效半径远小于此值 */
export const BLUR_UI_MAX = 160
/** 有效模糊半径上限（px）。超过后 box 近似环状伪影明显，再大只会「看起来更花」而不是更糊 */
export const BLUR_EFFECTIVE_MAX = 48

/**
 * UI 半径 → 有效模糊半径（单调、可逆感官）。
 * 用 sqrt 压缩：小半径手感细腻，大半径渐缓并停在 BLUR_EFFECTIVE_MAX。
 */
export function mapBlurRadius(uiRadius: number): number {
  if (!Number.isFinite(uiRadius) || uiRadius <= 0) return 0
  const t = Math.min(uiRadius, BLUR_UI_MAX) / BLUR_UI_MAX
  return Math.sqrt(t) * BLUR_EFFECTIVE_MAX
}

interface BlurSnapshot {
  canvas: HTMLCanvasElement | OffscreenCanvas
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  w: number
  h: number
}
/** 边缘延拓用的大缓冲（含 pad）；按尺寸复用 */
let paddedSnap: BlurSnapshot | null = null
/** 多趟模糊的中间缓冲 */
let midSnap: BlurSnapshot | null = null

function snapFor(
  store: { current: BlurSnapshot | null },
  w: number,
  h: number
): BlurSnapshot | null {
  if (store.current && store.current.w === w && store.current.h === h) return store.current
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!ctx) return null
    store.current = { canvas, ctx, w, h }
    return store.current
  } catch {
    return null
  }
}

const padStore = { current: paddedSnap }
const midStore = { current: midSnap }

/**
 * 把 src 的内容画进 (w+2p)×(h+2p) 的目标，并做四边/四角延拓，
 * 使模糊采样不再读到「画布外透明」→ 消除边缘渐变。
 */
function drawEdgeBleed(
  dest: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  src: CanvasImageSource,
  w: number,
  h: number,
  p: number
): void {
  dest.setTransform(1, 0, 0, 1, 0, 0)
  dest.globalAlpha = 1
  dest.filter = 'none'
  dest.clearRect(0, 0, w + 2 * p, h + 2 * p)
  // 中心
  dest.drawImage(src, p, p, w, h)
  // 四边：把最外 1px 拉成条
  dest.drawImage(src, 0, 0, 1, h, 0, p, p, h)
  dest.drawImage(src, w - 1, 0, 1, h, p + w, p, p, h)
  dest.drawImage(src, 0, 0, w, 1, p, 0, w, p)
  dest.drawImage(src, 0, h - 1, w, 1, p, p + h, w, p)
  // 四角
  dest.drawImage(src, 0, 0, 1, 1, 0, 0, p, p)
  dest.drawImage(src, w - 1, 0, 1, 1, p + w, 0, p, p)
  dest.drawImage(src, 0, h - 1, 1, 1, 0, p + h, p, p)
  dest.drawImage(src, w - 1, h - 1, 1, 1, p + w, p + h, p, p)
}

export function drawGaussianBlur(
  ctx: PresetCtx,
  env: PresetRenderEnv,
  params: Record<string, unknown>,
  meta: PresetMeta
): void {
  const tRel = env.tRel ?? 0
  const uiRadius = paramAt(params, env.keyframes, 'radius', tRel, num(params, meta, 'radius'))
  const strength = paramAt(params, env.keyframes, 'strength', tRel, num(params, meta, 'strength'))
  const saturation = num(params, meta, 'saturation')
  const darken = num(params, meta, 'darken')
  const radius = mapBlurRadius(uiRadius)

  // 暗角/压暗（0..1）总是生效，便于做"背景虚化 + 压暗"的常见组合
  if (darken > 0.001) {
    ctx.save()
    ctx.globalAlpha = env.opacity * darken
    ctx.fillStyle = str(params, meta, 'darkenColor') || '#000000'
    ctx.fillRect(0, 0, env.width, env.height)
    ctx.restore()
  }

  if (radius <= 0.3 || strength <= 0.002) return

  const w = env.width
  const h = env.height
  // pad ≈ 2σ 足够盖住高斯支撑；限制上限防大缓冲
  const pad = Math.min(Math.ceil(radius * 2.5), 96)
  const pw = w + pad * 2
  const ph = h + pad * 2

  const padded = snapFor(padStore, pw, ph)
  if (!padded || !padded.ctx) return

  // 1) 边缘延拓快照（此时画布上只有"本层之下"的内容）
  drawEdgeBleed(padded.ctx, ctx.canvas as CanvasImageSource, w, h, pad)

  // 2) 多趟小半径模糊：比单次大 blur 更接近真高斯，减轻环状伪影。
  //    独立高斯卷积 σ 可加：用 passes 趟 perPass≈r/√passes 做工程近似，观感随半径单调变糊。
  //    ⚠ 绝不能把画布 blur 后 drawImage 到自身——必须乒乓到另一张缓冲。
  const passes = radius > 20 ? 3 : radius > 10 ? 2 : 1
  const perPass = radius / Math.sqrt(passes)
  const mid = snapFor(midStore, pw, ph)
  if (!mid || !mid.ctx) return

  let src = padded
  let dest = mid
  for (let i = 0; i < passes; i++) {
    dest.ctx!.setTransform(1, 0, 0, 1, 0, 0)
    dest.ctx!.globalAlpha = 1
    dest.ctx!.clearRect(0, 0, pw, ph)
    dest.ctx!.filter = `blur(${perPass.toFixed(2)}px)`
    dest.ctx!.drawImage(src.canvas as CanvasImageSource, 0, 0)
    dest.ctx!.filter = 'none'
    const tmp = src
    src = dest
    dest = tmp
  }

  // 3) 从含 pad 的结果裁回整幅，按强度叠回
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = env.opacity * Math.min(1, Math.max(0, strength))
  if (saturation > 0.001) {
    ctx.filter = `saturate(${(100 + saturation * 120).toFixed(0)}%)`
  } else {
    ctx.filter = 'none'
  }
  ctx.drawImage(src.canvas as CanvasImageSource, pad, pad, w, h, 0, 0, w, h)
  ctx.filter = 'none'
  ctx.restore()
}
