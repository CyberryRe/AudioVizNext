/**
 * presets/types.ts —— 预设样式的元数据 schema 与绘制契约。
 *
 * 组件化思路：
 *  - 每个预设样式 = `presets/<分类>/<id>/preset.json`（**声明式**：元数据 + 参数 schema）
 *    + 由 `drawer` 字段指向的**内置绘制器**（`presets/drawers/*.ts`）。
 *  - 检查器 UI 完全由 `params` schema 自动生成 → 新增样式不用改 UI 代码。
 *  - `.avnpre` 只携带声明 + 参数 + 资源（base64），**绝不携带可执行代码**（安全），
 *    因此导入的预设必须引用内置 drawer id；未知 drawer 会被拒绝。
 */

export type ParamType = 'number' | 'color' | 'bool' | 'select' | 'image' | 'gradient'

interface ParamBase {
  /** 参数键（存进 clip.params） */
  key: string
  label: string
  /** 检查器里的分组标题（同组连续渲染成一节） */
  group?: string
  /** 联动参数键：如缩放 Y 关联到 X（检查器显示 🔗 按钮） */
  link?: string
  hint?: string
}

export interface NumberParam extends ParamBase {
  type: 'number'
  min: number
  max: number
  step: number
  default: number
  /** 单位后缀（仅展示） */
  unit?: string
  /** 以百分比显示（内部仍存 0..1 等原值） */
  percent?: boolean
  /** 该参数支持关键帧（检查器显示 ⏱ 按钮；drawer 用 paramAt() 取值） */
  keyframe?: boolean
}

export interface ColorParam extends ParamBase { type: 'color'; default: string }
export interface BoolParam extends ParamBase { type: 'bool'; default: boolean }
export interface SelectParam extends ParamBase {
  type: 'select'
  options: { value: string; label: string }[]
  default: string
}
/** 引用工程素材库里的图片（存 src 字符串） */
export interface ImageParam extends ParamBase { type: 'image'; default?: string }

/** 渐变色标 */
export interface GradientStop { t: number; color: string }
/** 渐变值（存入 clip.params；线性带角度，径向从中心向外） */
export interface GradientValue {
  type: 'linear' | 'radial'
  /** 线性角度（度，0=向右，顺时针）；径向时忽略 */
  angle: number
  stops: GradientStop[]
}
export interface GradientParam extends ParamBase {
  type: 'gradient'
  default: GradientValue
}

export type PresetParam = NumberParam | ColorParam | BoolParam | SelectParam | ImageParam | GradientParam

export interface PresetAsset {
  key: string
  /** 相对 preset.json 的文件名（内置）或 userData 下的绝对路径（用户预设） */
  path: string
  mime: string
}

export interface PresetMeta {
  format: 'avnpreset'
  version: number
  id: string
  name: string
  category: 'visualization' | 'image' | 'effect'
  /** 生成的 clip 类型（visual = 无素材生成式；image = 需绑定图片；effect = 调整层） */
  clipType: 'visual' | 'image' | 'effect'
  /** 拖拽落轨的轨道类型 */
  kind: 'visual' | 'image'
  /** 内置绘制器 id（可作为 script 失败时的回退；纯 script 预设可为空串） */
  drawer: string
  /** 第三方脚本源码（.avnpre implementation.script；导入后编译执行） */
  script?: string
  /** 最近一次脚本编译/运行错误（UI 展示；成功则为空） */
  scriptError?: string | null
  durationFrames: number
  color?: string
  desc?: string
  params: PresetParam[]
  assets?: PresetAsset[]
  /** 调整层：作用于其下已合成画面（如高斯模糊），预览端需特殊合成 */
  adjust?: boolean
  /**
   * 调整层类型（预览端据此用 GPU 实现；导出端由 drawer 用 Canvas2D 实现）：
   * `blur` = 高斯模糊（强度/半径/压暗/饱和度）
   */
  adjustKind?: 'blur'
  /** 运行时填充：来源 */
  source?: 'builtin' | 'user'
}

/** 可作为 drawImage 源的图片（预览传 Pixi 纹理资源、导出传 ImageBitmap） */
export type PresetImage = CanvasImageSource & { width: number; height: number }

/** 绘制环境（预览与导出共用同一份语义） */
export interface PresetRenderEnv {
  /** 输出画布尺寸（= 工程 stage） */
  width: number
  height: number
  /** 时间轴帧 / 帧率 / 秒 */
  frame: number
  fps: number
  timeSec: number
  /** clip 内源帧（图片/视频类用） */
  sourceFrame: number
  /** 音频能量 0..1（可视化用；无音频时为静息值） */
  energy: number
  /**
   * 逐帧音频分析数据（波形/频谱/电平/粒子发射前缀）。
   * 预览与导出共用同一份（见 media/audioAnalysis.ts）→ 可视化逐帧一致。
   */
  audio?: import('../media/audioAnalysis').PresetAudioData | null
  /** 层透明度 0..1 */
  opacity: number
  /** clip 绑定的图片素材（image 类预设） */
  image?: PresetImage | null
  /** 参数字段引用的图片（如圆形边框纹理），key = 参数值(src) */
  images?: Map<string, PresetImage>
  /** 预设自带资源 URL（内置预设的 assets），key = asset.key */
  assets?: Map<string, string>
  /** 关键帧轨道（相对 clip 时长 0..1）：drawer 用 `paramAt(params, env.keyframes, key, env.tRel, 默认值)` 求值 */
  keyframes?: import('./keyframes').KeyframeTracks
  /** clip 内相对进度 0..1（关键帧求值用） */
  tRel?: number
  /**
   * 同帧「圆形」图片预设的几何（环形柱状图等跟随用）。
   * 由预览/导出从 scene 中第一个 circle 图片层算出；无则 null。
   */
  followCircle?: FollowCircle | null
  /**
   * 跟随圆形时，把 stage 坐标映射进「圆形图片的 3D 透视」的投影函数。
   *
   * = `projectStagePoint(x, y, resolveLayer3D(followCircle.layer3d, stage, followCircle.box))`
   * 的预解析版本（由渲染方按被跟随圆形的盒子+layer3d 构造）。未跟随 / 圆形未启用 3D 时为 undefined
   * → 调用方退回恒等（直接返回原坐标）。
   *
   * 为什么放在 env 而不是 drawer 自己算：**内容盒必须是「圆形图片盒」**（四角相对它归一化），
   * drawer 只知 stage 尺寸，拿不到该盒；由渲染方（预览 PixiRenderer / 导出 Worker）统一构造
   * → 预览与导出共用同一映射，保证「导出 ≡ 预览」。
   */
  followProject?: ((x: number, y: number) => { x: number; y: number }) | undefined
}

