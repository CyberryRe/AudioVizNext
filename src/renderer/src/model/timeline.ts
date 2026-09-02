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

/** 时间轴分区：视频区（上） / 音频区（下），两区独立折叠滚动 */
export type TrackZone = 'video' | 'audio'

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
  /** 时间轴分区：video（上）/ audio（下），决定 UI 归属区 */
  zone: TrackZone
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

  // 时长上限（帧）。命中该值时，拖拽尾部调整时长会被钳制在该值（如「单次播放」音频 clip 上限 = 关联歌曲完整时长）。
  maxDurationFrames?: number
  /** 该 clip 的时长受源素材时长上限约束（如「单次播放」）。 */
  clampToSource?: boolean

  /** 歌词类 clip 的样式配置（滚动歌词等） */
  lyrics?: LyricStyle
  /** 是否为歌词类 clip（滚动歌词等） */
  isLyrics?: boolean

  // 标志
  locked?: boolean
  disabled?: boolean
}

/** 歌词样式（滚动歌词 clip 的可编辑项） */
export interface LyricStyle {
  /** 字体族 */
  fontFamily?: string
  /** 对齐：left / center / right */
  align?: 'left' | 'center' | 'right'
  /** 字号（px，相对画幅高度比例？存画幅归一化便于导出缩放） */
  fontSize?: number
  /** 缩放大小（整体缩放倍率） */
  scale?: number
  /** 字颜色 */
  color?: string
  /** 辉光开关 */
  glowEnabled?: boolean
  /** 辉光颜色 */
  glowColor?: string
  /** 位置（画幅内偏移，-0.5..0.5，同 transform.x/y 语义，画幅中心为 0,0） */
  x?: number
  y?: number
  /** 3D 旋转（度）：绕 X/Y/Z 轴，CSS 3D transform（perspective + rotate3d） */
  rotateX?: number
  rotateY?: number
  rotateZ?: number
}

/** 歌词默认样式 */
export function defaultLyricStyle(): LyricStyle {
  return {
    fontFamily: 'sans-serif',
    align: 'center',
    fontSize: 48,
    scale: 1,
    color: '#ffffff',
    glowEnabled: true,
    glowColor: '#00e5ff',
    x: 0,
    y: 0,
    rotateX: 0,
    rotateY: 0,
    rotateZ: 0
  }
}

/** 素材 */
export interface MediaAsset {
  id: string
  kind: 'video' | 'audio' | 'image' | 'lyrics'
  name: string
  src: string
  durationSec: number
  width?: number
  height?: number
  sourceFps?: number
  thumbnailUrl?: string
  byteSize: number
  addedAt: number
  /** 歌词类素材：LRC 文本内容 */
  textContent?: string
  /** 素材源文件绝对路径（Electron File.path；用于持久化/导出引用） */
  sourcePath?: string
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
    zone: 'video',
    order: 0,
    height: 47,
    locked: false,
    disabled: false,
    muted: false,
    solo: false,
    ...overrides
  }
}

/** 由轨道类型推断其所属分区 */
export function zoneForKind(kind: TrackKind): TrackZone {
  return kind === 'audio' ? 'audio' : 'video'
}

/** 标准序列比例（宽/高）。随分辨率联动，决定预览与导出比例。 */
export interface StageRatio {
  id: string
  name: string
  /** 宽高比（宽/高），如 16/9 */
  ratio: number
}

/** 内置序列比例预设 */
export const STAGE_RATIOS: StageRatio[] = [
  { id: '16:9', name: '16:9', ratio: 16 / 9 },
  { id: '9:16', name: '9:16', ratio: 9 / 16 },
  { id: '1:1', name: '1:1', ratio: 1 },
  { id: '4:3', name: '4:3', ratio: 4 / 3 },
  { id: '21:9', name: '21:9', ratio: 21 / 9 },
  { id: '3:2', name: '3:2', ratio: 3 / 2 }
]

/**
 * 依据比例 + 分辨率主边，计算舞台尺寸。
 * @param ratio 宽高比（宽/高）
 * @param mainLength 主边像素（宽或高，取决于 orientation）
 */
