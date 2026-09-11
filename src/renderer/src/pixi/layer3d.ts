/**
 * layer3d.ts —— 「长方体透视舞台」几何底层（纯数学，无 DOM/Pixi 依赖）。
 *
 * **模型**：工程级维护**一个正对观众的长方体**。前墙（z=0）严格等于画幅矩形，相机固定在
 * 盒轴线上、距前墙 `camera`，朝 +z 看。用户只调「对面那个面（后墙）的距离」= `depth`
 * 来决定透视强弱；六个面由**同一个相机**推导 → 相邻面在公共棱上严格重合，透视天然自洽。
 *
 * 相比上一版「四角单应性」：
 *  - 旧模型每个 clip 各拖四个角，面与面之间没有共同相机 → 透视是否自洽只能靠眼睛；
 *    四角一旦拖到退化（地平线穿过图形）画面会撕裂。
 *  - 新模型每个面都是相机前方的凸四边形，投影有界、绝不退化；用户只需选「贴在哪个面」。
 *
 * **内容如何落到面上**：沿用 clip 原来的 stage 坐标排版，把 stage 坐标当作**该平面上的坐标**
 *  → 前面 ≡ 原来的 2D 效果（恒等，图片比例/位置/缩放全不变）；换面只是把同一份排版重新投影。
 *  坐标约定：世界原点 = 画幅中心，x 向右、y 向下、z 向屏幕里；stage 像素 → 世界：
 *  `cx = px - W/2`，`cy = py - H/2`。各面另有一维用于「深度」：
 *  左/右面用横向进度 u = px/W，顶/底面用纵向进度 v = py/H，后/前面直接用 (cx, cy)。
 *  六个面都保证内容在屏幕上**正立**（v=0 在上、u=0 在左）。
 *
 * 预览与导出共用同一 H 与同一细分网格 → 像素一致。
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

/** 四角（顺序：左上、右上、右下、左下） */
export type Quad = [Pt, Pt, Pt, Pt]

// ===== 长方体 =====

/** 长方体的六个面（相对观众：前面 = 画幅平面，后面 = 对面那个面） */
export type FaceId = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'

export const FACE_IDS: FaceId[] = ['front', 'back', 'left', 'right', 'top', 'bottom']

export const FACE_LABELS: Record<FaceId, string> = {
  front: '前面',
  back: '后面',
  left: '左面',
  right: '右面',
  top: '顶面',
  bottom: '底面'
}

/**
 * 工程级长方体（存工程）。默认 `enabled:false` → 全部 clip 走纯 2D。
 *
 * - `depth`：**对面（后墙）到前墙的距离**，以画幅宽度为单位。越大侧墙越深、透视越强。
 * - `camera`：相机到前墙的距离，以画幅宽度为单位。越大越像长焦（透视越弱），越小越广角。
 *   两个量都以画幅宽度为基准 → 换分辨率时观感不变（分辨率无关）。
 */
export interface Box3D {
  enabled?: boolean
  depth?: number
  camera?: number
  /** 预览是否叠加长方体线框（仅预览，不进导出） */
  showWireframe?: boolean
}

/** 用户可编辑的层 3D 参数（存工程）：只选「贴在哪个面」 */
export interface Layer3DStyle {
  enabled?: boolean
  /** 附着面。缺省 = front（= 不透视，等价于关闭） */
  face?: FaceId
}

/** 长方体默认值（新建工程 / 缺字段时补齐） */
export function defaultBox3D(): Required<Box3D> {
  return { enabled: false, depth: 0.35, camera: 1, showWireframe: true }
}

export function defaultLayer3D(): Layer3DStyle {
  return { enabled: false, face: 'front' }
}

