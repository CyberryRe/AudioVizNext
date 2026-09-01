import type { Project } from '../model/timeline'

interface PropertiesPanelProps {
  project: Project
  selectedClipId: string | null
}

/** 右下：属性面板 —— 显示选中 clip 的属性 */
export default function PropertiesPanel({ project, selectedClipId }: PropertiesPanelProps): React.JSX.Element {
  let clip = null
  if (selectedClipId) {
    for (const clips of Object.values(project.clips)) {
      const c = clips.find((x) => x.id === selectedClipId)
      if (c) { clip = c; break }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="tabline">
        <span className="tab active">属性</span>
        <span style={{ marginLeft: 'auto', color: '#888' }}>☰</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 18, color: 'var(--text-secondary)' }}>
        {clip ? (
          <div>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>⚙ {clip.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              <div>类型: {clip.type}</div>
              <div>起始帧: {clip.startFrame}</div>
              <div>时长帧: {clip.durationFrames}</div>
              <div>源起始帧: {clip.sourceStartFrame}</div>
              <div>音量: {Math.round((clip.volume ?? 1) * 100)}%</div>
              <div>不透明度: {Math.round((clip.opacity ?? 1) * 100)}%</div>
            </div>
          </div>
        ) : (
          <div style={{ textAlign: 'center', marginTop: 40, color: 'var(--text-faint)' }}>
            在时间轴中选择剪辑以查看属性。
          </div>
        )}
      </div>
    </div>
  )
}