export function stageSizeFor(ratio: number, mainLength: number, orientation: 'landscape' | 'portrait' = 'landscape'): { width: number; height: number } {
  if (orientation === 'portrait') {
    // 高 > 宽：ratio = 宽/高 < 1
    return { width: Math.round(mainLength * ratio), height: mainLength }
  }
  return { width: mainLength, height: Math.round(mainLength / ratio) }
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
    lyrics: defaultLyricStyle(),
    ...overrides
  }
}

// ===== 纯逻辑操作（供 UI/拖拽调用，保持不变量） =====

/** 给定目标轨道与落点帧，返回在该轨可容纳的插入帧（避免重叠）。 */
export function findInsertionFrame(clips: Clip[], dropFrame: number): number {
  let best = dropFrame
  for (const c of clips) {
    const start = c.startFrame
    const end = c.startFrame + c.durationFrames
    // 落点落在某个 clip 区间内 → 挪到该 clip 结束位置
    if (dropFrame >= start && dropFrame < end) {
      best = end
      break
    }
  }
  return Math.max(0, best)
}

/**
 * 向某轨添加一个 clip（先排序校验不变量）。
 * 返回新的 clips 数组（不可变）。若与既有 clip 重叠，自动推到末尾。
 */
export function addClipToTrack(
  clips: Clip[],
  newClip: Clip,
  pushForward = false
): Clip[] {
  let insertFrame = pushForward ? findInsertionFrame(clips, newClip.startFrame) : newClip.startFrame
  const candidate = { ...newClip, startFrame: insertFrame }
  const merged = [...clips, candidate]
  try {
    return sortClips(merged)
  } catch {
    // 仍冲突（理论上不会，除非 duration 异常）→ 追加到轨末尾
    const end = clips.reduce((m, c) => Math.max(m, c.startFrame + c.durationFrames), 0)
    return sortClips([...clips, { ...candidate, startFrame: end }])
  }
}

/**
 * 同轨移动 clip：把 startFrame 改为 newStart，若与其他 clip 重叠则推到对方末尾。
 * 返回新的 clips 数组（不可变）。
 */
export function moveClip(clips: Clip[], clipId: string, newStart: number): Clip[] {
  const others = clips.filter((c) => c.id !== clipId)
  const target = clips.find((c) => c.id === clipId)
  if (!target) return clips

  let start = Math.max(0, newStart)
  const dur = target.durationFrames
  // 避免与其他 clip 重叠：若 [start, start+dur) 与任一 other 相交，推到该 other 的末尾
  for (const o of others) {
    const oEnd = o.startFrame + o.durationFrames
    if (start < oEnd && start + dur > o.startFrame) {
      start = oEnd
    }
  }
  return sortClips([...others, { ...target, startFrame: start }])
}

/** 删除某轨中指定 clip，返回新的 clips 数组（不可变）。clip 不存在则原样返回。 */
export function deleteClip(clips: Clip[], clipId: string): Clip[] {
  return clips.filter((c) => c.id !== clipId)
}

/**
 * 新增一条音频轨：追加到现有音频轨之下（order = max+1）。
 * 返回新的 tracks 数组与新建轨道。
 */
export function addAudioTrack(tracks: Track[], overrides?: Partial<Track>): { tracks: Track[]; track: Track } {
  const audioTracks = tracks.filter((t) => t.zone === 'audio')
  const maxOrder = audioTracks.reduce((m, t) => Math.max(m, t.order), -1)
  const track = createTrack({ kind: 'audio', zone: 'audio', order: maxOrder + 1, name: `A${audioTracks.length + 1}`, ...overrides })
  return { tracks: [...tracks, track], track }
}

/** 同轨调整 clip 时长：改变 durationFrames（至少 1 帧），右侧相邻 clip 不重叠；且不超过 maxDurationFrames（若存在）。 */
export function resizeClip(clips: Clip[], clipId: string, newDuration: number): Clip[] {
  const target = clips.find((c) => c.id === clipId)
  if (!target) return clips

  // 最小 1 帧，最大不超过右侧相邻 clip 的起点，且不超过 clip 的时长上限
  let dur = Math.max(1, Math.round(newDuration))
  if (target.maxDurationFrames != null) {
    dur = Math.min(dur, target.maxDurationFrames)
  }
  const rightNeighbor = clips
    .filter((c) => c.id !== clipId && c.startFrame >= target.startFrame)
    .sort((a, b) => a.startFrame - b.startFrame)[0]
  if (rightNeighbor) {
    dur = Math.min(dur, rightNeighbor.startFrame - target.startFrame)
  }
  return clips.map((c) => (c.id === clipId ? { ...c, durationFrames: dur } : c))
}

