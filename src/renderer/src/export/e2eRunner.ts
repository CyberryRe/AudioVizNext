/**
 * e2eRunner.ts —— 导出 E2E 测试台（Chrome/Electron 模式，非 Node 模式）。
 *
 * 目的：在**真实渲染进程**（真 WebCodecs / 真 GPU / 真 Worker）里跑一次完整导出，
 * 用真实素材验证「产物是否完整」与「瓶颈在哪」。Node 模式没有 VideoEncoder/canvas/GPU，测不了。
 *
 * 启用方式（只在设了环境变量时生效，正常使用零影响）：
 *   AVS_E2E_SPEC='{"out":"F:/ExportTest/out.mp4","seconds":20,...}' electron .
 * `main.tsx` 在挂载 React 之前调用 runE2E()，跑完经 IPC 把结果打回主进程 stdout 并退出。
 *
 * 关键回归门 = **产物自检**（主进程 `verifyVideoIntegrity`）：容器包数 ≠ 解出帧数即判定码流被写坏。
 */

import {
  createClip,
  createProject,
  createTrack,
  defaultLyricStyle,
  type Clip,
  type Project,
  type Track
} from '../model/timeline'
import { runMbExport } from './mbExport'
import { type ExportProgress } from './exportTypes'
import { getPreset, initPresetRegistry, listPresets } from '../presets/registry'

export interface E2ESpec {
  /** 输出 mp4 绝对路径 */
  out: string
  /** 导出时长（秒），默认 20 */
  seconds?: number
  /** 帧率，默认 30 */
  fps?: number
  /** 画幅，默认 1920x1080 */
  stage?: [number, number]
  /** 背景视频绝对路径（可选；循环填满整段） */
  video?: string
  /** 音频绝对路径（可选） */
  audio?: string
  /** LRC 歌词绝对路径（可选） */
  lrc?: string
  /** 字幕文本（无 lrc 时的普通文本层） */
  text?: string
  /** 预设样式 clip（可视化 / 图片样式）：逐个落到最前面的轨道 */
  presets?: { id: string; seconds?: number; image?: string; params?: Record<string, unknown>; keyframes?: Record<string, { t: number; v: number }[]> }[]
  /** true = 预设轨道放到歌词**下面**（用于验证调整层与上层的关系，如"歌词不被模糊"） */
  presetsBelowLyrics?: boolean
  /** 视频码率（默认 20Mbps） */
  bitrate?: number
  /**
   * 时间轴映射检查：比较导出文件两个时间点的画面相似度（SSIM）。
   * `expect:'same'` = 应≈相同（如循环素材 t 与 t+源时长）；`expect:'differ'` = 应明显不同（画面在动）。
   */
  frameChecks?: { a: number; b: number; expect: 'same' | 'differ'; min?: number; max?: number }[]
  /** 预留：测试模式（当前只有完整导出） */
  mode?: 'mb' | 'preview'
  benchFrames?: number
}

interface E2EReport {
  ok: boolean
  error?: string | null
  outPath?: string
  frames?: number
  wallMs: number
  spec: E2ESpec
  project: { tracks: number; clips: number; totalFrames: number }
  encoderProbe: unknown
  /** 模块 Worker 可用性（file:// 源下可能被 Chromium 拒绝） */
  workerProbe?: string
  /** 产物自检：容器包数 vs 实际解出帧数（不等 = 码流被写坏） */
  integrity?: { packets: number; decoded: number; errors: number } | null
  /** 时间轴映射检查结果（SSIM） */
  frameChecks?: { a: number; b: number; expect: string; ssim: number | null; pass: boolean }[]
  frameTimes: number[]
  fpsStats: { p50: number; p90: number; min: number; max: number; mean: number }
  logs: string[]
}

function avnUrl(absPath: string): string {
  return `avn-file://${encodeURIComponent(absPath)}`
}

