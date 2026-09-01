/**
 * AudioVizNext — 主应用
 *
 * Pr 界面布局 + Elah 数据模型逻辑。
 * 布局参考 reference/premiere_ui_1to1_mockup.html（三列两行网格）。
 */
import { useState, useMemo, useCallback, useEffect } from 'react'
import type { Project, MediaAsset, Clip, Track, TrackZone } from './model/timeline'
import {
  createDemoProject,
  createDemoAssets,
  clipFromTemplate,
  createEffectCategories,
  type EffectTemplate
} from './model/demo'
import {
  addClipToTrack,
  moveClip,
  resizeClip,
  deleteClip,
  moveClipAcrossTracks,
  addVideoTrack,
  addAudioTrack,
  assetFromFile,
  bindAssetToClip,
  STAGE_RATIOS,
  stageSizeFor
} from './model/timeline'
import TitleBar from './components/TitleBar'
import MenuBar from './components/MenuBar'
import EffectControls from './components/EffectControls'
import Monitor from './components/Monitor'
import EffectsPanel from './components/EffectsPanel'
import ProjectPanel from './components/ProjectPanel'
import Timeline from './components/Timeline'
import PropertiesPanel from './components/PropertiesPanel'
import './app.css'

/** 拖拽负载：效果库模板 或 素材 */
export type DragPayload =
  | { type: 'template'; template: EffectTemplate }
  | { type: 'asset'; assetId: string }

/** 依据模板 kind 路由到目标轨道 id（Pr 规范映射） */
function trackIdForKind(project: Project, kind: EffectTemplate['kind']): string {
  const track = project.tracks.find((t) => {
    if (kind === 'audio') return t.kind === 'audio'
    if (kind === 'text') return t.kind === 'text'
    // video / image / visual → 最上面的 video 轨
    return t.kind === 'video'
  })
  return track?.id ?? project.tracks[0]?.id ?? ''
}

/** 依据模板 kind 路由到目标分区 */
function zoneForKind(kind: EffectTemplate['kind']): TrackZone {
  return kind === 'audio' ? 'audio' : 'video'
}

/** 依据素材类型路由到目标分区 */
function zoneForAsset(kind: MediaAsset['kind']): TrackZone {
  return kind === 'audio' ? 'audio' : 'video'
}

/**
 * 探测媒体文件真实时长（秒）。用 <video>/<audio> 加载 blob 读取 duration。
 * 失败或超时返回 0（调用方回退为模板默认时长）。
 */
function probeMediaDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const kind = file.name.split('.').pop()?.toLowerCase() ?? ''
    const isAudio = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'].includes(kind)
    const el = isAudio ? document.createElement('audio') : document.createElement('video')
    const url = URL.createObjectURL(file)
    let settled = false
    const done = (d: number): void => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      el.removeAttribute('src')
      el.load()
      resolve(d)
    }
    el.preload = 'metadata'
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : 0)
    el.onerror = () => done(0)
    el.src = url
    // 超时兜底（5s），避免个别文件卡住
    window.setTimeout(() => done(0), 5000)
  })
}

/** 在某分区找到第一条轨道 id（用于默认落点） */
function firstTrackIdInZone(project: Project, zone: TrackZone): string {
  const t = project.tracks.find((x) => x.zone === zone)
  return t?.id ?? ''
}

