interface TitleBarProps {
  projectName: string
}

/**
 * 标题栏。
 * 窗口控制（放大/缩小/退出）由系统原生外框处理，这里只显示应用名，不自绘窗口按钮。
 */
export default function TitleBar({ projectName }: TitleBarProps): React.JSX.Element {
  return (
    <div
      className="titlebar"
      style={{
        height: 31,
        background: '#1f1f1f',
        color: '#bbb',
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        userSelect: 'none',
        borderBottom: '1px solid #0a0a0a'
      }}
    >
      <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>AudioVizNext · {projectName}</span>
    </div>
  )
}
