import { useRef, useState } from 'react'
import type { Project, Clip, Track, MediaAsset, TrackZone } from '../model/timeline'
import { formatTimecode } from '../model/demo'
import type { EffectTemplate } from '../model/demo'

interface TimelineProps {
  project: Project
  total: number
  playheadFrame: number
  isPlaying: boolean
  pxPerFrame: number
  onPlay: (playing: boolean) => void
  onSeek: (frame: number) => void
  onZoomIn: () => void
  onZoomOut: () => void
  selectedClipId: string | null
  onSelectClip: (id: string | null) => void
  onAddTemplate: (tpl: EffectTemplate, dropFrame: number, targetTrackId?: string) => void
  onAddAssetClip: (asset: MediaAsset, dropFrame: number, targetTrackId?: string) => void
  onToggleTrack: (trackId: string, prop: 'disabled' | 'muted' | 'solo' | 'locked') => void
  onMoveClip: (clipId: string, newStart: number) => void
  onResizeClip: (clipId: string, newDuration: number) => void
  onMoveClipAcrossTracks: (clipId: string, targetTrackId: string, newStart: number, targetZone: TrackZone) => void
  getAsset: (id: string) => MediaAsset | undefined
}

const TRACK_HEIGHT = 47
const TRACK_CONTROL_WIDTH = 174
const RULER_HEIGHT = 44
const ZONE_HEADER_HEIGHT = 24

/** 轨道标签配色 */
const TRACK_COLOR: Record<Track['kind'], string> = {
  video: 'var(--track-video)',
  audio: 'var(--track-audio)',
  text: 'var(--track-text)'
}

