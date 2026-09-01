import { useEffect, useRef, useState } from 'react'
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

const FIT_OPTIONS = ['适合', '100%', '50%', '25%', '放大']

/**
 * 中上：节目监视器 —— 预览画布 + 播放控制。
 * 用 resolveTimeline 纯函数解析当前帧 scene，并按 zIndex 渲染。
 */
export default function Monitor({ project, frame, isPlaying, onPlay, onSeek }: MonitorProps): React.JSX.Element {
  const scene = resolveTimeline(frame, project)
  const fps = project.fps
  const { width, height } = project.stage
  const stageRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState('适合')
  const [fitOpen, setFitOpen] = useState(false)
  const [totalFrames, setTotalFrames] = useState(30 * 12)

  // 收集预览视频元素，随播放状态播放/暂停
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([])
  // 收集音频 clip 的 <audio> 元素（「单次播放」等音频轨发声用）
  const audioRefs = useRef<(HTMLAudioElement | null)[]>([])

  // 估算工程总帧（预览进度条用）
  useEffect(() => {
    let max = 0
    for (const clips of Object.values(project.clips)) {
      for (const c of clips) max = Math.max(max, c.startFrame + c.durationFrames)
    }
    setTotalFrames(max || 30 * 12)
  }, [project])

  // 简单播放时钟：isPlaying 时每秒前进 fps 帧（占位，后续接 PlaybackEngine）
  useEffect(() => {
    if (!isPlaying) return
    const id = setInterval(() => {
      onSeek(frame + 1)
    }, 1000 / fps)
    return () => clearInterval(id)
  }, [isPlaying, frame, fps, onSeek])

  // 按 zIndex 升序排序，最后渲染的在上层。收集 transform 以应用缩放/位置。
  const textLayers = scene.texts.map((t) => ({ z: t.zIndex, clip: t }))
  const mediaLayers = [
    ...scene.videos.map((v) => ({ z: v.zIndex, src: v.src, opacity: v.opacity, transform: v.transform })),
    ...scene.images.map((i) => ({ z: i.zIndex, src: i.src, opacity: i.opacity, transform: i.transform }))
  ].sort((a, b) => a.z - b.z)
  textLayers.sort((a, b) => a.z - b.z)
  // 音频 clip（不可见，仅用于发声）
  const audioLayers = scene.audios.map((a) => ({ src: a.src, volume: a.volume, sourceFrame: a.sourceFrame }))

  // 播放状态 → 控制预览视频播放/暂停（未点播放时不自动播放）
  useEffect(() => {
    const vids = videoRefs.current.filter((v): v is HTMLVideoElement => !!v)
    for (const v of vids) {
      if (isPlaying) v.play().catch(() => {})
      else v.pause()
    }
  }, [isPlaying, mediaLayers.length])

  // 播放状态 → 控制音频 clip 播放/暂停（「单次播放」等音频轨发声）
  useEffect(() => {
    const audios = audioRefs.current.filter((a): a is HTMLAudioElement => !!a)
    for (const a of audios) {
      if (isPlaying) a.play().catch(() => {})
      else a.pause()
    }
  }, [isPlaying, audioLayers.length])

  // 非播放时，把每个音频元素定位到当前帧对应的源位置（seek 用）
  useEffect(() => {
    if (isPlaying) return
    const audios = audioRefs.current.filter((a): a is HTMLAudioElement => !!a)
    for (const a of audios) {
      const f = Number(a.dataset.sourceFrame || '0')
      a.currentTime = f / fps
    }
  }, [frame, isPlaying, audioLayers.length, fps])

  // 进度条拖动 seek
  const progressRef = useRef<HTMLDivElement>(null)
  const handleProgressDrag = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const seekFromEvent = (clientX: number): void => {
      const el = progressRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      onSeek(Math.round(ratio * totalFrames))
    }
    seekFromEvent(e.clientX)
    const move = (ev: MouseEvent): void => seekFromEvent(ev.clientX)
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const progress = totalFrames > 0 ? Math.min(1, frame / totalFrames) : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="tabline">
        <span className="tab active">节目: 序列 01</span>
        <span style={{ marginLeft: 'auto', color: '#888', cursor: 'pointer' }}>☰</span>
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
          // 画幅外深色底纹，衬托中间遮罩(Mask)亮边框
          background: 'radial-gradient(circle at 50% 45%, #262626 0%, #161616 70%)',
          overflow: 'hidden'
        }}
      >
        <div
          ref={stageRef}
          style={{
            width: 'min(88%, 900px)',
            aspectRatio: `${width}/${height}`,
            background: '#000',
            // 遮罩(Mask)边界指示：亮边框 + 外侧一圈暗角，让用户看清"渲染会取哪部分"
            boxShadow: '0 0 0 1px rgba(255,255,255,.28), 0 0 24px rgba(0,0,0,.9)',
            outline: '1px solid rgba(255,255,255,.08)',
            position: 'relative',
            overflow: 'hidden',
            borderRadius: 2
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
          {mediaLayers.map((l, i) => {
            const tr = l.transform
            const scaleX = tr?.scaleX ?? 1
            const scaleY = tr?.scaleY ?? 1
            // 位置：相对画幅(遮罩)的比例，范围 -0.5..0.5（内容中心可在画幅内移动，画幅本身不动）
            const tx = tr?.x ?? 0
            const ty = tr?.y ?? 0
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  inset: 0,
                  transform: `translate(${tx * 100}%, ${ty * 100}%) scale(${scaleX}, ${scaleY})`,
                  transformOrigin: 'center',
                  opacity: l.opacity,
                  pointerEvents: 'none'
                }}
              >
                <video
                  ref={(el) => { videoRefs.current[i] = el }}
                  src={l.src}
                  muted
                  loop
                  playsInline
                  preload="metadata"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              </div>
            )
          })}
          {/* 音频 clip（不可见，仅发声） */}
          {audioLayers.map((l, i) => (
            <audio
              key={i}
              ref={(el) => { audioRefs.current[i] = el }}
              src={l.src}
              preload="metadata"
              data-source-frame={l.sourceFrame}
              style={{ display: 'none' }}
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

        {/* 适合 下拉 */}
        <div style={{ justifySelf: 'center', position: 'relative' }}>
          <div
            style={{ background: '#111', border: '1px solid #444', borderRadius: 3, padding: '2px 9px', fontSize: 11, color: '#bbb', cursor: 'pointer', userSelect: 'none' }}
            onClick={() => setFitOpen((o) => !o)}
          >
            {fit} ⌄
          </div>
          {fitOpen && (
            <div
              style={{ position: 'absolute', top: '100%', left: 0, background: '#222', border: '1px solid #444', borderRadius: 3, zIndex: 20, minWidth: 90 }}
            >
              {FIT_OPTIONS.map((o) => (
                <div
                  key={o}
                  style={{ padding: '5px 10px', fontSize: 11, color: o === fit ? '#19a8ff' : '#ddd', cursor: 'pointer', whiteSpace: 'nowrap' }}
                  onClick={() => { setFit(o); setFitOpen(false) }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#333' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
                >
                  {o}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ justifySelf: 'end', color: '#bbb', cursor: 'pointer' }} title="画面设置">🔧</div>

        {/* 进度条 + 播放按钮 */}
        <div style={{ gridColumn: '1/4', display: 'flex', alignItems: 'center', gap: 15, color: '#bcbcbc' }}>
          <div
            ref={progressRef}
            onMouseDown={handleProgressDrag}
            style={{ height: 4, background: '#696969', flex: 1, borderRadius: 4, position: 'relative', cursor: 'pointer' }}
          >
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${progress * 100}%`,
                background: '#19a8ff',
                borderRadius: 4
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: `calc(${progress * 100}% - 4px)`,
                top: -3,
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: '#fff',
                boxShadow: '0 0 0 1px rgba(0,0,0,.4)'
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: 15, alignItems: 'center', fontSize: 14 }}>
            <span style={{ cursor: 'pointer' }} onClick={() => onPlay(!isPlaying)} title="播放/暂停">
              {isPlaying ? '⏸' : '▶'}
            </span>
            <span style={{ cursor: 'pointer' }} onClick={() => onSeek(0)} title="回到起点">⏮</span>
            <span style={{ cursor: 'pointer' }} onClick={() => onSeek(frame + fps)} title="下一帧片段">⏭</span>
          </div>
        </div>
      </div>
    </div>
  )
}
