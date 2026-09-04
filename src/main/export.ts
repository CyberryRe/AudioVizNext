/**
 * export.ts —— 主进程导出（渲染层逐帧送原始像素(NV12/PNG) → ffmpeg 编码视频 + 音频混流 → 最终 MP4）。
 *
 * 职责（三段式，用系统临时文件中间产物，稳定清晰）：
 *  1) 视频编码：ffmpeg 从 stdin 读像素流（pixelInput:'nv12' → rawvideo nv12 直读；'png' → image2pipe）
 *     → H.264/MP4（纯画面，无音轨）
 *  2) 音频混流：若工程含音频 clip，用另一条 ffmpeg 按各 clip 的 start/duration/volume
 *     （尊重 muted/disabled/solo）adelay+volume+amix → AAC 临时文件
 *  3) 最终合成：mux 视频+音频 → 用户选择的 outPath
 *
 * 会话态存模块级（一次只允许一个导出任务；多次 begin 会先结束上一个）。
 */

import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ffmpegPath, hasFfmpeg } from './mediaCache'
import { injectSpsTiming } from './spsInjector'
import { loadPreferences, type ExportDevicePref } from './preferences'

/** 一个音频 clip 的参与信息（由渲染层解析，尊重 mute/solo/disabled） */
export interface AudioClipInput {
  /** 源音频文件绝对路径（ffmpeg 直接读） */
  path: string
  /** 时间轴起始帧（决定 adelay） */
  startFrame: number
  /** 时间轴结束帧（半开） */
  endFrame: number
  /** 素材内起始帧（决定 atrim 起点） */
  sourceStartFrame: number
  /** clip 音量 0..1（已含轨 muted 置 0） */
  volume: number
}

export interface ExportVideoParams {
  /** 最终输出文件绝对路径（.mp4） */
  outPath: string
  width: number
  height: number
  fps: number
  /** 要编码的视频帧总数（= 导出区间的帧数） */
  totalFrames: number
  /**
   * 渲染层逐帧喂给 stdin 的像素格式：
   *  - 'png'（默认，兼容旧路径）：ffmpeg image2pipe 逐帧解码 PNG；
   *  - 'nv12'：ffmpeg rawvideo 直读 NV12（免 PNG 编码/解码，传输量较 RGBA 少 62.5%，
   *    硬编/软编均原生接受，免 swscale）。渲染层须送 W*H*1.5 字节/帧。
   */
  pixelInput?: 'png' | 'nv12'
}

export interface ExportResult {
  ok: boolean
  outPath?: string
  frames?: number
  durationSec?: number
  error?: string
}

interface Session {
  child: ChildProcess
  stdin: NodeJS.WritableStream | null
  params: ExportVideoParams
  tempVideo: string
  tempAudio: string | null
  received: number
  broken: boolean
  closed: boolean
  childErr: string
}

let session: Session | null = null

function tmpPath(prefix: string, ext: string): string {
  return join(tmpdir(), `avnexport_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`)
}

function ensureDirFor(path: string): string {
  return path
}

/**
 * 探测一个编码器在本机能否初始化。失败=驱动/运行时不支持。
 * ⚠ 测试分辨率必须用真实尺寸(如 1920×1080)：NVENC 有最小帧尺寸(~145px)，
 *   拿 64×64 去试会报 "Frame Dimension less than minimum" 而被误判成"驱动不支持"。
 */
export function probeHwEncoder(enc: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ff = ffmpegPath()
    if (!ff) return resolve(false)
    const child = spawn(
      ff,
      ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=30:d=0.1', '-frames:v', '1',
        '-c:v', enc, '-pix_fmt', 'yuv420p', '-f', 'null', '-'],
      { windowsHide: true }
    )
    let err = ''
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', () => resolve(false))
    child.on('close', (code) => {
      if (code !== 0) console.warn(`[Export] 编码器 ${enc} 不可用(exit ${code}): ${err.slice(-300)}`)
      resolve(code === 0)
    })
  })
}

/** 按导出设备偏好给出编码器探测链。 */
function encoderChain(pref: ExportDevicePref): string[] {
  switch (pref) {
    case 'discrete': return ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264']
    case 'integrated': return ['h264_qsv', 'h264_nvenc', 'h264_amf', 'libx264']
    case 'software': return ['libx264']
    default: return ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264']
  }
}

