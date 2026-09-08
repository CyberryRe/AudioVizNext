/**
 * exportTypes.ts —— 导出路径共用的类型与纯工具（渲染层 / Worker 均可安全 import）。
 *
 * 单独成文件的原因：导出循环搬进 Worker 后，Worker 不能触碰 `window`/DOM 相关模块，
 * 所以进度类型、帧数计算、avn-file 路径换算这些"两边都要用"的东西必须独立、无副作用。
 */

import type { Project } from '../model/timeline'

/** 导出进度（UI 进度条 + 速度/剩余时间） */
export interface ExportProgress {
  /** 已编码帧数 */
  frames: number
  totalFrames: number
  /** 0..1 */
  ratio: number
  /** 实测导出速度（帧/秒，滚动均值） */
  fps: number
  /** 预计剩余秒数（按 fps 推算；样本不足时 NaN） */
  etaSec: number
}

/** 工程内容总帧数（0 .. 最末 clip 终点；空工程返回 0）。 */
export function contentTotalFrames(project: Project): number {
  let max = 0
  for (const clips of Object.values(project.clips)) {
    for (const c of clips) max = Math.max(max, c.startFrame + c.durationFrames)
  }
  return max
}

/** 磁盘绝对路径 → avn-file:// URL（本仓自定义协议，支持 Range，mediabunny UrlSource 走 fetch） */
export function avnUrl(absPath: string): string {
  return `avn-file://${encodeURIComponent(absPath)}`
}

/** avn-file:// URL → 磁盘绝对路径；非该协议返回 null */
export function pathFromAvn(src: string | undefined): string | null {
  if (!src || !src.startsWith('avn-file://')) return null
  try {
    const u = new URL(src)
    const p = decodeURIComponent(u.hostname)
    return p && p.length > 1 ? p : null
  } catch {
    return null
  }
}

/** H.264 4:2:0 / NV12 要求偶数尺寸：向上取偶（奇数会导致色度面错位 → 导出绿带）。 */
export function evenUp(n: number): number {
  const v = Math.round(n)
  return v % 2 === 0 ? v : v + 1
}
