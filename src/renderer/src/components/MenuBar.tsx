const MENUS = ['文件(F)', '编辑(E)', '剪辑(C)', '序列(S)', '标记(M)', '视图(V)', '窗口(W)', '帮助(H)']
const WORKSPACES = ['导入', '编辑', '导出', '效果']

export default function MenuBar(): React.JSX.Element {
  return (
    <div
      style={{
        height: 44,
        background: '#202020',
        borderBottom: '1px solid #090909',
        display: 'flex',
        alignItems: 'center',
        gap: 22,
        padding: '0 14px',
        flex: 'none'
      }}
    >
      <span style={{ fontSize: 18, fontWeight: 700, marginRight: 4, color: '#eee' }}>◆</span>
      {MENUS.map((m) => (
        <span key={m} style={{ fontSize: 13, color: '#ddd', cursor: 'default', whiteSpace: 'nowrap' }}>
          {m}
        </span>
      ))}
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 20, color: '#ddd' }}>
        {WORKSPACES.map((w, i) => (
          <span
            key={w}
            style={{
              height: 44,
              display: 'flex',
              alignItems: 'center',
              borderBottom: i === 1 ? '2px solid #d7d7d7' : 'none',
              cursor: 'default'
            }}
          >
            {w}
          </span>
        ))}
      </span>
    </div>
  )
}
