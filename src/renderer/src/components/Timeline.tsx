import { useRef } from 'react'
import type { Project, Clip, Track, MediaAsset } from '../model/timeline'
import { formatTimecode } from '../model/demo'
import type { EffectTemplate } from '../model/demo'

interface TimelineProps {
  project: Project
  total: number
  playheadFrame: number
  isPlaying: boolean
  onPlay: (playing: boolean) => void
  onSeek: (frame: number) => void
  selectedClipId: string | null
  onSelectClip: (id: string | null) => void
  onAddTemplate: (tpl: EffectTemplate, dropFrame: number, targetTrackId?: string) => void
  onAddAssetClip: (asset: MediaAsset, dropFrame: number, targetTrackId?: string) => void
  onToggleTrack: (trackId: string, prop: 'disabled' | 'muted' | 'solo' | 'locked') => void
  onMoveClip: (clipId: string, newStart: number) => void
  onResizeClip: (clipId: string, newDuration: number) => void
  getAsset: (id: string) => MediaAsset | undefined
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

/** 读取拖拽 payload（自定义 MIME + 兜底 stash） */
function readDragPayload(e: React.DragEvent): { template?: EffectTemplate; assetId?: string } | null {
  // 优先自定义 MIME
  try {
    const raw = e.dataTransfer.getData('application/x-avn-template')
    if (raw) {
      const p = JSON.parse(raw)
      if (p.template) return { template: p.template }
    }
  } catch { /* ignore */ }
  try {
    const raw = e.dataTransfer.getData('application/x-avn-asset')
    if (raw) {
      const p = JSON.parse(raw)
      if (p.assetId) return { assetId: p.assetId }
    }
  } catch { /* ignore */ }
  // 兜底 stash
  const stash = (window as unknown as Record<string, unknown>)._avsPendingDrag as
    | { type: 'template'; template: EffectTemplate }
    | { type: 'asset'; assetId: string }
    | undefined
  if (stash) {
    if (stash.type === 'template') return { template: stash.template }
    if (stash.type === 'asset') return { assetId: stash.assetId }
  }
  return null
}

/**
 * 中下：时间轴。
 * 轨道控制（左）+ 标尺 + 轨道行 + 播放头。
 * 支持：点击定位、播放头拖动、拖拽模板/素材落轨。
 */
export default function Timeline({
  project,
  total,
  playheadFrame,
  isPlaying,
  onPlay,
  onSeek,
  selectedClipId,
  onSelectClip,
  onAddTemplate,
  onAddAssetClip,
  onToggleTrack,
  onMoveClip,
  onResizeClip,
  getAsset
}: TimelineProps): React.JSX.Element {
  const fps = project.fps
  const totalPx = total * PX_PER_FRAME
  const timeAreaRef = useRef<HTMLDivElement>(null)

  // 由鼠标事件计算帧
  const frameFromEvent = (clientX: number): number => {
    const el = timeAreaRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return Math.max(0, Math.round((clientX - rect.left) / PX_PER_FRAME))
  }

  const handleTimelineClick = (e: React.MouseEvent): void => {
    onSeek(frameFromEvent(e.clientX))
  }

  // 播放头拖动
  const handlePlayheadDrag = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const seek = (ev: MouseEvent): void => onSeek(frameFromEvent(ev.clientX))
    const up = (): void => {
      window.removeEventListener('mousemove', seek)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', seek)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = 'ew-resize'
  }

  // 拖拽落轨
  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const payload = readDragPayload(e)
    if (!payload) return
    const dropFrame = frameFromEvent(e.clientX)

    // 由落点 y 推断目标轨道
    const el = timeAreaRef.current
    let targetTrackId: string | undefined
    if (el) {
      const rect = el.getBoundingClientRect()
      const relY = e.clientY - rect.top - RULER_HEIGHT
      const idx = Math.floor(relY / TRACK_HEIGHT)
      const track = project.tracks[idx]
      if (track) targetTrackId = track.id
    }

    if (payload.template) {
      onAddTemplate(payload.template, dropFrame, targetTrackId)
    } else if (payload.assetId) {
      const asset = getAsset(payload.assetId)
      if (asset) onAddAssetClip(asset, dropFrame, targetTrackId)
    }
    // 清空兜底
    ;(window as unknown as Record<string, unknown>)._avsPendingDrag = undefined
  }

