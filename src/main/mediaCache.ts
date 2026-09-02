/**
 * MediaCache —— 参考 Pr(Premiere Pro)「媒体缓存」的转码代理服务（主进程）。
 *
 * 动机：
 *  - 原始素材（尤其高码率/异型编码的 MOV/AVI/ProRes/HEVC）Chromium `<video>` 在 WebGL
 *    下解码可能慢、不稳，甚至某些帧拿不到；Pr 的做法是把素材转成"编辑友好"的代理文件
 *    放进独立缓存目录，编辑/预览都走代理，既稳定又快。
 *  - 本服务把视频素材转码为 H.264(AVC)/yuv420p 的 MP4 代理，缓存到
 *    `<userData>/MediaCache/<key>/proxy.mp4`，以"源绝对路径"为键（同源跨工程复用缓存）。
 *
 * 关键点：
 *  - 纯 Node + child_process（无第三方转码依赖），靠系统/可配置的 ffmpeg/ffprobe。
 *  - ffmpeg 二进制解析顺序：env AVS_FFMPEG_PATH → 项目 bin/ffmpeg(.exe) → 常见系统路径
 *    (C:\Windows\ffmpeg.exe 等) → PATH where 命令。ffprobe 同理(AVS_FFPROBE_PATH)。
 *  - 转码带每源去重队列；完成/失败后向所有窗口广播 avs:mediaCache:ready。
 *  - 不阻塞渲染：ensure 立即返回状态(已缓存/转码中/无ffmpeg/缺失)，完成后由事件通知换源。
 */

import { app, BrowserWindow } from 'electron'
import { spawn, execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'fs'
import { join, basename } from 'path'

/** 转码代理产物结构 */
export interface ProxyMeta {
  original: string // 源绝对路径
  proxyPath: string // 代理 mp4 绝对路径
  durationSec: number
  fps: number
  width: number
  height: number
  createdAt: number
  fileSize: number
}

export type EnsureState =
  | 'cached' // 已有代理
  | 'transcoding' // 正在转码（后台）
  | 'queued' // 排队待转码
  | 'noffmpeg' // 无可用 ffmpeg，调用方回退原素材
  | 'missing' // 源文件不存在/无法访问
  | 'error' // 转码失败

export interface EnsureResult {
  state: EnsureState
  original: string
  proxy?: ProxyMeta
}

interface QueueEntry {
  original: string
  state: 'running' | 'queued'
}

// 转码中的源 → 入口（避免同一源并发转码）
const queue = new Map<string, QueueEntry>()

// 惰性解析的 ffmpeg/ffprobe 路径（null 表示已确认不可用）
let _ffmpeg: string | null | undefined
let _ffprobe: string | null | undefined

/** 递归确保目录存在 */
function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true })
  return p
}

/** 缓存根目录（userData/MediaCache） */
export function mediaCacheDir(): string {
  return ensureDir(join(app.getPath('userData'), 'MediaCache'))
}

/** 通用可执行文件定位：候选路径第一个存在者 */
function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

/** 解析 ffmpeg/ffprobe 二进制路径（解析顺序：显式 env → 项目内嵌 bin/ → packaged extraResources → 常见路径 → PATH） */
function resolveBin(kind: 'ffmpeg' | 'ffprobe'): string | null {
  const envVar = kind === 'ffmpeg' ? 'AVS_FFMPEG_PATH' : 'AVS_FFPROBE_PATH'
  const binName = kind === 'ffmpeg' ? 'ffmpeg' : 'ffprobe'
  const exe = process.platform === 'win32' ? `${binName}.exe` : binName
  const cache = kind === 'ffmpeg' ? _ffmpeg : _ffprobe
  if (cache !== undefined) return cache

  const candidates: string[] = []
  const env = process.env[envVar]
  if (env) candidates.push(env)
  // ① 项目内嵌 bin/（dev 与 `npm start`=electron-vite preview 均从 out/main 运行，
  //    __dirname=out/main，向上两级到工程根 → <root>/bin/ffmpeg(.exe)）。首选已知兼容版本。
  candidates.push(join(__dirname, '..', '..', 'bin', exe))
  // ② 已打包(asar)时 __dirname 在 asar 内读不到；从 resources 的 extraResources 找。
  candidates.push(join(process.resourcesPath, 'bin', exe))
  // ③ 兜底常见位置
  candidates.push(
    join(app.getPath('userData'), 'ffmpeg', exe),
    join('C:\\Windows', exe)
  )
  let found = firstExisting(candidates)

  // 仍未找到时回退 PATH（where / which）——但仅供兜底，正常应命中内嵌版本
  if (!found) {
    try {
      const out = execFileSync(
        process.platform === 'win32' ? 'where' : 'which',
        [binName],
        { encoding: 'utf8', windowsHide: true }
      )
      const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0)
      if (first) found = first
    } catch {
      found = null
    }
  }

  if (kind === 'ffmpeg') _ffmpeg = found
  else _ffprobe = found
  return found
}

