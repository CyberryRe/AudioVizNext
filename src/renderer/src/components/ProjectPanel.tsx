import type { MediaAsset } from '../model/timeline'

interface ProjectPanelProps {
  assets: MediaAsset[]
}

const KIND_ICON: Record<MediaAsset['kind'], string> = {
  video: '▶',
  audio: '♪',
  image: '▧'
}

/** 左下：项目面板 —— 素材库网格 + 属性 */
export default function ProjectPanel({ assets }: ProjectPanelProps): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="tabline">
        <span className="tab active">项目</span>
        <span className="tab">媒体浏览器</span>
      </div>
      <div className="search">
        <span className="search-icon">⌕</span>
        <input placeholder="搜索素材" />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '13px 14px' }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {assets.map((a) => (
            <div key={a.id} style={{ width: 91 }}>
              <div
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
                  fontSize: 16
                }}
              >
                {a.kind === 'image' && a.src ? (
                  <img src={a.src} alt={a.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  KIND_ICON[a.kind]
                )}
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
    </div>
  )
}
