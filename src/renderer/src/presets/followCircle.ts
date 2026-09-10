/**
 * followCircle.ts —— 从场景图片层中找出「圆形」预设的几何，供可视化（环形柱状图）跟随。
 * 预览（Pixi）与导出（Worker）共用 → 跟随结果一致。
 */
import type { Project } from '../model/timeline'
import type { FollowCircle, PresetMeta } from './types'
import { getPreset } from './registry'
import { num, str } from './types'
import { resolveLayer3D, projectStagePoint, isLayer3DActive } from '../pixi/layer3d'

/** 与 drawers/imageShape.baseBox 同口径 */
function circleFromImageClip(
  clip: {
    src?: string
    presetId?: string
    params?: Record<string, unknown>
    transform?: { x?: number; y?: number; scaleX?: number; scaleY?: number }
    layer3d?: import('../pixi/layer3d').Layer3DStyle
  },
  imgW: number,
  imgH: number,
  stage: { width: number; height: number },
  timeSec: number,
  fps: number
): FollowCircle | null {
  const meta: PresetMeta | undefined = getPreset(clip.presetId)
  if (!meta) return null
  const shape = str(clip.params ?? {}, meta, 'shape')
  // 仅圆形图片预设（内置 id=circle 或 shape=circle）
  if (meta.id !== 'circle' && shape !== 'circle') return null

  const px = num(clip.params ?? {}, meta, 'posX')
  const py = num(clip.params ?? {}, meta, 'posY')
  const sx = num(clip.params ?? {}, meta, 'scaleX')
  const sy = num(clip.params ?? {}, meta, 'scaleY')
  // imageShape.baseBox：以图片高铺满画框高
  const scaleH = stage.height / (imgH || 1)
  const w = imgW * scaleH * sx
  const h = stage.height * sy
  const x = stage.width / 2 + px * stage.width
  const y = stage.height / 2 + py * stage.height
  const radius = Math.min(w, h) / 2
  if (!(radius > 1)) return null
  // 边框外扩：跟随半径用「图片圆 + 边框」外沿，环形柱才会贴在唱片外侧
  const bwFrac = num(clip.params ?? {}, meta, 'borderWidth')
  const borderStyle = str(clip.params ?? {}, meta, 'borderStyle')
  const bw = borderStyle !== 'none' ? bwFrac * radius : 0
  const spin = num(clip.params ?? {}, meta, 'spin')
  const spinRad = (spin * 360 * timeSec * Math.PI) / 180
  void fps
  return {
    x,
    y,
    radius: radius + Math.max(0, bw),
    spinRad,
    // 内容盒（左上原点）——与 imageShape.baseBox 完全一致，供跟随方解析同一套 3D 单应性
    box: { x: x - w / 2, y: y - h / 2, w, h },
    layer3d: clip.layer3d
  }
}

/**
 * 在当前帧活跃的 image 层里找第一个圆形预设。
 * @param getImageSize 由 src 取纹理像素尺寸（预览用 Texture，导出用 ImageBitmap）
 */
export function findFollowCircle(
  project: Project,
  frame: number,
  getImageSize: (src: string) => { width: number; height: number } | null
): FollowCircle | null {
  const stage = project.stage
  const fps = project.fps || 30
  const timeSec = frame / fps
  for (const track of project.tracks) {
    if (track.disabled) continue
    for (const clip of project.clips[track.id] ?? []) {
      if (clip.disabled || clip.type !== 'image' || !clip.src) continue
      const end = clip.startFrame + clip.durationFrames
      if (frame < clip.startFrame || frame >= end) continue
      const size = getImageSize(clip.src)
      if (!size || size.width < 1 || size.height < 1) continue
      const hit = circleFromImageClip(
        { src: clip.src, presetId: clip.presetId, params: clip.params, transform: clip.transform, layer3d: clip.layer3d },
        size.width,
        size.height,
        stage,
        timeSec,
        fps
      )
      if (hit) return hit
    }
  }
  return null
}

/**
 * 构造「把 stage 坐标映射进被跟随圆形剪贴 3D 透视」的投影函数。
 *
 * 内容盒 = 圆形图片的内容盒（四角 layer3d 相对它归一化）；被跟随圆形未启用 3D 或缺少盒信息时
 * 返回 **undefined**（调用方退回恒等，保持旧行为）。
 *
 * 预览（PixiRenderer）与导出（Worker）都调用**这一个函数** → 两端映射逐点一致 → 导出 ≡ 预览。
 */
export function followProjection(
  follow: FollowCircle | null | undefined,
  stage: { width: number; height: number }
): ((x: number, y: number) => { x: number; y: number }) | undefined {
  if (!follow || !follow.box || !isLayer3DActive(follow.layer3d)) return undefined
  const cfg = resolveLayer3D(follow.layer3d, stage, follow.box)
  if (!cfg.enabled) return undefined
  return (x: number, y: number) => {
    const p = projectStagePoint(x, y, cfg)
    return { x: p.x, y: p.y }
  }
}
