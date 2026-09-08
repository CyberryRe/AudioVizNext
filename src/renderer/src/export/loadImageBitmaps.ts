/**
 * loadImageBitmaps.ts —— 预载工程里所有需要的图片为 ImageBitmap（逐帧复用，只解码一次）。
 *
 * 覆盖两类：
 *  1. image clip 绑定的素材（`clip.src`）；
 *  2. 预设参数里 type='image' 的引用（如「圆形」的边框纹理）。
 *
 * 独立成文件：导出循环跑在 Worker 里，不能 import 任何触碰 window/DOM 的模块。
 */
import type { Project } from '../model/timeline'
import { getPreset } from '../presets/registry'

export async function loadImageBitmaps(project: Project): Promise<Map<string, ImageBitmap>> {
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
  const map = new Map<string, ImageBitmap>()
  for (const src of srcs) {
    try {
      const res = await fetch(src)
      if (!res.ok) {
        console.warn('[Export] image fetch failed:', src, res.status)
        continue
      }
      map.set(src, await createImageBitmap(await res.blob()))
    } catch (e) {
      console.warn('[Export] image decode failed:', src, (e as Error)?.message)
    }
  }
  return map
}