/** 截获 console 的导出相关日志 */
function captureConsole(sink: string[]): () => void {
  const orig = { log: console.log, warn: console.warn, error: console.error }
  const wrap = (fn: (...a: unknown[]) => void): ((...a: unknown[]) => void) => {
    return (...a: unknown[]) => {
      try {
        fn(...a)
      } catch {
        /* 忽略 */
      }
      const line = a
        .map((x) => (typeof x === 'string' ? x : x instanceof Error ? (x.stack ?? x.message) : safeJson(x)))
        .join(' ')
      if (/\[(Export|mbExport|MediaCache|gpu|main)/.test(line)) sink.push(line)
    }
  }
  console.log = wrap(orig.log)
  console.warn = wrap(orig.warn)
  console.error = wrap(orig.error)
  return () => {
    console.log = orig.log
    console.warn = orig.warn
    console.error = orig.error
  }
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x)
  } catch {
    return String(x)
  }
}

function fpsStats(frameTimes: number[]): E2EReport['fpsStats'] {
  if (frameTimes.length < 2) return { p50: 0, p90: 0, min: 0, max: 0, mean: 0 }
  const deltas: number[] = []
  for (let i = 1; i < frameTimes.length; i++) deltas.push(frameTimes[i] - frameTimes[i - 1])
  deltas.sort((a, b) => a - b)
  const fpsOf = (ms: number): number => (ms > 0 ? 1000 / ms : 0)
  const at = (q: number): number => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * q))]
  const meanMs = deltas.reduce((a, b) => a + b, 0) / deltas.length
  return { p50: fpsOf(at(0.5)), p90: fpsOf(at(0.9)), min: fpsOf(deltas[deltas.length - 1]), max: fpsOf(deltas[0]), mean: fpsOf(meanMs) }
}

/** 探测 WebCodecs H.264 编码可用性（mediabunny 的 CanvasSource 走的就是它） */
async function probeEncoders(w: number, h: number, fps: number): Promise<unknown> {
  const out: Record<string, unknown> = { hasVideoEncoder: typeof VideoEncoder !== 'undefined' }
  if (typeof VideoEncoder === 'undefined') return out
  const variants: unknown[] = []
  for (const hw of ['prefer-hardware', 'no-preference', 'prefer-software'] as const) {
    for (const latencyMode of ['realtime', 'quality'] as const) {
      const cfg: VideoEncoderConfig = {
        codec: 'avc1.640028',
        width: w,
        height: h,
        bitrate: 20_000_000,
        framerate: fps,
        bitrateMode: 'variable',
        avc: { format: 'annexb' },
        latencyMode,
        hardwareAcceleration: hw
      }
      try {
        const s = await VideoEncoder.isConfigSupported(cfg)
        variants.push({ hw, latencyMode, supported: !!s?.supported })
      } catch (e) {
        variants.push({ hw, latencyMode, error: String((e as Error)?.message ?? e) })
      }
    }
  }
  out.variants = variants
  return out
}

/** 探测模块 Worker 能否在本渲染进程创建并通信（file:// 源下 Chromium 可能直接拒绝） */
function probeModuleWorker(): Promise<string> {
  return new Promise((resolve) => {
    let w: Worker | null = null
    const done = (s: string): void => { try { w?.terminate() } catch { /* 忽略 */ } resolve(s) }
    try {
      w = new Worker(new URL('./mbProbeWorker.ts', import.meta.url), { type: 'module' })
      const timer = setTimeout(() => done('timeout(未收到回包)'), 4000)
      w.onmessage = (e: MessageEvent) => { clearTimeout(timer); done(`ok(${String(e.data)})`) }
      w.onerror = (e: ErrorEvent) => { clearTimeout(timer); done(`error(${e.message || 'unknown'})`) }
      w.postMessage('ping')
    } catch (e) {
      done(`throw(${String((e as Error)?.message ?? e)})`)
    }
  })
}

/**
 * 预览回归测试（mode:'preview'）：真实挂载 PixiRenderer，喂一个带视频 clip 的工程逐帧渲染，
 * 然后**移除该 clip 再渲染**（触发 retire 回收路径），全程捕获异常。
 * 覆盖的是"导入素材拖到 clip 上就崩"这类渲染期崩溃（历史 bug：render() 调用了已删除的方法）。
 */
