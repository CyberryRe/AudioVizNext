import { useEffect, useRef, useState } from 'react'
import type { Project, Clip } from '../model/timeline'
import { resolveTimeline, parseLrc, lrcLineAt } from '../model/timeline'
import { formatTimecode } from '../model/demo'
import { PixiRenderer } from '../pixi/PixiRenderer'
import { effectiveMediaSrc, initMediaProxy } from '../pixi/mediaProxy'

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
  const previewRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState('适合')
  const [fitOpen, setFitOpen] = useState(false)
  const [totalFrames, setTotalFrames] = useState(30 * 12)

  // 预览区可用尺寸（自适应缩放用）
  const [area, setArea] = useState({ w: 800, h: 450 })

  // 媒体代理就绪计数：源转码完成后 bump，触发重渲染，令 DOM 视频/音频元素换用代理源发声。
  // （Pixi 模式下视频代理由 PixiRenderer 自管；这里主要负责 `<audio>`/DOM `<video>` 的换源。）
  const [proxyTick, setProxyTick] = useState(0)
  useEffect(() => initMediaProxy(() => setProxyTick((t) => t + 1)), [])

  // 收集预览视频元素，随播放状态播放/暂停
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([])
  // 收集音频 clip 的 <audio> 元素（「单次播放」等音频轨发声用）
  const audioRefs = useRef<(HTMLAudioElement | null)[]>([])

  // ===== PixiJS 渲染管线（可选开启；开启后用 Pixi canvas 渲染视觉层，DOM 层兜底） =====
  const [pixiOn, setPixiOn] = useState(false)
  const [pixiErr, setPixiErr] = useState<string | null>(null)
  const pixiRef = useRef<PixiRenderer | null>(null)
  const pixiHostRef = useRef<HTMLDivElement>(null)
  // 初始化 PixiRenderer（懒加载，切到开启时初始化一次），初始化完成后启动内部连续渲染循环
  useEffect(() => {
    if (!pixiOn) return
    let cancelled = false
    const host = pixiHostRef.current
    if (!host) return
    const pr = new PixiRenderer(host)
    pixiRef.current = pr
    pr.init()
      .then(() => {
        if (cancelled) { pr.destroy(); return }
        pr.start(frame, project, fps, isPlaying)
      })
      .catch((e) => { if (!cancelled) setPixiErr(String(e?.message ?? e)) })
    return () => {
      cancelled = true
      // 关闭 Pixi 时彻底销毁（含 canvas 卸载），避免残留层
      pr.destroy()
      if (pixiRef.current === pr) pixiRef.current = null
    }
  }, [pixiOn])
  // 每次帧/工程/播放状态变化时更新 Pixi 渲染输入；播放态翻转用 setPlaying 强制立即同步视频(暂停即停帧)
  useEffect(() => {
    if (!pixiOn) return
    pixiRef.current?.updateInput(frame, project, fps)
    pixiRef.current?.setPlaying(isPlaying)
  }, [pixiOn, frame, project, fps, isPlaying])

  // 监听预览区尺寸，自适应缩放画幅(Mask)，改比例/窗口大小都会跟随
  useEffect(() => {
    const el = previewRef.current
    if (!el) return
    const update = (): void => {
      const r = el.getBoundingClientRect()
      setArea({ w: r.width, h: r.height })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 计算画幅(Mask)在预览区内自适应 fit 后的像素尺寸（保持序列比例）
  const aspect = width / height
  // 「适合」= 缩放铺进预览区；否则按真实分辨率比例缩放（100%/50%/25%/放大）
  let maskW = width
  let maskH = height
  if (fit === '适合') {
    maskW = area.w * 0.92
    maskH = maskW / aspect
    if (maskH > area.h * 0.86) {
      maskH = area.h * 0.86
      maskW = maskH * aspect
    }
  } else if (fit === '100%') {
    // 1:1 真实像素
    maskW = width
    maskH = height
  } else if (fit === '50%') {
    maskW = width / 2
    maskH = height / 2
  } else if (fit === '25%') {
    maskW = width / 4
    maskH = height / 4
  } else {
    // 放大：1.5×
    maskW = width * 1.5
    maskH = height * 1.5
  }

  // 估算工程总帧（预览进度条用）
  useEffect(() => {
    let max = 0
    for (const clips of Object.values(project.clips)) {
      for (const c of clips) max = Math.max(max, c.startFrame + c.durationFrames)
    }
    setTotalFrames(max || 30 * 12)
  }, [project])

  // 简单播放时钟：wall-clock 绝对时间驱动（rAF + performance.now 基准现算），
  // 绝不用 setInterval 累计帧数——定时器延迟会累积漂移，时间越久歌词/视频切句越滞后。
  // 播放开始记录 {wall, frame} 基准；每 rAF 现算 f = base.frame + (now-base.wall)/1000*fps。
  // 外部 seek（进度条拖动/⏮/⏭）会令 frame 突变，检测到与预测偏差过大时重置基准续播。
  const frameRef = useRef(frame)
  frameRef.current = frame
  const clockBaseRef = useRef<{ wall: number; frame: number } | null>(null)
  useEffect(() => {
    if (!isPlaying) {
      clockBaseRef.current = null
      return
    }
    const now = performance.now()
    // 预测当前帧：若与真实 frame 偏差过大（外部 seek 或拖动），重置基准到最新播放头
    const predicted = clockBaseRef.current
      ? clockBaseRef.current.frame + ((now - clockBaseRef.current.wall) / 1000) * fps
      : -1
    if (Math.abs(predicted - frameRef.current) > fps * 0.5) {
      clockBaseRef.current = { wall: now, frame: frameRef.current }
    } else if (!clockBaseRef.current) {
      clockBaseRef.current = { wall: now, frame: frameRef.current }
    }
    let raf = 0
    const tick = (): void => {
      const base = clockBaseRef.current
      if (!base) return
      const f = Math.floor(base.frame + ((performance.now() - base.wall) / 1000) * fps)
      onSeek(f)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, fps, onSeek])

  // 按 zIndex 升序排序，最后渲染的在上层。收集 transform 以应用缩放/位置。
  const textLayers = scene.texts.map((t) => ({ z: t.zIndex, clip: t }))
  const mediaLayers = [
    ...scene.videos.map((v) => ({ z: v.zIndex, src: v.src, opacity: v.opacity, transform: v.transform })),
    ...scene.images.map((i) => ({ z: i.zIndex, src: i.src, opacity: i.opacity, transform: i.transform }))
  ].sort((a, b) => a.z - b.z)
  textLayers.sort((a, b) => a.z - b.z)
  // 音频 clip（不可见，仅用于发声）
  const audioLayers = scene.audios.map((a) => ({ src: a.src, volume: a.volume, sourceFrame: a.sourceFrame }))

  // clip 查找表（按 id），用于拿歌词样式等原始 clip 属性
  const clipLookup = useRef<Map<string, Clip>>(new Map())
  clipLookup.current.clear()
  for (const clips of Object.values(project.clips)) {
    for (const c of clips) clipLookup.current.set(c.id, c)
  }

  // 渲染歌词行：若是歌词 clip，则按当前帧源秒数解析出当前句
  const lyricTextFor = (id: string, sourceFrame: number): { text: string; isLyrics: boolean } => {
    const clip = clipLookup.current.get(id)
    if (clip?.isLyrics) {
      const sec = sourceFrame / fps
      const lines = parseLrc(clip.content)
      return { text: lrcLineAt(lines, sec), isLyrics: true }
    }
    return { text: clip?.content ?? '', isLyrics: false }
  }

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
      if (isPlaying) {
        // 播放时先归位到该 clip 应发声的源位置（源秒），再 play——保证无论之前暂停拖动到哪，
        // 播放都从"这条 clip 在时间轴上该出现的声音"开始（而非从元素残留的 currentTime 起）。
        const f = Number(a.dataset.sourceFrame || '0')
        const target = f / fps
        if (Number.isFinite(a.duration) && a.duration > 0 && target > 0 && Math.abs(a.currentTime - target) > 0.05) {
          a.currentTime = target
        }
        a.play().catch(() => {
          // 自动播放被拦/解码未就绪时静默，但打印一条便于定位"无声"
          if (a.readyState < 3) console.warn('[Monitor] audio play blocked/not-ready:', a.src?.slice(0, 60), 'readyState', a.readyState)
        })
      } else {
        a.pause()
      }
    }
  }, [isPlaying, audioLayers.length, fps])

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
        <span
          onClick={() => { setPixiOn((v) => !v); setPixiErr(null) }}
          title="切换渲染后端：DOM(CSS) / PixiJS(WebGL)"
          style={{ marginLeft: 14, cursor: 'pointer', fontSize: 11, padding: '3px 10px', borderRadius: 3, background: pixiOn ? '#2a7de1' : '#1d1d1d', border: '1px solid ' + (pixiOn ? '#5aa7ff' : '#555'), color: pixiOn ? '#fff' : '#e0e0e0', fontWeight: 600, userSelect: 'none' }}
        >
          {pixiOn ? '渲染: Pixi' : '渲染: DOM'}
        </span>
        <span style={{ marginLeft: 'auto', color: '#888', cursor: 'pointer' }}>☰</span>
      </div>

      {/* 预览画布：视频内容完整显示，画幅(Mask)作为叠在上层的输出窗口 */}
      <div
        ref={previewRef}
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          // 画幅外深色底纹，衬托中间遮罩
          background: 'radial-gradient(circle at 50% 45%, #262626 0%, #141414 70%)',
          overflow: 'hidden'
        }}
      >
        {/* 画幅(Mask)窗口：边框 + 外部压暗，标明"最终渲染取哪一部分"。始终渲染（Pixi/DOM 模式都在） */}
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: maskW,
            height: maskH,
            // 外部压暗（9999px 大阴影铺满视口外侧），内部即输出区域
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
            border: '1px solid rgba(255,255,255,0.55)',
            borderRadius: 1,
            overflow: 'hidden',
            background: 'rgba(0,0,0,0.02)',
            pointerEvents: 'none'
          }}
        >
          {/* Pixi 渲染后端宿主：铺满遮罩(Mask)窗口内部，1920×1080 舞台按比例映射到遮罩矩形。
              放在遮罩内部（而非外层整块预览区）才能让 Pixi 输出与遮罩/画幅严格对齐，
              否则会铺满整个预览区、明显大于遮罩且对不齐。 */}
          <div ref={pixiHostRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
          {!pixiOn && (<>
          {/* 媒体内容层：完整显示原素材（objectFit:contain，绝不按遮罩比例裁剪），中心对齐画幅；可被变换移动 */}
          {mediaLayers.map((l, i) => {
            const tr = l.transform
            const scaleX = tr?.scaleX ?? 1
            const scaleY = tr?.scaleY ?? 1
            // 位置：相对画幅(遮罩)的比例 -0.5..0.5，换算为像素偏移
            const tx = tr?.x ?? 0
            const ty = tr?.y ?? 0
            const dx = tx * maskW
            const dy = ty * maskH
            // 媒体框至少铺满遮罩与预览区，保证能露出遮罩外的素材（不裁剪）
            const mediaBoxW = Math.max(maskW, area.w)
            const mediaBoxH = Math.max(maskH, area.h)
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  width: mediaBoxW,
                  height: mediaBoxH,
                  transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(${scaleX}, ${scaleY})`,
                  transformOrigin: 'center',
                  opacity: l.opacity,
                  pointerEvents: 'none'
                }}
              >
                {l.src && (
                  <video
                    ref={(el) => { videoRefs.current[i] = el }}
                    src={effectiveMediaSrc(l.src)}
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#000' }}
                  />
                )}
              </div>
            )
          })}

          {/* 文字层：属于输出内容，绘制在画幅内（歌词 clip 按样式+当前句渲染） */}
          {textLayers.length > 0 && textLayers.map((l) => {
            const clip = clipLookup.current.get(l.clip.id)
            const ly = lyricTextFor(l.clip.id, l.clip.sourceFrame)
            const s = clip?.lyrics
            const isLyric = clip?.isLyrics
            // 歌词字号随预览缩放联动：真实字号按「画幅宽度比例」缩放（48px 在 1920 画幅上 = 预览里 48*(maskW/1920)），
            // 否则预览缩小后歌词仍按绝对 px 显示，看起来不随预览缩放。非歌词文本 clip 用固定字号。
            const previewScale = maskW / width
            const lyricBase = (s?.fontSize ?? 48) * (s?.scale ?? 1)
            const fontSize = isLyric ? lyricBase * previewScale : (s?.fontSize ?? 48)
            const align = s?.align ?? 'center'
            const color = s?.color ?? '#ffffff'
            const glowOn = s?.glowEnabled ?? true
            const glowColor = s?.glowColor ?? '#00e5ff'
            // 位置：画幅内偏移（同 transform 语义），中心 0,0；预览态按 maskW/H 换算
            const lx = (s?.x ?? 0) * maskW
            const lyy = (s?.y ?? 0) * maskH
            // 3D 旋转（CSS 3D transform）：perspective 提供纵深视差
            const rx = s?.rotateX ?? 0
            const ry = s?.rotateY ?? 0
            const rz = s?.rotateZ ?? 0
            const has3D = rx !== 0 || ry !== 0 || rz !== 0
            // 外框负责透视 + 纵深；内层负责平移（3D 生效时平移放外框 transform，避免与 rotate 冲突）
            const outerTransform = has3D
              ? `perspective(900px) translate(calc(-50% + ${lx}px), calc(-50% + ${lyy}px))`
              : `translate(calc(-50% + ${lx}px), calc(-50% + ${lyy}px))`
            const innerTransform = has3D
              ? `rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg)`
              : undefined
            return (
              <div
                key={l.clip.id}
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  width: '100%',
                  transform: outerTransform,
                  transformStyle: has3D ? 'preserve-3d' : undefined,
                  // 旋转应用在歌词文本容器上
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center',
                    padding: '0 40px',
                    color,
                    fontFamily: s?.fontFamily ?? 'sans-serif',
                    fontSize,
                    fontWeight: 700,
                    lineHeight: 1.4,
                    textAlign: align,
                    opacity: l.clip.opacity,
                    whiteSpace: 'pre-wrap',
                    pointerEvents: 'none',
                    transform: innerTransform,
                    transformStyle: has3D ? 'preserve-3d' : undefined,
                    textShadow: glowOn
                      ? `0 0 ${Math.max(6, fontSize * 0.15)}px ${glowColor}, 0 0 ${Math.max(18, fontSize * 0.4)}px ${glowColor}`
                      : '0 2px 8px rgba(0,0,0,.6)'
                  }}
                >
                  {isLyric ? (ly.text || ' ') : (l.clip.content ?? '')}
                </div>
              </div>
            )
          })}
          {mediaLayers.length === 0 && textLayers.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444', fontSize: 13 }}>
              无素材 · 黑色窗口即输出画幅(Mask)
            </div>
          )}
          </>)}
        </div>

        {/* Pixi 初始化失败提示（两种渲染模式下都叠在预览区上方） */}
        {pixiErr && (
          <div style={{ position: 'absolute', top: 8, left: 8, color: '#ff8080', fontSize: 11, background: 'rgba(0,0,0,.7)', padding: '4px 8px', borderRadius: 3, zIndex: 20 }}>
            Pixi 初始化失败（已回退 DOM 渲染）：{pixiErr}
          </div>
        )}

        {/* 音频 clip（不可见，仅发声）：源走 mediaProxy——若该文件已被转码出含音轨的代理(如背景视频同源)，
            则 `<audio>` 播放 Chromium 原生能解的代理(AAC)，绕开 FFmpegDemuxer 对异型编码原文件的解码失败。
            proxyTick 触发的重渲染会把 src 从原素材换到代理。 */}
        {audioLayers.map((l, i) => (
          <audio
            key={i}
            ref={(el) => { audioRefs.current[i] = el }}
            src={effectiveMediaSrc(l.src)}
            preload="metadata"
            // avn-file:// 是自定义协议；纯 <audio> 播放(不涉及 WebGL 取帧)本无需 CORS。
            // 若某源已转码出含音轨代理，src 已是 Chromium 原生可解的 AAC，发声正常。
            data-source-frame={l.sourceFrame}
            onError={(e) => {
              const a = e.currentTarget
              console.error('[Monitor] audio error:', a.src?.slice(0, 80), 'code', a.error?.code, a.error?.message, 'readyState', a.readyState)
            }}
            style={{ display: 'none' }}
          />
        ))}
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