/** 广播事件到所有窗口 */
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(channel, payload)
  }
}

/** 用 ffprobe 读视频基本信息（JSON 输出） */
function probeWithFfprobe(ffprobe: string, src: string): ProxyMeta['durationSec' | 'fps' | 'width' | 'height'] | null {
  try {
    const raw = execFileSync(
      ffprobe,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,duration',
        '-show_entries', 'format=duration',
        '-of', 'json',
        src
      ],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
    )
    const j = JSON.parse(raw)
    const st = j?.streams?.[0]
    const fmt = j?.format
    const parseRate = (s?: string): number => {
      if (!s) return 0
      const m = /^(\d+)\/(\d+)$/.exec(s.trim())
      if (m) { const d = +m[2]; return d ? +m[1] / d : 0 }
      const n = parseFloat(s)
      return Number.isFinite(n) ? n : 0
    }
    const dur = parseFloat(fmt?.duration ?? st?.duration ?? '0')
    return {
      durationSec: Number.isFinite(dur) && dur > 0 ? dur : 0,
      fps: parseRate(st?.r_frame_rate),
      width: st?.width ? +st.width : 0,
      height: st?.height ? +st.height : 0
    }
  } catch (e) {
    console.warn('[MediaCache] ffprobe failed:', src, (e as Error).message)
    return null
  }
}

// 代理格式版本：改动转码参数(如从 -an 改为保留音频轨)后 +1，令旧缓存目录名失效、强制重转，
// 否则已存在的无音频代理会一直被命中、听不到声。目录名拼在 cacheKey 里参与 key。
const PROXY_VERSION = 2

/** 缓存键目录名：源名 + 路径哈希（同源跨会话复用） */
function cacheKeyDir(src: string): string {
  const h = createHash('sha1').update(src).digest('hex').slice(0, 12)
  const base = basename(src).replace(/[^\w.\-]+/g, '_')
  return `v${PROXY_VERSION}_${base}_${h}`
}

/** 读取已缓存的 meta（存在且原路径一致则命中） */
function readMeta(metaPath: string, original: string): ProxyMeta | null {
  try {
    if (!existsSync(metaPath)) return null
    const m = JSON.parse(readFileSync(metaPath, 'utf8')) as ProxyMeta
    if (m.original !== original || !existsSync(m.proxyPath)) return null
    return m
  } catch {
    return null
  }
}

/**
 * 确保源视频已转码为代理。返回立即态；若需转码则后台执行，完成后广播
 * `avs:mediaCache:ready`，负载 { original, proxy }。
 */
export function ensureProxy(src: string): EnsureResult {
  if (!src) return { state: 'missing', original: src }
  // 源必须存在
  if (!existsSync(src)) return { state: 'missing', original: src }

  const ffmpeg = resolveBin('ffmpeg')
  if (!ffmpeg) return { state: 'noffmpeg', original: src }

  const dir = join(mediaCacheDir(), cacheKeyDir(src))
  ensureDir(dir)
  const proxyPath = join(dir, 'proxy.mp4')
  const metaPath = join(dir, 'meta.json')

  const cached = readMeta(metaPath, src)
  if (cached) return { state: 'cached', original: src, proxy: cached }

  // 已在转码/排队 → 不重复
  const q = queue.get(src)
  if (q) return { state: q.state === 'running' ? 'transcoding' : 'queued', original: src }

  queue.set(src, { state: 'queued' })
  // 异步启动转码（不 await，立即返回 queued/transcoding）
  void runTranscode(ffmpeg, src, proxyPath, metaPath, dir)
  return { state: 'queued', original: src }
}