/** 解析后的长方体（stage 像素；相机在 (0,0,-camera)） */
export interface ResolvedBox3D {
  enabled: boolean
  width: number
  height: number
  /** 深度（stage 像素） */
  depth: number
  /** 相机距离（stage 像素） */
  camera: number
  /** 用户原始配置里的线框开关 */
  showWireframe: boolean
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * 把工程里的 Box3D 解析成 stage 像素配置。
 * `enabled` 要求：显式开启 **且** 深度 > 0（深度为 0 时六个面退化成同一条线，无意义）。
 */
export function resolveBox3D(box: Box3D | undefined, stage: { width: number; height: number }): ResolvedBox3D {
  const w = Math.max(1, stage.width)
  const h = Math.max(1, stage.height)
  const base = w
  const depth = clamp(num(box?.depth, 0.35), 0, 4) * base
  const camera = clamp(num(box?.camera, 1), 0.15, 8) * base
  return {
    enabled: box?.enabled === true && depth > 1e-6,
    width: w,
    height: h,
    depth,
    camera,
    showWireframe: box?.showWireframe !== false
  }
}

/**
 * 透视投影：世界点 (x,y,z) → 屏幕坐标（**画幅中心为原点**，单位 stage 像素）。
 * 相机在 (0,0,-camera)，朝 +z；z=0 平面（前墙）恒等。
 */
export function project3D(x: number, y: number, z: number, box: ResolvedBox3D): { x: number; y: number; s: number } {
  const denom = box.camera + z
  // 面都落在 z ∈ [0, depth] → 分母恒 > 0；这里仍兜底防 NaN（极端参数下不炸）
  const s = denom > 1e-6 ? box.camera / denom : 0
  return { x: x * s, y: y * s, s }
}

/**
 * stage 坐标 (px,py) → 指定面上的世界点。
 *
 * **平面是无限的，长方体只是参考体积** —— 面只负责"这个平面在哪 + 用哪台相机"，不做任何
 * 渲染范围限制；内容按自己的 stage 坐标 1:1 落到平面上，超出盒子的部分照常渲染（只被画幅裁）。
 *
 *  - front：`(cx, cy, 0)`，恒等（≡ 2D）。
 *  - back：`(cx, cy, depth)`，前后位置不动、只被 `depth` 推远（"对面那个面"就是他）。
 *  - left/right：`x = ∓W/2`，`y = cy`，**深度 = 画幅横坐标 1:1**（左面 `z = px`，右面 `z = W - px`
 *    以便从左读到右）——等价于"把画幅沿该棱折过去"：形状不被盒子拉伸，位置不随 depth 漂移。
 *  - top/bottom：`y = ∓H/2`，`x = cx`，**深度 = 画幅纵坐标 1:1**（顶面 `z = py`，底面 `z = H - py`，
 *    保证内容在屏幕上正立）。
 *
 * 两个直接好处（都是"别限制渲染范围"）：① 侧墙/顶底的内容**与 depth 无关**，调深度只移动后墙，
 * 不会把已贴好的图拉扁或挪位；② `px > depth*W` 的内容自然落在盒子**外面**，照常投影渲染。
 */
export function faceToWorld(
  face: FaceId,
  px: number,
  py: number,
  box: ResolvedBox3D
): { x: number; y: number; z: number } {
  const W = box.width
  const H = box.height
  const D = box.depth
  const cx = px - W / 2
  const cy = py - H / 2
  switch (face) {
    case 'front':
      return { x: cx, y: cy, z: 0 }
    case 'back':
      return { x: cx, y: cy, z: D }
    case 'left':
      return { x: -W / 2, y: cy, z: px }
    case 'right':
      return { x: W / 2, y: cy, z: W - px }
    case 'top':
      return { x: cx, y: -H / 2, z: py }
    case 'bottom':
      return { x: cx, y: H / 2, z: H - py }
  }
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

/** 解析后的层 3D 配置（内部计算用） */
export interface ResolvedLayer3D {
  enabled: boolean
  /** 生效的附着面（未启用时 = front） */
  face: FaceId
  /** 内容盒子（stage 像素）——投影输入的定义域 */
  srcX: number
  srcY: number
  srcW: number
  srcH: number
  /** 内容盒四角投影后的目标四角（stage 像素，左上/右上/右下/左下） */
  quad: Quad
  /** 由内容盒单位方形 → 目标四角 的单应性（作用于 u,v ∈ [0,1]） */
  H: Mat3
  width: number
  height: number
}

/**
 * 把工程里的 Layer3DStyle + 长方体解析成 stage 像素配置（含单应性矩阵）。
 *
 * @param box   工程级长方体（未启用 / 缺省 → 恒不透视）
 * @param src   内容盒子（stage 像素）；缺省 = 整幅画幅
 */
export function resolveLayer3D(
  style: Layer3DStyle | undefined,
  stage: { width: number; height: number },
  box?: Box3D,
  src?: { x: number; y: number; w: number; h: number }
): ResolvedLayer3D {
  const rb = resolveBox3D(box, stage)
  const face: FaceId = style?.face ?? 'front'
  // front 面恒等（≡ 2D）→ 视为「未透视」，调用方走简单路径
  const active = rb.enabled && style?.enabled === true && face !== 'front'
  const s = src ?? { x: 0, y: 0, w: rb.width, h: rb.height }
  const cornersStage: [number, number][] = [
    [s.x, s.y],
    [s.x + s.w, s.y],
    [s.x + s.w, s.y + s.h],
    [s.x, s.y + s.h]
  ]
  // 未真正生效时 quad 必须退回「内容盒自身」（恒等）——否则调用方拿到一个用不上的畸变四边形
  const quadPx = (active
    ? cornersStage.map(([px, py]) => {
        const wp = faceToWorld(face, px, py, rb)
        const p = project3D(wp.x, wp.y, wp.z, rb)
        return { x: p.x + rb.width / 2, y: p.y + rb.height / 2 }
      })
    : cornersStage.map(([px, py]) => ({ x: px, y: py }))) as Quad
  const H = homographyFromUnitSquare(quadPx)
  return {
    enabled: active,
    face,
    srcX: s.x,
    srcY: s.y,
    srcW: s.w,
    srcH: s.h,
    quad: quadPx,
    H,
    width: rb.width,
    height: rb.height
  }
}

/**
 * 该 clip 的 3D 是否**有可能**生效（还须 `resolveLayer3D(...).enabled` 才算真生效——
 * 那里才知道长方体是否启用）。front 面恒等 → 返回 false，等价于关闭。
 */
export function isLayer3DActive(style: Layer3DStyle | undefined): boolean {
  if (style?.enabled !== true) return false
  const f = style.face
  return !!f && f !== 'front'
}

// ===== 绘制范围（出血）=====

/**
 * 每边最多外扩「画幅尺寸」的多少倍（0.5 = 画布最多 2× 画幅）。
 * 侧墙/顶底面的原像在深度方向趋于无穷（消失点），必须截断，否则画布会爆掉。
 */
export const LAYER3D_BLEED_MAX = 0.5
/** 侧墙/顶底面在「非深度轴」上的出血上限（内容越过画幅上下/左右边仍可见，但通常只差一点） */
export const LAYER3D_BLEED_CROSS = 0.15

/** 3×3 单应性求逆（h33 归一化为 1）；奇异返回 null */
export function invertMat3(m: Mat3): Mat3 | null {
  const a = m.h11; const b = m.h12; const c = m.h13
  const d = m.h21; const e = m.h22; const f = m.h23
  const g = m.h31; const h = m.h32
  const z = a * e - b * d
  if (!Number.isFinite(z) || Math.abs(z) < 1e-12) return null
  return {
    h11: (e - f * h) / z,
    h12: -(b - c * h) / z,
    h13: (b * f - c * e) / z,
    h21: -(d - f * g) / z,
    h22: (a - c * g) / z,
    h23: -(a * f - c * d) / z,
    h31: (d * h - e * g) / z,
    h32: -(a * h - b * g) / z
  }
}

/**
 * 该层**需要绘制的 stage 矩形**（整数、向外取整）——预设类层的离屏画布尺寸就用它。
 *
 * 为什么需要它（"面只当平面用，不做渲染范围限制"）：
 *  预设 drawer 只知道自己画在一张画幅大小的画布上，超出画幅的笔触会被 canvas 裁掉。
 *  贴到面上之后，"画幅矩形"正好被投成**那个面的矩形**（后面 = 画幅的 s 倍，侧墙 = 楔形），
 *  被 canvas 裁掉的部分就表现为**面边界处的一条硬切边**。
 *  这里把画幅**在该面上的原像**（把画幅四角经 H⁻¹ 投回内容坐标）取包围盒 → 画布覆盖到
 *  "画幅可见范围内的全部内容"，于是硬切边被推到画幅之外（画幅自己会裁，符合输出语义）。
 *
 * ⚠ 未启用 3D 时原样返回内容盒（不额外占显存）。
 */
export function layer3DDrawBox(
  style: Layer3DStyle | undefined,
  stage: { width: number; height: number },
  box3d?: Box3D,
  src?: { x: number; y: number; w: number; h: number }
): { x: number; y: number; w: number; h: number } {
  const base = src ?? { x: 0, y: 0, w: stage.width, h: stage.height }
  const cfg = resolveLayer3D(style, stage, box3d, base)
  if (!cfg.enabled) return base
  const padX = LAYER3D_BLEED_MAX * stage.width
  const padY = LAYER3D_BLEED_MAX * stage.height
  let x0 = base.x
  let y0 = base.y
  let x1 = base.x + base.w
  let y1 = base.y + base.h

  if (cfg.face === 'left' || cfg.face === 'right' || cfg.face === 'top' || cfg.face === 'bottom') {
    // 侧墙/顶底面：深度方向的原像是无界的（趋于消失点，甚至落到相机后面）→ 不用 H⁻¹ 硬算，
    // 直接按上限朝「更深」的一侧外扩；另一轴（内容越过画幅上下/左右边仍可见）给小出血。
    const cx = LAYER3D_BLEED_CROSS * stage.width
    const cy = LAYER3D_BLEED_CROSS * stage.height
    x0 -= cx
    x1 += cx
    y0 -= cy
    y1 += cy
    // 深度方向用掉「每边 0.5 画幅」预算的剩余部分（保证每边总外扩不超上限）
    const restX = Math.max(0, padX - cx)
    const restY = Math.max(0, padY - cy)
    if (cfg.face === 'left') x1 += restX
    else if (cfg.face === 'right') x0 -= restX
    else if (cfg.face === 'top') y1 += restY
    else y0 -= restY
  } else {
    // 前/后面与画幅平行：画幅在该面上的原像 = 画幅按 1/s 外扩，用 H⁻¹ 精确算
    const inv = invertMat3(cfg.H)
    if (!inv) return base
    const frameCorners: [number, number][] = [[0, 0], [cfg.width, 0], [cfg.width, cfg.height], [0, cfg.height]]
    for (const [X, Y] of frameCorners) {
      const p = mapUnitPoint(X, Y, inv)
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
      const sx = cfg.srcX + p.x * cfg.srcW
      const sy = cfg.srcY + p.y * cfg.srcH
      if (Number.isFinite(sx)) { x0 = Math.min(x0, sx); x1 = Math.max(x1, sx) }
      if (Number.isFinite(sy)) { y0 = Math.min(y0, sy); y1 = Math.max(y1, sy) }
    }
    x0 = Math.max(x0, base.x - padX)
    y0 = Math.max(y0, base.y - padY)
    x1 = Math.min(x1, base.x + base.w + padX)
    y1 = Math.min(y1, base.y + base.h + padY)
  }
  // 画布尺寸必须整数：向外取整（宁可多几个像素，也不要切掉内容）
  const ix0 = Math.floor(x0)
  const iy0 = Math.floor(y0)
  const ix1 = Math.ceil(x1)
  const iy1 = Math.ceil(y1)
  return { x: ix0, y: iy0, w: Math.max(1, ix1 - ix0), h: Math.max(1, iy1 - iy0) }
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
 * 双线性插值，GPU 会在三角形内部线性插值 → 画面折成两个平面（折痕）。细分后每格内线性
 * 近似误差极小 → 曲面连续、无折痕。段数由 `chooseGridSeg()` 按误差自适应选取。
 *
 * 返回可直接喂 Pixi `MeshGeometry`（positions/uvs/indices）与 Canvas 逐格绘制。
 * 顶点顺序：行主序（先 y 后 x）。导出端**复用同一顶点数组**逐格贴图 → 两端几何逐位一致。
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
  seg: number
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
    vertexCount,
    seg: n
  }
}

/**
 * 格内线性（双线性）插值相对真实投影的最大偏差（stage 像素，取格心）。
 * 用于自适应细分段数：误差 ∝ 1/seg²，所以探测一次即可外推需要的段数。
 */
export function gridErrorAt(
  box: { x: number; y: number; w: number; h: number },
  cfg: ResolvedLayer3D,
  seg: number
): number {
  if (!cfg.enabled) return 0
  const n = Math.max(1, Math.min(64, Math.floor(seg)))
  const cw = box.w / n
  const ch = box.h / n
  let max = 0
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x0 = box.x + cw * c
      const y0 = box.y + ch * r
      const p00 = projectStagePoint(x0, y0, cfg)
      const p10 = projectStagePoint(x0 + cw, y0, cfg)
      const p01 = projectStagePoint(x0, y0 + ch, cfg)
      const p11 = projectStagePoint(x0 + cw, y0 + ch, cfg)
      const bx = (p00.x + p10.x + p01.x + p11.x) / 4
      const by = (p00.y + p10.y + p01.y + p11.y) / 4
      const real = projectStagePoint(x0 + cw / 2, y0 + ch / 2, cfg)
      const d = Math.hypot(bx - real.x, by - real.y)
      if (d > max) max = d
    }
  }
  return max
}

