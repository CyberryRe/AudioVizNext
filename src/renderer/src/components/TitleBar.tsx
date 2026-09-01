interface TitleBarProps {
  projectName: string
}

/** 窗口控制按钮（接入 preload 的 window API） */
function WinButton({ label, onClick, hover, hoverColor }: {
  label: string
  onClick: () => void
  hover?: string
  hoverColor?: string
}): React.JSX.Element {
  return (
    <span
      onClick={onClick}
      style={{
        width: 44,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 13,
        cursor: 'pointer',
        color: '#111'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = hover ?? '#c8c8c8'
        if (hoverColor) e.currentTarget.style.color = hoverColor
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = ''
        e.currentTarget.style.color = '#111'
      }}
    >
      {label}
    </span>
  )
}

export default function TitleBar({ projectName }: TitleBarProps): React.JSX.Element {
  const win = window.api?.window
  return (
    <div
      className="titlebar"
      style={{
        height: 31,
        background: '#e9e9e9',
        color: '#111',
        display: 'flex',
        alignItems: 'center',
        padding: '0 0 0 10px',
        userSelect: 'none'
      }}
    >
      <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>AudioVizNext · {projectName}</span>
      <span style={{ marginLeft: 'auto', display: 'flex', height: '100%' }}>
        <WinButton label="—" onClick={() => win?.minimize()} hover="#c8c8c8" />
        <WinButton label="□" onClick={() => win?.maximize()} hover="#c8c8c8" />
        <WinButton
          label="×"
          onClick={() => win?.close()}
          hover="#e81123"
          hoverColor="#fff"
        />
      </span>
    </div>
  )
}