/** 挑选最快的可用视频编码器（按设备偏好排序；按偏好缓存）。 */
const _encCache = new Map<string, Promise<string>>()
function pickVideoEncoder(pref: ExportDevicePref): Promise<string> {
  const hit = _encCache.get(pref)
  if (hit) return hit
  const p = (async () => {
    for (const enc of encoderChain(pref)) {
      if (enc === 'libx264') return enc
      if (await probeHwEncoder(enc)) return enc
    }
    return 'libx264' // 理论不可达，保险兜底
  })()
  _encCache.set(pref, p)
  return p
}

/** 该编码会话的 ffmpeg 参数（硬编给出稳定码率档，软编 crf 控质量）。 */
function videoEncodeArgs(params: ExportVideoParams, tempVideo: string, enc: string): string[] {
  const pixel = params.pixelInput === 'nv12' ? 'nv12' : 'png'
  let base: string[]
  if (pixel === 'nv12') {
    // rawvideo 直读 NV12（每帧 W*H*1.5 字节，无帧边界标记，按字节数定帧——喂帧切块任意都安全）
    base = [
      '-y',
      '-f', 'rawvideo',
      '-pix_fmt', 'nv12',
      '-s', `${params.width}x${params.height}`,
      '-framerate', String(params.fps),
      '-i', 'pipe:0'
    ]
  } else {
    base = [
      '-y',
      '-f', 'image2pipe',
      '-framerate', String(params.fps),
      '-c:v', 'png',
      '-i', 'pipe:0'
    ]
  }
  if (enc === 'h264_nvenc') {
    base.push(
      '-c:v', 'h264_nvenc',
      '-preset', 'p5',
      '-rc', 'vbr', '-cq', '23', '-b:v', '12M', '-maxrate', '18M', '-bufsize', '24M',
      '-pix_fmt', 'yuv420p'
    )
  } else if (enc === 'h264_qsv') {
    base.push('-c:v', 'h264_qsv', '-global_quality', '22', '-pix_fmt', 'yuv420p')
  } else if (enc === 'h264_amf') {
    base.push('-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '22', '-pix_fmt', 'yuv420p')
  } else {
    base.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p')
  }
  base.push('-movflags', '+faststart')
  base.push(tempVideo)
  return base
}

/** 开始一个视频编码会话（spawn ffmpeg，等待渲染层逐帧送 PNG）。异步：先探测选用硬编。 */
export async function beginVideoEncoding(params: ExportVideoParams): Promise<{ ok: boolean; error?: string; encoder?: string }> {
  // 只能同时一个导出任务
  if (session) {
    try { session.child.kill('SIGKILL') } catch { /* 忽略 */ }
    session = null
  }
  if (!params || !params.outPath) return { ok: false, error: '缺少输出路径' }
  if (!hasFfmpeg()) return { ok: false, error: '未找到可用 ffmpeg，无法导出' }
  if (params.width < 16 || params.height < 16 || params.fps < 1) {
    return { ok: false, error: '导出分辨率/帧率不合法' }
  }

  const enc = await pickVideoEncoder(loadPreferences().exportDevice)
  const ff = ffmpegPath()!
  const tempVideo = tmpPath('video', 'mp4')
  const args = videoEncodeArgs(params, tempVideo, enc)

  const child = spawn(ff, args, { windowsHide: true })
  let err = ''
  child.stderr.on('data', (d: Buffer) => { err += d.toString() })
  child.on('error', (e) => {
    console.error('[Export] ffmpeg video error:', e.message)
    const s = session
    if (s) { s.broken = true; s.childErr = e.message }
  })

  session = {
    child,
    stdin: child.stdin,
    params,
    tempVideo,
    tempAudio: null,
    received: 0,
    broken: false,
    closed: false,
    childErr: ''
  }

  return { ok: true, encoder: enc }
}

/**
 * 写一帧到 ffmpeg stdin（renderer 逐帧调用；顺序保证 + 背压由 IPC 往返自然提供）。
 * 字节含义取决于 begin 时的 pixelInput：'png' → 一帧 PNG；'nv12' → 一帧 W*H*1.5 的 NV12。
 */
export function writeVideoFrame(pngBytes: Uint8Array): { ok: boolean; error?: string } {
  const s = session
  if (!s) return { ok: false, error: '导出未开始' }
  if (s.broken) return { ok: false, error: s.childErr || 'ffmpeg 已中止' }
  try {
    s.stdin?.write(Buffer.from(pngBytes))
    s.received++
    return { ok: true }
  } catch (e) {
    s.broken = true
    return { ok: false, error: String((e as Error).message) }
  }
}

/** 结束视频编码，并按需混音频 + 合成最终文件。返回结果。 */
export function finishExport(audio: AudioClipInput[]): Promise<ExportResult> {
  return new Promise<ExportResult>((resolve) => {
    const s = session
    if (!s) return resolve({ ok: false, error: '导出未开始' })
    session = null
    const params = s.params

    const done = (r: ExportResult): void => {
      // 清理临时文件
      for (const p of [s.tempVideo, s.tempAudio]) {
        if (p) { try { if (existsSync(p)) unlinkSync(p) } catch { /* 忽略 */ } }
      }
      resolve(r)
    }

    const finishVideo = (): void => {
      s.child.stdin?.end()
      // 等 ffmpeg 关闭视频输出
      s.child.on('close', (code) => {
        if (code !== 0) {
          return done({ ok: false, error: `视频编码退出码 ${code}（${s.childErr}）` })
        }
        const vstat = existsSync(s.tempVideo) ? statSync(s.tempVideo) : null
        if (!vstat || vstat.size === 0) {
          return done({ ok: false, error: '视频编码产出为空' })
        }
        // 有音频 clip → 混音频再合成；否则直接把纯视频 remux 到最终路径
        if (audio && audio.length > 0) {
          void buildAudioAndMux(s, audio).then(done)
        } else {
          void remuxVideoOnly(s).then(done)
        }
      })
      s.child.stdin?.on('error', () => { /* stdin 关闭噪声，忽略 */ })
    }

    // 若已有 error 事件置 broken，可能 pipe 已死
    if (s.broken) {
      return done({ ok: false, error: s.childErr || 'ffmpeg 已中止' })
    }
    finishVideo()
  })
}

/** 纯视频：把临时视频文件复制/转封装到最终路径。 */
async function remuxVideoOnly(s: Session): Promise<ExportResult> {
  const ff = ffmpegPath()!
  return runFfmpeg(ff, [
    '-y',
    '-i', s.tempVideo,
    '-c', 'copy',
    '-movflags', '+faststart',
    s.params.outPath
  ]).then((ok) =>
    ok
      ? { ok: true, outPath: s.params.outPath, frames: s.received, durationSec: s.received / s.params.fps }
      : { ok: false, error: '视频转封装失败' }
  )
}

/** 混音频（含 video+audio 最终合成到一个输出）。 */
async function buildAudioAndMux(s: Session, audio: AudioClipInput[]): Promise<ExportResult> {
  const ff = ffmpegPath()!
  const fps = s.params.fps
  // 过滤源文件不存在的音频输入
  const clips = audio.filter((a) => a.path && existsSync(a.path))
  if (clips.length === 0) {
    return remuxVideoOnly(s)
  }

  const args: string[] = ['-y']
  // 视频输入
  args.push('-i', s.tempVideo)
  // 各音频输入
  const inputs = clips.map((c) => c.path)
  for (const p of inputs) args.push('-i', p)

  // filter_complex：每 clip atrim 素材内窗口 → volume → adelay 到时间轴位置 → 转立体声 → amix
  const totalSec = s.params.totalFrames / fps
  const parts: string[] = []
  const amixInputs: string[] = []
  clips.forEach((c, idx) => {
    const inIdx = idx + 1 // 0 是视频
    const srcSec = c.sourceStartFrame / fps
    const clipDurSec = (c.endFrame - c.startFrame) / fps
    const delayMs = Math.round((c.startFrame / fps) * 1000)
    const trim = `[${inIdx}:a]atrim=start=${srcSec.toFixed(3)}:duration=${clipDurSec.toFixed(3)},asetpts=PTS-STARTPTS`
    const vol = `volume=${c.volume.toFixed(3)}`
    const delay = `adelay=${delayMs}:all=1`
    const aformat = `aformat=sample_rates=48000:channel_layouts=stereo`
    const label = `[ac${idx}]`
    parts.push(`${trim},${vol},${delay},${aformat}${label}`)
    amixInputs.push(label)
  })
  const mix = `amix=inputs=${clips.length}:normalize=0:dropout_transition=0`
  // amix 输出匿名流，直接续接 atrim 截断到视频总长；最终命名 [aout]
  const finalTrim = `atrim=0:${totalSec.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo`
  const graph = `${parts.join(';')};${amixInputs.join('')}${mix},${finalTrim}[aout]`
  args.push('-filter_complex', graph)
  args.push('-map', '0:v')
  args.push('-map', '[aout]')
  args.push('-c:v', 'copy')
  args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000')
  args.push('-movflags', '+faststart')
  args.push(s.params.outPath)

  return runFfmpeg(ff, args).then((ok) =>
    ok
      ? { ok: true, outPath: s.params.outPath, frames: s.received, durationSec: totalSec }
      : { ok: false, error: '音频混流/合成失败' }
  )
}

/** 运行一条 ffmpeg（无 stdin），返回是否成功并打印尾部错误。 */
function runFfmpeg(ff: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(ff, args, { windowsHide: true })
    let err = ''
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', (e) => { console.error('[Export] ffmpeg error:', e.message); resolve(false) })
    child.on('close', (code) => {
      if (code === 0) resolve(true)
      else {
        console.error('[Export] ffmpeg failed:\n' + err.slice(-1200))
        resolve(false)
      }
    })
  })
}

