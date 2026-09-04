/**
 * runExport.ts —— 渲染层导出编排（Canvas 2D 逐帧确定性渲染 → 编码 → 主进程 ffmpeg 合成）。
 *
 * 核心原则「导出 = 预览」：
 *  - 复用与预览完全相同的 scene 解析(resolveTimeline) 与 布局(layout.ts)，
 *    由一个 Canvas 2D 渲染器(Canvas2DExportRenderer)逐帧渲染（不做 WebGL 上传+回读两趟往返）；
 *  - 视频一律"暂停态精确钉帧"（绝不墙钟播放），得到的就是"播放头停在该帧时预览显示的那一帧"；
 *  - 输出区域 = 整幅 stage 画布 = 遮罩窗口里的内容；画布透明区合成到不透明黑底(标准合成语义)。
 *
 * 两条编码路径（参考旧项目 AudioViz Studio 的导出流水线）：
 *  - 快路径：WebCodecs VideoEncoder（优先 NVENC）编 H.264 Annex-B → IPC chunk → 主进程 ffmpeg
 *    `-c:v copy` 只复用（webcodecsEncoder.ts + exportMux*）。无逐帧 rawvideo IPC、无 getImageData。
 *  - 兜底路径：Canvas getImageData → rgbaToNv12 → rawvideo → ffmpeg 硬编（无 WebCodecs 硬编时）。
 *
 * 导出区间 = 0 .. 所有 clip 终点(内容末帧)。
 */

import type { Project } from '../model/timeline'
import { resolveTimeline } from '../model/timeline'
import { Canvas2DExportRenderer, loadImageBitmaps } from './canvas2dRenderer'
import { probeH264Config, WebCodecsExportEncoder, type EncoderConfig } from './webcodecsEncoder'
import { effectiveVideoSrc } from '../pixi/mediaProxy'
import type { AudioClipInput } from '../../../main/export'
import type { ExportResult } from '../../../main/export'
import { DecodeSourceManager } from '../pixi/h264/decodeSources'

export interface ExportProgress {
  /** 已编码帧数 */
  frames: number
  totalFrames: number
  /** 0..1 */
  ratio: number
  /** 实测导出速度（帧/秒，滚动均值） */
  fps: number
  /** 预计剩余秒数（按 fps 推算；样本不足时 NaN） */
  etaSec: number
}

/** 解码 avn-file:// 源 → 磁盘绝对路径；非 avn 返回 null。 */
export function pathFromSrc(src: string | undefined): string | null {
  if (!src || !src.startsWith('avn-file://')) return null
  try {
    const u = new URL(src)
    const p = decodeURIComponent(u.hostname)
    return p && p.length > 1 ? p : null
  } catch {
    return null
  }
}

/** 工程内容总帧数（0 .. 最末 clip 终点；空工程返回 0）。 */
export function contentTotalFrames(project: Project): number {
  let max = 0
  for (const clips of Object.values(project.clips)) {
    for (const c of clips) max = Math.max(max, c.startFrame + c.durationFrames)
  }
  return max
}

/**
 * 收集工程中所有可能参与画面渲染的视频源（仅 enabled video 轨上 type==='video' 的 clip）。
 * 返回去重后的 { orig, eff, path }——
 *  - orig: clip 原始 src(avn 绝对路径)，渲染层 resolveTimeline 出的场景用它；
 *  - eff: 渲染器实际喂纹理的 effectiveVideoSrc(可能已被 mediaCache 换成 proxy avn)；
 *  - path: 源磁盘绝对路径(解码会话按它建,真正 demux)。
 */
export function collectVideoSources(project: Project): { orig: string; eff: string; path: string }[] {
  const out = new Map<string, { orig: string; eff: string; path: string }>() // path → 条目(按磁盘路径去重)
  for (const track of project.tracks) {
    if (track.kind !== 'video' || track.disabled) continue
    for (const c of project.clips[track.id] ?? []) {
      if (c.disabled || c.type !== 'video' || !c.src) continue
      const path = pathFromSrc(c.src)
      if (!path) continue // blob/无法定位源 → 无法 demux，跳过
      const eff = typeof window !== 'undefined'
        ? (() => { try { return effectiveVideoSrc(c.src!) } catch { return c.src! } })()
        : c.src!
      const orig = c.src!
      if (!out.has(path)) out.set(path, { orig, eff, path })
    }
  }
  return Array.from(out.values())
}

