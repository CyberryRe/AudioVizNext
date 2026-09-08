/**
 * mbExport.ts —— 导出编排（**主线程**）+ Worker 通信。
 *
 * 分工（与 Elah `exportVideo.ts` 同构）：
 *  - 主线程：音频混音（`OfflineAudioContext`/`decodeAudioData` 仅在主线程可用）→ PCM transfer 进 Worker；
 *    进度转发、取消、以及把 Worker 推来的 MP4 字节写盘（Worker 没有 preload API）。
 *  - Worker（`mbExportWorker.ts`）：逐帧 resolveTimeline → 2D 绘制 → mediabunny `CanvasSource` 编码
 *    → `Mp4OutputFormat` 复用（进程内，无 ffmpeg、无逐帧 IPC 送块）。
 *
 * 渲染几何仍来自本仓 `layout.ts` + `drawTextLayer.ts`，与预览同源，保证「导出 = 预览」。
 */
import type { Project } from '../model/timeline'
import type { ExportResult } from '../../../main/export'
import { contentTotalFrames, type ExportProgress } from './exportTypes'
import { analyzePcm } from '../media/audioAnalysis'
import type { WorkerAudioMix, WorkerStartMessage } from './mbExportWorker'

export interface MbExportRequest {
  project: Project
  outPath: string
  /** 视频码率（默认 20Mbps） */
  bitrate?: number
  onProgress?: (p: ExportProgress) => void
  /** 返回 true 则中止导出 */
  onCancel?: () => boolean
}

type WorkerOutMessage =
  | { type: 'progress'; progress: ExportProgress }
  | { type: 'done'; frames: number; wallMs: number }
  | { type: 'error'; message: string }
  | { type: 'log'; line: string }
  | { type: 'write'; id: number; data: Uint8Array; position: number }

/** 主线程离线混音 → 可转移的 planar Float32 PCM。 */
async function renderAudioMix(project: Project, fps: number, totalFrames: number): Promise<WorkerAudioMix | null> {
  const audioTracks = project.tracks.filter((t) => t.kind === 'audio')
  const anySolo = audioTracks.some((t) => t.solo)
  const enabled = new Set(audioTracks.filter((t) => !t.disabled && (!anySolo || t.solo) && !t.muted).map((t) => t.id))
  const clips = Object.values(project.clips).flat().filter((c) => c.type === 'audio' && c.src && !c.disabled && enabled.has(c.trackId))
  if (clips.length === 0) return null

  const sampleRate = 48000
  const totalSec = totalFrames / fps
  const ctx = new OfflineAudioContext(2, Math.ceil(sampleRate * totalSec), sampleRate)

  const decodedBySrc = new Map<string, Promise<AudioBuffer>>()
  const decodeOnce = (src: string): Promise<AudioBuffer> => {
    let p = decodedBySrc.get(src)
    if (!p) {
      p = fetch(src)
        .then((r) => {
          if (!r.ok) throw new Error(`fetch ${r.status}`)
          return r.arrayBuffer()
        })
        .then((buf) => ctx.decodeAudioData(buf))
      decodedBySrc.set(src, p)
    }
    return p
  }

  for (const clip of clips) {
    try {
      const decoded = await decodeOnce(clip.src!)
      const node = ctx.createBufferSource()
      node.buffer = decoded
      const gain = ctx.createGain()
      gain.gain.value = clip.volume ?? 1
      node.connect(gain).connect(ctx.destination)
      node.start(clip.startFrame / fps, (clip.sourceStartFrame ?? 0) / fps, clip.durationFrames / fps)
    } catch (e) {
      console.warn(`[mbExport] 音频 clip 跳过（解码失败）: ${String((e as Error)?.message ?? e)} src=${clip.src?.slice(-48)}`)
    }
  }
  const mixed = await ctx.startRendering()
  const channels: ArrayBuffer[] = []
  const planar: Float32Array[] = []
  for (let c = 0; c < mixed.numberOfChannels; c++) {
    const ch = new Float32Array(mixed.getChannelData(c))
    planar.push(ch)
    channels.push(ch.buffer)
  }
  // 逐帧音频分析（波形/频谱/电平/发射前缀）：可视化预设的驱动信号（导出与预览共用同一份）
  const analysis = analyzePcm(planar, sampleRate, fps, totalFrames)
  return {
    sampleRate,
    numberOfChannels: mixed.numberOfChannels,
    length: mixed.length,
    channels,
    analysis
  }
}