async function benchPreview(spec: E2ESpec, logs: string[]): Promise<{ frames: number; errors: string[]; ok: boolean; captureDataUrl: () => string | null }> {
  const fps = spec.fps ?? 30
  const errors: string[] = []
  const onError = (e: ErrorEvent): void => { errors.push(`window.onerror: ${e.message}`) }
  const onRejection = (e: PromiseRejectionEvent): void => { errors.push(`unhandledrejection: ${String(e.reason)}`) }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)

  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:720px'
  document.body.appendChild(host)
  const { PixiRenderer } = await import('../pixi/PixiRenderer')
  const r = new PixiRenderer(host)
  let frames = 0
  try {
    await r.init()
    const { project } = await buildProjectFromSpec(spec)
    const total = spec.benchFrames ?? Math.min(60, contentTotalFramesOf(project))
    logs.push(`[E2E-preview] 工程 ${project.tracks.length} 轨 / ${total} 帧，开始逐帧渲染`)
    // 阶段一：带 clip 渲染（视频层 + 文字层）
    for (let f = 0; f < total; f++) {
      r.updateInput(f, project, fps)
      r.render(f, project, fps)
      frames++
      await new Promise((res) => setTimeout(res, 8))
    }
    // 阶段二：移除全部 clip 再渲染 → 触发 retire 回收（崩溃高发点）
    const empty = { ...project, clips: Object.fromEntries(Object.keys(project.clips).map((k) => [k, []])) }
    for (let f = 0; f < 10; f++) {
      r.updateInput(f, empty, fps)
      r.render(f, empty, fps)
      frames++
      await new Promise((res) => setTimeout(res, 8))
    }
    logs.push(`[E2E-preview] 渲染完成 ${frames} 帧（含 clip 移除后的回收路径）`)

    // 等媒体就绪再截图：<video> 首次解码是异步的，太早截图只会得到空背景
    const settle = Date.now() + 2500
    while (Date.now() < settle) {
      r.updateInput(total - 1, project, fps)
      r.render(total - 1, project, fps)
      await new Promise((res) => setTimeout(res, 60))
    }
    logs.push('[E2E-preview] 媒体就绪等待结束，开始截图')

    // 预览截图落盘：目视验证"预览里到底画了什么"（曾经漏掉 adjust 层就是靠这个才发现）
    const shot = r.captureDataUrl()
    if (shot) {
      const shotPath = spec.out.replace(/[^\\/]+$/, 'preview-shot.png')
      const ok = await window.api.e2eSavePng(shotPath, shot)
      logs.push(`[E2E-preview] 预览截图 ${ok ? '已保存' : '保存失败'}: ${shotPath}`)
    } else {
      logs.push('[E2E-preview] 预览截图不可用（canvas 未就绪）')
    }
  } catch (e) {
    errors.push(`throw: ${String((e as Error)?.stack ?? e)}`)
  } finally {
    try { r.destroy() } catch (e) { errors.push(`destroy: ${String(e)}`) }
    host.remove()
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
  return { frames, errors, ok: errors.length === 0, captureDataUrl: () => r.captureDataUrl() }
}

function contentTotalFramesOf(project: Project): number {
  let max = 0
  for (const clips of Object.values(project.clips)) {
    for (const c of clips as Clip[]) max = Math.max(max, c.startFrame + c.durationFrames)
  }
  return max
}