  // 轨道空行点击：定位播放头
  const handleTrackClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onSeek(frameFromEvent(e.clientX))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="tabline">
        <span className="tab active">序列 01</span>
        <span style={{ marginLeft: 'auto', color: '#888', cursor: 'pointer', fontSize: 14 }} title="时间轴设置">☰</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: `${TRACK_CONTROL_WIDTH}px 1fr`, position: 'relative' }}>
        {/* ===== 轨道控制（左） ===== */}
        <div style={{ background: 'var(--bg-track-controls)', borderRight: '1px solid var(--border-dark)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ height: RULER_HEIGHT, borderBottom: '1px solid var(--border-dark)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', gap: 8, fontSize: 12 }}>
            <span title="添加轨道" style={{ cursor: 'pointer' }}>▣</span>
            <span title="吸附" style={{ cursor: 'pointer' }}>⚓</span>
            <span title="链接" style={{ cursor: 'pointer' }}>🔗</span>
            <span title="轨道设置" style={{ cursor: 'pointer' }}>🔧</span>
          </div>
          <div style={{ paddingTop: 7, flex: 1, overflow: 'auto' }}>
            {project.tracks.map((track) => (
              <div
                key={track.id}
                style={{ height: TRACK_HEIGHT, borderBottom: '1px solid var(--border-row)', display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px' }}
              >
                <div
                  style={{
                    width: 29,
                    height: 29,
                    background: track.kind === 'audio' ? (track.muted ? '#5a5a5a' : TRACK_COLOR[track.kind]) : TRACK_COLOR[track.kind],
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
                <div style={{ color: '#8e8e8e', display: 'flex', gap: 6, fontSize: 13, alignItems: 'center' }}>
                  {/* 可见性 */}
                  <span
                    title={track.disabled ? '启用轨道' : '禁用轨道'}
                    onClick={() => onToggleTrack(track.id, 'disabled')}
                    style={{ cursor: 'pointer', color: track.disabled ? '#5a5a5a' : '#9e9e9e', opacity: track.disabled ? 0.45 : 1 }}
                  >
                    ▱
                  </span>
                  {track.kind === 'audio' ? (
                    <>
                      <span
                        title="静音"
                        onClick={() => onToggleTrack(track.id, 'muted')}
                        style={{ cursor: 'pointer', fontWeight: 700, color: track.muted ? '#e05c5c' : '#8e8e8e' }}
                      >
                        M
                      </span>
                      <span
                        title="独奏"
                        onClick={() => onToggleTrack(track.id, 'solo')}
                        style={{ cursor: 'pointer', fontWeight: 700, color: track.solo ? '#e0b34c' : '#8e8e8e' }}
                      >
                        S
                      </span>
                    </>
                  ) : (
                    <>
                      <span
                        title="独奏"
                        onClick={() => onToggleTrack(track.id, 'solo')}
                        style={{ cursor: 'pointer', fontWeight: 700, color: track.solo ? '#e0b34c' : '#8e8e8e' }}
                      >
                        ◉
                      </span>
                      <span
                        title="锁定"
                        onClick={() => onToggleTrack(track.id, 'locked')}
                        style={{ cursor: 'pointer', color: track.locked ? '#e0b34c' : '#8e8e8e' }}
                      >
                        ◌
                      </span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ===== 时间区（标尺 + 轨道行） ===== */}
        <div
          ref={timeAreaRef}
          style={{ overflow: 'hidden', position: 'relative', background: 'var(--bg-timeline)', cursor: 'crosshair' }}
          onClick={handleTimelineClick}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
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
                  style={{ position: 'absolute', top: 4, left, color: '#aaa', fontSize: 11, whiteSpace: 'nowrap', cursor: 'crosshair' }}
                >
                  {formatTimecode(i * fps, fps)}
                </span>
              )
            })}
          </div>

          {/* 轨道行 */}
          <div style={{ position: 'absolute', left: 0, right: 0, top: RULER_HEIGHT, bottom: 0, overflow: 'hidden' }}>
            {project.tracks.map((track) => (
              <div
                key={track.id}
                style={{ height: TRACK_HEIGHT, borderBottom: '1px solid var(--border-row)', position: 'relative' }}
                onClick={handleTrackClick}
              >
                {(project.clips[track.id] ?? []).map((clip) => (
                  <ClipBlock
                    key={clip.id}
                    clip={clip}
                    track={track}
                    pxPerFrame={PX_PER_FRAME}
                    selected={clip.id === selectedClipId}
                    onSelect={() => onSelectClip(clip.id === selectedClipId ? null : clip.id)}
                    onMove={(newStart) => onMoveClip(clip.id, newStart)}
                    onResize={(newDuration) => onResizeClip(clip.id, newDuration)}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* 播放头（可拖动） */}
          <div
            onMouseDown={handlePlayheadDrag}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              width: 1,
              background: 'var(--accent-playhead)',
              left: playheadFrame * PX_PER_FRAME,
              zIndex: 4,
              cursor: 'ew-resize'
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: -4,
                borderLeft: '5px solid transparent',
                borderRight: '5px solid transparent',
                borderTop: '9px solid #18a8ff',
                cursor: 'ew-resize'
              }}
            />
          </div>

          {/* 宽度占位（让内容可横向滚动） */}
          <div style={{ position: 'absolute', left: 0, top: RULER_HEIGHT, width: Math.max(totalPx, 1), height: 1 }} />
        </div>
      </div>

      {/* 底部工具栏 */}
      <div style={{ height: 30, flex: 'none', background: 'var(--bg-tabline)', borderTop: '1px solid var(--border-dark)', display: 'flex', alignItems: 'center', gap: 14, padding: '0 12px', color: 'var(--text-muted)' }}>
        <span style={{ color: 'var(--accent-playhead)', fontWeight: 600 }}>{formatTimecode(playheadFrame, fps)}</span>
        <span style={{ cursor: 'pointer', fontSize: 14 }} onClick={() => onPlay(!isPlaying)} title="播放/暂停">
          {isPlaying ? '⏸' : '▶'}
        </span>
        <span style={{ cursor: 'pointer', fontSize: 14 }} onClick={() => onSeek(0)} title="回到起点">⏮</span>
        <span style={{ cursor: 'pointer', fontSize: 14 }} onClick={() => onSeek(playheadFrame + fps)} title="下一帧片段">⏭</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7 }}>
          ▣ Ⅱ ▶ ⌄ 🔧 CC
        </span>
      </div>
    </div>
  )
}

/** 单个 clip 块 —— 支持拖动改变位置 + 拖动右缘调整时长 */
function ClipBlock({
  clip,
  track,
  pxPerFrame,
  selected,
  onSelect,
  onMove,
  onResize
}: {
  clip: Clip
  track: Track
  pxPerFrame: number
  selected: boolean
  onSelect: () => void
  onMove: (newStart: number) => void
  onResize: (newDuration: number) => void
}): React.JSX.Element {
  const left = clip.startFrame * pxPerFrame
  const width = clip.durationFrames * pxPerFrame

  /** 拖动主体：移动 clip */
  const startMove = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const startClientX = e.clientX
    const startFrame = clip.startFrame
    const move = (ev: MouseEvent): void => {
      const deltaFrame = Math.round((ev.clientX - startClientX) / pxPerFrame)
      onMove(startFrame + deltaFrame)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = 'grabbing'
  }

  /** 拖动右缘：调整时长 */
  const startResize = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const startClientX = e.clientX
    const startDur = clip.durationFrames
    const move = (ev: MouseEvent): void => {
      const deltaFrame = Math.round((ev.clientX - startClientX) / pxPerFrame)
      onResize(startDur + deltaFrame)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = 'ew-resize'
  }

  return (
    <div
      onClick={(e) => { e.stopPropagation(); onSelect() }}
      onMouseDown={startMove}
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
        cursor: 'grab',
        userSelect: 'none',
        touchAction: 'none'
      }}
      title={`${clip.name}（拖动移动，拖右缘调整时长）`}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{clip.name}</span>
      {/* 右缘调整手柄 */}
      <div
        onMouseDown={startResize}
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: 10,
          cursor: 'ew-resize',
          background: 'rgba(255,255,255,0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 8,
          color: 'rgba(255,255,255,0.6)'
        }}
      >
        ▏
      </div>
    </div>
  )
}
