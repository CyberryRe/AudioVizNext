/// <reference lib="webworker" />

/**
 * mbExportWorker.ts —— 导出循环（**Worker 线程**）：mediabunny 解码 + Canvas2D 绘制 + 编码复用。
 *
 * 为什么在 Worker：整条导出流水（解码/绘制/编码/复用）原本跑在主线程，导出期间界面会顿、
 * 且与预览争同一线程。mediabunny 全链路不依赖 DOM（OffscreenCanvas + WebCodecs），
 * 因此可以整块搬进 Worker —— 与 Elah 的 `ExportWorker` 同构。
 *
 * 分工：
 *  - 主线程（mbExport.ts）：音频混音（Web Audio 仅主线程）、进度转发、文件写入、取消。
 *  - 本 Worker：逐帧 resolveTimeline → 绘制 → CanvasSource.add() → Mp4Output；
 *    MP4 字节经 StreamTarget 以 {position,data} 推给主线程写盘（Worker 无 preload API）。
 *
 * 解码用 `CanvasSink.canvasesAtTimestamps(...)` **顺序**喂时间戳：每个包只解一次、绝不逐帧随机 seek
 * （Elah 实测随机访问会出绿带崩坏）。素材循环时按"源时间戳单调段"切分，每圈一段。
 */

import * as mb from 'mediabunny'
import { resolveTimeline, type Clip, type Project } from '../model/timeline'
import { mediaBox } from '../pixi/layout'
import { drawTextLayer } from './drawTextLayer'
import { loadImageBitmaps, imageForFrame, type LoadedImage } from './loadImageBitmaps'
import { findFollowCircle, followProjection } from '../presets/followCircle'
import { avnUrl, evenUp, pathFromAvn, type ExportProgress } from './exportTypes'
import { getPreset, drawPreset, installUserPresetMetas } from '../presets/registry'
import { levelAt, type PresetAudioData } from '../media/audioAnalysis'
import { resolveLayer3D, isLayer3DActive, planPerspectiveGrid, chooseGridSeg, gridCellDrawRects, layer3DDrawBox, type ResolvedLayer3D } from '../pixi/layer3d'
import { bool as boolParam, type PresetImage } from '../presets/types'

export interface WorkerAudioMix {
  sampleRate: number
  numberOfChannels: number
  length: number
  channels: ArrayBuffer[]
  /** 逐帧音频分析（波形/频谱/电平/发射前缀）：可视化预设用，transferable */
  analysis?: PresetAudioData | null
}

export interface WorkerStartMessage {
  type: 'start'
  project: Project
  outPath: string
  bitrate: number
  audio: WorkerAudioMix | null
  /** 用户预设（含 script 源码）：Worker 无 window.api，须主线程序列化注入 */
  userPresets?: unknown[]
}

type InMessage = WorkerStartMessage | { type: 'cancel' } | { type: 'writeDone'; id: number; ok: boolean }

type OutMessage =
  | { type: 'progress'; progress: ExportProgress }
  | { type: 'done'; frames: number; wallMs: number }
  | { type: 'error'; message: string }
  | { type: 'log'; line: string }
  | { type: 'write'; id: number; data: Uint8Array; position: number }

const post = (m: OutMessage, transfer?: Transferable[]): void => {
  ;(self as unknown as Worker).postMessage(m, transfer ?? [])
}
const log = (line: string): void => post({ type: 'log', line })

let cancelled = false

/**
 * 接缝补偿：相邻格的目标矩形各向外扩这么多 **stage 像素**。
 * 两个独立成因都靠它解决（详见 `pixi/layer3d.ts` 的 `gridCellDrawRects`）：
 *  ① 源子矩形边界的双线性采样被 clamp → 采样断裂（源矩形按同比例出血后消失）；
 *  ② 抗锯齿覆盖率缝：跨接缝的像素被两格各盖一半 → 漏底色（外扩 ≥ 半像素后必被一格完整覆盖）。
 * 取 0.75 略大于半像素，留浮点/取整余量。
 */
const GRID_SEAM_PAD_PX = 0.75

/** 逐格贴图暂存画布（跨帧复用）：网格以 alpha=1 画满后再整体按 opacity 合成 */
let gridScratch: OffscreenCanvas | null = null

