import { useState } from 'react'

const FOLDERS = ['预设', 'Lumetri 预设', '音频效果', '音频过渡', '视频效果', '视频过渡', '旧版']

/** 右上：效果面板 —— 效果树 + 搜索 */
export default function EffectsPanel(): React.JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({ 预设: true, 视频效果: true })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="tabline">
        <span className="tab active">效果</span>
        <span className="tab">历史记录</span>
      </div>
      <div className="search">
        <span className="search-icon">⌕</span>
        <input placeholder="搜索效果" />
      </div>
      <div style={{ padding: '0 13px', color: 'var(--text-secondary)', lineHeight: '31px', flex: 1, overflow: 'auto' }}>
        {FOLDERS.map((f) => (
          <div
            key={f}
            style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', userSelect: 'none' }}
            onClick={() => setOpen((o) => ({ ...o, [f]: !o[f] }))}
          >
            <span style={{ fontSize: 10, width: 9, color: '#aaa' }}>{open[f] ? '▼' : '▶'}</span>
            <span style={{ width: 15, height: 11, border: '1px solid #9b9b9b', position: 'relative', display: 'inline-block' }}>
              <span
                style={{
                  content: '""',
                  position: 'absolute',
                  left: 1,
                  top: -4,
                  width: 6,
                  height: 4,
                  border: '1px solid #9b9b9b',
                  borderBottom: 0
                }}
              />
            </span>
            <span>{f}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