/** 依据文件扩展名推断素材类型。 */
export function kindFromFileName(name: string): MediaAsset['kind'] {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'].includes(ext)) return 'audio'
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'].includes(ext)) return 'image'
  if (['lrc', 'srt', 'txt'].includes(ext)) return 'lyrics'
  return 'image'
}

/** 默认 clip 变换（归一化：x/y 为相对画布中心的偏移比例，scaleX/Y 为缩放） */
export function defaultTransform(): Transform {
  return { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }
}

/** 一行 LRC 歌词 */
export interface LrcLine {
  time: number // 秒
  text: string
}

/**
 * 解析 LRC 文本 → 按时间排序的歌词行数组。
 * 支持 `[mm:ss.xx]` / `[mm:ss]` 多时间标签、空行跳过、无标签纯文本行当作第 0 秒。
 */
export function parseLrc(text: string | undefined): LrcLine[] {
  if (!text) return []
  const lines = text.split(/\r?\n/)
  const out: LrcLine[] = []
  const timeRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const times: number[] = []
    let m: RegExpExecArray | null
    timeRe.lastIndex = 0
    while ((m = timeRe.exec(line)) !== null) {
      const min = parseInt(m[1], 10)
      const sec = parseInt(m[2], 10)
      const fracRaw = m[3] ?? '0'
      // 兼容 .xx（毫秒两位）与 .xxx（毫秒三位）
      const frac = fracRaw.length <= 2 ? parseInt(fracRaw, 10) / 100 : parseInt(fracRaw, 10) / 1000
      times.push(min * 60 + sec + frac)
    }
    const body = line.replace(timeRe, '').trim()
    if (times.length > 0) {
      for (const t of times) {
        if (body) out.push({ time: t, text: body })
      }
    } else if (body) {
      // 无时间标签 → 放第 0 秒（滚动歌词会默认显示）
      out.push({ time: 0, text: body })
    }
  }
  return out.sort((a, b) => a.time - b.time)
}

/** 依据给定秒数取当前应显示的歌词行（滚动歌词：最后一条 time <= sec 的行；无则空串）。 */
export function lrcLineAt(lines: LrcLine[], sec: number): string {
  let current = ''
  for (const l of lines) {
    if (l.time <= sec) current = l.text
    else break
  }
  return current
}

/** 当前应高亮的歌词行索引（滚动歌词居中定位用）。无则 -1。 */
export function lrcIndexAt(lines: LrcLine[], sec: number): number {
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= sec) idx = i
    else break
  }
  return idx
}

/**
 * 歌词滚动滑行位置（参考 AudioViz Studio LyricsLayout.glidePos）：
 * 返回浮动行位置 pos = currentIdx + eased，其中 eased∈[0,1]。
 * 当前行离下一句 time 不足 SCROLL_DELTA(0.4s) 时，pos 开始从 currentIdx 平滑滑向 currentIdx+1
 * （smoothstep 缓动）→ 让位行/目标行在行边界前 0.4s 内渐变，切句零跳变。
 * 高亮归属仍严格由 lrcIndexAt 决定（t 未到 next.time 前仍是当前行），此处仅驱动视觉平滑位移。
 */
export function lrcGlide(lines: LrcLine[], sec: number): number {
  const idx = lrcIndexAt(lines, sec)
  if (idx < 0 || idx >= lines.length - 1) return idx
  const remaining = lines[idx + 1].time - sec
  const SCROLL_DELTA = 0.4
  const raw = Math.max(0, Math.min(1, (SCROLL_DELTA - remaining) / SCROLL_DELTA))
  const eased = raw * raw * (3 - 2 * raw)
  return idx + eased
}

// ===== 颜色工具（歌词滚动行间混色用；hex/rgb → 混合色串）=====