/**
 * 解析音频参与计划（尊重轨 disabled/muted/solo；仅音频轨上的 clip）。
 * 每个音频 clip → 主进程 ffmpeg 输入所需信息（sourceStart 决定素材内裁剪起点，volume 已含 muted 置 0）。
 */
export function resolveAudioPlan(project: Project): AudioClipInput[] {
  const audioTracks = project.tracks.filter((t) => t.kind === 'audio')
  const anySolo = audioTracks.some((t) => t.solo)
  const enabledTracks = audioTracks.filter((t) => !t.disabled && (!anySolo || t.solo))

  const inputs: AudioClipInput[] = []
  for (const t of enabledTracks) {
    const clips = project.clips[t.id] ?? []
    for (const c of clips) {
      if (c.disabled || c.type !== 'audio') continue
      const path = pathFromSrc(c.src)
      if (!path) continue
      const vol = t.muted ? 0 : (c.volume ?? 1)
      inputs.push({
        path,
        startFrame: c.startFrame,
        endFrame: c.startFrame + c.durationFrames,
        sourceStartFrame: c.sourceStartFrame ?? 0,
        volume: vol
      })
    }
  }
  return inputs
}

/** NV12 一帧字节数（Y 平面 W*H + 交错 UV 平面 W*H/2） */
function nv12FrameSize(w: number, h: number): number {
  return (w * h * 1.5) | 0
}

/**
 * RGBA → NV12（BT.601 limited range，与 ffmpeg swscale 默认一致）。
 * src = getImageData 的 Uint8ClampedArray(W*H*4)；dst = 池化复用缓冲(≥W*H*1.5)。
 */
function rgbaToNv12(src: Uint8ClampedArray, dst: Uint8Array, w: number, h: number): void {
  const yPlane = w * h
  for (let i = 0, s = 0; i < yPlane; i++, s += 4) {
    dst[i] = ((66 * src[s] + 129 * src[s + 1] + 25 * src[s + 2] + 128) >> 8) + 16
  }
  let uvi = yPlane
  for (let y = 0; y < h; y += 2) {
    const row0 = y * w * 4
    const row1 = (y + 1) * w * 4
    for (let x = 0; x < w; x += 2) {
      const i0 = row0 + x * 4
      const b0 = i0 + 4
      const c = row1 + x * 4
      const d = c + 4
      const su =
        -38 * (src[i0] + src[b0] + src[c] + src[d]) -
        74 * (src[i0 + 1] + src[b0 + 1] + src[c + 1] + src[d + 1]) +
        112 * (src[i0 + 2] + src[b0 + 2] + src[c + 2] + src[d + 2])
      const sv =
        112 * (src[i0] + src[b0] + src[c] + src[d]) -
        94 * (src[i0 + 1] + src[b0 + 1] + src[c + 1] + src[d + 1]) -
        18 * (src[i0 + 2] + src[b0 + 2] + src[c + 2] + src[d + 2])
      dst[uvi++] = ((su + 512) >> 10) + 128
      dst[uvi++] = ((sv + 512) >> 10) + 128
    }
  }
}

export interface ExportRequest {
  project: Project
  outPath: string
  onProgress?: (p: ExportProgress) => void
  /** 允许中断：返回 true 则中止 */
  onCancel?: () => boolean
}

/** 暖启动：把各解码会话播头推到导出起点（第 0 帧）所在 AU，短暂 await 其首帧缓存。 */
async function warmDecodeAt(mgr: DecodeSourceManager, project: Project, fps: number): Promise<void> {
  const scene0 = resolveTimeline(0, project)
  const targets = new Set<string>()
  for (const v of scene0.videos) {
    const eff = effectiveVideoSrc(v.src)
    const s = mgr.sessionForSrc(eff)
    if (s && s.provider.status === 'ready' && s.provider.auCount > 0) targets.add(eff)
  }
  for (const v of scene0.videos) {
    const eff = effectiveVideoSrc(v.src)
    const s = mgr.sessionForSrc(eff)
    if (!s || !targets.has(eff)) continue
    const au = mgr.auForFrame(s, v.sourceFrame, fps)
    s.provider.setPlayhead(au)
    await s.provider.awaitUntil(au, 800)
  }
}

