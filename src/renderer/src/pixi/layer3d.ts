/**
 * layer3d.ts —— 可复用的「四角单应性」透视底层（纯数学，无 DOM/Pixi 依赖）。
 *
 * **模型**：一个平面（源矩形）被映射到任意四边形（目标四角），中间用
 * **单应性变换（homography，3×3）** 插值——这是数学上唯一能精确把矩形映射成任意
 * 四边形的透视变换，等同于 Photoshop「透视扭曲」。
 *
 * 相比旧「轴旋转 + 消失点 + 纵深」模型：
 *  - 用户直接摆四个角（最直观）；不再需要理解「消失点在画面哪里」；
 *  - 数学精确，无针孔近似的退化（旧模型消失点一动就变鬼样）。
 *
 * 预览与导出共用同一 H 与同一细分网格 → 像素一致。
 * 调参 HUD 画四角与四边形轮廓（仅预览叠加，不进导出）。
 */

/** 2D 仿射矩阵（Canvas setTransform / Pixi 矩阵同一约定） */
export interface Mat2D {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

/** 单应性矩阵（行主序 3×3，h33 归一化为 1） */
export interface Mat3 {
  h11: number; h12: number; h13: number
  h21: number; h22: number; h23: number
  h31: number; h32: number
}

/** 一个点 */
export interface Pt {
  x: number
  y: number
}

/** 四角（顺序：左上、右上、右下、左下），相对画幅 0..1 */
export type Quad = [Pt, Pt, Pt, Pt]

/**
 * 用户可编辑的层 3D 参数（存工程）。
 *
 * **四角相对「内容盒子」**（不是画幅）的归一化坐标 0..1：
 *  - 默认 (0,0)(1,0)(1,1)(0,1) = 内容盒子自身 → 恒等（不变）。
 *  - 拖角 = 相对内容做透视扭曲。
 *  - 移动内容（transform / 预设 posX）时四角自动跟随源盒 → 形状严格锁定。
 *
 * 旧的 axis/vp/depth 字段保留用于**旧工程迁移**。
 */
export interface Layer3DStyle {
  enabled?: boolean
  /** 四角（左上、右上、右下、左下），相对内容盒子 0..1 */
  corners?: Quad
  /** @deprecated 旧轴旋转模型；仅迁移用 */
  axisX?: number
  axisY?: number
  axisAngle?: number
  rotate?: number
  depth?: number
  focal?: number
  vpX?: number
  vpY?: number
}

/** 解析后的像素坐标配置（内部计算用） */
export interface ResolvedLayer3D {
  enabled: boolean
  /** 内容盒子（stage 像素）——投影输入的定义域 */
  srcX: number
  srcY: number
  srcW: number
  srcH: number
  /** 目标四角（stage 像素，左上/右上/右下/左下） */
  quad: Quad
  /** 由内容盒子单位方形 → 目标四角 的单应性（作用于 u,v ∈ [0,1]） */
  H: Mat3
  width: number
  height: number
}

export function defaultLayer3D(): { enabled: boolean; corners: Quad } {
  return {
    enabled: false,
    corners: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 }
    ]
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

// ===== 单应性 =====

/** 8×8 线性方程组高斯消元（部分主元）；奇异返回 null */
function solve8(A: number[][], b: number[]): number[] | null {
  const n = 8
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null
    if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t }
    const d = M[col][col]
    for (let c = col; c <= n; c++) M[col][c] /= d
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col]
      if (f === 0) continue
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row) => row[n])
}

/**
 * 求把「单位方形四角 (0,0)(1,0)(1,1)(0,1)」映射到目标四角 `dst` 的单应性矩阵。
 * 退化（自交/共线）时回退为单位矩阵（调用方不会崩，只是退化成恒等）。
 */
export function homographyFromUnitSquare(dst: Quad): Mat3 {
  const sx = [0, 1, 1, 0]
  const sy = [0, 0, 1, 1]
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const X = dst[i].x
    const Y = dst[i].y
    const x = sx[i]
    const y = sy[i]
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X])
    b.push(X)
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y])
    b.push(Y)
  }
  const hv = solve8(A, b)
  if (!hv) return { h11: 1, h12: 0, h13: 0, h21: 0, h22: 1, h23: 0, h31: 0, h32: 0 }
  return { h11: hv[0], h12: hv[1], h13: hv[2], h21: hv[3], h22: hv[4], h23: hv[5], h31: hv[6], h32: hv[7] }
}

