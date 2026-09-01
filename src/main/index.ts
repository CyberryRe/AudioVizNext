import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'

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
