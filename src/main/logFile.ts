/**
 * logFile.ts —— 主进程日志落盘：把主进程 console + 各窗口渲染进程 console 一起写入
 * `userData/logs/avnext-<日期>.log`，崩溃/GPU 异常后仍可回溯全量输出
 * （Electron 崩溃时 DevTools console 会丢，落盘日志是唯一可靠现场）。
 *
 * 用法（main/index.ts 最先调用）：
 *   import { initFileLog } from './logFile'
 *   const logger = initFileLog()
 *   logger.attachWindow(mainWindow)   // 每个 BrowserWindow 都 attach，捕获其渲染 console
 *
 * 特性：
 *  - 主进程 console.log/warn/error 重定向 → 带 [main] 前缀落盘 + 仍打到 stdout(dev 可看)。
 *  - 渲染进程 console-message → 带 [render:N] 前缀落盘（含 [Export-cap]/[DecodeSource]/WebGL 报错）。
 *  - 捕获 GPU 崩溃/子进程退出/uncaughtException/unhandledRejection/进程退出，落一行醒目标记。
 *  - 写日志本身绝不抛错（失败静默，避免把 app 搞挂）。
 */
import { app, BrowserWindow, type WebContents } from 'electron'
import { join } from 'path'
import { mkdirSync, appendFileSync } from 'fs'

/** 取一个跨会话不重复的日志文件名（含进程启动时间），避免多开互相覆盖 */
function logPath(): string {
  const dir = join(app.getPath('userData'), 'logs')
  try { mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return join(dir, `avnext-${ts}-${process.pid}.log`)
}

/** 是否已启用（幂等：多次调用只写一个文件） */
let _file: string | null = null

export interface FileLog {
  file: string
  /** 把某窗口的渲染 console 接入日志 */
  attachWindow: (wc: WebContents) => void
}

/**
 * 初始化文件日志。返回 { file, attachWindow }。
 * 可在 app ready 前调用（只要 app.getPath 可用）。
 */
export function initFileLog(): FileLog {
  if (_file) {
    // 已初始化：仅把新窗口接上即可
    return { file: _file, attachWindow }
  }
  _file = logPath()

  // 1) 主进程 console 重定向（保留原 console 供 dev stdout 观看）
  const wrap = (orig: (...a: unknown[]) => void, level: 'log' | 'warn' | 'error'): ((...a: unknown[]) => void) => {
    return (...a: unknown[]) => {
      try {
        orig(...a)
      } catch { /* 忽略 */ }
      write(`[main:${level}] ${fmtArgs(a)}`)
    }
  }
  // 用最简单的劫持：不改 console 对象（避免被 webpack/babel 缓存破坏），
  // 而是把所有 console 调用点视为已存在——这里仅包装本文件可见的方法。
  // 更稳妥做法：直接覆盖 console.*（渲染层无影响，主进程安全）。
  const origLog = console.log.bind(console)
  const origWarn = console.warn.bind(console)
  const origError = console.error.bind(console)
  console.log = wrap(origLog, 'log')
  console.warn = wrap(origWarn, 'warn')
  console.error = wrap(origError, 'error')

  // 2) 崩溃/异常兜底标记
  process.on('uncaughtException', (e) => {
    write(`[main:uncaughtException] ${e?.stack ?? String(e)}`)
  })
  process.on('unhandledRejection', (r) => {
    write(`[main:unhandledRejection] ${String(r)}`)
  })
  // GPU/子进程崩溃（renderer/gpu/utility）
  app.on('child-process-gone', (_e, details) => {
    write(`[child-process-gone] type=${details.type} name=${details.name} reason=${details.reason} exitCode=${details.exitCode} serviceName=${details.serviceName ?? ''}`)
  })
  process.on('exit', (code) => {
    write(`[main:exit] code=${code}`)
  })
  // 应用级崩溃(crash)回调（Windows 用 app.on('render-process-gone') 已有；进程崩溃前 flush 尽力）
  write(`--- avnext log start pid=${process.pid} electron=${process.versions.electron} ---`)
  console.log(`[logFile] 日志文件: ${_file}`)
  return { file: _file, attachWindow }
}

/** 把一个窗口的渲染进程 console + 崩溃接入日志 */
function attachWindow(wc: WebContents): void {
  if (!wc || wc.isDestroyed()) return
  try {
    // console-message 事件签名跨 Electron 版本不同：新版本为 (event, {level,message,lineNumber,...})
    // 兼容处理两种。
    wc.on('console-message', (...args: unknown[]) => {
      const ev = args[1] as { level?: number | string; message?: string } | undefined
      let levelNum = typeof args[1] === 'number' ? (args[1] as number) : -1
      let message: string = ''
      if (ev && typeof ev === 'object' && 'message' in ev) {
        message = String(ev.message ?? '')
        const lv = ev.level
        if (typeof lv === 'number') levelNum = lv
        else if (lv === 'info') levelNum = 1
        else if (lv === 'warning') levelNum = 2
        else if (lv === 'error') levelNum = 3
        else levelNum = 1
      } else {
        message = String(args[1] ?? '')
      }
      const tag = levelNum >= 3 ? 'ERR' : levelNum === 2 ? 'WARN' : 'LOG'
      write(`[render:${tag}] ${message}`)
    })
    // 渲染进程崩溃 / GPU 崩溃
    wc.on('render-process-gone', (_e, details) => {
      write(`[render-process-gone] reason=${details.reason} exitCode=${details.exitCode}`)
    })
    // GPU 进程崩溃（WebGL CONTEXT_LOST 根源）：webContents 上无 direct，但 console 会带；此处附 app 级已由 child-process-gone 覆盖。
    wc.on('gpu-process-crashed', () => {
      write(`[render:gpu-process-crashed] WebGL context lost 需重建`)
    })
  } catch {
    /* 忽略 attach 失败 */
  }
}

/** 格式化 console 参数为单行文本 */
function fmtArgs(a: unknown[]): string {
  return a
    .map((x) => {
      try {
        if (typeof x === 'string') return x
        if (x instanceof Error) return x.stack ?? x.message
        return JSON.stringify(x)
      } catch {
        return String(x)
      }
    })
    .join(' ')
    .slice(0, 4000)
}

/** 追加写日志（同步，失败静默） */
function write(line: string): void {
  if (!_file) return
  const ts = new Date().toISOString()
  try {
    appendFileSync(_file, `[${ts}] ${line}\n`)
  } catch {
    /* 忽略写失败 */
  }
}