/** 用单应性映射单位方形内一点 (u,v) → 目标坐标 */
export function mapUnitPoint(u: number, v: number, H: Mat3): { x: number; y: number; w: number } {
  const X = H.h11 * u + H.h12 * v + H.h13
  const Y = H.h21 * u + H.h22 * v + H.h23
  const W = H.h31 * u + H.h32 * v + 1
  const iw = Math.abs(W) < 1e-9 ? 1e9 : 1 / W
  return { x: X * iw, y: Y * iw, w: W }
}

/**
 * 旧「轴旋转 + 消失点」模型 → 四角（读取旧工程时一次性迁移）。
 */
function legacyToCorners(style: Layer3DStyle, w: number, h: number): Quad {
  const minSide = Math.min(w, h)
  const axisX = num(style.axisX, 0.5) * w
  const axisY = num(style.axisY, 0.5) * h
  const aa = (num(style.axisAngle, 0) * Math.PI) / 180
  const rr = (num(style.rotate, 0) * Math.PI) / 180
  const focal = Math.max(minSide * 0.08, num(style.depth, num(style.focal, 0.9)) * minSide)
  const vpX = num(style.vpX, 0.5) * w
  const vpY = num(style.vpY, 0.5) * h
  const ux = Math.cos(aa)
  const uy = Math.sin(aa)
  const nx = -uy
  const ny = ux
  const cos = Math.cos(rr)
  const sin = Math.sin(rr)
  const proj = (x: number, y: number): Pt => {
    const dx = x - axisX
    const dy = y - axisY
    const along = dx * ux + dy * uy
    const perp = dx * nx + dy * ny
    const qx = axisX + along * ux + perp * cos * nx
    const qy = axisY + along * uy + perp * cos * ny
    const z = perp * sin
    const s = focal / Math.max(focal * 0.12, focal + z)
    return { x: (vpX + (qx - vpX) * s) / w, y: (vpY + (qy - vpY) * s) / h }
  }
  return [proj(0, 0), proj(w, 0), proj(w, h), proj(0, h)]
}

/**
 * 把工程里的 Layer3DStyle 解析成 stage 像素配置（含单应性矩阵）。
 *
 * @param src 内容盒子（stage 像素）：四角是相对它的归一化坐标。默认整幅画幅。
 */
export function resolveLayer3D(
  style: Layer3DStyle | undefined,
  stage: { width: number; height: number },
  src?: { x: number; y: number; w: number; h: number }
): ResolvedLayer3D {
  const w = stage.width
  const h = stage.height
  const s = src ?? { x: 0, y: 0, w, h }
  const enabled = style?.enabled === true
  let quadRel: Quad
  if (style?.corners && style.corners.length === 4) {
    quadRel = style.corners
  } else if (style && (style.rotate !== undefined || style.vpX !== undefined || style.depth !== undefined)) {
    quadRel = legacyToCorners(style, s.w, s.h)
  } else {
    quadRel = defaultLayer3D().corners
  }
  // 相对内容盒 → stage 像素
  const quadPx = quadRel.map((p) => ({
    x: s.x + p.x * s.w,
    y: s.y + p.y * s.h
  })) as Quad
  const H = homographyFromUnitSquare(quadPx)
  return {
    enabled,
    srcX: s.x,
    srcY: s.y,
    srcW: s.w,
    srcH: s.h,
    quad: quadPx,
    H,
    width: w,
    height: h
  }
}

/** 是否真正启用（enabled 且四角非恒等矩形） */
export function isLayer3DActive(style: Layer3DStyle | undefined): boolean {
  if (style?.enabled !== true) return false
  const q = style.corners
  if (!q || q.length !== 4) {
    return style.rotate !== undefined || style.vpX !== undefined || style.depth !== undefined
  }
  const id = defaultLayer3D().corners
  for (let i = 0; i < 4; i++) {
    if (Math.abs(q[i].x - id[i].x) > 1e-4 || Math.abs(q[i].y - id[i].y) > 1e-4) return true
  }
  return false
}

