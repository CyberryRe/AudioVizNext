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
}

/**
 * 效果分类（Stage 2 骨架）。
 * 其中「可视化」下放了 test clip，用于验证「拖拽创建 Clip」的整条业务链路，
 * 真正的可视化渲染后续阶段再接。
 */
export function createEffectCategories(): EffectCategory[] {
  return [
    {
      id: 'video',
      name: '视频',
      icon: '▶',
      items: [
        {
          id: 'tpl-video-loop', name: '视频循环', kind: 'video', clipType: 'video', durationFrames: 30 * 5, color: '#0b5eaa',
          desc: '循环视频，可关联素材并设置缩放/位置', transform: defaultTransform()
        },
        { id: 'tpl-video-transform', name: '视频变换', kind: 'video', clipType: 'video', durationFrames: 30 * 5, color: '#0b5eaa' }
      ]
    },
    {
      id: 'image',
      name: '图片',
      icon: '▧',
      items: [
        { id: 'tpl-image-fill', name: '图片填充', kind: 'image', clipType: 'image', durationFrames: 30 * 4, color: '#7a4a9a' }
      ]
    },
    {
      id: 'audio',
      name: '音频',
      icon: '♪',
      items: [
        { id: 'tpl-audio-music', name: '背景音乐', kind: 'audio', clipType: 'audio', durationFrames: 30 * 8, color: '#2a7a3a' },
        { id: 'tpl-audio-vo', name: '画外音', kind: 'audio', clipType: 'audio', durationFrames: 30 * 6, color: '#2a7a3a' },
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
        { id: 'tpl-lyrics-karaoke', name: '卡拉OK歌词', kind: 'text', clipType: 'text', durationFrames: 30 * 6, color: '#8a5a2a', desc: 'LRC 歌词逐行高亮' }
      ]
    },
    {
      id: 'visual',
      name: '可视化',
      icon: '◎',
      items: [
        { id: 'tpl-visual-test', name: 'Test Clip', kind: 'visual', clipType: 'text', durationFrames: 30 * 4, color: '#c05a3a', desc: '拖拽业务验证占位' }
      ]
    }
  ]
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
    maxDurationFrames: tpl.clampToSource ? tpl.durationFrames : undefined
  })
}
