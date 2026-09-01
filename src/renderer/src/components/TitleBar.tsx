interface TitleBarProps {
  projectName: string
}

export default function TitleBar({ projectName }: TitleBarProps): React.JSX.Element {
  return (
    <div
      className="titlebar"
      style={{
        height: 31,
        background: '#e9e9e9',
        color: '#111',
        display: 'flex',
        alignItems: 'center',
        padding: '0 10px',
        userSelect: 'none'
      }}
    >
      <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>AudioVizNext · {projectName}</span>
      <span style={{ marginLeft: 'auto', display: 'flex', height: '100%' }}>
        {['—', '□', '×'].map((s, i) => (
          <span
            key={i}
            style={{
              width: 44,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              cursor: 'default'
            }}
          >
            {s}
          </span>
        ))}
      </span>
    </div>
  )
}