/**
 * 执行导出。返回 ExportResult（与旧 runExport 同型，UI/测试台可直接替换）。
 */
export async function runMbExport(req: MbExportRequest): Promise<ExportResult> {
  const { project, outPath } = req
  const fps = project.fps || 30
  const totalFrames = contentTotalFrames(project)
  if (totalFrames < 1) return { ok: false, error: '时间轴没有可导出的内容' }
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return { ok: false, error: '当前环境不支持 Worker/OffscreenCanvas，无法导出' }
  }
  if (typeof window.api?.mbBegin !== 'function') return { ok: false, error: '导出不可用（缺少宿主 API）' }

  // 1) 音频混音（主线程）
  let audio: WorkerAudioMix | null = null
  try {
    audio = await renderAudioMix(project, fps, totalFrames)
  } catch (e) {
    console.warn('[mbExport] 音频混音失败，改为仅视频导出：', (e as Error)?.message)
    audio = null
  }

  // 2) 打开输出文件
  if (!(await window.api.mbBegin(outPath))) return { ok: false, error: `无法创建输出文件：${outPath}` }

  // 3) Worker 导出
  const worker = new Worker(new URL('./mbExportWorker.ts', import.meta.url), { type: 'module' })
  try {
    return await new Promise<ExportResult>((resolve) => {
      let settled = false
      const finish = (r: ExportResult): void => {
        if (settled) return
        settled = true
        clearInterval(cancelTimer)
        try { worker.terminate() } catch { /* 忽略 */ }
        // 先关文件再 resolve：保证调用方（UI/测试台）拿到的文件已完整落盘
        void window.api.mbEnd(outPath).then(() => resolve(r))
      }
      const cancelTimer = setInterval(() => {
        if (req.onCancel?.()) worker.postMessage({ type: 'cancel' })
      }, 250)

      worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
        const msg = e.data
        if (msg.type === 'progress') {
          req.onProgress?.(msg.progress)
        } else if (msg.type === 'log') {
          console.log(msg.line)
        } else if (msg.type === 'write') {
          // Worker 无 preload API：由主线程代写（随机偏移写盘）
          void window.api
            .mbWrite(outPath, msg.data, msg.position)
            .then((ok) => worker.postMessage({ type: 'writeDone', id: msg.id, ok }))
            .catch(() => worker.postMessage({ type: 'writeDone', id: msg.id, ok: false }))
        } else if (msg.type === 'done') {
          console.log(`[mbExport] 导出完成：${msg.frames} 帧 / ${(msg.wallMs / 1000).toFixed(1)}s`)
          finish({ ok: true, outPath, frames: msg.frames, durationSec: totalFrames / fps })
        } else if (msg.type === 'error') {
          console.error('[mbExport] Worker 导出失败:', msg.message)
          finish({ ok: false, error: msg.message })
        }
      }
      worker.onerror = (e: ErrorEvent) => {
        finish({ ok: false, error: `导出 Worker 崩溃: ${e.message || 'unknown'}` })
      }

      const start: WorkerStartMessage = { type: 'start', project, outPath, bitrate: req.bitrate ?? 20_000_000, audio }
      const transfer: Transferable[] = audio ? [...audio.channels] : []
      if (audio?.analysis) {
        transfer.push(
          audio.analysis.wave.buffer as ArrayBuffer,
          audio.analysis.freq.buffer as ArrayBuffer,
          audio.analysis.level.buffer as ArrayBuffer,
          audio.analysis.spawnPrefix.buffer as ArrayBuffer
        )
      }
      worker.postMessage(start, transfer)
      console.log(`[mbExport] 开始导出：${totalFrames} 帧 @${fps}fps，音频=${audio ? `${audio.numberOfChannels}ch` : '无'}`)
    })
  } catch (e) {
    try { worker.terminate() } catch { /* 忽略 */ }
    await window.api.mbEnd(outPath)
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}
