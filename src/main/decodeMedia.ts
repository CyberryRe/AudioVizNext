/**
 * decodeMedia.ts —— 主进程：把视频源"拆成 H.264 Annex-B 裸流"，供渲染层 WebCodecs 预解码。
 *
 * 背景（参考 elah 用 mediabunny 在浏览器拆包；我们用现成 ffmpeg 在主进程拆，零新 WASM）：
 *  Chromium `VideoDecoder`(WebCodecs) 吃 H.264 Annex-B 字节流 + codec 串/description。
 *  一个容器(MP4/MOV…)内的视频轨通常是 avcC(avc1)，不是 Annex-B —— 需先 `-bsf:v h264_mp4toannexb`
 *  转成一根 .h264 裸流。此模块用 ffmpeg 把源视频轨**无损(流拷贝)抽**成临时 ES 文件，并返回元数据，
 *  渲染层据此：建 AU 索引(esUtils)、经 avn-file:// Range 读回分段字节、喂 WebCodecs。
 *
 * 约束与取舍：
 *  - 仅对"视频轨为 H.264(AVC)"的源开 WebCodecs 预解码路径；HEVC/VP9/AV1 等因本仓解码器只按
 *    avc1 处理而回退现有 `<video>`（不改既有一条路）。
 *  - 无损拷贝(不重编码)因此极快(接近文件复制速率)，解码交由 WebCodecs 硬件/软件。
 *  - 抽出的 ES 写系统临时目录，按源绝对路径哈希缓存（会话内复用；应用退出清理遗留）。
 */

import { app } from 'electron'
import { spawn, execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { join } from 'path'
import { existsSync, statSync, mkdirSync, rmSync, readFileSync } from 'fs'
import { ffmpegPath, ffprobePath } from './mediaCache'

/** WebCodecs 解码所需元数据 */
export interface DecodeMediaMeta {
  /** 临时 .h264 ES 文件绝对路径 */
  esPath: string
  /** ES 字节长度 */
  esLen: number
  /** 源视频帧率（秒→源帧换算用）；可能为 0 */
  sourceFps: number
  width: number
  height: number
  /** 视频轨时长(秒) */
  durationSec: number
}

/** 主进程 decode 缓存目录（会话级临时，非 MediaCache 永久缓存） */
let _tmpRoot: string | null = null
function tmpRoot(): string {
  if (_tmpRoot) return _tmpRoot
  _tmpRoot = join(app.getPath('temp'), 'avnex_decode')
  mkdirSync(_tmpRoot, { recursive: true })
  return _tmpRoot
}

const keyed = new Map<string, string>() // src abs → esPath（会话内命中避免重复 demux）

function esKey(src: string): string {
  return 'es_' + createHash('sha1').update(src).digest('hex').slice(0, 16) + '.h264'
}

interface ProbedInfo {
  codec: string
  width: number
  height: number
  fps: number
  durationSec: number
}

/** 用 ffprobe 探测源视频轨编码信息（含编码器名）。 */
function probeVideo(ffprobe: string, src: string): ProbedInfo | null {
  try {
    const raw = execFileSync(ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,r_frame_rate,avg_frame_rate,duration',
      '-show_entries', 'format=duration',
      '-of', 'json', src
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
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
    return {
      codec: String(st?.codec_name ?? ''),
      width: st?.width ? +st.width : 0,
      height: st?.height ? +st.height : 0,
      fps: parseRate(st?.r_frame_rate) || parseRate(st?.avg_frame_rate),
      durationSec: Number.parseFloat(fmt?.duration ?? st?.duration ?? '0') || 0
    }
  } catch (e) {
    console.warn('[DecodeMedia] ffprobe failed:', src, (e as Error).message)
    return null
  }
}

/**
 * 把源视频轨拆成 H.264 Annex-B 临时 ES；返回元数据。仅当源为 H.264 且 ffmpeg 可用。
 * 会话内对同一源只 demux 一次（命中缓存）。失败返回 null（调用方回退 <video>）。
 */
export function demuxSourceToEs(src: string): Promise<DecodeMediaMeta | null> {
  return new Promise((resolve) => {
    if (!src || !existsSync(src)) return resolve(null)
    const ff = ffmpegPath()
    const ffprobe = ffprobePath()
    if (!ff) return resolve(null)

    // 会话内缓存命中（不重复 demux）
    const hit = keyed.get(src)
    if (hit && existsSync(hit)) {
      const st = statSync(hit)
      const probe = ffprobe ? probeVideo(ffprobe, src) : null
      return resolve({
        esPath: hit, esLen: st.size,
        sourceFps: probe?.fps ?? 0, width: probe?.width ?? 0, height: probe?.height ?? 0,
        durationSec: probe?.durationSec ?? 0
      })
    }

    // 探测确认 H.264（AVC）才走预解码路径
    const probe = ffprobe ? probeVideo(ffprobe, src) : null
    if (!probe || !/^h264$/i.test(probe.codec)) {
      return resolve(null) // 非 H.264 → 回退 <video>
    }

    const esPath = join(tmpRoot(), esKey(src))
    // 已存在同文件（上轮崩溃残留）先清
    if (existsSync(esPath)) { try { rmSync(esPath, { force: true }) } catch { /* 忽略 */ } }

    const child = spawn(ff, [
      '-y', '-v', 'error',
      '-i', src,
      '-map', '0:v:0',
      '-an',
      '-c:v', 'copy',
      '-bsf:v', 'h264_mp4toannexb',
      '-f', 'h264',
      esPath
    ], { windowsHide: true })
    let err = ''
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', (e) => { console.error('[DecodeMedia] ffmpeg error:', e.message); resolve(null) })
    child.on('close', (code) => {
      if (code !== 0 || !existsSync(esPath)) {
        console.warn('[DecodeMedia] demux failed:', src, 'code', code, err.slice(-300))
        return resolve(null)
      }
      const st = statSync(esPath)
      keyed.set(src, esPath)
      console.log(`[DecodeMedia] demuxed ${probe.width}x${probe.height} @${probe.fps.toFixed?.(2) ?? probe.fps}fps → ES ${(st.size / 1048576).toFixed(1)}MB (${src})`)
      resolve({
        esPath, esLen: st.size,
        sourceFps: probe.fps ?? 0, width: probe.width, height: probe.height,
        durationSec: probe.durationSec ?? 0
      })
    })
  })
}

/** 供 preload/渲染层读取临时 ES 文件（受限，仅返回已知 demux 产出的文件） */
export function readEsBytes(esPath: string, start: number, end: number): Uint8Array | null {
  try {
    const abs = esPath.startsWith('avn-file://') ? decodeURIComponent(new URL(esPath).hostname) : esPath
    const st = statSync(abs)
    if (!st.isFile()) return null
    const s = Math.max(0, start)
    const e = Math.min(end, st.size)
    if (s >= e) return new Uint8Array(0)
    const buf = readFileSync(abs)
    return new Uint8Array(buf.buffer, buf.byteOffset + s, e - s)
  } catch {
    return null
  }
}
