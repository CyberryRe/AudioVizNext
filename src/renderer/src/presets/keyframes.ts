/**
 * presets/keyframes.ts —— 关键帧（内置能力，**对外暴露 API 供所有预设调用**）。
 *
 * 数据模型（与旧项目 AudioViz Studio `renderer/clips/keyframes.js` 同口径）：
 *   clip.keyframes[key] = [{ t, v }, ...]      t = **clip 内相对时长 0..1**（升序），v = 参数值
 * 用相对时长而不是绝对帧：拖动/缩放 clip 时关键帧自动跟随，无需重映射。
 *
 * 对外 API：
 *   evaluateKeyframes(track, tRel)                     单参数求值（线性插值，端点夹取）
 *   paramAt(params, keyframes, key, tRel, fallback)    预设里取"关键帧优先"的参数值
 *   setKeyframe / removeKeyframeNear / hasKeyframeNear 编辑（返回新数组，不可变）
 *   isValidKeyframes                                   结构校验（供 .avnpre 导入校验）
 *
 * 预设用法（drawer 内）：
 *   const radius = paramAt(params, env.keyframes, 'radius', env.tRel ?? 0, 40)
 * 预览与导出共用同一份求值逻辑 → 关键帧动画逐帧一致。
 */

export interface Keyframe {
  /** clip 内相对时长 0..1（升序） */
  t: number
  /** 参数值 */
  v: number
}

export type KeyframeTracks = Record<string, Keyframe[]>

/** 插入/替换关键帧的匹配容差（相对时长）：比一帧还小，避免误合并 */
export const KEYFRAME_EPS = 1e-4

/**
 * 单参数求值：tRel∈[0,1] 线性插值，范围外取端点（不外推）。
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
      return lo.v + (hi.v - lo.v) * f
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

/** 插入/替换关键帧（按 t 排序；返回新数组）。 */
export function setKeyframe(track: Keyframe[] | undefined, tRel: number, v: number): Keyframe[] {
  const t = Math.max(0, Math.min(1, tRel))
  const next = [...(track ?? [])]
  const i = next.findIndex((k) => Math.abs(k.t - t) <= KEYFRAME_EPS)
  if (i >= 0) next[i] = { t, v }
  else {
    next.push({ t, v })
    next.sort((a, b) => a.t - b.t)
  }
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
  for (const arr of Object.values(kf as Record<string, unknown>)) {
    if (!Array.isArray(arr)) return false
    let prev = -Infinity
    for (const pt of arr) {
      const k = pt as Partial<Keyframe>
      if (!k || typeof k.t !== 'number' || typeof k.v !== 'number') return false
      if (k.t < prev - 1e-9 || k.t < 0 || k.t > 1) return false
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