/** 读取拖拽 payload（自定义 MIME + 兜底 stash） */
function readDragPayload(e: React.DragEvent): { template?: EffectTemplate; assetId?: string } | null {
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
 * 中下：时间轴 —— Pr 式双区布局。
 * 上：视频区（V2/V1…，可折叠、独立滚动，拖到最顶自动新建视频轨）
 * 下：音频区（A1/A2…，可折叠、独立滚动）
 * 支持：跨轨拖动（水平 + 垂直）、播放头拖动、拖拽模板/素材落轨、滚轮缩放。
 */
export default function Timeline({
  project,
  total,
  playheadFrame,
  isPlaying,
  pxPerFrame,
  onPlay,
  onSeek,
  onZoomIn,
  onZoomOut,
  selectedClipId,
  onSelectClip,
  onAddTemplate,
  onAddAssetClip,
  onToggleTrack,
  onMoveClip,
  onResizeClip,
  onMoveClipAcrossTracks,
  getAsset
}: TimelineProps): React.JSX.Element {
  const fps = project.fps
  const totalPx = total * pxPerFrame
  const timeAreaRef = useRef<HTMLDivElement>(null)

  const [videoCollapsed, setVideoCollapsed] = useState(false)
  const [audioCollapsed, setAudioCollapsed] = useState(false)

  const videoTracks = project.tracks.filter((t) => t.zone === 'video')
  const audioTracks = project.tracks.filter((t) => t.zone === 'audio')

  const frameFromEvent = (clientX: number): number => {
    const el = timeAreaRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return Math.max(0, Math.round((clientX - rect.left) / pxPerFrame))
  }

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

  // 滚轮缩放时间轴（Ctrl/⌘ + 滚轮）
  const handleWheel = (e: React.WheelEvent): void => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    if (e.deltaY < 0) onZoomIn()
    else onZoomOut()
  }

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
    const targetTrackId = trackIdAtY(e.clientY)
    if (payload.template) {
      onAddTemplate(payload.template, dropFrame, targetTrackId)
    } else if (payload.assetId) {
      const asset = getAsset(payload.assetId)
      if (asset) onAddAssetClip(asset, dropFrame, targetTrackId)
    }
    ;(window as unknown as Record<string, unknown>)._avsPendingDrag = undefined
  }

  // 由全局 Y 推断落点轨道 id（跨区）
  const trackIdAtY = (clientY: number): string | undefined => {
    const el = timeAreaRef.current
    if (!el) return undefined
    const rect = el.getBoundingClientRect()
    let y = clientY - rect.top - RULER_HEIGHT
    if (y < 0) return undefined

    if (!videoCollapsed) {
      y -= ZONE_HEADER_HEIGHT
      const vIdx = Math.floor(y / TRACK_HEIGHT)
      if (vIdx >= 0 && vIdx < videoTracks.length) return videoTracks[vIdx]?.id
      y -= videoTracks.length * TRACK_HEIGHT
    } else {
      y -= ZONE_HEADER_HEIGHT
    }

    if (!audioCollapsed) {
      y -= ZONE_HEADER_HEIGHT
      const aIdx = Math.floor(y / TRACK_HEIGHT)
      if (aIdx >= 0 && aIdx < audioTracks.length) return audioTracks[aIdx]?.id
    }
    return undefined
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="tabline">
        <span className="tab active">序列 01</span>
        <span style={{ marginLeft: 'auto', color: '#888', cursor: 'pointer', fontSize: 14 }} title="时间轴设置">☰</span>
      </div>

      <div
        ref={timeAreaRef}
        onWheel={handleWheel}
        style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: `${TRACK_CONTROL_WIDTH}px 1fr`, position: 'relative' }}
      >
        {/* ===== 左侧：轨道控制 ===== */}
        <div style={{ background: 'var(--bg-track-controls)', borderRight: '1px solid var(--border-dark)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ height: RULER_HEIGHT, borderBottom: '1px solid var(--border-dark)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', gap: 8, fontSize: 12 }}>
            <span title="添加轨道" style={{ cursor: 'pointer' }}>▣</span>
            <span title="吸附" style={{ cursor: 'pointer' }}>⚓</span>
            <span title="链接" style={{ cursor: 'pointer' }}>🔗</span>
            <span title="轨道设置" style={{ cursor: 'pointer' }}>🔧</span>
          </div>

          <ZoneControls zone="video" tracks={videoTracks} collapsed={videoCollapsed} onToggleCollapse={() => setVideoCollapsed((c) => !c)} onToggleTrack={onToggleTrack} />
          <ZoneControls zone="audio" tracks={audioTracks} collapsed={audioCollapsed} onToggleCollapse={() => setAudioCollapsed((c) => !c)} onToggleTrack={onToggleTrack} />
        </div>

        {/* ===== 右侧：时间区 ===== */}
        <div
          style={{ overflow: 'hidden', position: 'relative', background: 'var(--bg-timeline)', cursor: 'crosshair' }}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <Ruler total={total} fps={fps} pxPerFrame={pxPerFrame} onSeek={onSeek} frameFromEvent={frameFromEvent} />

          {/* 视频区轨道行（折叠时仍保留头部占位，与左控制列对齐） */}
          <ZoneRows
            zone="video"
            tracks={videoTracks}
            clips={project.clips}
            pxPerFrame={pxPerFrame}
            selectedClipId={selectedClipId}
            onSelectClip={onSelectClip}
            onMoveClip={onMoveClip}
            onResizeClip={onResizeClip}
            onMoveClipAcrossTracks={onMoveClipAcrossTracks}
            getAsset={getAsset}
            onSeek={onSeek}
            frameFromEvent={frameFromEvent}
            topOffset={RULER_HEIGHT}
            collapsed={videoCollapsed}
          />
          <ZoneRows
            zone="audio"
            tracks={audioTracks}
            clips={project.clips}
            pxPerFrame={pxPerFrame}
            selectedClipId={selectedClipId}
            onSelectClip={onSelectClip}
            onMoveClip={onMoveClip}
            onResizeClip={onResizeClip}
            onMoveClipAcrossTracks={onMoveClipAcrossTracks}
            getAsset={getAsset}
            onSeek={onSeek}
            frameFromEvent={frameFromEvent}
            topOffset={RULER_HEIGHT + ZONE_HEADER_HEIGHT + (videoCollapsed ? 0 : videoTracks.length * TRACK_HEIGHT)}
            collapsed={audioCollapsed}
          />

          <div
            onMouseDown={handlePlayheadDrag}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              width: 1,
              background: 'var(--accent-playhead)',
              left: playheadFrame * pxPerFrame,
              zIndex: 4,
              cursor: 'ew-resize'
            }}
          >
            <div style={{ position: 'absolute', top: 0, left: -4, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '9px solid #18a8ff', cursor: 'ew-resize' }} />
          </div>

          <div style={{ position: 'absolute', left: 0, top: RULER_HEIGHT, width: Math.max(totalPx, 1), height: 1 }} />
        </div>
      </div>

      {/* 底部工具栏 */}
      <div style={{ height: 30, flex: 'none', background: 'var(--bg-tabline)', borderTop: '1px solid var(--border-dark)', display: 'flex', alignItems: 'center', gap: 14, padding: '0 12px', color: 'var(--text-muted)' }}>
        <span style={{ color: 'var(--accent-playhead)', fontWeight: 600 }}>{formatTimecode(playheadFrame, fps)}</span>
        <span style={{ cursor: 'pointer', fontSize: 14 }} onClick={() => onPlay(!isPlaying)} title="播放/暂停">{isPlaying ? '⏸' : '▶'}</span>
        <span style={{ cursor: 'pointer', fontSize: 14 }} onClick={() => onSeek(0)} title="回到起点">⏮</span>
        <span style={{ cursor: 'pointer', fontSize: 14 }} onClick={() => onSeek(playheadFrame + fps)} title="下一帧片段">⏭</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
          <span style={{ cursor: 'pointer' }} onClick={onZoomOut} title="缩小时间轴">−</span>
          <span style={{ cursor: 'pointer' }} onClick={onZoomIn} title="放大时间轴">+</span>
          <span style={{ opacity: 0.7, fontSize: 12 }}>Ctrl+滚轮 / − + 缩放 · ←→ 步进</span>
        </span>
      </div>
    </div>
  )
}