/**
 * 可被可视化跟随的圆形图片几何（舞台像素坐标）。
 *
 * 除圆心/半径/盘面旋转外，还带出**被跟随圆形 clip 的 3D 状态**：
 * 开启「跟随圆形」的层（如环形频谱）可用它把自身几何一并映射进同一套单应性，
 * 从而与圆形图片的整体 3D 透视严格同构（环随圆一起被压扁/倾斜）。
 */
export interface FollowCircle {
  x: number
  y: number
  radius: number
  /** 盘面旋转角（弧度），与圆形预设 spin 一致 */
  spinRad: number
  /**
   * 圆形图片的内容盒（stage 像素，左上原点）——与 imageShape.baseBox 同口径。
   * 四角 layer3d 就是相对**这个盒子**归一化的，跟随方必须用同一盒子解析才能对齐。
   */
  box?: { x: number; y: number; w: number; h: number }
  /** 圆形 clip 的四角 3D 样式（未启用/未设时为 undefined） */
  layer3d?: import('../pixi/layer3d').Layer3DStyle
}

export type PresetCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export type PresetDrawer = (
  ctx: PresetCtx,
  env: PresetRenderEnv,
  params: Record<string, unknown>,
  meta: PresetMeta
) => void

/** 取参数默认值（schema 的 default）。 */
export function defaultParams(meta: PresetMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of meta.params) out[p.key] = (p as { default?: unknown }).default ?? null
  return out
}

/** 数值参数读取（带范围钳制），参数缺失/非法时回退 schema 默认值。 */
export function num(params: Record<string, unknown>, meta: PresetMeta, key: string): number {
  const spec = meta.params.find((p) => p.key === key) as NumberParam | undefined
  const raw = params[key]
  const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : (spec?.default ?? 0)
  if (!spec) return v
  return Math.min(spec.max, Math.max(spec.min, v))
}

export function str(params: Record<string, unknown>, meta: PresetMeta, key: string): string {
  const spec = meta.params.find((p) => p.key === key) as { default?: string } | undefined
  const raw = params[key]
  return typeof raw === 'string' ? raw : (spec?.default ?? '')
}

export function bool(params: Record<string, unknown>, meta: PresetMeta, key: string): boolean {
  const spec = meta.params.find((p) => p.key === key) as BoolParam | undefined
  const raw = params[key]
  return typeof raw === 'boolean' ? raw : (spec?.default ?? false)
}

/** 渐变参数读取（非法结构回退 schema 默认值） */
export function gradient(params: Record<string, unknown>, meta: PresetMeta, key: string): GradientValue {
  const spec = meta.params.find((p) => p.key === key) as GradientParam | undefined
  const fallback: GradientValue = spec?.default ?? {
    type: 'linear',
    angle: 0,
    stops: [
      { t: 0, color: '#ff6b6b' },
      { t: 1, color: '#4ecdc4' }
    ]
  }
  const raw = params[key] as Partial<GradientValue> | undefined
  if (!raw || typeof raw !== 'object') return fallback
  const type = raw.type === 'radial' ? 'radial' : 'linear'
  const angle = Number.isFinite(raw.angle) ? (raw.angle as number) : fallback.angle
  const stops = Array.isArray(raw.stops) && raw.stops.length >= 2
    ? raw.stops
        .filter((s) => s && typeof s.t === 'number' && typeof s.color === 'string')
        .map((s) => ({ t: Math.min(1, Math.max(0, s.t)), color: s.color }))
        .sort((a, b) => a.t - b.t)
    : fallback.stops
  if (stops.length < 2) return fallback
  return { type, angle, stops }
}

/** 把 GradientValue 画到 Canvas（线性/径向）。预览与导出共用 → 像素一致。 */
export function paintGradient(
  ctx: PresetCtx,
  g: GradientValue,
  x: number,
  y: number,
  w: number,
  h: number
): CanvasGradient | string {
  if (!g.stops.length) return g.stops[0]?.color ?? '#888'
  if (g.type === 'radial') {
    const cx = x + w / 2
    const cy = y + h / 2
    const r = Math.hypot(w, h) / 2
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    for (const s of g.stops) grad.addColorStop(s.t, s.color)
    return grad
  }
  // 线性：角度（度）→ 单位向量，覆盖包围盒
  const rad = ((g.angle % 360) * Math.PI) / 180
  const dx = Math.cos(rad)
  const dy = Math.sin(rad)
  const cx = x + w / 2
  const cy = y + h / 2
  const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2
  const grad = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half)
  for (const s of g.stops) grad.addColorStop(s.t, s.color)
  return grad
}