export function hasFfmpegExport(): boolean {
  return hasFfmpeg()
}

// ===== Annexb 复用路径（渲染层 WebCodecs 硬编裸流 → ffmpeg -c:v copy 只 mux，参考旧项目 muxer）=====

/**
 * 开始 annexb 复用会话：渲染层把 WebCodecs VideoEncoder 的 H.264 Annex-B 裸流写入 stdin，
 * ffmpeg `-f h264 -i pipe:0 -c:v copy` 无损复用为临时 mp4（零重编码，比 rawvideo+NVENC 快得多）。
 * 音频混流仍复用 finishExport 的 buildAudioAndMux（-c:v copy）。
 */
export function beginAnnexbMux(params: ExportVideoParams): { ok: boolean; error?: string } {
  if (session) {
    try { session.child.kill('SIGKILL') } catch { /* 忽略 */ }
    session = null
  }
  if (!params || !params.outPath) return { ok: false, error: '缺少输出路径' }
  if (!hasFfmpeg()) return { ok: false, error: '未找到可用 ffmpeg，无法导出' }
  if (params.width < 16 || params.height < 16 || params.fps < 1) {
    return { ok: false, error: '导出分辨率/帧率不合法' }
  }

  const ff = ffmpegPath()!
  const tempVideo = tmpPath('video', 'mp4')
  const args = [
    '-y',
    '-f', 'h264',
    '-framerate', String(params.fps),
    '-i', 'pipe:0',
    '-c:v', 'copy',
    '-movflags', '+faststart',
    tempVideo
  ]

  const child = spawn(ff, args, { windowsHide: true })
  let err = ''
  child.stderr.on('data', (d: Buffer) => { err += d.toString() })
  child.on('error', (e) => {
    console.error('[Export] ffmpeg annexb error:', e.message)
    const s = session
    if (s) { s.broken = true; s.childErr = e.message }
  })

  session = {
    child,
    stdin: child.stdin,
    params,
    tempVideo,
    tempAudio: null,
    received: 0,
    broken: false,
    closed: false,
    childErr: ''
  }

  return { ok: true }
}

/** 写一块 annexb 裸流（WebCodecs 编码 chunk），写前注入 SPS VUI timing（否则只写前 ~50 帧）。 */
export function writeAnnexbChunk(bytes: Uint8Array): { ok: boolean; error?: string } {
  const s = session
  if (!s) return { ok: false, error: '导出未开始' }
  if (s.broken) return { ok: false, error: s.childErr || 'ffmpeg 已中止' }
  try {
    const data = injectSpsTiming(Buffer.from(bytes), s.params.fps)
    s.stdin?.write(data)
    s.received++
    return { ok: true }
  } catch (e) {
    s.broken = true
    return { ok: false, error: String((e as Error).message) }
  }
}
