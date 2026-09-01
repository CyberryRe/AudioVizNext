/**
 * AudioVizNext — 主应用
 *
 * Pr 界面布局 + Elah 数据模型逻辑。
 * 布局参考 reference/premiere_ui_1to1_mockup.html（三列两行网格）。
 */
import { useState, useMemo } from 'react'
import type { Project } from './model/timeline'
import { createDemoProject, createDemoAssets } from './model/demo'
import TitleBar from './components/TitleBar'
import MenuBar from './components/MenuBar'
import EffectControls from './components/EffectControls'
import Monitor from './components/Monitor'
import EffectsPanel from './components/EffectsPanel'
import ProjectPanel from './components/ProjectPanel'
import Timeline from './components/Timeline'
import PropertiesPanel from './components/PropertiesPanel'
import './app.css'

export default function App(): React.JSX.Element {
  // ===== 引擎状态（Ring 0 的简化版：项目 + 播放头） =====
  const [project, setProject] = useState<Project>(() => createDemoProject())
  const [playheadFrame, setPlayheadFrame] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)

  // ===== 素材库 =====
  const [assets] = useState(() => createDemoAssets())

  // ===== UI 瞬态（Ring 2） =====
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)

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
          <EffectsPanel />
        </section>

        {/* 左下：项目 / 素材库 */}
        <section className="panel left-bottom">
          <ProjectPanel assets={assets} />
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