/** 自适应段数上限：48×48 = 2304 格（1080p 下开销可接受，误差已远低于 0.1px） */
export const GRID_SEG_MAX = 48
/** 自适应段数下限 */
export const GRID_SEG_MIN = 8

/**
 * 按「格内偏差 < maxErrPx」选最小细分段数（8 的倍数，上限 48）。
 * 预览与导出必须调同一个函数 → 几何逐位一致。
 *
 * 注：`gridErrorAt` 量的是双线性格心偏差，而网格实际是三角形内仿射插值，极值略大于它，
 * 故阈值取得保守（默认 0.25px）。
 */
export function chooseGridSeg(
  box: { x: number; y: number; w: number; h: number },
  cfg: ResolvedLayer3D,
  maxErrPx = 0.25
): number {
  if (!cfg.enabled) return 1
  const probe = GRID_SEG_MIN
  const e = gridErrorAt(box, cfg, probe)
  if (!(e > maxErrPx)) return probe
  // 误差 ∝ 1/seg² → 先按探测值外推，再实测校验（外推是近似，强透视下会略低估）
  let seg = Math.min(GRID_SEG_MAX, Math.max(probe, Math.ceil((probe * Math.sqrt(e / maxErrPx)) / 4) * 4))
  while (seg < GRID_SEG_MAX && gridErrorAt(box, cfg, seg) > maxErrPx) seg = Math.min(GRID_SEG_MAX, seg + 4)
  return seg
}

