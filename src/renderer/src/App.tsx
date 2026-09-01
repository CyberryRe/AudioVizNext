/**
 * AudioVizNext — 主应用
 *
 * Pr 界面布局 + Elah 数据模型逻辑。
 * 布局参考 reference/premiere_ui_1to1_mockup.html（三列两行网格）。
 */
import { useState, useMemo, useCallback } from 'react'
import type { Project, MediaAsset, Clip } from './model/timeline'
import {
  createDemoProject,
  createDemoAssets,
  clipFromTemplate,
  createEffectCategories,
  type EffectTemplate
} from './model/demo'
import { addClipToTrack, assetFromFile } from './model/timeline'
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

export default function App(): React.JSX.Element {
  // ===== 引擎状态（Ring 0 的简化版：项目 + 播放头） =====
  const [project, setProject] = useState<Project>(() => createDemoProject())
  const [playheadFrame, setPlayheadFrame] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)

  // ===== 素材库（可变，可拖入） =====
  const [assets, setAssets] = useState<MediaAsset[]>(() => createDemoAssets())

  // ===== UI 瞬态（Ring 2） =====
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)

  const effectCategories = useMemo(() => createEffectCategories(), [])

  // 时间轴总长（帧）
  const total = useMemo(
    () => {
      let max = 0
      for (const clips of Object.values(project.clips)) {
        for (const c of clips) max = Math.max(max, c.startFrame + c.durationFrames)
      }
      return max || 30 * 20
    },
    [project]
  )

  // ===== 操作：本地文件拖入素材库 =====
  const handleImportFiles = useCallback((files: File[]) => {
    if (!files || files.length === 0) return
    const next = files.map(assetFromFile)
    setAssets((prev) => [...next, ...prev])
  }, [])

  // ===== 操作：把模板（效果库 test clip）落到时间轴 =====
  const handleAddTemplate = useCallback(
    (tpl: EffectTemplate, dropFrame: number, targetTrackId?: string) => {
      const trackId = targetTrackId ?? trackIdForKind(project, tpl.kind)
      const clip = clipFromTemplate(tpl, trackId)
      setProject((prev) => {
        const target = targetTrackId ?? trackIdForKind(prev, tpl.kind)
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
      const clip: Clip = {
        id: `clip-${Math.random().toString(36).slice(2, 8)}`,
        trackId: targetTrackId ?? trackIdForKind(project, asset.kind),
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
        const target = targetTrackId ?? trackIdForKind(prev, asset.kind)
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

  // 供子组件从 assets 按 id 取素材
  const getAsset = useCallback(
    (id: string) => assets.find((a) => a.id === id),
    [assets]
  )

  return (
    <div className="app">
      <TitleBar projectName="未命名.avproj" />
      <MenuBar />

      <div className="main">
        {/* 左上：效果控件 */}
        <section className="panel left-top">
          <EffectControls selectedClipId={selectedClipId} project={project} />
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
            selectedClipId={selectedClipId}
            onSelectClip={setSelectedClipId}
            onAddTemplate={handleAddTemplate}
            onAddAssetClip={handleAddAssetClip}
            onToggleTrack={handleToggleTrack}
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
