import { useEffect, useRef } from 'react'
import type { Project } from '../model/timeline'
import { resolveTimeline } from '../model/timeline'
import { formatTimecode } from '../model/demo'

interface MonitorProps {
  project: Project
  frame: number
  isPlaying: boolean
  onPlay: (playing: boolean) => void
  onSeek: (frame: number) => void
}

/**
 * 中上：节目监视器 —— 预览画布 + 播放控制。
 * 用 resolveTimeline 纯函数解析当前帧 scene，并按 zIndex 渲染。
 */
export default function Monitor({ project, frame, isPlaying, onPlay, onSeek }: MonitorProps): React.JSX.Element {
  const scene = resolveTimeline(frame, project)
  const fps = project.fps
  const { width, height } = project.stage
  const stageRef = useRef<HTMLDivElement>(null)

  // 简单播放时钟：isPlaying 时每秒前进 fps 帧（占位，后续接 PlaybackEngine）
  useEffect(() => {
    if (!isPlaying) return
    const id = setInterval(() => {
      onSeek(frame + 1)
    }, 1000 / fps)
    return () => clearInterval(id)
  }, [isPlaying, frame, fps, onSeek])

  // 按 zIndex 升序排序，最后渲染的在上层
  const textLayers = scene.texts.map((t) => ({ z: t.zIndex, clip: t }))
  const mediaLayers = [
    ...scene.videos.map((v) => ({ z: v.zIndex, src: v.src, opacity: v.opacity })),
    ...scene.images.map((i) => ({ z: i.zIndex, src: i.src, opacity: i.opacity }))
  ].sort((a, b) => a.z - b.z)
  textLayers.sort((a, b) => a.z - b.z)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="tabline">
        <span className="tab active">节目: 序列 01</span>
        <span style={{ marginLeft: 'auto', color: '#888' }}>☰</span>
      </div>

      {/* 预览画布 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 20px 10px',
          background: '#202020',
          overflow: 'hidden'
        }}
      >
        <div
          ref={stageRef}
          style={{
            width: 'min(88%, 900px)',
            aspectRatio: `${width}/${height}`,
            background: '#000',
            boxShadow: '0 0 0 1px #111',
            position: 'relative',
            overflow: 'hidden'
          }}
        >
          {mediaLayers.length === 0 && textLayers.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333' }}>
              无素材
            </div>
          )}
          {textLayers.map((l) => (
            <div
              key={l.clip.id}
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 48,
                fontWeight: 700,
                opacity: l.clip.opacity,
                textShadow: '0 2px 8px rgba(0,0,0,.6)',
                pointerEvents: 'none'
              }}
            >
              {l.clip.content}
            </div>
          ))}
          {mediaLayers.map((l, i) => (
            <video
              key={i}
              src={l.src}
              autoPlay
              muted
              loop
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                opacity: l.opacity
              }}
            />
          ))}
        </div>
      </div>

      {/* 播放控制 */}
      <div
        style={{
          height: 87,
          flex: 'none',
          padding: '0 18px',
          display: 'grid',
          gridTemplateColumns: '92px 1fr 100px',
          gridTemplateRows: '28px 35px',
          alignItems: 'center'
        }}
      >
        <div style={{ color: '#19a8ff', fontWeight: 600, fontSize: 12 }}>{formatTimecode(frame, fps)}</div>
        <div style={{ justifySelf: 'center', background: '#111', border: '1px solid #444', borderRadius: 3, padding: '2px 9px', fontSize: 11, color: '#bbb' }}>
          适合 ⌄
        </div>
        <div style={{ justifySelf: 'end', color: '#bbb' }}>🔧</div>
        <div style={{ gridColumn: '1/4', display: 'flex', alignItems: 'center', gap: 15, color: '#bcbcbc' }}>
          <div style={{ height: 4, background: '#696969', flex: 1, borderRadius: 4, position: 'relative', cursor: 'pointer' }} />
          <div style={{ display: 'flex', gap: 15, alignItems: 'center', fontSize: 14 }}>
            <span style={{ cursor: 'pointer' }} onClick={() => onPlay(!isPlaying)}>
              {isPlaying ? '⏸' : '▶'}
            </span>
            <span style={{ cursor: 'pointer' }} onClick={() => onSeek(0)}>⏮</span>
            <span style={{ cursor: 'pointer' }} onClick={() => onSeek(frame + fps)}>⏭</span>
          </div>
        </div>
      </div>
    </div>
  )
}
