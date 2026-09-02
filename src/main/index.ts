import { app, shell, BrowserWindow, protocol, ipcMain } from 'electron'
import { join, extname } from 'path'
import { createReadStream, statSync, readFileSync } from 'fs'
import { ensureProxy, mediaCacheDir, hasFfmpeg, probeVideo } from './mediaCache'

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
      if (range && range.startsWith('bytes=')) {
        // 解析单段 Range，覆盖三种形态（Chromium 媒体栈/FFmpegDemuxer 会发后缀区间）：
        //   bytes=start-end   固定区间
        //   bytes=start-      从 start 到文件尾
        //   bytes=-suffixLen  末尾 suffixLen 字节（此前被误当 0..suffixLen，返回错误字节致解码器读坏）
        const spec = range.slice('bytes='.length).split(',')[0].trim()
        const dash = spec.indexOf('-')
        const a = dash >= 0 ? spec.slice(0, dash) : spec
        const b = dash >= 0 ? spec.slice(dash + 1) : ''
        let start: number
        let end: number
        if (a === '') {
          // suffix 区间 bytes=-N → 取末尾 N 字节
          const n = parseInt(b, 10)
          start = Math.max(0, size - (Number.isFinite(n) ? n : size))
          end = size - 1
        } else {
          start = parseInt(a, 10)
          end = b === '' ? size - 1 : parseInt(b, 10)
        }
        if (!Number.isFinite(start)) start = 0
        if (!Number.isFinite(end)) end = size - 1
        const safeStart = Math.max(0, Math.min(start, size - 1))
        const safeEnd = Math.max(safeStart, Math.min(end, size - 1))
        const stream = createReadStream(absPath, { start: safeStart, end: safeEnd })
        return new Response(stream as unknown as BodyInit, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(safeEnd - safeStart + 1),
            'Content-Range': `bytes ${safeStart}-${safeEnd}/${size}`,
            'Accept-Ranges': 'bytes',
            // CORS：让渲染层 <video>/<img> 以 crossOrigin=anonymous 加载时不污染画布（WebGL 才能 texImage2D）
            'Access-Control-Allow-Origin': '*'
          }
        })
      }
      const stream = createReadStream(absPath)
      return new Response(stream as unknown as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
          // CORS：让渲染层 <video>/<img> 以 crossOrigin=anonymous 加载时不污染画布（WebGL 才能 texImage2D）
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch (e) {
      console.error('[avn-file] error:', (e as Error).message)
      return new Response('Bad request', { status: 400 })
    }
  })

  // ===== 媒体缓存(MediaCache)：渲染层请求转码代理 / 探测信息 / 能力查询 =====
  mediaCacheDir() // 确保根缓存目录存在
  ipcMain.handle('avs:mediaCache', async (_e, action: string, payload?: unknown) => {
    if (action === 'ensure') {
      const src = typeof payload === 'string' ? payload : ''
      return ensureProxy(src)
    }
    if (action === 'probe') {
      const src = typeof payload === 'string' ? payload : ''
      return { original: src, info: probeVideo(src) }
    }
    if (action === 'hasFfmpeg') return hasFfmpeg()
    if (action === 'cacheDir') return mediaCacheDir()
    return null
  })

  // ===== 读取磁盘文件字节(供音频 clip 打成 blob: URL 播放) =====
  // Chromium FFmpegDemuxer 对 avn-file:// 自定义流式协议的随机区间读不可靠，会 PIPELINE_ERROR_READ。
  // 音频文件通常较小(几 MB)，直接整读回传，渲染层 new Blob+createObjectURL 用进程内原生解码器播放。
  ipcMain.handle('avs:readFileBytes', async (_e, filePath: unknown) => {
    const p = typeof filePath === 'string' ? filePath : ''
    if (!p) return new Uint8Array(0)
    try {
      // 限制避免把超大视频整读进内存（该接口面向音频/小文件）
      const st = statSync(p)
      if (!st.isFile()) return new Uint8Array(0)
      if (st.size > 200 * 1024 * 1024) {
        console.warn('[avs:readFileBytes] too large, skip:', p)
        return new Uint8Array(0)
      }
      const buf = readFileSync(p)
      // Electron IPC 结构化克隆：Uint8Array 视图跨进程可传递，渲染层可直接 new Blob
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } catch (e) {
      console.error('[avs:readFileBytes] failed:', p, (e as Error).message)
      return new Uint8Array(0)
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
