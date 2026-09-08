import { app, shell, BrowserWindow, protocol, ipcMain, dialog } from 'electron'
import { join, extname } from 'path'
import { createReadStream, statSync, readFileSync, openSync, closeSync, writeSync, writeFileSync } from 'fs'
import { ensureProxy, mediaCacheDir, hasFfmpeg, probeVideo } from './mediaCache'
import { initFileLog } from './logFile'
import { verifyVideoIntegrity, compareFrames } from './export'
import { loadPreferences, savePreferences, type Preferences } from './preferences'
import { probeExportDevices, getGpuEnv } from './deviceProbe'
import { applyWindowsGpuPreference } from './gpuPreference'
import { listUserPresets, importAvnpreFile, inspectAvnpreFile } from './presets'

// GPU 开关：强制 ANGLE 用 D3D11。旧项目实测 use-gl=desktop 会让 Chromium 的 D3D11 视频
// 编码器不可用（WebCodecs 硬编探测全失败），且 GameViewer 虚拟显示器环境对 GPU 后端尤其敏感。
app.commandLine.appendSwitch('use-angle', 'd3d11')
// 导出设备偏好：多 GPU 混合模式（如关闭独显直连）下强制 Chromium 用独显/核显。
// 这两个开关只能在 GPU 进程启动前设置，故改偏好需重启生效。
const _startupPrefs = loadPreferences()
if (_startupPrefs.exportDevice === 'discrete') {
  app.commandLine.appendSwitch('force-high-performance-gpu')
  console.log('[prefs] 导出设备=独显 → force-high-performance-gpu')
} else if (_startupPrefs.exportDevice === 'integrated') {
  app.commandLine.appendSwitch('force-low-power-gpu')
  console.log('[prefs] 导出设备=核显 → force-low-power-gpu')
}

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

// 尽早初始化文件日志（主进程 console 落盘 + 捕获渲染进程 console/崩溃），
// 崩溃后到 userData/logs/avnext-*.log 回溯全量现场（含 WebGL CONTEXT_LOST / GPU 崩溃）。
const fileLog = initFileLog()
console.log(`[main] userData logs dir 就绪: ${fileLog.file}`)

/** mediabunny 导出：输出路径 → 已打开的文件描述符（StreamTarget 按偏移随机写盘） */
const mbFds = new Map<string, number>()