interface ExportContext {
  req: ExportRequest
  project: Project
  outPath: string
  fps: number
  w: number
  h: number
  totalFrames: number
  audio: AudioClipInput[]
  images: Map<string, ImageBitmap>
  decodeMgr: DecodeSourceManager
}

/**
 * 执行导出。返回 ExportResult。
 * 优先 WebCodecs 硬编 + ffmpeg 复用；探测失败回退 rawvideo + ffmpeg 硬编。
 */
export async function runExport(req: ExportRequest): Promise<ExportResult> {
  const { project, outPath } = req
  const fps = project.fps || 30
  const w = project.stage.width
  const h = project.stage.height
  const totalFrames = contentTotalFrames(project)
  if (totalFrames < 1) return { ok: false, error: '时间轴没有可导出的内容' }
  const hasFfmpeg = typeof window.api?.exportHasFfmpeg === 'function' ? await window.api.exportHasFfmpeg() : false
  if (!hasFfmpeg) return { ok: false, error: '未找到可用 ffmpeg，无法导出视频' }

  const scene0 = resolveTimeline(0, project)
  const anyVisual = scene0.videos.length > 0 || scene0.images.length > 0 || scene0.texts.length > 0
  if (!anyVisual) return { ok: false, error: '没有可导出的画面内容（视频/图片/文本）' }

  const audio = resolveAudioPlan(project)
  const images = await loadImageBitmaps(project)

  const decodeMgr = new DecodeSourceManager(fps)
  try {
    const videoSources = collectVideoSources(project)
    if (videoSources.length > 0) {
      for (const { orig, eff, path } of videoSources) {
        decodeMgr.registerSrc(eff, path)
        if (orig !== eff) decodeMgr.registerSrc(orig, path)
      }
      const prepared = await decodeMgr.prepare(videoSources.map((v) => v.path))
      if (prepared > 0) await warmDecodeAt(decodeMgr, project, fps)
    }
  } catch (e) {
    console.warn('[Export] WebCodecs 预解码加速不可用：', (e as Error)?.message)
  }

  const ctx: ExportContext = { req, project, outPath, fps, w, h, totalFrames, audio, images, decodeMgr }

  // 导出设备偏好：'software' → 不走 WebCodecs（强制 libx264 兜底）；其余走 WebCodecs + GPU 开关。
  let devicePref: string = 'auto'
  try {
    if (typeof window.api?.getPreferences === 'function') {
      devicePref = (await window.api.getPreferences()).exportDevice ?? 'auto'
    }
  } catch { /* 读偏好失败 → auto */ }

  try {
    const encCfg = devicePref !== 'software' && typeof VideoEncoder !== 'undefined'
      ? await probeH264Config(w, h, fps, 12_000_000)
      : null
    if (encCfg) {
      console.log(`[Export] 使用 WebCodecs 硬编（${encCfg.codec}）+ ffmpeg -c:v copy 复用`)
      return await runWebCodecsExport(ctx, encCfg)
    }
  } catch (e) {
    console.warn('[Export] WebCodecs 编码探测失败，回退 rawvideo：', (e as Error)?.message)
  }

  return await runRawvideoExport(ctx)
}

