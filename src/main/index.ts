import { app, shell, BrowserWindow, protocol } from 'electron'
import { join, extname } from 'path'
import { createReadStream, statSync } from 'fs'

/** 按扩展名返回 MIME 类型（video/audio 必须给对，否则 <video> 可能拒绝播放） */
function mimeFor(absPath: string): string {
  const ext = extname(absPath).toLowerCase()
  const map: Record<string, string> = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.ogg': 'video/ogg', '.ogv': 'video/ogg',
    '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.ts': 'video/mp2t',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
    '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/opus',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.lrc': 'text/plain'
  }
  return map[ext] ?? 'application/octet-stream'
}

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
  // 用 fs.createReadStream 直接流式返回（不用 net.fetch(file://)——Electron 的 net.fetch
  // 默认不接受 file: scheme，会令视频/图片加载静默失败）；并支持 HTTP Range 请求
  // （HTML5 <video> 播放/seek 依赖 Range，返回 206 才能让 readyState 正常就绪）。
  protocol.handle('avn-file', (request) => {
    try {
      const u = new URL(request.url)
      const absPath = decodeURIComponent(u.hostname)
      // 校验：只允许绝对路径，防路径穿越（拒绝相对路径）
      if (!absPath.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(absPath)) {
        return new Response('Forbidden: not an absolute path', { status: 403 })
      }
      const size = statSync(absPath).size
      const mime = mimeFor(absPath)
      const range = request.headers.get('Range')
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        const start = m && m[1] ? parseInt(m[1], 10) : 0
        const end = m && m[2] ? parseInt(m[2], 10) : size - 1
        const safeStart = Math.max(0, Math.min(start, size - 1))
        const safeEnd = Math.max(safeStart, Math.min(end, size - 1))
        const stream = createReadStream(absPath, { start: safeStart, end: safeEnd })
        return new Response(stream as unknown as BodyInit, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(safeEnd - safeStart + 1),
            'Content-Range': `bytes ${safeStart}-${safeEnd}/${size}`,
            'Accept-Ranges': 'bytes'
          }
        })
      }
      const stream = createReadStream(absPath)
      return new Response(stream as unknown as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes'
        }
      })
    } catch (e) {
      console.error('[avn-file] error:', (e as Error).message)
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