/**
 * 把源图按 layer3d 投影网格逐格贴到目标 2D 上下文。
 *
 * ⚠ 几何直接取自 `planPerspectiveGrid`（与预览端 Pixi `Mesh` **同一份顶点数组**）→ 两端逐位一致。
 * ⚠ 每格：`setTransform` 的基向量 = 该格两条投影边（已含全部缩放），目标矩形必须是**单位格**
 *   （若传 `cellW,cellH` 会把缩放重复施加 → 格子叠加错位 → 一团模糊色块）。
 * ⚠ 相邻格必须外扩重叠（不裁剪）：见 `GRID_SEAM_PAD_PX`。
 */
function drawProjectedGrid(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  src: CanvasImageSource & { width: number; height: number },
  box: { x: number; y: number; w: number; h: number },
  cfg: ResolvedLayer3D,
  seg: number
): void {
  const g = planPerspectiveGrid(box, cfg, seg)
  const n = g.seg
  const cols = n + 1
  const tw = src.width
  const th = src.height
  const scw = tw / n
  const sch = th / n
  const p = g.positions
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i00 = (r * cols + c) * 2
      const i10 = (r * cols + c + 1) * 2
      const i01 = ((r + 1) * cols + c) * 2
      const x00 = p[i00]
      const y00 = p[i00 + 1]
      const a = p[i10] - x00
      const b = p[i10 + 1] - y00
      const cc = p[i01] - x00
      const dd = p[i01 + 1] - y00
      // 目标侧外扩 PAD stage px ⇔ 源侧外扩 PAD * 源格 / 投影格边长（源像素）
      const bleedX = (GRID_SEAM_PAD_PX * scw) / Math.max(1e-3, Math.hypot(a, b))
      const bleedY = (GRID_SEAM_PAD_PX * sch) / Math.max(1e-3, Math.hypot(cc, dd))
      const cell = gridCellDrawRects(c, r, n, tw, th, bleedX, bleedY)
      ctx.save()
      // 基向量 = 该格两条投影边（与预览端 Mesh 顶点同源）
      ctx.setTransform(a, b, cc, dd, x00, y00)
      ctx.drawImage(src, cell.sx, cell.sy, cell.sw, cell.sh, cell.dx, cell.dy, cell.dw, cell.dh)
      ctx.restore()
    }
  }
}

/**
 * 按 opacity 把网格贴到目标上下文。
 * `opacity < 1` 时先画到暂存画布（alpha=1）再整体合成 —— 否则相邻格接缝处同一像素被两次
 * 半透明覆盖，会出现比目标更深的网格线。
 */
function blitProjectedGrid(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  src: CanvasImageSource & { width: number; height: number },
  box: { x: number; y: number; w: number; h: number },
  cfg: ResolvedLayer3D,
  seg: number,
  opacity: number,
  w: number,
  h: number
): void {
  if (opacity >= 0.999) {
    drawProjectedGrid(ctx, src, box, cfg, seg)
    return
  }
  if (!gridScratch || gridScratch.width !== w || gridScratch.height !== h) {
    gridScratch = new OffscreenCanvas(w, h)
  }
  const sctx = gridScratch.getContext('2d')
  if (!sctx) {
    // 兜底：拿不到暂存画布就直接画（网格线比丢内容可接受）
    const keep = ctx.globalAlpha
    ctx.globalAlpha = opacity
    drawProjectedGrid(ctx, src, box, cfg, seg)
    ctx.globalAlpha = keep
    return
  }
  sctx.setTransform(1, 0, 0, 1, 0, 0)
  sctx.globalAlpha = 1
  sctx.clearRect(0, 0, w, h)
  drawProjectedGrid(sctx, src, box, cfg, seg)
  const keep = ctx.globalAlpha
  ctx.globalAlpha = opacity
  // 逐格贴图会改变换（save/restore 已还原），这里显式归一化，确保暂存画布 1:1 对位
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(gridScratch, 0, 0)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = keep
}

// —— 落盘 RPC：Worker 不能调 window.api，改由主线程代写 ——
let writeSeq = 0
const writePending = new Map<number, (ok: boolean) => void>()
function writeChunk(data: Uint8Array, position: number): Promise<boolean> {
  const id = ++writeSeq
  return new Promise<boolean>((resolve) => {
    writePending.set(id, resolve)
    post({ type: 'write', id, data, position }, [data.buffer as ArrayBuffer])
  })
}

