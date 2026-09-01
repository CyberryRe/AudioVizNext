/**
 * AudioVizNext — 演示工程数据
 *
 * 用于 UI 骨架展示：填充轨道、clip、素材，让时间轴/监视器/素材库有内容可看。
 * 帧率 30fps，舞台 1920×1080。
 */
import {
  createProject,
  createTrack,
  createClip,
  sortClips,
  type Project,
  type MediaAsset,
  type ClipType
} from './timeline'

export function createDemoProject(): Project {
  const project = createProject({ fps: 30, stage: { width: 1920, height: 1080 } })

  // 轨道（order 0 = 最顶）
  const v2 = createTrack({ id: 'v2', name: 'V2', kind: 'video', order: 0 })
  const v1 = createTrack({ id: 'v1', name: 'V1', kind: 'video', order: 1 })
  const t1 = createTrack({ id: 't1', name: 'T1', kind: 'text', order: 2 })
  const a1 = createTrack({ id: 'a1', name: 'A1', kind: 'audio', order: 3 })

  project.tracks = [v2, v1, t1, a1]

  // V2: 背景视频（cover 铺满画布）
  const bg = createClip({
    id: 'clip-bg',
    trackId: 'v2',
    type: 'video',
    name: '背景视频.mov',
    startFrame: 0,
    durationFrames: 30 * 12, // 12 秒
    sourceStartFrame: 100,
    sourceDurationFrames: 30 * 12,
    src: 'https://vjs.zencdn.net/v/oceans.mp4'
  })

  // V2: 第二个视频片段
  const seg2 = createClip({
    id: 'clip-seg2',
    trackId: 'v2',
    type: 'video',
    name: '片段02.mp4',
    startFrame: 30 * 12,
    durationFrames: 30 * 8,
    sourceStartFrame: 0,
    sourceDurationFrames: 30 * 8,
    src: 'https://www.w3schools.com/html/mov_bbb.mp4'
  })

  // V1: 图片
  const img = createClip({
    id: 'clip-img',
    trackId: 'v1',
    type: 'image',
    name: '封面.png',
    startFrame: 30 * 5,
    durationFrames: 30 * 5,
    sourceStartFrame: 0,
    sourceDurationFrames: 30 * 5,
    src: 'https://picsum.photos/400/300'
  })

  // T1: 标题文字
  const title = createClip({
    id: 'clip-title',
    trackId: 't1',
    type: 'text',
    name: '标题',
    startFrame: 30 * 2,
    durationFrames: 30 * 6,
    sourceStartFrame: 0,
    sourceDurationFrames: 30 * 6,
    content: 'AudioViz 演示'
  })

  // A1: 音频轨（音乐 + 画外音，避免重叠）
  const music = createClip({
    id: 'clip-music',
    trackId: 'a1',
    type: 'audio',
    name: '背景音乐.mp3',
    startFrame: 0,
    durationFrames: 30 * 8, // 8 秒
    sourceStartFrame: 0,
    sourceDurationFrames: 30 * 8,
    src: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    volume: 0.7
  })
  const vo = createClip({
    id: 'clip-vo',
    trackId: 'a1',
    type: 'audio',
    name: '画外音.wav',
    startFrame: 30 * 8, // music 结束处开始，不重叠
    durationFrames: 30 * 6,
    sourceStartFrame: 0,
    sourceDurationFrames: 30 * 6,
    src: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
    volume: 1
  })

  // 排序并写入（保持不变量）
  project.clips = {
    v2: sortClips([bg, seg2]),
    v1: sortClips([img]),
    t1: sortClips([title]),
    a1: sortClips([music, vo])
  }

  project.version = 1
  return project
}

/** 演示素材库 */
export function createDemoAssets(): MediaAsset[] {
  const now = Date.now()
  return [
    { id: 'asset-1', kind: 'video', name: '背景视频.mov', src: 'https://vjs.zencdn.net/v/oceans.mp4', durationSec: 12, width: 1920, height: 1080, sourceFps: 30, byteSize: 1024 * 1024 * 20, addedAt: now },
    { id: 'asset-2', kind: 'video', name: '片段02.mp4', src: 'https://www.w3schools.com/html/mov_bbb.mp4', durationSec: 8, width: 1920, height: 1080, sourceFps: 30, byteSize: 1024 * 1024 * 15, addedAt: now },
    { id: 'asset-3', kind: 'image', name: '封面.png', src: 'https://picsum.photos/400/300', durationSec: 5, width: 400, height: 300, byteSize: 1024 * 500, addedAt: now },
    { id: 'asset-4', kind: 'audio', name: '背景音乐.mp3', src: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', durationSec: 20, byteSize: 1024 * 3000, addedAt: now },
    { id: 'asset-5', kind: 'audio', name: '画外音.wav', src: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3', durationSec: 6, byteSize: 1024 * 800, addedAt: now }
  ]
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
        { id: 'tpl-video-loop', name: '视频循环', kind: 'video', clipType: 'video', durationFrames: 30 * 5, color: '#0b5eaa' },
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
        { id: 'tpl-audio-vo', name: '画外音', kind: 'audio', clipType: 'audio', durationFrames: 30 * 6, color: '#2a7a3a' }
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

/** 由模板生成一个 clip（落到指定轨道；空素材位）。 */
export function clipFromTemplate(tpl: EffectTemplate, trackId: string): ReturnType<typeof createClip> {
  return createClip({
    trackId,
    type: tpl.clipType,
    name: tpl.name,
    durationFrames: tpl.durationFrames,
    sourceDurationFrames: tpl.durationFrames,
    src: tpl.clipType === 'text' ? undefined : `avn://template/${tpl.id}`,
    content: tpl.clipType === 'text' ? (tpl.desc ?? tpl.name) : undefined,
    opacity: 1
  })
}