/** 快路径：WebCodecs VideoEncoder（annexb）→ 主进程 ffmpeg -c:v copy。 */
async function runWebCodecsExport(ctx: ExportContext, encCfg: EncoderConfig): Promise<ExportResult> {
  const { req, project, outPath, fps, w, h, totalFrames, audio, images, decodeMgr } = ctx

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const c2d = canvas.getContext('2d') // 默认 GPU 加速，new VideoFrame(canvas) 低拷贝
  if (!c2d) return { ok: false, error: '无法创建编码画布' }
  const renderer = new Canvas2DExportRenderer(c2d, project, fps, decodeMgr, images)

  const mux = await window.api.exportMuxBegin({ outPath, width: w, height: h, fps, totalFrames })
  if (!mux.ok) return { ok: false, error: mux.error || '复用会话启动失败' }

  let encErr: string | null = null
  const pending: Uint8Array[] = []
  const enc = new WebCodecsExportEncoder()
  await enc.init(encCfg, (batch) => { pending.push(...batch) }, (e) => { encErr = e.message })

  let error: string | null = null
  const t0 = performance.now()
  const speedWin: number[] = []
  const usPerFrame = Math.round(1e6 / fps)

  const reportSpeed = (t: number): { fps: number; etaSec: number } => {
    const now = performance.now()
    speedWin.push(now)
    while (speedWin.length > 30) speedWin.shift()
    if (speedWin.length < 4) return { fps: 0, etaSec: NaN }
    const span = speedWin[speedWin.length - 1] - speedWin[0]
    const f = ((speedWin.length - 1) / Math.max(span, 1)) * 1000
    return { fps: f, etaSec: f > 0 ? (totalFrames - t - 1) / f : NaN }
  }

  try {
    for (let t = 0; t < totalFrames; t++) {
      if (req.onCancel?.()) { error = '已取消'; break }
      if (encErr) { error = encErr; break }
      await renderer.render(t)
      enc.encode(canvas, t * usPerFrame, t === 0)
      await enc.backpressure(64)
      // 排空已编码 chunk（批量送主进程 mux）
      while (pending.length) {
        const batch = pending.splice(0, 128)
        for (const c of batch) {
          const r = await window.api.exportMuxChunk(c)
          if (!r.ok) { error = r.error || '写块失败'; break }
        }
        if (error) break
      }
      if (error) break
      const sp = reportSpeed(t)
      req.onProgress?.({ frames: t + 1, totalFrames, ratio: (t + 1) / totalFrames, fps: sp.fps, etaSec: sp.etaSec })
      await new Promise((r) => setTimeout(r, 0))
    }
  } finally {
    if (encErr && !error) error = encErr
    try { await enc.close((batch) => pending.push(...batch)) } catch { /* 忽略 */ }
    try {
      while (pending.length) {
        const batch = pending.splice(0, 128)
        for (const c of batch) await window.api.exportMuxChunk(c)
      }
    } catch { /* 忽略 */ }
    const wall = Math.max(performance.now() - t0, 0.001)
    console.log(`[Export-perf-webcodecs] ${totalFrames} 帧总 ${(wall / 1000).toFixed(1)}s (avg ${(wall / 1000 / totalFrames).toFixed(3)}s/f)`)
    decodeMgr.dispose()
    for (const bmp of images.values()) { try { bmp.close() } catch { /* 忽略 */ } }
  }

  if (error) {
    const res = await window.api.exportMuxEnd(error === '已取消' ? [] : audio)
    return { ok: false, error: error || res.error || '导出未完成' }
  }
  const res = await window.api.exportMuxEnd(audio)
  return res
}