// ===== 逐格贴图（导出端 Canvas 2D 用；与 Mesh 顶点同源）=====

export interface GridCellRects {
  /** 源矩形（**含出血**，源像素） */
  sx: number
  sy: number
  sw: number
  sh: number
  /** 目标矩形（单位格坐标，含与源同比例的外扩） */
  dx: number
  dy: number
  dw: number
  dh: number
}

/**
 * 逐格贴图时单格的「源矩形 + 目标矩形」（**相邻格必须外扩重叠，否则接缝处会出现裂痕**）。
 *
 * 两道独立成因，都必须靠外扩解决：
 *  ① **采样断裂**：每格 `drawImage` 只看得到自己那块子矩形，边界处的双线性采样被 clamp →
 *     相邻格在接缝两侧采样不连续（波形/渐变图最明显）。源矩形出血后，相邻格在公共边界处
 *     采到**同一源坐标**（可证：`sx + ((0-dx)/dw)*sw === sx' + ((1-dx')/dw')*sw'`）。
 *  ② **覆盖率缝**：抗锯齿按覆盖率合成，边界像素被两格各盖一半时
 *     `a = c1 + c2 - c1*c2 < 1`（最多漏 25% 底色）→ 画面出现网格状暗线。
 *     目标矩形各向外扩 ≥ 半像素后，跨边界的像素**必被其中一格完整覆盖**（覆盖率 = 1）→ 无漏底。
 *
 * 源/目标外扩必须同比例（否则内容被拉伸/错位）：调用方按「目标侧要外扩多少 stage 像素」
 * 反推源侧出血像素数 = `padStagePx * 源格尺寸 / 投影格边长`。
 * **出血不得越出源图**：`drawImage` 的源矩形越界时会按比例裁掉目标矩形（规范行为）→
 * 图层最外缘会少画约 1px。故四边出血各自夹紧在源图内（外缘侧不外扩，等价于没有邻居）。
 * 代价：外扩重叠区对**半透明内容**会被两次半透明覆盖（`a(2-a)`），仅沿网格线呈 1~2px 淡痕；
 * 不透明内容（视频/JPEG）与整层 opacity（调用方走暂存画布）都不受影响。
 */