/** 由 spec 构造一个真实工程（歌词 + 背景视频 + 音频）。 */export async function buildProjectFromSpec(spec: E2ESpec): Promise<{ project: Project; totalFrames: number }> {
  const fps = spec.fps ?? 30
  const seconds = spec.seconds ?? 20
  const [w, h] = spec.stage ?? [1920, 1080]
  const project = createProject({ fps, stage: { width: w, height: h }, design: { width: w, height: h } })

  // 轨道（order 0 = 最前）：P1 预设样式 > T1 歌词 > V1 背景视频 > A1 音频
  const hasPresets = (spec.presets?.length ?? 0) > 0
  // order 0 = 最前（zIndex 最高）。默认预设在最前；presetsBelowLyrics 时把歌词提到最前。
  const pOrder = spec.presetsBelowLyrics ? 1 : 0
  const tOrder = spec.presetsBelowLyrics ? 0 : (hasPresets ? 1 : 0)
  const p1 = createTrack({ id: 'p1', name: 'P1', kind: 'video', zone: 'video', order: pOrder })
  const t1 = createTrack({ id: 't1', name: 'T1', kind: 'text', zone: 'video', order: tOrder })
  const v1 = createTrack({ id: 'v1', name: 'V1', kind: 'video', zone: 'video', order: hasPresets ? 2 : 1 })
  const a1 = createTrack({ id: 'a1', name: 'A1', kind: 'audio', zone: 'audio', order: hasPresets ? 3 : 2 })
  const tracks: Track[] = hasPresets ? [p1, t1, v1, a1] : [t1, v1, a1]
  project.tracks = tracks
  project.clips = hasPresets ? { p1: [], t1: [], v1: [], a1: [] } : { t1: [], v1: [], a1: [] }

  const dur = Math.max(1, Math.round(seconds * fps))

  // 歌词层
  let lyricText = spec.text ?? ''
  if (spec.lrc) {
    const res = await fetch(avnUrl(spec.lrc))
    lyricText = await res.text()
  }
  if (lyricText) {
    project.clips.t1.push(createClip({
      id: 'clip-lyrics',
      trackId: 't1',
      type: 'text',
      name: '滚动歌词',
      startFrame: 0,
      durationFrames: dur,
      sourceStartFrame: 0,
      sourceDurationFrames: dur,
      content: lyricText,
      isLyrics: true,
      lyrics: defaultLyricStyle(),
      opacity: 1
    }))
  }

  // 背景视频（循环填满整段）
  if (spec.video) {
    project.clips.v1.push(createClip({
      id: 'clip-video',
      trackId: 'v1',
      type: 'video',
      name: '背景视频',
      startFrame: 0,
      durationFrames: dur,
      sourceStartFrame: 0,
      sourceDurationFrames: dur,
      src: avnUrl(spec.video),
      opacity: 1
    }))
  }

  // 音频
  if (spec.audio) {    project.clips.a1.push(createClip({
      id: 'clip-audio',
      trackId: 'a1',
      type: 'audio',
      name: '背景音乐',
      startFrame: 0,
      durationFrames: dur,
      sourceStartFrame: 0,
      sourceDurationFrames: dur,
      src: avnUrl(spec.audio),
      volume: 1
    }))
  }

  // 预设样式 clip（可视化 / 图片样式）
  if (hasPresets) {
    let i = 0
    for (const p of spec.presets ?? []) {
      const preset = getPreset(p.id)
      if (!preset) {
        console.warn(`[E2E] 未知预设 ${p.id}，跳过`)
        continue
      }
      const dur2 = Math.max(1, Math.round((p.seconds ?? seconds) * fps))
      project.clips.p1.push(createClip({
        id: `clip-preset-${i++}`,
        trackId: 'p1',
        type: preset.clipType,
        name: preset.name,
        startFrame: 0,
        durationFrames: dur2,
        sourceStartFrame: 0,
        sourceDurationFrames: dur2,
        src: p.image ? avnUrl(p.image) : undefined,
        opacity: 1,
        presetId: preset.id,
        params: p.params,
        keyframes: p.keyframes
      }))
    }
  }

  let totalFrames = 0
  for (const clips of Object.values(project.clips)) {
    for (const c of clips as Clip[]) totalFrames = Math.max(totalFrames, c.startFrame + c.durationFrames)
  }
  return { project, totalFrames }
}

