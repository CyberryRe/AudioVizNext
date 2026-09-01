import type { Project } from '../model/timeline'

interface EffectControlsProps {
  selectedClipId: string | null
  project: Project
}

/** 左上：效果控件 —— 显示选中 clip 的属性；未选中则提示 */
export default function EffectControls({ selectedClipId, project }: EffectControlsProps): React.JSX.Element {
  // 查找选中的 clip
  let selectedClipName: string | null = null
  if (selectedClipId) {
    for (const clips of Object.values(project.clips)) {
      const c = clips.find((x) => x.id === selectedClipId)
      if (c) { selectedClipName = c.name; break }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="tabline">
        <span className="tab active">效果控件</span>
        <span style={{ marginLeft: 'auto', color: '#888' }}>☰</span>
      </div>
      <div className="panel-head" style={{ flex: 'none' }}>
        <span>{selectedClipName ? selectedClipName : '(未选择剪辑)'}</span>
        <span className="dots">▣</span>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: 14,
          color: 'var(--text-muted)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {selectedClipName ? (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
            <div style={{ marginBottom: 8 }}>已选中剪辑</div>
            <div style={{ color: 'var(--accent)' }}>{selectedClipName}</div>
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-faint)' }}>
              效果参数控件将在这里显示
            </div>
          </div>
        ) : (
          <div>在时间轴中选择剪辑以查看效果控件</div>
        )}
      </div>
    </div>
  )
}