export default function App(): React.JSX.Element {
  // ===== 引擎状态（Ring 0 的简化版：项目 + 播放头） =====
  const [project, setProject] = useState<Project>(() => createDemoProject())
  const [playheadFrame, setPlayheadFrame] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)

  // ===== 序列设置（Stage）：比例 + 分辨率，实时改预览与导出比例 =====
  const [stageConfig, setStageConfig] = useState(() => ({
    ratioId: '16:9',
    width: 1920,
    height: 1080,
    // 宽>高 → landscape；9:16/1:1 等 → portrait
    orientation: 'landscape' as 'landscape' | 'portrait'
  }))

  // ===== 素材库（可变，可拖入） =====
  const [assets, setAssets] = useState<MediaAsset[]>(() => createDemoAssets())

  // ===== UI 瞬态（Ring 2） =====
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  // 时间轴缩放（px / 帧）
  const [pxPerFrame, setPxPerFrame] = useState(0.6)

  const effectCategories = useMemo(() => createEffectCategories(), [])

  // 舞台尺寸随序列设置变化
  const stage = useMemo(() => ({ width: stageConfig.width, height: stageConfig.height }), [stageConfig])

  // 时间轴总长（帧）：默认很长（例如 5 小时 @fps），长素材也能从容编辑；
  // 若某 clip 终点超过默认值则跟随扩展（始终 ≥ 最远 clip 终点）。
  const total = useMemo(
    () => {
      let max = 0
      for (const clips of Object.values(project.clips)) {
        for (const c of clips) max = Math.max(max, c.startFrame + c.durationFrames)
      }
      const DEFAULT_FRAMES = 5 * 3600 * project.fps // 5 小时
      return Math.max(max, DEFAULT_FRAMES)
    },
    [project, project.fps]
  )

  // ===== 序列设置：改比例 + 分辨率 =====
  const handleSetStage = useCallback((next: { ratioId: string; width: number; height: number; orientation: 'landscape' | 'portrait' }) => {
    setStageConfig(next)
    setProject((prev) => ({
      ...prev,
      stage: { width: next.width, height: next.height },
      version: prev.version + 1
    }))
  }, [])

  // ===== 操作：本地文件拖入素材库（探测真实媒体时长；歌词读取文本） =====
  const handleImportFiles = useCallback(async (files: File[]) => {
    if (!files || files.length === 0) return
    const next = await Promise.all(files.map(async (file) => {
      const asset = assetFromFile(file)
      const dur = await probeMediaDuration(file)
      if (dur > 0) asset.durationSec = dur
      if (asset.kind === 'lyrics') {
        try {
          asset.textContent = await file.text()
        } catch {
          asset.textContent = ''
        }
      }
      return asset
    }))
    setAssets((prev) => [...next, ...prev])
  }, [])

  // ===== 操作：把模板（效果库 clip）落到时间轴 =====
  const handleAddTemplate = useCallback(
    (tpl: EffectTemplate, dropFrame: number, targetTrackId?: string) => {
      const zone = zoneForKind(tpl.kind)
      const trackId = targetTrackId ?? firstTrackIdInZone(project, zone)
      const clip = clipFromTemplate(tpl, trackId)
      setProject((prev) => {
        const target = targetTrackId ?? firstTrackIdInZone(prev, zone)
        const nextClips = addClipToTrack(prev.clips[target] ?? [], clip, true)
        return { ...prev, clips: { ...prev.clips, [target]: nextClips }, version: prev.version + 1 }
      })
      setSelectedClipId(clip.id)
    },
    [project]
  )

  // ===== 操作：把素材落到时间轴（生成对应 clip） =====
  const handleAddAssetClip = useCallback(
    (asset: MediaAsset, dropFrame: number, targetTrackId?: string) => {
      const zone = zoneForAsset(asset.kind)
      const clip: Clip = {
        id: `clip-${Math.random().toString(36).slice(2, 8)}`,
        trackId: targetTrackId ?? firstTrackIdInZone(project, zone),
        type: asset.kind,
        name: asset.name,
        startFrame: dropFrame,
        durationFrames: 30 * Math.max(1, Math.round(asset.durationSec || 5)),
        sourceStartFrame: 0,
        sourceDurationFrames: 30 * Math.max(1, Math.round(asset.durationSec || 5)),
        src: asset.src,
        assetId: asset.id,
        volume: asset.kind === 'audio' ? 1 : undefined,
        opacity: 1
      }
      setProject((prev) => {
        const target = targetTrackId ?? firstTrackIdInZone(prev, zone)
        const nextClips = addClipToTrack(prev.clips[target] ?? [], clip, true)
        return { ...prev, clips: { ...prev.clips, [target]: nextClips }, version: prev.version + 1 }
      })
      setSelectedClipId(clip.id)
    },
    [project]
  )

  // ===== 操作：切换轨道属性（可见性/静音/独奏/锁定） =====
  const handleToggleTrack = useCallback((trackId: string, prop: 'disabled' | 'muted' | 'solo' | 'locked') => {
    setProject((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) => (t.id === trackId ? { ...t, [prop]: !t[prop] } : t)),
      version: prev.version + 1
    }))
  }, [])

  // ===== 操作：删除选中 clip（Delete/Backspace） =====
  const handleDeleteClip = useCallback((clipId: string | null) => {
    if (!clipId) return
    setProject((prev) => {
      const nextClips: Record<string, Clip[]> = {}
      let touched = false
      for (const [tid, clips] of Object.entries(prev.clips)) {
        const filtered = deleteClip(clips, clipId)
        if (filtered.length !== clips.length) touched = true
        nextClips[tid] = filtered
      }
      if (!touched) return prev
      return { ...prev, clips: nextClips, version: prev.version + 1 }
    })
    setSelectedClipId(null)
  }, [])

  // ===== 操作：手动新增视频轨 / 音频轨 =====
  const handleAddVideoTrack = useCallback(() => {
    setProject((prev) => {
      const { tracks, track } = addVideoTrack(prev.tracks)
      return { ...prev, tracks, clips: { ...prev.clips, [track.id]: [] }, version: prev.version + 1 }
    })
  }, [])

  const handleAddAudioTrack = useCallback(() => {
    setProject((prev) => {
      const { tracks, track } = addAudioTrack(prev.tracks)
      return { ...prev, tracks, clips: { ...prev.clips, [track.id]: [] }, version: prev.version + 1 }
    })
  }, [])

  // ===== 操作：同轨移动 clip =====
  const handleMoveClip = useCallback((clipId: string, newStart: number) => {
    setProject((prev) => {
      let trackId = ''
      for (const [tid, clips] of Object.entries(prev.clips)) {
        if (clips.some((c) => c.id === clipId)) { trackId = tid; break }
      }
      if (!trackId) return prev
      const next = moveClip(prev.clips[trackId] ?? [], clipId, newStart)
      return { ...prev, clips: { ...prev.clips, [trackId]: next }, version: prev.version + 1 }
    })
  }, [])

  // ===== 操作：跨轨移动 clip（视频轨/音频轨之间互拖） =====
  const handleMoveClipAcrossTracks = useCallback(
    (clipId: string, targetTrackId: string, newStart: number, targetZone: TrackZone) => {
      setProject((prev) => {
        // 拖到视频区最顶 → 占位 id，自动新建视频轨再移动
        if (targetTrackId === '__new-video-track__' && targetZone === 'video') {
          const { tracks, track } = addVideoTrack(prev.tracks)
          const result = moveClipAcrossTracks(prev.clips, clipId, track.id, newStart)
          if (!result) return prev
          return { ...prev, tracks, clips: result.clips, version: prev.version + 1 }
        }
        // 目标轨不存在 且 落在视频区 → 自动新建视频轨
        if (!prev.clips[targetTrackId] && targetZone === 'video') {
          const { tracks, track } = addVideoTrack(prev.tracks)
          const result = moveClipAcrossTracks(prev.clips, clipId, track.id, newStart)
          if (!result) return prev
          return { ...prev, tracks, clips: result.clips, version: prev.version + 1 }
        }
        const result = moveClipAcrossTracks(prev.clips, clipId, targetTrackId, newStart)
        if (!result) return prev
        return { ...prev, clips: result.clips, version: prev.version + 1 }
      })
    },
    []
  )

  // ===== 操作：同轨调整 clip 时长 =====
  const handleResizeClip = useCallback((clipId: string, newDuration: number) => {
    setProject((prev) => {
      let trackId = ''
      for (const [tid, clips] of Object.entries(prev.clips)) {
        if (clips.some((c) => c.id === clipId)) { trackId = tid; break }
      }
      if (!trackId) return prev
      const next = resizeClip(prev.clips[trackId] ?? [], clipId, newDuration)
      return { ...prev, clips: { ...prev.clips, [trackId]: next }, version: prev.version + 1 }
    })
  }, [])

  // ===== 操作：更新选中 clip 的变换参数（缩放/位置） =====
  const handleUpdateClipParams = useCallback((clipId: string, patch: Partial<Clip>) => {
    setProject((prev) => {
      const nextClips: Record<string, Clip[]> = {}
      let touched = false
      for (const [tid, clips] of Object.entries(prev.clips)) {
        nextClips[tid] = clips.map((c) => {
          if (c.id !== clipId) return c
          touched = true
          return { ...c, ...patch }
        })
      }
      if (!touched) return prev
      return { ...prev, clips: nextClips, version: prev.version + 1 }
    })
  }, [])

  // ===== 操作：给 clip 绑定素材（关联素材） =====
  const handleBindAssetToClip = useCallback((clipId: string, assetId: string) => {
    const asset = assets.find((a) => a.id === assetId)
    if (!asset) return
    setProject((prev) => {
      const nextClips: Record<string, Clip[]> = {}
      let touched = false
      for (const [tid, clips] of Object.entries(prev.clips)) {
        nextClips[tid] = clips.map((c) => {
          if (c.id !== clipId) return c
          const updated = bindAssetToClip(c, asset)
          if (!updated) return c
          touched = true
          return updated
        })
      }
      if (!touched) return prev
      return { ...prev, clips: nextClips, version: prev.version + 1 }
    })
  }, [assets])

  // ===== 时间轴缩放（快捷键 + 滚轮） =====
  const zoomIn = useCallback(() => setPxPerFrame((p) => Math.min(3, p * 1.25)), [])
  const zoomOut = useCallback(() => setPxPerFrame((p) => Math.max(0.1, p / 1.25)), [])
  const resetZoom = useCallback(() => setPxPerFrame(0.6), [])

  // 供子组件从 assets 按 id 取素材
  const getAsset = useCallback(
    (id: string) => assets.find((a) => a.id === id),
    [assets]
  )

  // ===== 快捷键（Pr 风格）：空格播放、←/→ 步进、Ctrl+滚轮缩放、Home/End =====
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 忽略输入框内的快捷键
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      // 缩放：= / - / 0（Pr 风格）+ Ctrl+滚轮在 Timeline 内处理
      if (e.key === '=' || e.key === '+') { zoomIn(); return }
      if (e.key === '-') { zoomOut(); return }
      if (e.key === '0' && (e.ctrlKey || e.metaKey)) { resetZoom(); return }

      if (e.key === ' ') { e.preventDefault(); setIsPlaying((p) => !p); return }

      // Delete / Backspace 删除选中 clip
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedClipId) { e.preventDefault(); handleDeleteClip(selectedClipId) }
        return
      }

      if (e.key === 'ArrowLeft') {
        if (e.ctrlKey || e.metaKey) { setPlayheadFrame((f) => Math.max(0, f - 5 * project.fps)); e.preventDefault() }
        else { setPlayheadFrame((f) => Math.max(0, f - 1)); e.preventDefault() }
        return
      }
      if (e.key === 'ArrowRight') {
        if (e.ctrlKey || e.metaKey) { setPlayheadFrame((f) => f + 5 * project.fps); e.preventDefault() }
        else { setPlayheadFrame((f) => f + 1); e.preventDefault() }
        return
      }
      // Home / End
      if (e.key === 'Home') { setPlayheadFrame(0); return }
      if (e.key === 'End') { setPlayheadFrame((f) => f + project.fps * 5); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomIn, zoomOut, resetZoom, project.fps, selectedClipId, handleDeleteClip])

  return (
    <div className="app">
      <TitleBar projectName="未命名.avproj" />
      <MenuBar
        stageConfig={stageConfig}
        onSetStage={handleSetStage}
        ratios={STAGE_RATIOS}
        stageSizeFor={stageSizeFor}
      />

      <div className="main">
        {/* 左上：效果控件 */}
        <section className="panel left-top">
          <EffectControls
            selectedClipId={selectedClipId}
            project={project}
            getAsset={getAsset}
            onUpdateClipParams={handleUpdateClipParams}
            onBindAssetToClip={handleBindAssetToClip}
          />
        </section>

        {/* 中上：节目监视器 */}
        <section className="panel center-top">
          <Monitor
            project={project}
            frame={playheadFrame}
            isPlaying={isPlaying}
            onPlay={setIsPlaying}
            onSeek={setPlayheadFrame}
          />
        </section>

        {/* 右上：效果 */}
        <section className="panel right-top">
          <EffectsPanel
            categories={effectCategories}
            onAddTemplate={handleAddTemplate}
            playheadFrame={playheadFrame}
          />
        </section>

        {/* 左下：项目 / 素材库 */}
        <section className="panel left-bottom">
          <ProjectPanel
            assets={assets}
            onImportFiles={handleImportFiles}
            onAddAssetClip={handleAddAssetClip}
            playheadFrame={playheadFrame}
          />
        </section>

        {/* 中下：时间轴 */}
        <section className="panel center-bottom">
          <Timeline
            project={project}
            total={total}
            playheadFrame={playheadFrame}
            isPlaying={isPlaying}
            onPlay={setIsPlaying}
            onSeek={setPlayheadFrame}
            pxPerFrame={pxPerFrame}
            onZoomIn={zoomIn}
            onZoomOut={zoomOut}
            selectedClipId={selectedClipId}
            onSelectClip={setSelectedClipId}
            onAddTemplate={handleAddTemplate}
            onAddAssetClip={handleAddAssetClip}
            onToggleTrack={handleToggleTrack}
            onMoveClip={handleMoveClip}
            onResizeClip={handleResizeClip}
            onMoveClipAcrossTracks={handleMoveClipAcrossTracks}
            onAddVideoTrack={handleAddVideoTrack}
            onAddAudioTrack={handleAddAudioTrack}
            getAsset={getAsset}
          />
        </section>

        {/* 右下：属性 */}
        <section className="panel right-bottom">
          <PropertiesPanel project={project} selectedClipId={selectedClipId} />
        </section>
      </div>
    </div>
  )
}
