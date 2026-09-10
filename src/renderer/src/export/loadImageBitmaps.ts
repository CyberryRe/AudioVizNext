/**
 * loadImageBitmaps.ts —— 预载工程里所有需要的图片为 ImageBitmap（逐帧复用，只解码一次）。
 *
 * 覆盖两类：
 *  1. image clip 绑定的素材（`clip.src`）；
 *  2. 预设参数里 type='image' 的引用（如「圆形」的边框纹理）。
 *
 * 独立成文件：导出循环跑在 Worker 里，不能 import 任何触碰 window/DOM 的模块。
 *
 * **GIF 动画**：`createImageBitmap` 对 GIF 只取首帧，故先嗅探魔数，是 GIF 则用自研
 * `decodeGif`（纯字节运算，无 DOM）解出全部帧，每帧画到 OffscreenCanvas 并作为「帧数组」
 * 返回。导出时按时间轴源帧选帧（与预览端 PixiRenderer 同一 `gifFrameIndex`）→ 导出 ≡ 预览。
 */
import type { Project } from '../model/timeline'
import { getPreset } from '../presets/registry'
import { decodeGif, isGifBytes, gifFrameIndex } from '../media/gif'

/** 图片素材：静态位图，或 GIF 的逐帧画布数组 */
export type LoadedImage = ImageBitmap | { gifFrames: OffscreenCanvas[]; width: number; height: number }

export async function loadImageBitmaps(project: Project): Promise<Map<string, LoadedImage>> {
  const srcs = new Set<string>()
  for (const track of project.tracks) {
    for (const c of project.clips[track.id] ?? []) {
      if (c.type === 'image' && c.src) srcs.add(c.src)
      const meta = getPreset(c.presetId)
      if (!meta) continue
      for (const p of meta.params) {
        if (p.type !== 'image') continue
        const v = c.params?.[p.key]
        if (typeof v === 'string' && v) srcs.add(v)
      }
    }
  }
  const map = new Map<string, LoadedImage>()
  for (const src of srcs) {
    try {
      const res = await fetch(src)
      if (!res.ok) {
        console.warn('[Export] image fetch failed:', src, res.status)
        continue
      }
      const blob = await res.blob()
      const head = new Uint8Array(await blob.slice(0, 6).arrayBuffer())
      if (isGifBytes(head)) {
        const gif = decodeGif(new Uint8Array(await blob.arrayBuffer()))
        if (gif && gif.frames.length > 1) {
          const canvases = gif.frames.map((f) => {
            const cv = new OffscreenCanvas(gif.width, gif.height)
            const cx = cv.getContext('2d')
            if (cx) cx.putImageData(new ImageData(f.data, gif.width, gif.height), 0, 0)
            return cv
          })
          map.set(src, { gifFrames: canvases, width: gif.width, height: gif.height })
          console.log(`[Export] GIF 已解码: ${gif.width}x${gif.height}, ${canvases.length} 帧`)
          continue
        }
        // 单帧 GIF / 解码失败 → 回退静态位图
      }
      map.set(src, await createImageBitmap(blob))
    } catch (e) {
      console.warn('[Export] image decode failed:', src, (e as Error)?.message)
    }
  }
  return map
}

/**
 * 从已加载图片里取「当前帧应用哪张位图」。GIF 按时间轴源帧选帧；静态图直接返回自身。
 * 预览端 PixiRenderer 用同一 `gifFrameIndex` → 两端选帧完全一致。
 */
export function imageForFrame(
  loaded: LoadedImage | undefined,
  sourceFrame: number,
  gifSpeed = 1
): (CanvasImageSource & { width: number; height: number }) | null {
  if (!loaded) return null
  if (loaded instanceof ImageBitmap) {
    return loaded as unknown as CanvasImageSource & { width: number; height: number }
  }
  const gif = loaded as { gifFrames: OffscreenCanvas[]; width: number; height: number }
  if (gif.gifFrames.length === 0) return null
  const idx = gifFrameIndex(sourceFrame, gif.gifFrames.length, gifSpeed)
  return gif.gifFrames[idx] as unknown as CanvasImageSource & { width: number; height: number }
}