interface VideoClipDecoder {
  clip: Clip
  startFrame: number
  endFrame: number
  /** 源时间戳单调段（循环素材每圈一段，段内严格递增 → 每包只解一次） */
  segments: { fromFrame: number; gen: AsyncGenerator<mb.WrappedCanvas | null> }[]
  segIndex: number
}

/** 渲染一帧：不透明黑底 + 按 zIndex 叠层（与预览共用 layout / drawTextLayer / 预设 drawer）。 */
function renderFrame(
  ctx: OffscreenCanvasRenderingContext2D,
  project: Project,
  frame: number,
  w: number,
  h: number,
  clipById: Map<string, Clip>,
  clipCanvases: Map<string, CanvasImageSource & { width: number; height: number }>,
  images: Map<string, LoadedImage>,
  audioData: PresetAudioData | null
): void {
  const scene = resolveTimeline(frame, project)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)

  // 预设参数引用的图片（静态，与时间轴帧无关）→ 预解析一次供 drawer 用。
  // GIF 在此按「第 0 帧」解析（预设引用动图属边缘用法，与预览端 textureFor 兜底一致）。
  let presetImages: Map<string, PresetImage> | null = null
  const resolvedPresetImages = (): Map<string, PresetImage> => {
    if (presetImages) return presetImages
    const m = new Map<string, PresetImage>()
    for (const [src, loaded] of images) {
      const bmp = imageForFrame(loaded, 0)
      if (bmp) m.set(src, bmp as unknown as PresetImage)
    }
    presetImages = m
    return m
  }

  const layers = [
    ...scene.videos.map((v) => ({ kind: 'video' as const, id: v.id, src: v.src, opacity: v.opacity, transform: v.transform, sourceFrame: v.sourceFrame, z: v.zIndex, content: '', presetId: v.presetId, params: v.params, keyframes: v.keyframes, tRel: v.tRel, layer3d: v.layer3d, gifSpeed: undefined as number | undefined })),
    ...scene.images.map((i) => ({ kind: 'image' as const, id: i.id, src: i.src, opacity: i.opacity, transform: i.transform, sourceFrame: i.sourceFrame, z: i.zIndex, content: '', presetId: i.presetId, params: i.params, keyframes: i.keyframes, tRel: i.tRel, layer3d: i.layer3d, gifSpeed: i.gifSpeed })),
    ...scene.visuals.map((v) => ({ kind: 'visual' as const, id: v.id, src: '', opacity: v.opacity, transform: v.transform, sourceFrame: v.sourceFrame, z: v.zIndex, content: '', presetId: v.presetId, params: v.params, keyframes: v.keyframes, tRel: v.tRel, layer3d: v.layer3d, gifSpeed: undefined as number | undefined })),
    ...scene.effects.map((v) => ({ kind: 'effect' as const, id: v.id, src: '', opacity: v.opacity, transform: v.transform, sourceFrame: v.sourceFrame, z: v.zIndex, content: '', presetId: v.presetId, params: v.params, keyframes: v.keyframes, tRel: v.tRel, layer3d: v.layer3d, gifSpeed: undefined as number | undefined })),
    ...scene.texts.map((t) => ({ kind: 'text' as const, id: t.id, src: '', opacity: t.opacity, transform: t.transform, sourceFrame: t.sourceFrame, z: t.zIndex, content: t.content, presetId: t.presetId, params: t.params, keyframes: t.keyframes, tRel: t.tRel, layer3d: t.layer3d, gifSpeed: undefined as number | undefined }))
  ].sort((a, b) => a.z - b.z)

  for (const l of layers) {
    if (l.kind === 'text') {
      drawTextLayer(ctx, clipById.get(l.id), l, project.fps, project)
      continue
    }
    // 预设样式层（visual/effect 恒有；image 有 presetId 时改由 drawer 绘制）
    const meta = getPreset(l.presetId)
    if (meta) {
      if (frame === 0) log(`[Export] 预设层 ${l.presetId} params=${JSON.stringify(l.params ?? {})} kf=${Object.keys(l.keyframes ?? {}).length}`)
      const followCircle = findFollowCircle(project, frame, (src) => {
        const b = images.get(src)
        return b ? { width: b.width, height: b.height } : null
      })
      // ⚠ 只有**真正声明并开启跟随**的非图片层才是跟随方：
      //   ① 圆形图片层自身会命中自己 → 按 kind 排除，否则它自己的 3D 被误抑制；
      //   ② 效果层也可能带 layer3d 但不消费 followProject → 按「预设声明 followCircle 且值为真」判定。
      const declaresFollow = meta.params.some((p) => p.key === 'followCircle')
      const isFollower = l.kind !== 'image' && declaresFollow && boolParam(l.params ?? {}, meta, 'followCircle')
      const followProject = isFollower ? followProjection(followCircle, { width: w, height: h }, project.box3d) : undefined
      const l3cfg = resolveLayer3D(l.layer3d, project.stage, project.box3d, { x: 0, y: 0, w, h })
      // 跟随圆形时：环的 3D 已在 drawer 内逐点施加（followProject）→ 该层自身 3D 不再叠加
      // （用户约定「无脑跟随」：跟随态下忽略环形层自己的附着面设置）。
      const use3d = !followProject && isLayer3DActive(l.layer3d) && l3cfg.enabled
      ctx.save()
      if (use3d) {
        // 全幅预设 3D：先整层画到临时画布，再按细分网格逐格贴回（与预览同一投影，无折痕）。
        // ⚠ 临时画布按「该层需要绘制的区域」开（贴面时比画幅大）——drawer 仍在画幅坐标系作画，
        //   超出画幅的笔触不被 canvas 裁掉 → 不会在"面的矩形边界"处出现硬切边。
        const gridBox = layer3DDrawBox(l.layer3d, project.stage, project.box3d, { x: 0, y: 0, w, h })
        const cfg3 = resolveLayer3D(l.layer3d, project.stage, project.box3d, gridBox)
        const tmp = new OffscreenCanvas(gridBox.w, gridBox.h)
        const tctx = tmp.getContext('2d')
        if (tctx) {
          tctx.translate(-gridBox.x, -gridBox.y)
          drawPreset(tctx, meta, {
            width: w,
            height: h,
            frame,
            fps: project.fps,
            timeSec: l.sourceFrame / (project.fps || 30),
            sourceFrame: l.sourceFrame,
            energy: levelAt(audioData, frame),
            audio: audioData,
            opacity: 1,
            image: l.kind === 'image' ? (resolvedPresetImages().get(l.src) ?? null) : null,
            images: resolvedPresetImages(),
            keyframes: l.keyframes,
            tRel: l.tRel ?? 0,
            followCircle,
            followProject
          }, l.params)
          blitProjectedGrid(ctx, tmp, gridBox, cfg3, chooseGridSeg(gridBox, cfg3), l.opacity, w, h)
        }
      } else {
        drawPreset(ctx, meta, {
          width: w,
          height: h,
          frame,
          fps: project.fps,
          timeSec: l.sourceFrame / (project.fps || 30),
          sourceFrame: l.sourceFrame,
          energy: levelAt(audioData, frame),
          audio: audioData,
          opacity: l.opacity,
          image: l.kind === 'image' ? (resolvedPresetImages().get(l.src) ?? null) : null,
          images: resolvedPresetImages(),
          keyframes: l.keyframes,
          tRel: l.tRel ?? 0,
          followCircle,
          followProject
        }, l.params)
      }
      ctx.restore()
      continue
    }
    // 媒体层：视频走逐帧解码画布；图片（含 GIF）按当前源帧 + 速度取位图
    const src: (CanvasImageSource & { width: number; height: number }) | undefined | null =
      l.kind === 'video' ? clipCanvases.get(l.id) : imageForFrame(images.get(l.src), l.sourceFrame, l.gifSpeed ?? 1)
    if (!src) continue
    const rect = mediaBox(src.width, src.height, l.transform, { width: w, height: h })
    const box = { x: rect.x - rect.width / 2, y: rect.y - rect.height / 2, w: rect.width, h: rect.height }
    // 内容盒 = 源矩形：贴面时原样落到该平面上，形状锁定（无需跟随偏移）
    const m3 = resolveLayer3D(l.layer3d, project.stage, project.box3d, box)
    ctx.save()
    if (isLayer3DActive(l.layer3d) && m3.enabled) {
      // 细分网格透视：与预览端同一份顶点数组（同段数、同投影）→ 无折痕、导出=预览
      blitProjectedGrid(ctx, src, box, m3, chooseGridSeg(box, m3), l.opacity, w, h)
    } else {
      ctx.globalAlpha = l.opacity
      ctx.drawImage(src, rect.x - rect.width / 2, rect.y - rect.height / 2, rect.width, rect.height)
    }
    ctx.restore()
  }
}

