import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import type { E2ESpec } from './export/e2eRunner'

/**
 * E2E 测试台入口：仅当主进程设了 AVS_E2E_SPEC（preload 暴露 e2eSpec）时接管，
 * 在真实渲染进程里跑一次导出并把报告打回主进程；正常启动（e2eSpec === null）零影响。
 */
const e2eSpec = window.api?.e2eSpec as E2ESpec | null | undefined

if (e2eSpec && typeof e2eSpec === 'object') {
  void (async () => {
    const { runE2E } = await import('./export/e2eRunner')
    const report = await runE2E(e2eSpec)
    await window.api.e2eReport(report)
  })()
} else {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
