/**
 * layer3d.ts —— 可复用的「轴旋转 + 消失点」透视底层（纯数学，无 DOM/Pixi 依赖）。
 *
 * **泛用**：挂在 Clip 上，视频/图片/文本/可视化/预设层均可接入；预览与导出共用同一投影。
 * 不引入 Three.js，也不依赖 Canvas 不存在的 3D transform。
 *
 * 模型（档位 A：每元素仿射近似）：
 *  1. 屏幕平面点 P（stage 像素）绕「旋转轴」（过 axis、方向 axisAngle）做 3D 旋转 → 平面坐标 Q 与深度 z；
 *  2. 针孔透视：s = focal / (focal + z)，向消失点 VP 收缩 → P'；
 *  3. 在元素中心取 Jacobian 得到 2D 仿射矩阵，供 Pixi transform / Canvas setTransform。
 *
 * 调参 HUD 用 `layer3DHud()` 画轴线与 VP，仅预览叠加，不进导出。
 */
import type { LyricStyle } from '../model/timeline'

/** 2D 仿射矩阵（Canvas setTransform / Pixi 矩阵同一约定） */
export interface Mat2D {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

/** 用户可编辑的层 3D 参数（存工程；位置为画幅比例 0..1，角度为度） */
export interface Layer3DStyle {
  enabled?: boolean
  /** 旋转轴锚点，相对画幅 0..1 */
  axisX?: number
  axisY?: number
  /** 轴在屏幕上的方向（度），0 = 水平向右 */
  axisAngle?: number
  /** 绕轴旋转（度）；正值使轴一侧内容向屏幕内转 */
  rotate?: number
  /**
   * 消失点纵深距离（相对画幅短边比例，默认 0.9）。
   * **越小透视越猛**（近大远小越明显）；越大越接近正交/平面。
   * 与旧字段 `focal` 同义，优先读 `depth`。
   */
  depth?: number
  /** @deprecated 用 depth；保留兼容 */
  focal?: number
  /** 消失点，相对画幅 0..1 */
  vpX?: number
  vpY?: number
}

/** 解析后的像素坐标配置（内部计算用） */
export interface ResolvedLayer3D {
  enabled: boolean
  axisX: number
  axisY: number
  axisAngle: number
  rotateRad: number
  /** 相机/消失点纵深（像素），越小透视越强 */
  focal: number
  vpX: number
  vpY: number
  width: number
  height: number
}

export function defaultLayer3D(): Required<Omit<Layer3DStyle, 'focal'>> & { focal?: number } {
  return {
    enabled: false,
    axisX: 0.5,
    axisY: 0.5,
    axisAngle: 0,
    rotate: 0,
    depth: 0.9,
    vpX: 0.5,
    vpY: 0.5
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 把工程里的 Layer3DStyle 解析成 stage 像素配置 */
export function resolveLayer3D(
  style: Layer3DStyle | undefined,
  stage: { width: number; height: number }
): ResolvedLayer3D {
  const d = defaultLayer3D()
  const enabled = style?.enabled === true
  const w = stage.width
  const h = stage.height
  const minSide = Math.min(w, h)
  // depth 优先；兼容旧 focal
  const depthRel = num(style?.depth, num(style?.focal, d.depth))
  return {
    enabled,
    axisX: num(style?.axisX, d.axisX) * w,
    axisY: num(style?.axisY, d.axisY) * h,
    axisAngle: (num(style?.axisAngle, d.axisAngle) * Math.PI) / 180,
    rotateRad: (num(style?.rotate, d.rotate) * Math.PI) / 180,
    focal: Math.max(minSide * 0.08, depthRel * minSide),
    vpX: num(style?.vpX, d.vpX) * w,
    vpY: num(style?.vpY, d.vpY) * h,
    width: w,
    height: h
  }
}

/** 是否真正启用（enabled 且有可见旋转角） */
export function isLayer3DActive(style: Layer3DStyle | undefined): boolean {
  return style?.enabled === true && Math.abs(num(style.rotate, 0)) > 0.01
}

/**
 * 把已解析的轴/消失点整体平移（px）。
 * 用于「3D 跟随 Clip 位移」：轴与 VP 相对内容锚点保持不变。
 *
 * ⚠ 前提：**轴/VP 的平移量必须严格等于「内容自身的位移量」**。
 * 只要两者一致，内容相对轴的 perp/along 逐点不变 → 透视形状严格锁定。
 * 若跟随量多算/少算（如把与内容无关的位移也加进来），形状就会漂移。
 */
export function offsetResolvedLayer3D(
  cfg: ResolvedLayer3D,
  dx: number,
  dy: number
): ResolvedLayer3D {
  if (!cfg.enabled || (dx === 0 && dy === 0)) return cfg
  return {
    ...cfg,
    axisX: cfg.axisX + dx,
    axisY: cfg.axisY + dy,
    vpX: cfg.vpX + dx,
    vpY: cfg.vpY + dy
  }
}

/**
 * 由 clip 位移算出 layer3d 应跟随的偏移（stage px）。
 *
 * ⚠ 铁律：**跟随量必须严格等于「内容自身的实际位移量」**，多算一分形状就漂移。
 *
 * 两类层的「内容位移」来源不同，绝不可相加：
 * - `'media'`（视频/图片/文本）：内容位移 = `transform.x/y`（mediaBox / 文本框位置）。
 * - `'preset'`（可视化/图片样式预设）：内容**只**由 drawer 内的 `params.posX/posY` 决定，
 *   `transform.x/y` 不参与内容绘制 → 若也叠加 transform，轴会多跑一段而内容不动 → 形状漂移（旧 BUG）。
 */
export function layer3DClipOffset(
  layer3d: Layer3DStyle | undefined,
  stage: { width: number; height: number },
  kind: 'media' | 'preset',
  transform?: { x?: number; y?: number },
  params?: Record<string, unknown>
): { dx: number; dy: number } {
  if (!layer3d?.enabled) return { dx: 0, dy: 0 }
  let dx = 0
  let dy = 0
  if (kind === 'preset') {
    // 只认 drawer 内容位移
    if (params) {
      if (typeof params.posX === 'number' && Number.isFinite(params.posX)) {
        dx = num(params.posX, 0) * stage.width
      }
      if (typeof params.posY === 'number' && Number.isFinite(params.posY)) {
        dy = num(params.posY, 0) * stage.height
      }
    }
  } else {
    // 媒体/文本：内容位移 = transform
    dx = num(transform?.x, 0) * stage.width
    dy = num(transform?.y, 0) * stage.height
  }
  return { dx, dy }
}

/**
 * 投影 stage 平面一点 → 透视后坐标 + 缩放。
 * 未启用时恒等（便于调用方统一路径）。
 */
export function projectStagePoint(
  x: number,
  y: number,
  cfg: ResolvedLayer3D
): { x: number; y: number; s: number; z: number } {
  if (!cfg.enabled) return { x, y, s: 1, z: 0 }
  const ux = Math.cos(cfg.axisAngle)
  const uy = Math.sin(cfg.axisAngle)
  const nx = -uy
  const ny = ux
  const dx = x - cfg.axisX
  const dy = y - cfg.axisY
  const along = dx * ux + dy * uy
  const perp = dx * nx + dy * ny
  const cos = Math.cos(cfg.rotateRad)
  const sin = Math.sin(cfg.rotateRad)
  const perp2 = perp * cos
  const z = perp * sin
  const qx = cfg.axisX + along * ux + perp2 * nx
  const qy = cfg.axisY + along * uy + perp2 * ny
  const denom = Math.max(cfg.focal * 0.12, cfg.focal + z)
  const s = cfg.focal / denom
  return {
    x: cfg.vpX + (qx - cfg.vpX) * s,
    y: cfg.vpY + (qy - cfg.vpY) * s,
    s,
    z
  }
}

/**
 * 在 (x,y) 处求投影的仿射近似（Jacobian）。
 * `ctx.setTransform(a,b,c,d,e,f)`；局部 (0,0) 落在投影中心。
 */
export function affineAt(x: number, y: number, cfg: ResolvedLayer3D): Mat2D {
  if (!cfg.enabled) {
    return { a: 1, b: 0, c: 0, d: 1, e: x, f: y }
  }
  const eps = 1
  const p0 = projectStagePoint(x, y, cfg)
  const px = projectStagePoint(x + eps, y, cfg)
  const py = projectStagePoint(x, y + eps, cfg)
  const a = (px.x - p0.x) / eps
  const b = (px.y - p0.y) / eps
  const c = (py.x - p0.x) / eps
  const d = (py.y - p0.y) / eps
  return { a, b, c, d, e: p0.x, f: p0.y }
}

/** 盒子四角（左上、右上、右下、左下）投影后的 stage 坐标 —— 真透视用 */
export function projectBoxCorners(
  x: number,
  y: number,
  w: number,
  h: number,
  cfg: ResolvedLayer3D
): { x: number; y: number }[] {
  const pts = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h]
  ]
  return pts.map(([px, py]) => {
    const p = projectStagePoint(px, py, cfg)
    return { x: p.x, y: p.y }
  })
}

/**
 * 细分网格（真透视曲面）：把 box 沿 X/Y 各切 `seg` 段，逐顶点投影。
 *
 * **为什么必须细分**：`s = focal/(focal+z)` 是非线性投影。只给 4 个角做双线性插值，
 * GPU 会在三角形内部线性插值 → 画面被「折成两个平面」（旋转越大折痕越明显）。
 * 细分后每格内线性近似误差极小 → 曲面连续、无折痕。
 *
 * 返回可直接喂给 Pixi `MeshGeometry`（positions/uvs/indices）与 Canvas 逐格绘制。
 * 顶点顺序：行主序（先 y 后 x），行内 x 递增、行间 y 递增。
 */
export function planPerspectiveGrid(
  box: { x: number; y: number; w: number; h: number },
  cfg: ResolvedLayer3D,
  seg = 16
): {
  positions: Float32Array
  uvs: Float32Array
  indices: Uint32Array
  /** 投影后四角（左上、右上、右下、左下）——供轮廓辅助线用 */
  corners: { x: number; y: number }[]
  /** 顶点数 */
  vertexCount: number
} {
  const n = Math.max(1, Math.min(64, Math.floor(seg)))
  const cols = n + 1
  const rows = n + 1
  const vertexCount = cols * rows
  const positions = new Float32Array(vertexCount * 2)
  const uvs = new Float32Array(vertexCount * 2)
  for (let r = 0; r < rows; r++) {
    const v = r / n
    const sy = box.y + box.h * v
    for (let c = 0; c < cols; c++) {
      const u = c / n
      const sx = box.x + box.w * u
      const p = projectStagePoint(sx, sy, cfg)
      const i = r * cols + c
      positions[i * 2] = p.x
      positions[i * 2 + 1] = p.y
      uvs[i * 2] = u
      uvs[i * 2 + 1] = v
    }
  }
  // 三角形索引：每格两个三角形
  const indices = new Uint32Array(n * n * 6)
  let k = 0
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i0 = r * cols + c
      const i1 = i0 + 1
      const i2 = i0 + cols
      const i3 = i2 + 1
      indices[k++] = i0
      indices[k++] = i1
      indices[k++] = i3
      indices[k++] = i0
      indices[k++] = i3
      indices[k++] = i2
    }
  }
  return {
    positions,
    uvs,
    indices,
    corners: projectBoxCorners(box.x, box.y, box.w, box.h, cfg),
    vertexCount
  }
}

/** 预览调参 HUD：旋转轴线段 + 消失点（仅预览叠加） */export function layer3DHud(cfg: ResolvedLayer3D): {
  axis: { x1: number; y1: number; x2: number; y2: number }
  vp: { x: number; y: number }
  angleDeg: number
  rotateDeg: number
} | null {
  if (!cfg.enabled) return null
  const L = Math.hypot(cfg.width, cfg.height) * 1.2
  const ux = Math.cos(cfg.axisAngle)
  const uy = Math.sin(cfg.axisAngle)
  return {
    axis: {
      x1: cfg.axisX - ux * L,
      y1: cfg.axisY - uy * L,
      x2: cfg.axisX + ux * L,
      y2: cfg.axisY + uy * L
    },
    vp: { x: cfg.vpX, y: cfg.vpY },
    angleDeg: (cfg.axisAngle * 180) / Math.PI,
    rotateDeg: (cfg.rotateRad * 180) / Math.PI
  }
}
