/**
 * AudioVizNext — 演示工程数据
 *
 * 新建工程默认**空白**：只预置轨道结构（V2/V1/T1/A1），不预置任何 clip / 素材，
 * 让时间轴与素材库从空白开始，由用户通过拖拽/导入填充。
 * 帧率 30fps，舞台 1920×1080。
 */
import {
  createProject,
  createTrack,
  createClip,
  zoneForKind,
  defaultTransform,
  type Project,
  type MediaAsset,
  type ClipType,
  type Transform
} from './timeline'

export function createDemoProject(): Project {
  const project = createProject({ fps: 30, stage: { width: 1920, height: 1080 } })

  // 轨道（order 0 = 最顶）。Pr 式：上 2 条视频轨（V2/V1），下 2 条音频轨（A1/A2）。
  const v2 = createTrack({ id: 'v2', name: 'V2', kind: 'video', zone: 'video', order: 0 })
  const v1 = createTrack({ id: 'v1', name: 'V1', kind: 'video', zone: 'video', order: 1 })
  const a1 = createTrack({ id: 'a1', name: 'A1', kind: 'audio', zone: 'audio', order: 2 })
  const a2 = createTrack({ id: 'a2', name: 'A2', kind: 'audio', zone: 'audio', order: 3 })

  project.tracks = [v2, v1, a1, a2]
  project.clips = { v2: [], v1: [], a1: [], a2: [] }
  project.version = 1
  return project
}

/** 素材库（默认空，由用户拖入） */
export function createDemoAssets(): MediaAsset[] {
  return []
}

export function totalFrames(project: Project): number {
  let max = 0
  for (const clips of Object.values(project.clips)) {
    for (const c of clips) {
      max = Math.max(max, c.startFrame + c.durationFrames)
    }
  }
  return max
}

/** 帧 → 时间码 HH:MM:SS:FF */
export function formatTimecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.floor(frame))
  const frames = f % fps
  const totalSec = Math.floor(f / fps)
  const sec = totalSec % 60
  const min = Math.floor(totalSec / 60) % 60
  const hour = Math.floor(totalSec / 3600)
  return [hour, min, sec, frames].map((n) => String(n).padStart(2, '0')).join(':')
}

// ===== 效果分类（Pr 风格：按素材/效果大类） =====

/** 效果面板的分类结构 */
export interface EffectCategory {
  id: string
  name: string
  icon: string
  /** 分类下的可拖拽项（效果 / Clip 模板 / 素材占位） */
  items: EffectTemplate[]
}

/** 效果库中的可拖拽项 */
export interface EffectTemplate {
  id: string
  name: string
  /** 拖拽落轨的轨道类型 */
  kind: 'video' | 'audio' | 'text' | 'image' | 'visual'
  /** 落到时间轴后生成的 clip 类型 */
  clipType: ClipType
  /** 默认时长（帧） */
  durationFrames: number
  /** 默认颜色（UI 展示） */
  color?: string
  desc?: string
  /** 默认变换（视频循环等 clip 自带变换参数） */
  transform?: Transform
  /** 「单次播放」类 clip：时长受关联源素材完整时长上限约束（拖尾拉满即停）。 */
  clampToSource?: boolean
  /** 歌词类 clip：关联歌词素材 + 歌词样式编辑（滚动歌词等）。 */
  isLyrics?: boolean
  /** 预设样式 id（由 presets/registry 的 presetCategories() 生成；见 presets/types.ts） */
  presetId?: string
}

/**
 * 基础 Clip 模板（非预设）。这些是"素材类"落轨模板：拖到时间轴后需要关联素材。
 * 预设样式（presets/**）由 `presets/registry.presetCategories()` 生成，App 里两者合并。
 */
export function createEffectCategories(): EffectCategory[] {
  // 只保留有真实落轨/编辑流程的模板；纯占位（图片填充/背景音乐/画外音）已删除
  const cats: EffectCategory[] = [
    {
      id: 'video',
      name: '视频',
      icon: '▶',
      items: [
        {
          id: 'tpl-video-loop', name: '视频循环', kind: 'video', clipType: 'video', durationFrames: 30 * 5, color: '#0b5eaa',
          desc: '循环视频，可关联素材并设置缩放/位置', transform: defaultTransform()
        }
      ]
    },
    {
      id: 'audio',
      name: '音频',
      icon: '♪',
      items: [
        {
          id: 'tpl-audio-single', name: '单次播放', kind: 'audio', clipType: 'audio', durationFrames: 30 * 5, color: '#1e6a6a',
          clampToSource: true,
          desc: '单次播放音频：仅可编辑关联的音乐，时长上限为歌曲完整时长'
        }
      ]
    },
    {
      id: 'lyrics',
      name: '歌词',
      icon: '✎',
      items: [
        {
          id: 'tpl-lyrics-scroll', name: '滚动歌词', kind: 'text', clipType: 'text', durationFrames: 30 * 8, color: '#8a5a2a',
          isLyrics: true,
          desc: '关联 LRC 歌词，随播放滚动高亮当前句'
        }
      ]
    }
  ]
  return cats.filter((c) => c.items.length > 0)
}

/** 由模板生成一个 clip（落到指定轨道；空素材位，src 为空直到关联素材）。 */
export function clipFromTemplate(tpl: EffectTemplate, trackId: string): ReturnType<typeof createClip> {
  return createClip({
    trackId,
    type: tpl.clipType,
    name: tpl.name,
    durationFrames: tpl.durationFrames,
    sourceDurationFrames: tpl.durationFrames,
    // 空素材位：不设 src（避免 avn:// 占位触发 CSP / 加载报错），关联素材后才填充
    src: undefined,
    content: tpl.clipType === 'text' ? (tpl.desc ?? tpl.name) : undefined,
    transform: tpl.transform,
    opacity: 1,
    // 「单次播放」类：标记时长受源素材上限约束
    clampToSource: tpl.clampToSource,
    maxDurationFrames: tpl.clampToSource ? tpl.durationFrames : undefined,
    // 歌词类：标记，效果控件显示歌词样式编辑
    isLyrics: tpl.isLyrics || undefined,
    // 预设样式：记 id；参数留空，由 preset.json 的 schema 默认值补齐
    presetId: tpl.presetId
  })
}
