import type { Project, Clip, Track } from '../model/timeline'
import { formatTimecode } from '../model/demo'

interface TimelineProps {
  project: Project
  total: number
  playheadFrame: number
  isPlaying: boolean
  onPlay: (playing: boolean) => void
  onSeek: (frame: number) => void
  selectedClipId: string | null
  onSelectClip: (id: string | null) => void
}

/** 每帧的像素宽度 */
const PX_PER_FRAME = 0.6
const TRACK_HEIGHT = 47
const TRACK_CONTROL_WIDTH = 174
const RULER_HEIGHT = 47

/** 轨道标签配色 */
const TRACK_COLOR: Record<Track['kind'], string> = {
  video: 'var(--track-video)',
  audio: 'var(--track-audio)',
  text: 'var(--track-text)'
}

/**
 * 中下：时间轴。
 * 轨道控制（左）+ 标尺 + 轨道行 + 播放头。
 * clip 块按 startFrame/durationFrames × PX_PER_FRAME 定位。
 */
export default function Timeline({
  project,
  total,
  playheadFrame,
  isPlaying,
  onPlay,
  onSeek,
  selectedClipId,
  onSelectClip
}: TimelineProps): React.JSX.Element {
  const fps = project.fps
  const totalPx = total * PX_PER_FRAME

  const handleTimelineClick = (e: React.MouseEvent): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const frame = Math.max(0, Math.round(x / PX_PER_FRAME))
    onSeek(frame)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="tabline">
        <span className="tab active">序列 01</span>
        <span style={{ marginLeft: 'auto', color: '#888' }}>☰</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: `${TRACK_CONTROL_WIDTH}px 1fr`, position: 'relative' }}>
        {/* ===== 轨道控制（左） ===== */}
        <div style={{ background: 'var(--bg-track-controls)', borderRight: '1px solid var(--border-dark)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ height: RULER_HEIGHT, borderBottom: '1px solid var(--border-dark)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
            ▣ ▣ ▾ 🔧
          </div>
          <div style={{ paddingTop: 7, flex: 1 }}>
            {project.tracks.map((track) => (
              <div
                key={track.id}
                style={{ height: TRACK_HEIGHT, borderBottom: '1px solid var(--border-row)', display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px' }}
              >
                <div
                  style={{
                    width: 29,
                    height: 29,
                    background: TRACK_COLOR[track.kind],
                    borderRadius: 3,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: 12
                  }}
                >
                  {track.name}
                </div>
                <div style={{ color: '#8e8e8e', display: 'flex', gap: 9 }}>
                  {track.kind === 'audio' ? '▱ M S ♟' : '▱ ◉ ◌'}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ===== 时间区（标尺 + 轨道行） ===== */}
        <div
          style={{ overflow: 'hidden', position: 'relative', background: 'var(--bg-timeline)', cursor: 'crosshair' }}
          onClick={handleTimelineClick}
        >
          {/* 标尺 */}
          <div
            style={{
              height: RULER_HEIGHT,
              borderBottom: '1px solid var(--border-dark)',
              background: 'repeating-linear-gradient(90deg, transparent 0, transparent 8px, #555 9px, #555 10px)',
              position: 'relative',
              overflow: 'hidden'
            }}
          >
            {Array.from({ length: Math.floor(total / fps) + 1 }).map((_, i) => {
              const left = i * fps * PX_PER_FRAME
              return (
                <span
                  key={i}
                  style={{ position: 'absolute', top: 4, left, color: '#aaa', fontSize: 11, whiteSpace: 'nowrap' }}
                >
                  {formatTimecode(i * fps, fps)}
                </span>
              )
            })}
          </div>

          {/* 轨道行 */}
          <div style={{ position: 'absolute', left: 0, right: 0, top: RULER_HEIGHT, bottom: 0, overflow: 'hidden' }}>
            {project.tracks.map((track) => (
              <div key={track.id} style={{ height: TRACK_HEIGHT, borderBottom: '1px solid var(--border-row)', position: 'relative' }}>
                {(project.clips[track.id] ?? []).map((clip) => (
                  <ClipBlock
                    key={clip.id}
                    clip={clip}
                    track={track}
                    pxPerFrame={PX_PER_FRAME}
                    selected={clip.id === selectedClipId}
                    onSelect={() => onSelectClip(clip.id === selectedClipId ? null : clip.id)}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* 播放头 */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              width: 1,
              background: 'var(--accent-playhead)',
              left: playheadFrame * PX_PER_FRAME,
              zIndex: 4,
              pointerEvents: 'none'
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: -4,
                borderLeft: '5px solid transparent',
                borderRight: '5px solid transparent',
                borderTop: '9px solid #18a8ff'
              }}
            />
          </div>

          {/* 宽度占位（让内容可横向滚动） */}
          <div style={{ position: 'absolute', left: 0, top: RULER_HEIGHT, width: Math.max(totalPx, '100%' as never), height: 1 }} />
        </div>
      </div>

      {/* 底部工具栏 */}
      <div style={{ height: 30, flex: 'none', background: 'var(--bg-tabline)', borderTop: '1px solid var(--border-dark)', display: 'flex', alignItems: 'center', gap: 14, padding: '0 12px', color: 'var(--text-muted)' }}>
        <span style={{ color: 'var(--accent-playhead)', fontWeight: 600 }}>{formatTimecode(playheadFrame, fps)}</span>
        <span style={{ cursor: 'pointer' }} onClick={() => onPlay(!isPlaying)}>{isPlaying ? '⏸' : '▶'}</span>
        <span style={{ cursor: 'pointer' }} onClick={() => onSeek(0)}>⏮</span>
        <span style={{ marginLeft: 'auto' }}>▣ Ⅱ ▶ ⌄ 🔧 CC</span>
      </div>
    </div>
  )
}

/** 单个 clip 块 */
function ClipBlock({
  clip,
  track,
  pxPerFrame,
  selected,
  onSelect
}: {
  clip: Clip
  track: Track
  pxPerFrame: number
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const left = clip.startFrame * pxPerFrame
  const width = clip.durationFrames * pxPerFrame

  return (
    <div
      onClick={(e) => { e.stopPropagation(); onSelect() }}
      style={{
        position: 'absolute',
        left,
        top: 3,
        bottom: 3,
        width: Math.max(width - 2, 4),
        background: TRACK_COLOR[track.kind],
        opacity: 0.85,
        borderRadius: 3,
        border: selected ? '1px solid var(--accent)' : '1px solid rgba(255,255,255,0.15)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 6px',
        color: '#fff',
        fontSize: 10,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        cursor: 'pointer',
        userSelect: 'none'
      }}
      title={clip.name}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{clip.name}</span>
    </div>
  )
}