/** 兜底路径：Canvas getImageData → NV12 → rawvideo → ffmpeg 硬编。 */
async function runRawvideoExport(ctx: ExportContext): Promise<ExportResult> {
  const { req, project, outPath, fps, w, h, totalFrames, audio, images, decodeMgr } = ctx

  const begin = await window.api.exportBegin({ outPath, width: w, height: h, fps, totalFrames, pixelInput: 'nv12' })
  if (!begin.ok) return { ok: false, error: begin.error || '导出会话启动失败' }
  console.log(`[Export] 视频编码器: ${(begin as { encoder?: string }).encoder || '(未报告)'}（帧 ${w}x${h} @${fps}fps，共 ${totalFrames} 帧）`)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const c2d = canvas.getContext('2d', { willReadFrequently: true })
  if (!c2d) {
    await window.api.exportEnd([])
    return { ok: false, error: '无法创建 2D 导出画布' }
  }
  const renderer = new Canvas2DExportRenderer(c2d, project, fps, decodeMgr, images)

  let error: string | null = null
  const nv12Buf = new Uint8Array(nv12FrameSize(w, h))
  let nv12Valid = nv12Buf.byteLength > 0

  const perf = { frames: 0, captureMs: 0, readMs: 0, ipcMs: 0, otherMs: 0 }
  const t0 = performance.now()
  const speedWin: number[] = []
  const reportSpeed = (t: number): { fps: number; etaSec: number } => {
    const now = performance.now()
    speedWin.push(now)
    while (speedWin.length > 30) speedWin.shift()
    if (speedWin.length < 4) return { fps: 0, etaSec: NaN }
    const span = speedWin[speedWin.length - 1] - speedWin[0]
    const f = ((speedWin.length - 1) / Math.max(span, 1)) * 1000
    return { fps: f, etaSec: f > 0 ? (totalFrames - t - 1) / f : NaN }
  }

  try {
    for (let t = 0; t < totalFrames; t++) {
      if (req.onCancel?.()) { error = '已取消'; break }
      let fr: { ok: boolean; error?: string } | null = null
      let wrote = false
      for (let attempt = 0; attempt < 4 && !wrote; attempt++) {
        if (req.onCancel?.()) { error = '已取消'; break }
        const sCapture = performance.now()
        let cap: Uint8ClampedArray | null = null
        try {
          await renderer.render(t)
          cap = c2d.getImageData(0, 0, w, h).data
        } catch (capErr) {
          error = String((capErr as Error)?.message ?? capErr)
          console.error(`[Export] 渲染中止: ${error}`)
          break
        }
        perf.captureMs += performance.now() - sCapture
        const sRead = performance.now()
        let frameBytes: Uint8Array | null = null
        try {
          if (nv12Valid && cap && cap.length >= w * h * 4) {
            rgbaToNv12(cap, nv12Buf, w, h)
            frameBytes = nv12Buf
          }
        } catch (readErr) {
          error = `第 ${t + 1} 帧像素转换失败：${String((readErr as Error)?.message ?? readErr)}`
          nv12Valid = false
          break
        }
        perf.readMs += performance.now() - sRead
        if (!frameBytes) continue
        const sIpc = performance.now()
        fr = await window.api.exportFrame(frameBytes)
        perf.ipcMs += performance.now() - sIpc
        if (fr.ok) wrote = true
        else if (attempt < 3) await new Promise((r) => setTimeout(r, 16))
      }
      if (error) break
      if (!wrote) { error = fr?.error || `第 ${t + 1} 帧写入失败`; break }
      perf.frames++
      const sp = reportSpeed(t)
      req.onProgress?.({ frames: t + 1, totalFrames, ratio: (t + 1) / totalFrames, fps: sp.fps, etaSec: sp.etaSec })
      await new Promise((r) => setTimeout(r, 0))
    }
  } finally {
    const wall = Math.max(performance.now() - t0, 0.001)
    perf.otherMs = Math.max(wall - (perf.captureMs + perf.readMs + perf.ipcMs), 0)
    const pct = (ms: number) => `${(ms / wall * 100).toFixed(0)}%`
    console.log(
      `[Export-perf] ${perf.frames} 帧总 ${(wall / 1000).toFixed(1)}s (avg ${(wall / 1000 / Math.max(perf.frames, 1)).toFixed(3)}s/f) | ` +
      `capture(渲染+抽帧) ${perf.captureMs.toFixed(0)}ms=${pct(perf.captureMs)} | ` +
      `RGBA→NV12 ${perf.readMs.toFixed(0)}ms=${pct(perf.readMs)} | ` +
      `IPC/喂帧 ${perf.ipcMs.toFixed(0)}ms=${pct(perf.ipcMs)} | ` +
      `其他(让出/等待) ${perf.otherMs.toFixed(0)}ms=${pct(perf.otherMs)}`
    )
    decodeMgr.dispose()
    for (const bmp of images.values()) { try { bmp.close() } catch { /* 忽略 */ } }
  }

  if (error) {
    const res = await window.api.exportEnd(error === '已取消' ? [] : audio)
    return { ok: false, error: error || res.error || '导出未完成' }
  }
  const res = await window.api.exportEnd(audio)
  return res
}
