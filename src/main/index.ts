import { app, shell, BrowserWindow, protocol, net } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'

// 注册自定义协议 avn-file://：渲染层素材用真实文件路径（持久化），
// 避免 blob:/data: URL 在工程保存后失效及 WebGL 纹理问题。
// 必须在 app ready 前注册 scheme 特权（支持媒体流式响应 + 绕过 CSP 自身限制）。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'avn-file',
    privileges: {
      standard: false,
      secure: true,
      supportFetchAPI: true,
      stream: true,        // 允许流式传输大媒体文件
      bypassCSP: false,    // 仍受渲染层 CSP 约束（我们在 CSP 里放行 avn-file:）
      corsEnabled: true,
      codeCache: false
    }
  }
])

/** 创建主窗口 */
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 烟雾测试：AVS_SMOKE=1 时页面加载完成即自动退出（用于 CI/无头验证）
  if (process.env['AVS_SMOKE'] === '1') {
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('SMOKE_OK: page loaded')
      setTimeout(() => app.quit(), 500)
    })
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log(`SMOKE_FAIL: ${code} ${desc}`)
    })
    // 捕获渲染进程 console（含 React 错误）
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) console.log(`SMOKE_RENDER_ERROR: ${message}`)
    })
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.log(`SMOKE_RENDER_GONE: ${details.reason}`)
    })
  }

  // 外部链接交给系统浏览器打开，不在应用内导航
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 开发模式加载 Vite dev server，生产模式加载打包产物
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 注册 avn-file:// 处理器：avn-file://<encodeURIComponent(绝对路径)> → 流式返回本地文件
  // 约定：绝对路径整体做 URI 编码放在 host 位，跨平台（Windows C:\ 与 Unix / 均无歧义）。
  protocol.handle('avn-file', (request) => {
    try {
      const u = new URL(request.url)
      const absPath = decodeURIComponent(u.hostname)
      // 校验：只允许绝对路径，防路径穿越（拒绝相对路径）
      if (!absPath.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(absPath)) {
        return new Response('Forbidden: not an absolute path', { status: 403 })
      }
      const fileURL = pathToFileURL(absPath).toString()
      return net.fetch(fileURL)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
  })

  createWindow()

  // macOS：点击 Dock 图标且无窗口时重新创建
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 非 macOS：关闭全部窗口即退出
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
