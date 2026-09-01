import { useState } from 'react'
import type { MediaAsset } from '../model/timeline'

interface ProjectPanelProps {
  assets: MediaAsset[]
  /** 本地文件拖入素材库 */
  onImportFiles: (files: File[]) => void
  /** 把素材落到时间轴（播放头处） */
  onAddAssetClip: (asset: MediaAsset, dropFrame: number) => void
  playheadFrame: number
}

const KIND_ICON: Record<MediaAsset['kind'], string> = {
  video: '▶',
  audio: '♪',
  image: '▧'
}

const KIND_LABEL: Record<MediaAsset['kind'], string> = {
  video: '视频',
  audio: '音频',
  image: '图片'
}

/** 左下：项目面板 —— 素材库网格（可拖入本地文件 / 拖出到时间轴） */
export default function ProjectPanel({ assets, onImportFiles, onAddAssetClip, playheadFrame }: ProjectPanelProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'project' | 'media'>('project')
  const [query, setQuery] = useState('')
  const [over, setOver] = useState(false)

  const list = query.trim() ? assets.filter((a) => a.name.toLowerCase().includes(query.trim().toLowerCase())) : assets

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setOver(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length > 0) {
      onImportFiles(files)
      return
    }
  }

  const startDragAsset = (e: React.DragEvent, asset: MediaAsset): void => {
    e.dataTransfer.setData('application/x-avn-asset', JSON.stringify({ assetId: asset.id }))
    e.dataTransfer.setData('text/plain', asset.name)
    e.dataTransfer.effectAllowed = 'copy'
    ;(window as unknown as Record<string, unknown>)._avsPendingDrag = { type: 'asset', assetId: asset.id }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="tabline">
        <span
          className={`tab ${activeTab === 'project' ? 'active' : ''}`}
          onClick={() => setActiveTab('project')}
        >
          项目
        </span>
        <span
          className={`tab ${activeTab === 'media' ? 'active' : ''}`}
          onClick={() => setActiveTab('media')}
        >
          媒体浏览器
        </span>
      </div>
      <div className="search">
        <span className="search-icon">⌕</span>
        <input placeholder="搜索素材" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && (
          <span style={{ cursor: 'pointer', color: 'var(--text-muted)', padding: '0 2px' }} onClick={() => setQuery('')}>
            ✕
          </span>
        )}
      </div>

      {activeTab === 'project' ? (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            padding: '13px 14px',
            border: over ? '2px dashed var(--accent)' : '2px dashed transparent',
            borderRadius: 3,
            background: over ? 'rgba(25,136,255,0.06)' : 'transparent',
            transition: 'border-color .12s'
          }}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={handleDrop}
        >
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 8 }}>
            {assets.length} 个素材 · 可拖入本地文件
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {list.length === 0 && (
              <div style={{ padding: 24, color: 'var(--text-faint)', fontSize: 12, width: '100%', textAlign: 'center' }}>
                将视频 / 图片 / 音频文件拖到这里导入素材
              </div>
            )}
            {list.map((a) => (
              <div key={a.id} style={{ width: 91 }}>
                <div
                  draggable
                  onDragStart={(e) => startDragAsset(e, a)}
                  onClick={() => onAddAssetClip(a, playheadFrame)}
                  title={`${a.name}（点击或拖拽到时间轴）`}
                  style={{
                    width: 91,
                    height: 65,
                    border: '1px solid #555',
                    background: '#080808',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                    color: '#888',
                    fontSize: 16,
                    cursor: 'grab',
                    position: 'relative'
                  }}
                >
                  {a.kind === 'image' && a.src ? (
                    <img src={a.src} alt={a.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    KIND_ICON[a.kind]
                  )}
                  <span
                    style={{
                      position: 'absolute',
                      right: 3,
                      bottom: 3,
                      fontSize: 9,
                      background: 'rgba(0,0,0,.7)',
                      color: '#ccc',
                      padding: '0 3px',
                      borderRadius: 2
                    }}
                  >
                    {KIND_LABEL[a.kind]}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 10,
                    marginTop: 5,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    color: '#c8c8c8'
                  }}
                >
                  {a.name}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', padding: 16, color: 'var(--text-faint)', fontSize: 12 }}>
          媒体浏览器（本地文件扫描）将在后续阶段实现。
        </div>
      )}
    </div>
  )
}
