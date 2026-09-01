/**
 * AudioVizNext — 时间轴数据模型（纯 TS，无 React 依赖）
 *
 * 参考 Elah 架构（reference/elah/ARCHITECTURE.md）：
 *  - P2 时间用整数帧，避免浮点漂移
 *  - P4 resolveTimeline 是纯函数：同一 (frame, project) 恒产出同一 Scene
 *  - 引擎优先、框架其次；本模块可运行在 Node/Worker/CLI
 */

// ===== 基础类型 =====

/** 轨道类型 */
export type TrackKind = 'video' | 'audio' | 'text'

/** Clip 类型 */
export type ClipType = 'video' | 'audio' | 'text' | 'image'

/** 变换（归一化 0..1，与分辨率无关） */
export interface Transform {
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotation: number // 弧度
}

// ===== 模型 =====

export interface Project {
  id: string
  /** 帧率（整数） */
  fps: number
  /** 舞台尺寸（画布） */
  stage: { width: number; height: number }
  /** 轨道，order 0 = 最上层 = 渲染最前 */
  tracks: Track[]
  /** 每个轨道的 clip 列表，始终按 startFrame 升序、无重叠 */
  clips: Record<string, Clip[]>
  version: number
}

export interface Track {
  id: string
  name: string
  kind: TrackKind
  /** 0 = UI 最顶 = 渲染最前 */
  order: number
  /** UI 高度提示（px） */
  height: number
  locked: boolean
  disabled: boolean
  muted: boolean
  solo: boolean
}

export interface Clip {
  id: string
  trackId: string
  type: ClipType
  name: string

  // 时间轴位置（整数帧）
  startFrame: number
  durationFrames: number

  // 源素材裁剪窗口（整数帧）
  sourceStartFrame: number
  sourceDurationFrames: number

  // 媒体引用
  src?: string
  assetId?: string
  /** 文字类 clip 内容 */
  content?: string

  // 合成属性
  volume?: number
  opacity?: number
  transform?: Transform

  // 标志
  locked?: boolean
  disabled?: boolean
}

/** 素材 */
export interface MediaAsset {
  id: string
  kind: 'video' | 'audio' | 'image'
  name: string
  src: string
  durationSec: number
  width?: number
  height?: number
  sourceFps?: number
  thumbnailUrl?: string
  byteSize: number
  addedAt: number
}

// ===== Scene（resolveTimeline 输出） =====

export interface Scene {
  frame: number
  videos: ActiveVideoClip[]
  audios: ActiveAudioClip[]
  texts: ActiveTextClip[]
  images: ActiveImageClip[]
}

interface ActiveClipBase {
  id: string
  trackId: string
  name: string
  /** 源内应显示的精确帧 */
  sourceFrame: number
  opacity: number
  /** 更高 = 更靠近观看者 */
  zIndex: number
  transform?: Transform
}

export interface ActiveVideoClip extends ActiveClipBase {
  type: 'video'
  src: string
  volume: number
}

export interface ActiveAudioClip extends ActiveClipBase {
  type: 'audio'
  src: string
  volume: number
}

export interface ActiveTextClip extends ActiveClipBase {
  type: 'text'
  content: string
}

export interface ActiveImageClip extends ActiveClipBase {
  type: 'image'
  src: string
  volume: number
}

// ===== 工厂 =====

export function createProject(overrides?: Partial<Project>): Project {
  return {
    id: 'proj-1',
    fps: 30,
    stage: { width: 1920, height: 1080 },
    tracks: [],
    clips: {},
    version: 0,
    ...overrides
  }
}

export function createTrack(overrides?: Partial<Track>): Track {
  return {
    id: `tr-${Math.random().toString(36).slice(2, 8)}`,
    name: '轨道',
    kind: 'video',
    order: 0,
    height: 47,
    locked: false,
    disabled: false,
    muted: false,
    solo: false,
    ...overrides
  }
}