/** 把主线程混好的 PCM 按 1 秒分块喂给 AAC 编码器（尊重背压）。 */
async function addAudioMix(source: mb.AudioSampleSource, audio: WorkerAudioMix): Promise<void> {
  const { sampleRate, numberOfChannels, length } = audio
  const channels = audio.channels.map((b) => new Float32Array(b))
  const chunkFrames = sampleRate
  for (let start = 0; start < length; start += chunkFrames) {
    if (cancelled) return
    const frames = Math.min(chunkFrames, length - start)
    const data = new Float32Array(frames * numberOfChannels)
    for (let c = 0; c < numberOfChannels; c++) data.set(channels[c].subarray(start, start + frames), c * frames)
    const sample = new mb.AudioSample({ data, format: 'f32-planar', numberOfChannels, sampleRate, timestamp: start / sampleRate })
    await source.add(sample)
    sample.close()
  }
}

async function runExport(msg: WorkerStartMessage): Promise<void> {
  const { project, bitrate, audio } = msg
  // 用户脚本预设：主线程序列化注入（Worker 无 window.api / userData）
  if (msg.userPresets?.length) {
    installUserPresetMetas(msg.userPresets)
    log(`[Export] 已注入用户预设 ${msg.userPresets.length} 个`)
  }
  const fps = project.fps || 30
  const w = evenUp(project.stage.width)
  const h = evenUp(project.stage.height)
  const totalFrames = Object.values(project.clips).flat().reduce((m, c) => Math.max(m, c.startFrame + c.durationFrames), 0)
  if (totalFrames < 1) throw new Error('时间轴没有可导出的内容')
  if (w !== project.stage.width || h !== project.stage.height) {
    log(`[Export] 画幅尺寸为奇数（${project.stage.width}×${project.stage.height}）→ 向上取偶为 ${w}×${h}（H.264 4:2:0 要求偶数）`)
  }

  const clipById = new Map<string, Clip>()
  for (const clips of Object.values(project.clips)) for (const c of clips) clipById.set(c.id, c)

  const t0 = performance.now()
  const allClips = Object.values(project.clips).flat()
  const videoClips = allClips.filter((c) => c.type === 'video' && c.src && !c.disabled)
  const sinks = new Map<string, { input: mb.Input; sink: mb.CanvasSink }>()
  const decoders = new Map<string, VideoClipDecoder>()
  const images = await loadImageBitmaps(project)
  const audioData = audio?.analysis ?? null

  try {
    // —— 打开视频源（每唯一 src 一个 Input/CanvasSink）——
    for (const clip of videoClips) {
      const src = clip.src!
      if (!sinks.has(src)) {
        const url = avnUrl(pathFromAvn(src) ?? src)
        const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.UrlSource(url) })
        const track = await input.getPrimaryVideoTrack()
        if (!track) throw new Error(`无法读取视频轨: ${src.slice(-48)}`)
        sinks.set(src, { input, sink: new mb.CanvasSink(track) })
        log(`[Export] 视频源就绪: ${src.slice(-48)}`)
      }
      const entry = sinks.get(src)!
      const endFrame = clip.startFrame + clip.durationFrames
      // 按源时间戳单调段切分（循环素材每圈一段）。
      // ⚠ 段内时间戳必须用**取模后的圈内位置** `within`，绝不能用累计 offset：
      //   累计 offset 在第二圈起就超出素材时长 → mediabunny 把超出部分钳到最后一帧 →
      //   导出画面"只播一次然后定格"（实测 t=11s 与 t=19s 的 SSIM=0.976 = 冻结）。
      const duration = await (await entry.input.getPrimaryVideoTrack())!.computeDuration()
      const srcFrames = Math.max(1, Math.round(duration * fps))
      const segments: VideoClipDecoder['segments'] = []
      let f = clip.startFrame
      while (f < endFrame) {
        const offset = (clip.sourceStartFrame ?? 0) + (f - clip.startFrame)
        const within = offset % srcFrames
        const segLen = Math.min(srcFrames - within, endFrame - f)
        const timestamps = Array.from({ length: segLen }, (_, i) => (within + i + 0.5) / fps)
        segments.push({ fromFrame: f, gen: entry.sink.canvasesAtTimestamps(timestamps) })
        f += segLen
      }
      log(`[Export] clip ${clip.id}: 源 ${duration.toFixed(2)}s ≈ ${srcFrames} 帧，切 ${segments.length} 段覆盖 ${clip.durationFrames} 帧`)
      decoders.set(clip.id, { clip, startFrame: clip.startFrame, endFrame, segments, segIndex: 0 })
    }

    // —— 输出：MP4 + StreamTarget（字节交给主线程写盘）——
    const writable = new WritableStream<mb.StreamTargetChunk>({
      write: async (chunk) => { await writeChunk(chunk.data, chunk.position) }
    })
    const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.StreamTarget(writable) })

    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建 OffscreenCanvas 2D 上下文')
    const canvasSource = new mb.CanvasSource(canvas, { codec: 'avc', bitrate })
    output.addVideoTrack(canvasSource)

    let audioSource: mb.AudioSampleSource | null = null
    if (audio) {
      audioSource = new mb.AudioSampleSource({ codec: 'aac', bitrate: 192_000 })
      output.addAudioTrack(audioSource)
    }

    await output.start()
    if (audio && audioSource) await addAudioMix(audioSource, audio)

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

    const perf = { decodeMs: 0, drawMs: 0, encodeMs: 0, frames: 0 }
    for (let frame = 0; frame < totalFrames; frame++) {
      if (cancelled) break
      const clipCanvases = new Map<string, CanvasImageSource & { width: number; height: number }>()
      const sDec = performance.now()
      for (const dec of decoders.values()) {
        if (frame < dec.startFrame || frame >= dec.endFrame) continue
        while (dec.segIndex < dec.segments.length - 1 && frame >= dec.segments[dec.segIndex + 1].fromFrame) dec.segIndex++
        const seg = dec.segments[dec.segIndex]
        if (frame < seg.fromFrame) continue
        const r = await seg.gen.next()
        if (!r.done && r.value) clipCanvases.set(dec.clip.id, r.value.canvas as unknown as CanvasImageSource & { width: number; height: number })
      }
      perf.decodeMs += performance.now() - sDec

      const sDraw = performance.now()
      renderFrame(ctx, project, frame, w, h, clipById, clipCanvases, images, audioData)
      perf.drawMs += performance.now() - sDraw

      const sEnc = performance.now()
      await canvasSource.add(frame / fps, 1 / fps)
      perf.encodeMs += performance.now() - sEnc
      perf.frames++

      const sp = reportSpeed(frame)
      post({ type: 'progress', progress: { frames: frame + 1, totalFrames, ratio: (frame + 1) / totalFrames, fps: sp.fps, etaSec: sp.etaSec } })
    }

    await output.finalize()
    const wall = Math.max(performance.now() - t0, 0.001)
    const pct = (ms: number): string => `${((ms / wall) * 100).toFixed(0)}%`
    log(
      `[Export-perf-mediabunny] ${perf.frames} 帧总 ${(wall / 1000).toFixed(1)}s (avg ${(wall / 1000 / Math.max(perf.frames, 1)).toFixed(3)}s/f) | ` +
      `解码 ${perf.decodeMs.toFixed(0)}ms=${pct(perf.decodeMs)} | 绘制 ${perf.drawMs.toFixed(0)}ms=${pct(perf.drawMs)} | 编码+复用 ${perf.encodeMs.toFixed(0)}ms=${pct(perf.encodeMs)}`
    )
    post({ type: 'done', frames: perf.frames, wallMs: wall })
  } finally {
    for (const s of sinks.values()) { try { s.input.dispose?.() } catch { /* 忽略 */ } }
    for (const b of images.values()) {
      // 仅 ImageBitmap 有 close()；GIF 是 OffscreenCanvas 数组（GC 回收）
      if (b instanceof ImageBitmap) { try { b.close() } catch { /* 忽略 */ } }
    }
  }
}

self.onmessage = (e: MessageEvent<InMessage>): void => {
  const msg = e.data
  if (msg?.type === 'cancel') { cancelled = true; return }
  if (msg?.type === 'writeDone') { writePending.get(msg.id)?.(msg.ok); writePending.delete(msg.id); return }
  if (msg?.type !== 'start') return
  cancelled = false
  void runExport(msg).then(
    () => { /* done 已在 runExport 内发出 */ },
    (err) => post({ type: 'error', message: String((err as Error)?.stack ?? err) })
  )
}