/**
 * 由 clip 位移算出「内容自身位移量」（相对画幅比例）。
 * 仅用于诊断/兼容；**渲染不再需要跟随偏移**——四角相对内容盒，源矩形已随内容移动。
 *
 * ⚠ 若将来要恢复跟随，铁律：跟随量必须严格等于内容自身位移量，多算一分形状就漂移。
 */
export function layer3DClipOffset(
  layer3d: Layer3DStyle | undefined,
  kind: 'media' | 'preset',
  transform?: { x?: number; y?: number },
  params?: Record<string, unknown>
): { dx: number; dy: number } {
  if (!layer3d?.enabled) return { dx: 0, dy: 0 }
  if (kind === 'preset') {
    return { dx: num(params?.posX, 0), dy: num(params?.posY, 0) }
  }
  return { dx: num(transform?.x, 0), dy: num(transform?.y, 0) }
}

// ===== 投影 =====

/**
 * 投影 stage 源平面上一点 → 单应性映射后的目标坐标。
 * 未启用时恒等（便于调用方统一路径）。
 * 输入点若落在 `cfg.src*` 矩形外，仍按同一 H 外推（不影响直线映射）。
 */
export function projectStagePoint(
  x: number,
  y: number,
  cfg: ResolvedLayer3D
): { x: number; y: number; s: number; z: number } {
  if (!cfg.enabled) return { x, y, s: 1, z: 0 }
  const u = cfg.srcW === 0 ? 0 : (x - cfg.srcX) / cfg.srcW
  const v = cfg.srcH === 0 ? 0 : (y - cfg.srcY) / cfg.srcH
  const p = mapUnitPoint(u, v, cfg.H)
  // s：局部尺度（用 w 分量近似透视缩放），供诊断/兼容旧调用
  const s = Math.abs(p.w) < 1e-9 ? 1 : 1 / Math.abs(p.w)
  return { x: p.x, y: p.y, s, z: p.w - 1 }
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

/** 盒子四角（左上、右上、右下、左下）投影后的 stage 坐标 */
export function projectBoxCorners(
  x: number,
  y: number,
  w: number,
  h: number,
  cfg: ResolvedLayer3D
): Pt[] {
  const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
  return pts.map(([px, py]) => {
    const p = projectStagePoint(px, py, cfg)
    return { x: p.x, y: p.y }
  })
}

/**
 * 细分网格：把 box 沿 X/Y 各切 `seg` 段，逐顶点投影。
 *
 * **为什么必须细分**：单应性在四边形内部是「有透视的」非线性映射；只给 4 个角做
 * 双线性插值，GPU 会在三角形内部线性插值 → 画面折成两个平面。细分后每格内线性
 * 近似误差极小 → 曲面连续、无折痕。
 *
 * 返回可直接喂 Pixi `MeshGeometry`（positions/uvs/indices）与 Canvas 逐格绘制。
 * 顶点顺序：行主序（先 y 后 x）。
 */
export function planPerspectiveGrid(
  box: { x: number; y: number; w: number; h: number },
  cfg: ResolvedLayer3D,
  seg = 16
): {
  positions: Float32Array
  uvs: Float32Array
  indices: Uint32Array
  corners: Pt[]
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

/**
 * 预览调参 HUD：四角手柄 + 四边形轮廓 + 源矩形框。
 * 仅预览叠加，不进导出。
 */
export function layer3DHud(cfg: ResolvedLayer3D): {
  corners: Pt[]
  srcRect: { x: number; y: number; w: number; h: number }
  center: Pt
} | null {
  if (!cfg.enabled) return null
  const center = {
    x: (cfg.quad[0].x + cfg.quad[1].x + cfg.quad[2].x + cfg.quad[3].x) / 4,
    y: (cfg.quad[0].y + cfg.quad[1].y + cfg.quad[2].y + cfg.quad[3].y) / 4
  }
  return {
    corners: cfg.quad,
    srcRect: { x: cfg.srcX, y: cfg.srcY, w: cfg.srcW, h: cfg.srcH },
    center
  }
}