/** hex/rgb → {r,g,b}。解析失败回退白色。 */
export function parseColor(c: string): { r: number; g: number; b: number } {
  if (!c) return { r: 255, g: 255, b: 255 }
  c = String(c).trim()
  if (c.startsWith('#')) {
    let h = c.replace('#', '')
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    const n = parseInt(h, 16)
    if (Number.isNaN(n)) return { r: 255, g: 255, b: 255 }
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
  const m = c.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const p = m[1].split(',').map((v) => parseFloat(v.trim()))
    return { r: p[0] || 255, g: p[1] || 255, b: p[2] || 255 }
  }
  return { r: 255, g: 255, b: 255 }
}

/** 颜色插值：k=0 → c1，k=1 → c2。返回 rgb 字符串（供 Pixi/DOM 统一使用）。 */
export function mixColor(c1: string, c2: string, k: number): string {
  const a = parseColor(c1), b = parseColor(c2)
  const kk = Math.max(0, Math.min(1, k))
  const mix = (x: number, y: number) => Math.round(x + (y - x) * kk)
  return `rgb(${mix(a.r, b.r)},${mix(a.g, b.g)},${mix(a.b, b.b)})`
}

/**
 * 给 clip 绑定素材：更新 src/assetId/name。
 * 若 asset.kind 与 clip.type 兼容（video→video/image，image→image，audio→audio），
 * 并对「空模板位」clip（尚未绑定素材，即 !assetId）同步时长到素材时长。
 * 返回新 clip（或 null 表示不兼容 / clip 不存在）。
 */
export function bindAssetToClip(
  clip: Clip | undefined,
  asset: MediaAsset | undefined
): Clip | null {
  if (!clip || !asset) return null
  // 类型兼容校验
  const compatible =
    (clip.type === 'video' && asset.kind === 'video') ||
    (clip.type === 'video' && asset.kind === 'image') ||
    (clip.type === 'image' && asset.kind === 'image') ||
    (clip.type === 'audio' && asset.kind === 'audio') ||
    (clip.type === 'text' && asset.kind === 'lyrics')
  if (!compatible) return null

  const src = asset.src
  const assetFrames = asset.durationSec ? Math.max(1, Math.round(asset.durationSec * 30)) : undefined

  // 未绑定素材的模板位 clip → 时长随素材、并落素材名
  const isTemplate = !clip.assetId

  // 「单次播放」类 clip：绑定后时长扩展到源素材完整时长（时间轴 Clip 随之变长），
  // 同时设 maxDurationFrames = 源完整时长，作为拖尾调整的上限（拉满即停）。
  // 若无法取得源时长（探测失败）→ 不设上限，允许用户手动拖到任意长度。
  let maxDurationFrames = clip.maxDurationFrames
  let durationFrames = clip.durationFrames
  if (clip.clampToSource) {
    if (assetFrames) {
      maxDurationFrames = assetFrames
      durationFrames = assetFrames
    } else {
      // 源时长未知：去掉模板默认上限，避免"拖不动"
      maxDurationFrames = undefined
    }
  } else if (isTemplate && assetFrames) {
    // 普通模板位（如视频循环）→ 时长对齐源素材
    durationFrames = assetFrames
  }

  const next: Clip = {
    ...clip,
    src,
    assetId: asset.id,
    name: isTemplate ? asset.name : clip.name,
    durationFrames,
    maxDurationFrames,
    sourceDurationFrames: isTemplate && assetFrames ? assetFrames : clip.sourceDurationFrames,
    sourceStartFrame: clip.sourceStartFrame ?? 0,
    // 歌词类素材 → 把 LRC 文本写入 clip.content（供渲染逐句解析）
    content: clip.type === 'text' && asset.textContent != null ? asset.textContent : clip.content
  }
  return next
}

/**
 * 跨轨移动 clip：把 clip 从原轨移到目标轨，startFrame 改为 newStart。
 * - 源轨移除该 clip；目标轨 addClipToTrack（自动避免重叠）
 * - 若目标轨不存在，返回 null（由调用方决定是否自动建轨）
 * 返回 { clips, moved } 或 null。
 */
