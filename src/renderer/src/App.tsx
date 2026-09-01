/**
 * Stage 1 骨架启动页。
 * 仅验证：Electron 主进程 + preload + React 渲染进程三进程打通。
 * 不包含任何业务功能——业务从一个功能一个功能地加。
 */
function App(): React.JSX.Element {
  const v = window.api?.version

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        background: '#1e1e1e',
        color: '#e0e0e0'
      }}
    >
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>AudioVizNext</h1>
      <p style={{ margin: 0, color: '#888' }}>Stage 1 · 最小可启动骨架</p>
      {v && (
        <div style={{ fontSize: 12, color: '#666' }}>
          Electron {v.electron} · Chromium {v.chrome} · Node {v.node}
        </div>
      )}
    </div>
  )
}

export default App