export function gridCellDrawRects(
  c: number,
  r: number,
  seg: number,
  srcW: number,
  srcH: number,
  bleedX = 1,
  bleedY = bleedX
): GridCellRects {
  const n = Math.max(1, Math.floor(seg))
  const scw = srcW / n
  const sch = srcH / n
  const wantX = Math.max(0, bleedX)
  const wantY = Math.max(0, bleedY)
  // 四边分别夹到源图内（越界会被 drawImage 按比例裁掉目标）
  const bl = Math.min(wantX, c * scw)
  const br = Math.min(wantX, srcW - (c + 1) * scw)
  const bt = Math.min(wantY, r * sch)
  const bb = Math.min(wantY, srcH - (r + 1) * sch)
  const fx = scw === 0 ? 0 : 1 / scw
  const fy = sch === 0 ? 0 : 1 / sch
  return {
    sx: c * scw - bl,
    sy: r * sch - bt,
    sw: scw + bl + br,
    sh: sch + bt + bb,
    dx: -bl * fx,
    dy: -bt * fy,
    dw: 1 + (bl + br) * fx,
    dh: 1 + (bt + bb) * fy
  }
}

// ===== 预览线框 =====

export interface BoxWireframe {
  /** 六个面的投影四角（stage 像素），顺序同 FACE_IDS */
  faces: { id: FaceId; quad: Quad }[]
  /** 12 条棱（stage 像素） */
  edges: { a: Pt; b: Pt }[]
}