/** 执行一次转码（含排队去重），结束清理队列并广播 */
async function runTranscode(
  ffmpeg: string,
  src: string,
  proxyPath: string,
  metaPath: string,
  dir: string
): Promise<void> {
  queue.get(src)!.state = 'running'
  const started = Date.now()
  try {
    await spawnFfmpeg(ffmpeg, src, proxyPath)
    // probe 源信息（fps/duration 等）
    const ffprobe = resolveBin('ffprobe')
    const info = ffprobe ? probeWithFfprobe(ffprobe, src) : null
    const st = existsSync(proxyPath) ? statSync(proxyPath) : null
    const meta: ProxyMeta = {
      original: src,
      proxyPath,
      durationSec: info?.durationSec ?? 0,
      fps: info?.fps ?? 0,
      width: info?.width ?? 0,
      height: info?.height ?? 0,
      createdAt: Date.now(),
      fileSize: st?.size ?? 0
    }
    writeFileSync(metaPath, JSON.stringify(meta, null, 2))
    console.log(`[MediaCache] transcoded OK ${Math.round((Date.now() - started) / 1000)}s: ${basename(src)}`)
    broadcast('avs:mediaCache:ready', { original: src, proxy: meta, error: null })
  } catch (e) {
    console.error('[MediaCache] transcode failed:', basename(src), (e as Error).message)
    broadcast('avs:mediaCache:ready', { original: src, proxy: null, error: String((e as Error).message) })
  } finally {
    queue.delete(src)
    // 失败时清掉可能残留的半成品
    if (!existsSync(metaPath) && existsSync(proxyPath)) {
      try { execFileSync(process.platform === 'win32' ? 'del' : 'rm', [proxyPath], { windowsHide: true }) } catch { /* 忽略 */ }
    }
  }
}

/** spawn ffmpeg 转码并等待退出 */
function spawnFfmpeg(ffmpeg: string, src: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 编辑友好代理：视频 H.264 / yuv420p / faststart；并保留音频(若源含音频轨则转 AAC)。
    // 背景视频的"原声"可经独立 <audio> 播放，同时纯音频 clip 也要能从该代理取到声音，
    // 因此必须保留音频流（此前 -an 丢弃了音频，导致 avn-file 源非原生编码经 Chromium
    // FFmpegDemuxer 解码失败 → PIPELINE_ERROR_READ / 无声）。
    const args = [
      '-y',
      '-i', src,
      '-map', '0:v:0?',
      '-map', '0:a:0?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-movflags', '+faststart',
      '-threads', '0',
      out
    ]
    const child = spawn(ffmpeg, args, { windowsHide: true })
    let err = ''
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', (e) => reject(e))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-500)}`))
    })
  })
}

/** 手动指定二进制（测试/自定义环境用）；返回是否两枚皆可用 */
export function setBinaries(ffmpeg: string | null, ffprobe: string | null): void {
  _ffmpeg = ffmpeg
  _ffprobe = ffprobe
}

export const ffmpegPath = (): string | null => resolveBin('ffmpeg')
export const ffprobePath = (): string | null => resolveBin('ffprobe')

export function hasFfmpeg(): boolean {
  return !!resolveBin('ffmpeg')
}

/**
 * 对外探测视频信息（供渲染层取真实帧率等元数据）。内部解析 ffprobe；不可用返回 null。
 */
export function probeVideo(src: string): ProxyMeta['durationSec' | 'fps' | 'width' | 'height'] | null {
  if (!src || !existsSync(src)) return null
  const ffp = resolveBin('ffprobe')
  if (!ffp) return null
  return probeWithFfprobe(ffp, src)
}
