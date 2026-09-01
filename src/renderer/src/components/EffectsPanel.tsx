import { useState, useMemo } from 'react'
import type { EffectCategory, EffectTemplate } from '../model/demo'

interface EffectsPanelProps {
  categories: EffectCategory[]
  /** 点击 / 拖拽把模板放到时间轴（在播放头处） */
  onAddTemplate: (tpl: EffectTemplate, dropFrame: number) => void
  playheadFrame: number
}

/** 拖拽 MIME + 兜底 stash 键 */
export const DRAG_MIME = 'application/x-avn-template'

/** 右上：效果面板 —— 按大类分类的效果库，支持点击/拖拽添加到时间轴 */
export default function EffectsPanel({ categories, onAddTemplate, playheadFrame }: EffectsPanelProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'effects' | 'history'>('effects')
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(categories.map((c) => [c.id, true]))
  )
  const [query, setQuery] = useState('')

  // 搜索过滤
  const filtered = useMemo(() => {
    if (!query.trim()) return categories
    const q = query.trim().toLowerCase()
    return categories
      .map((c) => ({ ...c, items: c.items.filter((i) => i.name.toLowerCase().includes(q)) }))
      .filter((c) => c.items.length > 0)
  }, [categories, query])

  const startDrag = (e: React.DragEvent, tpl: EffectTemplate): void => {
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ template: tpl }))
    e.dataTransfer.setData('text/plain', tpl.name)
    e.dataTransfer.effectAllowed = 'copy'
    // 兜底：Electron 原生 DnD 自定义 MIME 不可靠时回退读取
    ;(window as unknown as Record<string, unknown>)._avsPendingDrag = {
      type: 'template',
      template: tpl
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="tabline">
        <span
          className={`tab ${activeTab === 'effects' ? 'active' : ''}`}
          onClick={() => setActiveTab('effects')}
        >
          效果
        </span>
        <span
          className={`tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          历史记录
        </span>
      </div>

      {activeTab === 'effects' ? (
        <>
          <div className="search">
            <span className="search-icon">⌕</span>
            <input
              placeholder="搜索效果"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <span
                style={{ cursor: 'pointer', color: 'var(--text-muted)', padding: '0 2px' }}
                onClick={() => setQuery('')}
              >
                ✕
              </span>
            )}
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 8px 14px' }}>
            {filtered.length === 0 && (
              <div style={{ padding: 18, color: 'var(--text-faint)', textAlign: 'center', fontSize: 12 }}>
                无匹配效果
              </div>
            )}
            {filtered.map((cat) => (
              <div key={cat.id} style={{ marginBottom: 2 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    cursor: 'pointer',
                    userSelect: 'none',
                    padding: '5px 5px',
                    color: 'var(--text-secondary)',
                    borderRadius: 3
                  }}
                  onClick={() => setOpen((o) => ({ ...o, [cat.id]: !o[cat.id] }))}
                >
                  <span style={{ fontSize: 9, width: 9, color: '#aaa' }}>{open[cat.id] ? '▼' : '▶'}</span>
                  <span style={{ width: 15, fontSize: 13, color: '#ccc', textAlign: 'center' }}>{cat.icon}</span>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{cat.name}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-faint)' }}>{cat.items.length}</span>
                </div>

                {open[cat.id] && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '2px 5px 8px 30px' }}>
                    {cat.items.map((item) => (
                      <div
                        key={item.id}
                        draggable
                        onDragStart={(e) => startDrag(e, item)}
                        onClick={() => onAddTemplate(item, playheadFrame)}
                        title={`${item.name}${item.desc ? ` — ${item.desc}` : ''}（点击添加到时间轴）`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 9px',
                          background: item.color ? `${item.color}22` : '#222',
                          border: `1px solid ${item.color ?? '#444'}`,
                          color: '#ddd',
                          borderRadius: 3,
                          fontSize: 12,
                          cursor: 'grab',
                          userSelect: 'none',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: item.color ?? '#888', display: 'inline-block' }} />
                        <span>{item.name}</span>
                        <span style={{ fontSize: 9, color: 'var(--text-faint)' }}>↧</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', padding: 14, color: 'var(--text-faint)', fontSize: 12 }}>
          历史记录将在后续阶段实现。
        </div>
      )}
    </div>
  )
}