/**
 * 长方体线框（仅预览叠加，不进导出）：8 个世界角点 → 投影 → 六个面 + 12 条棱。
 * 未启用时返回 null。
 */
export function planBoxWireframe(box: Box3D | undefined, stage: { width: number; height: number }): BoxWireframe | null {
  const rb = resolveBox3D(box, stage)
  if (!rb.enabled) return null
  const hw = rb.width / 2
  const hh = rb.height / 2
  // 世界 8 角：前 0-3（左上、右上、右下、左下），后 4-7 同序
  const world: [number, number, number][] = [
    [-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0], [-hw, hh, 0],
    [-hw, -hh, rb.depth], [hw, -hh, rb.depth], [hw, hh, rb.depth], [-hw, hh, rb.depth]
  ]
  const P = world.map(([x, y, z]) => {
    const p = project3D(x, y, z, rb)
    return { x: p.x + rb.width / 2, y: p.y + rb.height / 2 }
  })
  // 面角点（与 faceToWorld 对「整幅内容盒」的结果一致 → HUD 与实际贴图严格重合）
  const faceIndex: Record<FaceId, [number, number, number, number]> = {
    front: [0, 1, 2, 3],
    back: [4, 5, 6, 7],
    left: [0, 4, 7, 3],
    right: [5, 1, 2, 6],
    top: [0, 1, 5, 4],
    bottom: [7, 6, 2, 3]
  }
  const faces = FACE_IDS.map((id) => {
    const idx = faceIndex[id]
    return { id, quad: idx.map((i) => P[i]) as Quad }
  })
  const edgeIdx: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0], // 前墙
    [4, 5], [5, 6], [6, 7], [7, 4], // 后墙
    [0, 4], [1, 5], [2, 6], [3, 7]  // 连接棱
  ]
  return { faces, edges: edgeIdx.map(([a, b]) => ({ a: P[a], b: P[b] })) }
}