export function moveClipAcrossTracks(
  clipsMap: Record<string, Clip[]>,
  clipId: string,
  targetTrackId: string,
  newStart: number
): { clips: Record<string, Clip[]>; moved: boolean } | null {
  // 找到 clip 所在源轨
  let sourceTrackId: string | null = null
  let clip: Clip | null = null
  for (const [tid, clips] of Object.entries(clipsMap)) {
    const c = clips.find((x) => x.id === clipId)
    if (c) { sourceTrackId = tid; clip = c; break }
  }
  if (!sourceTrackId || !clip) return null
  if (sourceTrackId === targetTrackId) return null

  const targetClips = clipsMap[targetTrackId]
  if (!targetClips) return null

  const sourceRemoved = (clipsMap[sourceTrackId] ?? []).filter((c) => c.id !== clipId)
  const relocated: Clip = {
    ...clip,
    trackId: targetTrackId,
    startFrame: Math.max(0, newStart)
  }
  const targetNext = addClipToTrack(targetClips, relocated, true)
  return {
    clips: { ...clipsMap, [sourceTrackId]: sourceRemoved, [targetTrackId]: targetNext },
    moved: true
  }
}

/**
 * 新增一个视频轨（自动建轨用）：插入到现有视频轨**之上**（顶部）。
 * 实现：新轨 order = 现有视频轨最小 order（顶到最前 = 0 语义），现有视频轨 order 整体 +1 下移；
 * 并把新轨**插到 tracks 数组的视频区最前**（UI 从上到下按数组顺序显示，须与 order 一致，
 * 否则出现"order=0(该渲染最顶) 却在时间轴最底显示"的矛盾）。
 * 返回新的 tracks 数组与新建轨道。顺序保证：数组内视频轨按 order 升序（顶→底 = 最顶层→底层）。
 */
export function addVideoTrack(tracks: Track[], overrides?: Partial<Track>): { tracks: Track[]; track: Track } {
  const videoTracks = tracks.filter((t) => t.zone === 'video')
  const minOrder = videoTracks.reduce((m, t) => Math.min(m, t.order), Infinity)
  const order = Number.isFinite(minOrder) ? minOrder : 0
  // 把现有 video 轨的 order 整体下移（+1），让新轨在最顶
  const shifted = tracks.map((t) => (t.zone === 'video' ? { ...t, order: t.order + 1 } : t))
  const track = createTrack({ kind: 'video', zone: 'video', order, name: `V${videoTracks.length + 1}`, ...overrides })
  // 插入到视频区最前（视频轨原本就占据数组前部；audio 追加在尾部，order 更大）。保持按 order 升序。
  const firstVideoIdx = shifted.findIndex((t) => t.zone === 'video')
  const insertAt = firstVideoIdx < 0 ? 0 : firstVideoIdx
  const next = [...shifted]
  next.splice(insertAt, 0, track)
  return { tracks: next, track }
}

/**
 * 从 File 对象构造 MediaAsset（本地拖入素材库）。
 *
 * ⚠ Electron ≥32 已移除 `File.path`（WebUtils.getPathForFile 取代之）。本函数不自行读 file.path，
 * 而是接收调用方用 preload `window.api.getPathForFile(file)` 解析出的磁盘绝对路径：
 *  - 拿到真实路径 → src 用 `avn-file://<path>`（持久化/重开仍有效；也让媒体缓存 MediaCache 能命中）；
 *  - 拿不到（纯浏览器/非磁盘 File）→ 回退 blob URL 原样展示。
 */
export function assetFromFile(file: File, resolvedPath: string | null = null, index = 0): MediaAsset {
  const kind = kindFromFileName(file.name)
  const now = Date.now()
  let src: string
  const filePath = resolvedPath && resolvedPath.length > 1 ? resolvedPath : ''
  if (filePath) {
    src = `avn-file://${encodeURIComponent(filePath)}`
  } else {
    src = URL.createObjectURL(file)
  }
  return {
    id: `asset-${now.toString(36)}-${index}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    name: file.name,
    src,
    durationSec: 0,
    width: kind === 'image' ? 320 : undefined,
    height: kind === 'image' ? 180 : undefined,
    byteSize: file.size,
    addedAt: now,
    // 记录源路径，便于工程保存/导出引用
    sourcePath: filePath
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