/** 标尺 */
function Ruler({ total, fps, pxPerFrame, onSeek, frameFromEvent }: {
  total: number
  fps: number
  pxPerFrame: number
  onSeek: (f: number) => void
  frameFromEvent: (clientX: number) => number
}): React.JSX.Element {
  return (
    <div
      style={{
        height: RULER_HEIGHT,
        borderBottom: '1px solid var(--border-dark)',
        background: 'repeating-linear-gradient(90deg, transparent 0, transparent 8px, #555 9px, #555 10px)',
        position: 'relative',
        overflow: 'hidden'
      }}
      onMouseDown={(e) => onSeek(frameFromEvent(e.clientX))}
    >
      {Array.from({ length: Math.floor(total / fps) + 1 }).map((_, i) => {
        const left = i * fps * pxPerFrame
        return (
          <span key={i} style={{ position: 'absolute', top: 4, left, color: '#aaa', fontSize: 11, whiteSpace: 'nowrap', cursor: 'crosshair' }}>
            {formatTimecode(i * fps, fps)}
          </span>
        )
      })}
    </div>
  )
}

/** 左侧某分区控制块：可折叠 + 独立滚动 */
function ZoneControls({ zone, tracks, collapsed, onToggleCollapse, onToggleTrack }: {
  zone: TrackZone
  tracks: Track[]
  collapsed: boolean
  onToggleCollapse: () => void
  onToggleTrack: (trackId: string, prop: 'disabled' | 'muted' | 'solo' | 'locked') => void
}): React.JSX.Element {
  const label = zone === 'video' ? '视频轨道' : '音频轨道'
  const accent = zone === 'video' ? 'var(--track-video)' : 'var(--track-audio)'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: collapsed ? '0 0 auto' : 1, minHeight: 0 }}>
      <div
        onClick={onToggleCollapse}
        style={{
          height: ZONE_HEADER_HEIGHT,
          background: 'var(--bg-zone-header)',
          borderBottom: '1px solid var(--border-row)',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '0 8px',
          cursor: 'pointer',
          color: '#ccc',
          fontSize: 12,
          fontWeight: 600,
          userSelect: 'none',
          flex: 'none'
        }}
      >
        <span style={{ transition: 'transform .15s', transform: collapsed ? 'rotate(-90deg)' : 'none', fontSize: 10 }}>▼</span>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: accent }} />
        {label}
        <span style={{ marginLeft: 'auto', opacity: 0.6 }}>{tracks.length}</span>
      </div>
      {!collapsed && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {tracks.map((track) => (
            <TrackControlRow key={track.id} track={track} onToggleTrack={onToggleTrack} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 单条轨道控制行 */
function TrackControlRow({ track, onToggleTrack }: {
  track: Track
  onToggleTrack: (trackId: string, prop: 'disabled' | 'muted' | 'solo' | 'locked') => void
}): React.JSX.Element {
  return (
    <div style={{ height: TRACK_HEIGHT, borderBottom: '1px solid var(--border-row)', display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px' }}>
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
        <span title={track.disabled ? '启用轨道' : '禁用轨道'} onClick={() => onToggleTrack(track.id, 'disabled')} style={{ cursor: 'pointer', color: track.disabled ? '#5a5a5a' : '#9e9e9e', opacity: track.disabled ? 0.45 : 1 }}>▱</span>
        {track.kind === 'audio' ? (
          <>
            <span title="静音" onClick={() => onToggleTrack(track.id, 'muted')} style={{ cursor: 'pointer', fontWeight: 700, color: track.muted ? '#e05c5c' : '#8e8e8e' }}>M</span>
            <span title="独奏" onClick={() => onToggleTrack(track.id, 'solo')} style={{ cursor: 'pointer', fontWeight: 700, color: track.solo ? '#e0b34c' : '#8e8e8e' }}>S</span>
          </>
        ) : (
          <>
            <span title="独奏" onClick={() => onToggleTrack(track.id, 'solo')} style={{ cursor: 'pointer', fontWeight: 700, color: track.solo ? '#e0b34c' : '#8e8e8e' }}>◉</span>
            <span title="锁定" onClick={() => onToggleTrack(track.id, 'locked')} style={{ cursor: 'pointer', color: track.locked ? '#e0b34c' : '#8e8e8e' }}>◌</span>
          </>
        )}
      </div>
    </div>
  )
}

/** 右侧某分区轨道行。topOffset = 该区在时间区内的 Y 起点（含标尺）。collapsed 时只显示折叠头。 */
function ZoneRows({ zone, tracks, clips, pxPerFrame, selectedClipId, onSelectClip, onMoveClip, onResizeClip, onMoveClipAcrossTracks, getAsset, onSeek, frameFromEvent, topOffset, collapsed }: {
  zone: TrackZone
  tracks: Track[]
  clips: Record<string, Clip[]>
  pxPerFrame: number
  selectedClipId: string | null
  onSelectClip: (id: string | null) => void
  onMoveClip: (clipId: string, newStart: number) => void
  onResizeClip: (clipId: string, newDuration: number) => void
  onMoveClipAcrossTracks: (clipId: string, targetTrackId: string, newStart: number, targetZone: TrackZone) => void
  getAsset: (id: string) => MediaAsset | undefined
  onSeek: (f: number) => void
  frameFromEvent: (clientX: number) => number
  topOffset: number
  collapsed?: boolean
}): React.JSX.Element {
  const zoneHeight = collapsed ? ZONE_HEADER_HEIGHT : ZONE_HEADER_HEIGHT + tracks.length * TRACK_HEIGHT

  // 跨轨拖动的目标解析：由 Y 坐标找所在轨道行（同区）。
  // 视频区拖到最顶（第一轨上方）→ 返回 '__new__'，由 App 自动新建视频轨。
  const resolveTargetByY = (clientY: number): { trackId: string | null; isNewTop: boolean } => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-zone="${zone}"][data-trackid]`)
    )
    for (const row of rows) {
      const r = row.getBoundingClientRect()
      if (clientY >= r.top && clientY < r.bottom) {
        return { trackId: row.dataset.trackid ?? null, isNewTop: false }
      }
    }
    // 落到视频区第一轨上方 → 新建视频轨
    if (zone === 'video' && rows.length > 0) {
      const first = rows[0].getBoundingClientRect()
      if (clientY < first.top) return { trackId: null, isNewTop: true }
    }
    return { trackId: null, isNewTop: false }
  }

  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: topOffset, height: zoneHeight, overflowY: 'auto' }}>
      <div style={{ height: ZONE_HEADER_HEIGHT, borderBottom: '1px solid var(--border-row)', background: 'var(--bg-zone-header)', display: 'flex', alignItems: 'center', gap: 7, padding: '0 8px', color: '#888', fontSize: 11 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: zone === 'video' ? 'var(--track-video)' : 'var(--track-audio)' }} />
        {zone === 'video' ? '视频轨道区（拖到上方可自动新建视频轨）' : '音频轨道区'}
      </div>
      {!collapsed && tracks.map((track) => (
        <div
          key={track.id}
          data-zone={zone}
          data-trackid={track.id}
          style={{ height: TRACK_HEIGHT, borderBottom: '1px solid var(--border-row)', position: 'relative' }}
          onClick={(e) => { e.stopPropagation(); onSeek(frameFromEvent(e.clientX)) }}
        >
          {(clips[track.id] ?? []).map((clip) => (
            <ClipBlock
              key={clip.id}
              clip={clip}
              track={track}
              pxPerFrame={pxPerFrame}
              selected={clip.id === selectedClipId}
              onSelect={() => onSelectClip(clip.id === selectedClipId ? null : clip.id)}
              onMove={(newStart) => onMoveClip(clip.id, newStart)}
              onResize={(newDuration) => onResizeClip(clip.id, newDuration)}
              resolveTargetByY={resolveTargetByY}
              onCrossMove={(targetTrackId, newStart, isNewTop) => {
                if (isNewTop) {
                  // 新建视频轨：传给 App 一个占位 id，App 自动建轨
                  onMoveClipAcrossTracks(clip.id, '__new-video-track__', newStart, zone)
                } else if (targetTrackId && targetTrackId !== track.id) {
                  onMoveClipAcrossTracks(clip.id, targetTrackId, newStart, zone)
                } else {
                  onMove(newStart)
                }
              }}
              getAsset={getAsset}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** 单个 clip 块 —— 支持水平/跨轨拖动 + 右缘调整时长 */
function ClipBlock({ clip, track, pxPerFrame, selected, onSelect, onMove, onResize, resolveTargetByY, onCrossMove, getAsset }: {
  clip: Clip
  track: Track
  pxPerFrame: number
  selected: boolean
  onSelect: () => void
  onMove: (newStart: number) => void
  onResize: (newDuration: number) => void
  resolveTargetByY: (clientY: number) => { trackId: string | null; isNewTop: boolean }
  onCrossMove: (targetTrackId: string | null, newStart: number, isNewTop: boolean) => void
  getAsset: (id: string) => MediaAsset | undefined
}): React.JSX.Element {
  const left = clip.startFrame * pxPerFrame
  const width = clip.durationFrames * pxPerFrame

  const startMove = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (track.locked) return
    const startClientX = e.clientX
    const startFrame = clip.startFrame
    let lastTarget = track.id

    const move = (ev: MouseEvent): void => {
      const deltaFrame = Math.round((ev.clientX - startClientX) / pxPerFrame)
      const newStart = Math.max(0, startFrame + deltaFrame)
      const { trackId, isNewTop } = resolveTargetByY(ev.clientY)

      if (isNewTop && lastTarget !== '__new__') {
        lastTarget = '__new__'
        onCrossMove(null, newStart, true)
        return
      }
      if (trackId && trackId !== lastTarget) {
        lastTarget = trackId
        onCrossMove(trackId, newStart, false)
        return
      }
      if (trackId === lastTarget && !isNewTop) {
        onMove(newStart)
        return
      }
      if (!trackId && !isNewTop) {
        onMove(newStart)
        return
      }
      // 已在新轨目标上，仅水平推进
      onCrossMove(lastTarget === '__new__' ? null : lastTarget, newStart, lastTarget === '__new__')
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

  const startResize = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (track.locked) return
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

  const boundName = clip.assetId ? (getAsset(clip.assetId)?.name ?? clip.name) : clip.name

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
        opacity: track.disabled ? 0.4 : 0.85,
        borderRadius: 3,
        border: selected ? '1px solid var(--accent)' : '1px solid rgba(255,255,255,0.15)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 6px',
        color: '#fff',
        fontSize: 10,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        cursor: track.locked ? 'default' : 'grab',
        userSelect: 'none',
        touchAction: 'none'
      }}
      title={`${boundName}（拖动移动/跨轨，拖右缘调整时长）`}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{boundName}</span>
      <div
        onMouseDown={startResize}
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: 10,
          cursor: track.locked ? 'default' : 'ew-resize',
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