export function createClip(overrides?: Partial<Clip>): Clip {
  return {
    id: `clip-${Math.random().toString(36).slice(2, 8)}`,
    trackId: '',
    type: 'video',
    name: 'Clip',
    startFrame: 0,
    durationFrames: 30,
    sourceStartFrame: 0,
    sourceDurationFrames: 30,
    volume: 1,
    opacity: 1,
    ...overrides
  }
}

// ===== 不变量校验 =====

/**
 * 校验 track 的 clip 列表是否满足不变量：
 *  - 按 startFrame 升序
 *  - 无重叠（半开区间）
 *  - startFrame >= 0, durationFrames >= 1
 */
export function assertTrackInvariants(clips: Clip[]): void {
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]
    if (c.startFrame < 0) throw new Error(`clip ${c.id}: startFrame < 0`)
    if (c.durationFrames < 1) throw new Error(`clip ${c.id}: durationFrames < 1`)
    if (i > 0 && clips[i - 1].startFrame + clips[i - 1].durationFrames > c.startFrame) {
      throw new Error(`clip ${c.id}: overlaps previous`)
    }
  }
}

/** 排序并校验 track 的 clip 列表（保持不变量） */
export function sortClips(clips: Clip[]): Clip[] {
  const sorted = [...clips].sort((a, b) => a.startFrame - b.startFrame)
  assertTrackInvariants(sorted)
  return sorted
}

// ===== resolveTimeline（纯函数） =====

/**
 * 解析某帧的完整场景。纯函数：同一 (frame, project) 恒产出结构相同的 Scene。
 * 规则（对齐 Elah）：
 *  - 时间包含：clip 活跃 iff startFrame <= frame < startFrame + durationFrames（半开区间）
 *  - 源映射：sourceFrame = (frame - startFrame) + sourceStartFrame
 *  - 跳过：track.disabled / clip.disabled / 空 src
 *  - muted 的视频/音频 → volume = 0
 *  - solo：某类轨道有 solo 时，只保留该类 solo 轨道
 *  - zIndex = (maxOrder - track.order) * 1000
 */
export function resolveTimeline(frame: number, project: Project): Scene {
  const scene: Scene = { frame, videos: [], audios: [], texts: [], images: [] }

  const maxOrder = project.tracks.reduce((m, t) => Math.max(m, t.order), 0)

  for (const track of project.tracks) {
    // 跳过禁用轨道
    if (track.disabled) continue

    const clips = project.clips[track.id] ?? []

    for (const clip of clips) {
      if (clip.disabled) continue

      // 时间包含（半开区间）
      const end = clip.startFrame + clip.durationFrames
      if (frame < clip.startFrame || frame >= end) continue

      // 媒体 clip 无 src 则跳过
      if (clip.type !== 'text' && !clip.src) continue

      // 源帧映射
      const sourceFrame = frame - clip.startFrame + clip.sourceStartFrame

      const zIndex = (maxOrder - track.order) * 1000

      // solo 逻辑
      const isSoloTrack = track.solo
      const anySoloOfKind = project.tracks.some(
        (t) => t.kind === track.kind && t.solo
      )
      if (anySoloOfKind && !isSoloTrack) continue

      const base = {
        id: clip.id,
        trackId: clip.trackId,
        name: clip.name,
        sourceFrame,
        opacity: clip.opacity ?? 1,
        zIndex,
        transform: clip.transform
      }

      switch (clip.type) {
        case 'video':
          scene.videos.push({ ...base, type: 'video', src: clip.src!, volume: track.muted ? 0 : (clip.volume ?? 1) })
          break
        case 'audio':
          scene.audios.push({ ...base, type: 'audio', src: clip.src!, volume: track.muted ? 0 : (clip.volume ?? 1) })
          break
        case 'text':
          scene.texts.push({ ...base, type: 'text', content: clip.content ?? '' })
          break
        case 'image':
          scene.images.push({ ...base, type: 'image', src: clip.src!, volume: track.muted ? 0 : (clip.volume ?? 1) })
          break
      }
    }
  }

  return scene
}
