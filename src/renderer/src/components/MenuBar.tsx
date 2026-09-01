import { useState } from 'react'

const MENUS: { label: string; items: string[] }[] = [
  { label: '文件(F)', items: ['新建项目', '打开项目…', '保存', '另存为…', '导入', '导出', '—', '退出'] },
  { label: '编辑(E)', items: ['撤销', '重做', '—', '剪切', '复制', '粘贴', '—', '全选'] },
  { label: '剪辑(C)', items: ['新建剪辑', '重命名', '—', '绑定素材', '取消绑定', '—', '启用/禁用'] },
  { label: '序列(S)', items: ['新建序列', '序列设置…', '—', '添加轨道', '删除轨道'] },
  { label: '标记(M)', items: ['添加标记', '上一标记', '下一标记', '清除标记'] },
  { label: '视图(V)', items: ['缩放', '标尺', '安全边距', '—', '全屏'] },
  { label: '窗口(W)', items: ['效果控件', '项目', '时间轴', '—', '工作区'] },
  { label: '帮助(H)', items: ['关于 AudioVizNext', '文档'] }
]
const WORKSPACES = ['导入', '编辑', '导出', '效果']

export default function MenuBar(): React.JSX.Element {
  const [openMenu, setOpenMenu] = useState<number | null>(null)

  return (
    <div
      style={{
        height: 44,
        background: '#202020',
        borderBottom: '1px solid #090909',
        display: 'flex',
        alignItems: 'stretch',
        gap: 2,
        padding: '0 14px',
        flex: 'none',
        position: 'relative',
        zIndex: 30
      }}
      onMouseDown={() => setOpenMenu(null)}
    >
      <span style={{ fontSize: 18, fontWeight: 700, marginRight: 4, color: '#eee', alignSelf: 'center' }}>◆</span>

      {/* 菜单 */}
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        {MENUS.map((m, i) => (
          <div key={m.label} style={{ position: 'relative', display: 'flex' }}>
            <span
              onMouseEnter={() => setOpenMenu(openMenu !== null ? i : null)}
              onMouseDown={(e) => { e.stopPropagation(); setOpenMenu(openMenu === i ? null : i) }}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '0 7px',
                fontSize: 13,
                color: openMenu === i ? '#fff' : '#ddd',
                background: openMenu === i ? '#333' : 'transparent',
                cursor: 'default',
                whiteSpace: 'nowrap',
                borderRadius: 3
              }}
            >
              {m.label}
            </span>
            {openMenu === i && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  background: '#262626',
                  border: '1px solid #111',
                  borderRadius: 4,
                  minWidth: 190,
                  boxShadow: '0 6px 18px rgba(0,0,0,.5)',
                  padding: '4px 0'
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {m.items.map((it, j) =>
                  it === '—' ? (
                    <div key={j} style={{ height: 1, background: '#3a3a3a', margin: '5px 10px' }} />
                  ) : (
                    <div
                      key={j}
                      style={{
                        padding: '6px 18px 6px 24px',
                        fontSize: 13,
                        color: '#ddd',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap'
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = '#1a5a9a' }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
                      onClick={() => setOpenMenu(null)}
                    >
                      {it}
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 工作区 */}
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'stretch', gap: 18, color: '#ddd' }}>
        {WORKSPACES.map((w, i) => (
          <span
            key={w}
            style={{
              display: 'flex',
              alignItems: 'center',
              borderBottom: i === 1 ? '2px solid #d7d7d7' : 'none',
              cursor: 'default',
              fontSize: 13
            }}
          >
            {w}
          </span>
        ))}
      </span>
    </div>
  )
}