/** 跑一次 E2E 导出并回传报告。 */
export async function runE2E(spec: E2ESpec): Promise<E2EReport> {
  const logs: string[] = []
  const stopCapture = captureConsole(logs)
  const [w, h] = spec.stage ?? [1920, 1080]
  const fps = spec.fps ?? 30
  const t0 = performance.now()
  const report: E2EReport = {
    ok: false,
    wallMs: 0,
    spec,
    project: { tracks: 0, clips: 0, totalFrames: 0 },
    encoderProbe: null,
    frameTimes: [],
    fpsStats: { p50: 0, p90: 0, min: 0, max: 0, mean: 0 },
    logs
  }
  try {
    // 预设注册表必须先初始化（内置 presets/** + 用户导入），否则 getPreset 全空、预设层不渲染
    await initPresetRegistry()
    report.encoderProbe = await probeEncoders(w, h, fps)
    report.workerProbe = await probeModuleWorker()
    logs.push(`[E2E-bench] 模块 Worker（file:// 源）：${report.workerProbe}`)
    {
      const ys = performance.now()
      for (let i = 0; i < 100; i++) await new Promise((r) => setTimeout(r, 0))
      logs.push(`[E2E-bench] setTimeout(0) 单次 ${((performance.now() - ys) / 100).toFixed(2)}ms`)
    }

    const { project, totalFrames } = await buildProjectFromSpec(spec)
    report.project = {
      tracks: project.tracks.length,
      clips: Object.values(project.clips).reduce((n, a) => n + a.length, 0),
      totalFrames
    }
    logs.push(`[E2E] 工程: ${report.project.tracks} 轨 / ${report.project.clips} clip / ${totalFrames} 帧 @${fps}fps ${w}x${h}`)
    logs.push(`[E2E] 预设注册表: ${listPresets().map((p) => p.id).join(', ') || '(空)'}`)

    if (spec.mode === 'preview') {
      const r = await benchPreview(spec, logs)
      report.frames = r.frames
      report.ok = r.ok
      report.error = r.ok ? null : r.errors.join(' | ')
      if (!r.ok) logs.push(`[E2E-preview] ❌ 渲染期异常：${r.errors.join(' | ')}`)
      else logs.push('[E2E-preview] ✅ 预览渲染无异常')
      return report
    }

    const res = await runMbExport({
      project,
      outPath: spec.out,
      bitrate: spec.bitrate,
      onProgress: (p: ExportProgress) => {
        report.frameTimes.push(performance.now() - t0)
        if (p.frames % 300 === 0) {
          logs.push(`[E2E] progress ${p.frames}/${p.totalFrames} fps=${p.fps.toFixed(1)} eta=${Math.round(p.etaSec)}s`)
        }
      }
    })
    report.ok = res.ok
    report.error = res.error ?? null
    report.outPath = res.outPath
    report.frames = res.frames

    // 产物自检（关键回归门）
    if (res.ok && res.outPath) {
      report.integrity = await window.api.e2eVerify(res.outPath)
      const it = report.integrity
      if (it) {
        const bad = it.decoded !== it.packets || it.errors > 0
        logs.push(
          `[E2E-verify] 容器包 ${it.packets} / 解出帧 ${it.decoded} / 解码错误 ${it.errors} → ` +
          (bad ? '❌ 码流被写坏（画面会色块崩坏/丢帧）' : '✅ 完整')
        )
        if (bad) report.ok = false
      }

      // 时间轴映射检查：循环应回到同一画面、非循环时间点应不同（抓"只播一次就定格"这类 bug）
      report.frameChecks = []
      for (const ck of spec.frameChecks ?? []) {
        const ssim = await window.api.e2eCompare(res.outPath, ck.a, ck.b)
        const min = ck.min ?? 0.9
        const max = ck.max ?? 0.9
        const pass = ssim == null
          ? false
          : ck.expect === 'same' ? ssim >= min : ssim <= max
        report.frameChecks.push({ a: ck.a, b: ck.b, expect: ck.expect, ssim, pass })
        logs.push(
          `[E2E-frames] t=${ck.a}s vs t=${ck.b}s SSIM=${ssim == null ? 'n/a' : ssim.toFixed(3)} ` +
          `（期望 ${ck.expect}${ck.expect === 'same' ? ` ≥${min}` : ` ≤${max}`}）→ ${pass ? '✅' : '❌'}`
        )
        if (!pass) report.ok = false
      }
    }
  } catch (e) {
    report.ok = false
    report.error = String((e as Error)?.stack ?? e)
    logs.push(`[E2E] 异常: ${report.error}`)
  } finally {
    report.wallMs = performance.now() - t0
    report.fpsStats = fpsStats(report.frameTimes)
    stopCapture()
  }
  return report
}
