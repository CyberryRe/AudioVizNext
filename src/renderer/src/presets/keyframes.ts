/**
 * presets/keyframes.ts —— 关键帧（内置能力，**对外暴露 API 供所有预设调用**）。
 *
 * 数据模型：
 *   clip.keyframes[key] = [{ t, v, ease? }, ...]
 *   t = **clip 内相对时长 0..1**（升序），v = 参数值
 *   ease = 本关键帧 → 下一关键帧 的插值方式（最后一帧的 ease 被忽略）
 * 用相对时长而不是绝对帧：拖动/缩放 clip 时关键帧自动跟随，无需重映射。
 *
 * 对外 API：
 *   evaluateKeyframes(track, tRel)                     单参数求值（线性/缓动，端点夹取）
 *   paramAt(params, keyframes, key, tRel, fallback)    预设里取"关键帧优先"的参数值
 *   setKeyframe / removeKeyframeNear / hasKeyframeNear 编辑（返回新数组，不可变）
 *   isValidKeyframes                                   结构校验（供 .avnpre 导入校验）
 *
 * 预设用法（drawer 内）：
 *   const radius = paramAt(params, env.keyframes, 'radius', env.tRel ?? 0, 40)
 * 预览与导出共用同一份求值逻辑 → 关键帧动画逐帧一致。
 */

/** 段间插值（作用在「本帧 → 下一帧」） */
export type KeyframeEase = 'linear' | 'ease' | 'easeIn' | 'easeOut' | 'hold'

export const KEYFRAME_EASES: { value: KeyframeEase; label: string }[] = [
  { value: 'linear', label: '线性' },
  { value: 'ease', label: '缓入缓出' },
  { value: 'easeIn', label: '缓入' },
  { value: 'easeOut', label: '缓出' },
  { value: 'hold', label: '保持' }
]

export interface Keyframe {
  /** clip 内相对时长 0..1（升序） */
  t: number
  /** 参数值 */
  v: number
  /** 本帧 → 下一帧 的插值；缺省 linear */
  ease?: KeyframeEase
}

export type KeyframeTracks = Record<string, Keyframe[]>

/** 插入/替换关键帧的匹配容差（相对时长）：比一帧还小，避免误合并 */
export const KEYFRAME_EPS = 1e-4

/** 线性进度 f∈[0,1] → 缓动后的进度 */
export function easeProgress(ease: KeyframeEase | undefined, f: number): number {
  const x = Math.min(1, Math.max(0, f))
  switch (ease) {
    case 'hold':
      return 0
    case 'easeIn':
      return x * x
    case 'easeOut':
      return 1 - (1 - x) * (1 - x)
    case 'ease':
      // smoothstep：两端平缓、中间陡
      return x * x * (3 - 2 * x)
    default:
      return x
  }
}

/**
 * 单参数求值：tRel∈[0,1] 按段插值，范围外取端点（不外推）。
 * 无轨道/空轨道 → null（调用方回落静态参数）。
 */
export function evaluateKeyframes(track: Keyframe[] | undefined, tRel: number): number | null {
  if (!track || track.length === 0) return null
  if (track.length === 1) return track[0].v
  const first = track[0]
  const last = track[track.length - 1]
  if (tRel <= first.t) return first.v
  if (tRel >= last.t) return last.v
  for (let i = 0; i < track.length - 1; i++) {
    const lo = track[i]
    const hi = track[i + 1]
    if (tRel >= lo.t && tRel <= hi.t) {
      if (hi.t === lo.t) return lo.v
      const f = (tRel - lo.t) / (hi.t - lo.t)
      const fe = easeProgress(lo.ease, f)
      return lo.v + (hi.v - lo.v) * fe
    }
  }
  return last.v
}

/**
 * 取参数值：**有关键帧轨道时用轨道求值，否则用静态参数，再否则用 schema 默认值**。
 * 这是预设 drawer 应优先使用的入口（`num()` 的关键帧版本）。
 */
export function paramAt(
  params: Record<string, unknown> | undefined,
  keyframes: KeyframeTracks | undefined,
  key: string,
  tRel: number,
  fallback: number
): number {
  const v = evaluateKeyframes(keyframes?.[key], tRel)
  if (v !== null && Number.isFinite(v)) return v
  const raw = params?.[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

/**
 * 插入/替换关键帧（按 t 排序；返回新数组）。
 * 同位置替换时保留原 ease（只改 v）；新点默认 linear。
 */
export function setKeyframe(track: Keyframe[] | undefined, tRel: number, v: number, ease?: KeyframeEase): Keyframe[] {
  const t = Math.max(0, Math.min(1, tRel))
  const next = [...(track ?? [])]
  const i = next.findIndex((k) => Math.abs(k.t - t) <= KEYFRAME_EPS)
  if (i >= 0) {
    const prev = next[i]
    next[i] = { t, v, ease: ease ?? prev.ease }
  } else {
    next.push(ease ? { t, v, ease } : { t, v })
    next.sort((a, b) => a.t - b.t)
  }
  return next
}

/** 设置某关键帧的插值方式（按 t 最近匹配） */
export function setKeyframeEase(track: Keyframe[] | undefined, tRel: number, ease: KeyframeEase): Keyframe[] {
  if (!track || track.length === 0) return track ?? []
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < track.length; i++) {
    const d = Math.abs(track[i].t - tRel)
    if (d < bestD) { bestD = d; best = i }
  }
  if (bestD > 0.05) return track
  const next = [...track]
  next[best] = { ...next[best], ease }
  return next
}

/** 删除 tRel 附近的关键帧（返回新数组）。 */
export function removeKeyframeNear(track: Keyframe[] | undefined, tRel: number): Keyframe[] {
  if (!track) return []
  return track.filter((k) => Math.abs(k.t - tRel) > KEYFRAME_EPS)
}

export function hasKeyframeNear(track: Keyframe[] | undefined, tRel: number): boolean {
  return !!track?.some((k) => Math.abs(k.t - tRel) <= KEYFRAME_EPS)
}

/** 结构校验（供 .avnpre 导入/工程加载时防御性检查）。 */
export function isValidKeyframes(kf: unknown): kf is KeyframeTracks {
  if (kf === null || kf === undefined) return true
  if (typeof kf !== 'object' || Array.isArray(kf)) return false
  const eases: string[] = ['linear', 'ease', 'easeIn', 'easeOut', 'hold']
  for (const arr of Object.values(kf as Record<string, unknown>)) {
    if (!Array.isArray(arr)) return false
    let prev = -Infinity
    for (const pt of arr) {
      const k = pt as Partial<Keyframe>
      if (!k || typeof k.t !== 'number' || typeof k.v !== 'number') return false
      if (k.t < prev - 1e-9 || k.t < 0 || k.t > 1) return false
      if (k.ease !== undefined && !eases.includes(k.ease)) return false
      prev = k.t
    }
  }
  return true
}

/** 轨道是否有任何关键帧 */
export function hasAnyKeyframe(kf: KeyframeTracks | undefined): boolean {
  if (!kf) return false
  return Object.values(kf).some((a) => Array.isArray(a) && a.length > 0)
}