/** 创建主窗口 */
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 关键：导出/长任务期间窗口失焦或被遮挡时，Chromium 默认会把定时器/rAF 重度节流
      // （失焦 1s/次、隐藏 5 分钟后更甚）→ 导出直接掉到 ~1fps 甚至 0.4fps。必须关闭。
      backgroundThrottling: false
    }
  })

  // 把本窗口渲染进程的 console/崩溃接入文件日志（WebGL 报错/崩溃后回溯）
  fileLog.attachWindow(mainWindow.webContents)

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
  // GPU 特性诊断（视频编解码是否被虚拟显示适配器弄失效，供排查 WebCodecs 硬编不可用）
  try {
    const gfs = app.getGPUFeatureStatus()
    console.log(`[gpu] video_encode=${gfs.video_encode} video_decode=${gfs.video_decode} webgl=${gfs.webgl} gpu_compositing=${gfs.gpu_compositing}`)
  } catch { /* 忽略 */ }
  // E2E 模式下再晚点打一次：whenReady 时 GPU 进程往往还没初始化完，首报会是 disabled_software。
  if (process.env['AVS_E2E_SPEC']) {
    setTimeout(() => {
      try {
        const gfs = app.getGPUFeatureStatus()
        console.log(`[gpu:late] video_encode=${gfs.video_encode} video_decode=${gfs.video_decode} webgl=${gfs.webgl} gpu_compositing=${gfs.gpu_compositing} 2d_canvas=${gfs['2d_canvas']}`)
        void app.getGPUInfo('basic').then((i) => console.log('[gpu:info] ' + JSON.stringify(i))).catch(() => {})
      } catch { /* 忽略 */ }
    }, 2500)
  }
  // 启动时同步一次 Windows 每应用 GPU 偏好（保证注册表与偏好文件一致，供 DXGI 在进程启动时读取）
  void applyWindowsGpuPreference(loadPreferences().exportDevice)

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

  // ===== 导出：保存对话框（真正的导出在渲染层 Worker 里由 mediabunny 完成） =====
  ipcMain.handle('avs:exportSaveDialog', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const d = await dialog.showSaveDialog(win!, {
      title: '导出影片',
      defaultPath: '未命名导出.mp4',
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
    })
    return d.canceled ? null : (d.filePath ?? null)
  })

  // ===== 首选项（导出设备等）=====
  ipcMain.handle('avs:prefGet', async () => loadPreferences())
  ipcMain.handle('avs:prefSet', async (_e, p: Preferences | null) => {
    const saved = savePreferences(p && typeof p === 'object' ? p : { exportDevice: 'auto' })
    // 联动 Windows 每应用 GPU 偏好（写入 UserGpuPreferences 注册表；重启生效）
    void applyWindowsGpuPreference(saved.exportDevice)
    return saved
  })
  // 运行时探查可用导出设备（GPU 列表 + 编码器可用性），供首选项页展示
  ipcMain.handle('avs:exportDevices', async () => probeExportDevices())
  // GPU 环境（厂商白名单过滤后的真实 GPU + 被忽略的虚拟适配器）
  ipcMain.handle('avs:gpuEnv', async () => getGpuEnv())

  // ===== mediabunny 导出落盘：StreamTarget 按 {position,data} 分块随机写 =====
  // mediabunny 在渲染进程内完成 编码+MP4 复用，主进程只负责按偏移写盘（不把整片攒在内存）。
  ipcMain.handle('avs:mbBegin', async (_e, outPath: unknown) => {
    const p = typeof outPath === 'string' ? outPath : ''
    if (!p) return false
    try {
      if (mbFds.has(p)) { try { closeSync(mbFds.get(p)!) } catch { /* 忽略 */ } }
      mbFds.set(p, openSync(p, 'w')) // 'w' 截断已有文件
      return true
    } catch (e) {
      console.error('[mbExport] 无法创建输出文件:', p, (e as Error).message)
      return false
    }
  })
  ipcMain.handle('avs:mbWrite', async (_e, outPath: unknown, data: unknown, position: unknown) => {
    const p = typeof outPath === 'string' ? outPath : ''
    const fd = mbFds.get(p)
    const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null
    if (fd === undefined || !bytes) return false
    try {
      // 随机写（position 为输出文件绝对偏移）——mp4 的 moov 在末尾，必须能回头写
      let written = 0
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      while (written < buf.byteLength) {
        written += writeSync(fd, buf, written, buf.byteLength - written, Number(position) + written)
      }
      return true
    } catch (e) {
      console.error('[mbExport] 写盘失败:', (e as Error).message)
      return false
    }
  })
  ipcMain.handle('avs:mbEnd', async (_e, outPath: unknown) => {
    const p = typeof outPath === 'string' ? outPath : ''
    const fd = mbFds.get(p)
    if (fd !== undefined) { try { closeSync(fd) } catch { /* 忽略 */ } mbFds.delete(p) }
    return true
  })

  // ===== 预设包（.avnpre）导入 / 用户预设列表 =====
  // 内置预设在打包时随渲染层 bundle 一起进入应用；这里只管"用户导入"的预设，
  // 落到 userData/presets/<id>/（preset.json + assets/），下次启动自动加载。
  ipcMain.handle('avs:presetList', async () => listUserPresets())
  ipcMain.handle('avs:presetImport', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const d = await dialog.showOpenDialog(win!, {
      title: '导入预设包',
      filters: [{ name: 'AudioVizNext 预设包', extensions: ['avnpre'] }],
      properties: ['openFile']
    })
    if (d.canceled || !d.filePaths[0]) return { ok: false, error: '已取消' }
    const file = d.filePaths[0]
    // 先只解码：含可执行脚本的预设必须用户明确确认后才安装
    const info = inspectAvnpreFile(file)
    if (!info.ok) return { ok: false, error: info.error }
    if (info.impl === 'script') {
      const r = await dialog.showMessageBox(win!, {
        type: 'warning',
        buttons: ['取消', '仍然导入'],
        defaultId: 0,
        cancelId: 0,
        title: '该预设包含可执行脚本',
        message: `「${info.name ?? info.id}」携带脚本实现（约 ${Math.round((info.scriptChars ?? 0) / 1024)}KB）`,
        detail: '脚本将以本应用权限在渲染进程中运行（同 VS Code 扩展的信任模型）。\n只导入你信任来源的预设。'
      })
      if (r.response !== 1) return { ok: false, error: '已取消（含脚本的预设需确认）' }
    }
    return importAvnpreFile(file)
  })

  // ===== E2E 测试台：渲染层跑完导出把报告打回 stdout，然后退出 =====
  // 仅当设了 AVS_E2E_SPEC 时会被渲染层调用（见 preload e2eSpec / renderer export/e2eRunner.ts）。
  ipcMain.handle('avs:e2e:verify', async (_e, outPath: unknown) =>
    verifyVideoIntegrity(typeof outPath === 'string' ? outPath : '')
  )
  // 两个时间点的画面相似度（SSIM）——验证时间轴映射（循环/定格类 bug）
  ipcMain.handle('avs:e2e:compare', async (_e, outPath: unknown, t1: unknown, t2: unknown) =>
    compareFrames(typeof outPath === 'string' ? outPath : '', Number(t1), Number(t2))
  )
  // E2E：把渲染层画布（PNG base64）落盘，用于预览截图目视验证
  ipcMain.handle('avs:e2e:savePng', async (_e, filePath: unknown, base64: unknown) => {
    const p = typeof filePath === 'string' ? filePath : ''
    const b64 = typeof base64 === 'string' ? base64.replace(/^data:image\/\w+;base64,/, '') : ''
    if (!p || !b64) return false
    try {
      writeFileSync(p, Buffer.from(b64, 'base64'))
      console.log('[e2e] 预览截图已保存:', p)
      return true
    } catch (e) {
      console.error('[e2e] 截图保存失败:', (e as Error).message)
      return false
    }
  })
  ipcMain.handle('avs:e2e:report', async (_e, payload: unknown) => {
    console.log('E2E_RESULT_BEGIN')
    console.log(JSON.stringify(payload, null, 2))
    console.log('E2E_RESULT_END')
    setTimeout(() => app.quit(), 200)
    return true
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
