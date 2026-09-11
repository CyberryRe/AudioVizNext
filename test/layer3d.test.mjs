/**
 * layer3d.test.mjs —— 「长方体透视舞台」投影底层单测（纯数学）。
 *
 * 模型：工程级长方体（前墙 = 画幅平面），相机在盒轴线上；每个 clip 选贴在哪个面。
 * 关键性质：① 前面 ≡ 恒等；② 六个面由同一相机推导 → 相邻面公共棱严格重合；③ 投影恒有界（不撕裂）。
 */
import {
  resolveLayer3D,
  resolveBox3D,
  projectStagePoint,
  project3D,
  faceToWorld,
  affineAt,
  isLayer3DActive,
  planBoxWireframe,
  planPerspectiveGrid,
  gridErrorAt,
  chooseGridSeg,
  gridCellDrawRects,
  invertMat3,
  layer3DDrawBox,
  LAYER3D_BLEED_MAX,
  LAYER3D_BLEED_CROSS,
  homographyFromUnitSquare,
  mapUnitPoint,
  defaultBox3D,
  defaultLayer3D,
  FACE_IDS
} from '../src/renderer/src/pixi/layer3d.ts'

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e?.message ?? e}`) }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg ?? 'eq'}：期望 ${b}，实际 ${a}`)
}
function close(a, b, eps, msg) {
  if (Math.abs(a - b) > eps) throw new Error(`${msg ?? 'close'}：期望 ≈${b}，实际 ${a}`)
}
function closePt(a, b, eps, msg) {
  close(a.x, b.x, eps, `${msg ?? 'pt'} x`)
  close(a.y, b.y, eps, `${msg ?? 'pt'} y`)
}
function ok(v, msg) { if (!v) throw new Error(msg ?? '期望为真') }
const fin = (v, msg) => { if (!Number.isFinite(v)) throw new Error(`${msg ?? 'finite'}：${v}`) }

const stage = { width: 1920, height: 1080 }
/** 测试用长方体：深度 0.35*W，相机距离 1.0*W */
const BOX = { enabled: true, depth: 0.35, camera: 1 }
const W = stage.width
const H = stage.height
const D = 0.35 * W
const CAM = 1 * W
/** 后墙缩放比（纯仿射） */
const S = CAM / (CAM + D)
const boxOf = (patch) => ({ ...BOX, ...patch })

console.log('== 单应性核心 ==')
t('单位方形 → 自身：恒等映射', () => {
  const q = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  const Hm = homographyFromUnitSquare(q)
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1], [0.3, 0.7]]) {
    const p = mapUnitPoint(u, v, Hm)
    close(p.x, u, 1e-9, `u=${u} x`)
    close(p.y, v, 1e-9, `u=${u} y`)
  }
})
t('四角精确复原（错误应 <1e-9）', () => {
  const q = [{ x: 100, y: 50 }, { x: 1800, y: 200 }, { x: 1700, y: 900 }, { x: 200, y: 1000 }]
  const Hm = homographyFromUnitSquare(q)
  const src = [[0, 0], [1, 0], [1, 1], [0, 1]]
  src.forEach(([u, v], i) => {
    const p = mapUnitPoint(u, v, Hm)
    close(p.x, q[i].x, 1e-8, `角${i} x`)
    close(p.y, q[i].y, 1e-8, `角${i} y`)
  })
})
t('直线保持性：方形中线上三点共线', () => {
  const q = [{ x: 200, y: 100 }, { x: 1700, y: 300 }, { x: 1500, y: 950 }, { x: 100, y: 800 }]
  const Hm = homographyFromUnitSquare(q)
  const a = mapUnitPoint(0, 0.5, Hm)
  const b = mapUnitPoint(0.5, 0.5, Hm)
  const c = mapUnitPoint(1, 0.5, Hm)
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  close(cross, 0, 1e-6, '共线叉积')
})
t('退化四边形（共线）安全回退单位阵', () => {
  const q = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]
  const Hm = homographyFromUnitSquare(q)
  ok(Number.isFinite(Hm.h11), 'h11 有限')
  const p = mapUnitPoint(0.5, 0.5, Hm)
  ok(Number.isFinite(p.x) && Number.isFinite(p.y), '映射有限')
})

console.log('== 长方体解析 ==')
t('缺省 / 未启用 / 深度为 0 → 不生效', () => {
  eq(resolveBox3D(undefined, stage).enabled, false, 'undefined')
  eq(resolveBox3D({ depth: 0.5, camera: 1 }, stage).enabled, false, '未显式启用')
  eq(resolveBox3D({ enabled: true, depth: 0, camera: 1 }, stage).enabled, false, '深度 0')
  eq(resolveBox3D({ enabled: true, depth: 0.35, camera: 1 }, stage).enabled, true, '正常启用')
})
t('深度/相机以画幅宽度为基准（分辨率无关）', () => {
  const a = resolveBox3D({ enabled: true, depth: 0.35, camera: 1 }, { width: 1920, height: 1080 })
  const b = resolveBox3D({ enabled: true, depth: 0.35, camera: 1 }, { width: 3840, height: 2160 })
  close(a.depth * 2, b.depth, 1e-9, '深度随分辨率等比')
  close(a.camera * 2, b.camera, 1e-9, '相机距离随分辨率等比')
  // 前后墙比 = camera/(camera+depth) 与分辨率无关 → 换分辨率观感一致
  const sa = a.camera / (a.camera + a.depth)
  const sb = b.camera / (b.camera + b.depth)
  close(sa, sb, 1e-12, '后墙缩放比不变')
})
t('参数越界被夹紧（不出现 NaN/负深度）', () => {
  const b = resolveBox3D({ enabled: true, depth: -5, camera: 0 }, stage)
  ok(b.depth === 0, '深度夹到 0')
  ok(b.camera > 0, '相机距离夹到正数')
})

console.log('== 面投影性质 ==')
t('前面 ≡ 恒等（等价于 2D）', () => {
  const st = { enabled: true, face: 'front' }
  eq(isLayer3DActive(st), false, 'front 视为未透视')
  const cfg = resolveLayer3D(st, stage, BOX, { x: 100, y: 200, w: 300, h: 400 })
  eq(cfg.enabled, false, 'cfg.enabled')
  const p = projectStagePoint(123, 456, cfg)
  close(p.x, 123, 1e-9); close(p.y, 456, 1e-9)
})
t('长方体未启用 / clip 未开启 → 全部面恒等', () => {
  for (const face of FACE_IDS) {
    const cfg1 = resolveLayer3D({ enabled: true, face }, stage, { ...BOX, enabled: false })
    eq(cfg1.enabled, false, `${face}：盒子未启用`)
    const cfg2 = resolveLayer3D({ enabled: false, face }, stage, BOX)
    eq(cfg2.enabled, false, `${face}：clip 未启用`)
    const p = projectStagePoint(777, 333, cfg1)
    close(p.x, 777, 1e-12, `${face} x 恒等`)
    close(p.y, 333, 1e-12, `${face} y 恒等`)
  }
})
t('后面 = 以画幅中心为中心的均匀缩放 s = camera/(camera+depth)', () => {
  const cfg = resolveLayer3D({ enabled: true, face: 'back' }, stage, BOX)
  eq(cfg.enabled, true)
  // 中心不动
  const c = projectStagePoint(W / 2, H / 2, cfg)
  close(c.x, W / 2, 1e-9); close(c.y, H / 2, 1e-9)
  // 左上角：向中心收 s 倍
  const p = projectStagePoint(0, 0, cfg)
  close(p.x, W / 2 - (W / 2) * S, 1e-9)
  close(p.y, H / 2 - (H / 2) * S, 1e-9)
})
t('后面是纯仿射 → 网格误差恒为 0（无论段数）', () => {
  const cfg = resolveLayer3D({ enabled: true, face: 'back' }, stage, BOX)
  const box = { x: 0, y: 0, w: W, h: H }
  close(gridErrorAt(box, cfg, 4), 0, 1e-9)
  close(gridErrorAt(box, cfg, 16), 0, 1e-9)
  eq(chooseGridSeg(box, cfg), 8, '仿射面用最小段数')
})

console.log('== 六面 = 六个平面（长方体只是参考体积）==')
/** 取某面上「内容盒 = 整幅画幅」时投影后的四角 */
function faceQuad(face, box = BOX) {
  return resolveLayer3D({ enabled: true, face }, stage, box, { x: 0, y: 0, w: W, h: H }).quad
}
function eqWorld(a, b, msg) {
  close(a.x, b.x, 1e-9, `${msg} x`)
  close(a.y, b.y, 1e-9, `${msg} y`)
  close(a.z, b.z, 1e-9, `${msg} z`)
}
t('四个侧/顶底面：近棱（z=0）与前面的对应棱严格重合', () => {
  const rb = resolveBox3D(BOX, stage)
  eqWorld(faceToWorld('left', 0, 0, rb), faceToWorld('front', 0, 0, rb), '左面近上 == 前面左上')
  eqWorld(faceToWorld('left', 0, H, rb), faceToWorld('front', 0, H, rb), '左面近下 == 前面左下')
  eqWorld(faceToWorld('right', W, 0, rb), faceToWorld('front', W, 0, rb), '右面近上 == 前面右上')
  eqWorld(faceToWorld('top', 0, 0, rb), faceToWorld('front', 0, 0, rb), '顶面近左 == 前面左上')
  eqWorld(faceToWorld('bottom', 0, H, rb), faceToWorld('front', 0, H, rb), '底面近右 == 前面左下')
})
t('盒子 8 个角：相邻两个面给出同一世界点（平面确实交于盒角）', () => {
  const rb = resolveBox3D(BOX, stage)
  const Dd = rb.depth
  // 后左 / 后右 / 后上 / 后下 四条棱
  eqWorld(faceToWorld('left', Dd, 0, rb), faceToWorld('back', 0, 0, rb), '左面(px=depth) == 后面左上')
  eqWorld(faceToWorld('left', Dd, H, rb), faceToWorld('back', 0, H, rb), '左面(px=depth) == 后面左下')
  eqWorld(faceToWorld('right', W - Dd, 0, rb), faceToWorld('back', W, 0, rb), '右面(px=W-depth) == 后面右上')
  eqWorld(faceToWorld('top', 0, Dd, rb), faceToWorld('back', 0, 0, rb), '顶面(py=depth) == 后面左上')
  eqWorld(faceToWorld('top', W, Dd, rb), faceToWorld('back', W, 0, rb), '顶面(py=depth) == 后面右上')
  eqWorld(faceToWorld('bottom', 0, H - Dd, rb), faceToWorld('back', 0, H, rb), '底面(py=H-depth) == 后面左下')
})
t('侧墙/顶底面：内容是 1:1 落到平面上（形状不被盒子拉伸）', () => {
  const rb = resolveBox3D(BOX, stage)
  // 画幅横向 300px → 深度也是 300（旧模型会变成 300*D/W）
  close(faceToWorld('left', 400, 0, rb).z - faceToWorld('left', 100, 0, rb).z, 300, 1e-9, '左面 Δpx = Δz')
  close(faceToWorld('right', 100, 0, rb).z - faceToWorld('right', 400, 0, rb).z, 300, 1e-9, '右面 Δpx = Δz')
  close(faceToWorld('top', 0, 400, rb).z - faceToWorld('top', 0, 100, rb).z, 300, 1e-9, '顶面 Δpy = Δz')
})
t('侧墙/顶底面：内容位置**与 depth 无关**（调深度只移动后墙，不挪/不拉已贴内容）', () => {
  const a = resolveLayer3D({ enabled: true, face: 'left' }, stage, boxOf({ depth: 0.2 }))
  const b = resolveLayer3D({ enabled: true, face: 'left' }, stage, boxOf({ depth: 1.4 }))
  for (const [x, y] of [[300, 200], [960, 540], [1500, 900]]) {
    const pa = projectStagePoint(x, y, a)
    const pb = projectStagePoint(x, y, b)
    close(pa.x, pb.x, 1e-9, `深度不影响侧墙内容 x(${x},${y})`)
    close(pa.y, pb.y, 1e-9, `深度不影响侧墙内容 y(${x},${y})`)
  }
  // 对照：后面（"对面那个面"）本来就该随 depth 前后移动
  const c = resolveLayer3D({ enabled: true, face: 'back' }, stage, boxOf({ depth: 0.2 }))
  const d = resolveLayer3D({ enabled: true, face: 'back' }, stage, boxOf({ depth: 1.4 }))
  ok(Math.abs(projectStagePoint(0, 0, c).x - projectStagePoint(0, 0, d).x) > 50, '后面应随 depth 缩放')
})
t('内容可以长到长方体外面：px > depth*W 的部分照常投影（不再被夹进盒子里）', () => {
  const rb = resolveBox3D(BOX, stage) // depth = 0.35W
  const Dd = rb.depth
  ok(faceToWorld('left', Dd + 500, 0, rb).z > Dd, '左面：超出盒子（更深）')
  const cfg = resolveLayer3D({ enabled: true, face: 'left' }, stage, BOX)
  const inside = projectStagePoint(Dd * 0.5, H / 2, cfg)
  const outside = projectStagePoint(Dd + 600, H / 2, cfg)
  fin(outside.x, '盒外投影有限')
  ok(outside.x > inside.x, '盒外内容继续朝画面中心推进（单调）')
})
t('每个面都是凸四边形且四角有序（无自交 → 不可能撕裂）', () => {
  for (const face of FACE_IDS) {
    const q = faceQuad(face)
    for (const p of q) { fin(p.x, `${face} x`); fin(p.y, `${face} y`) }
    // 顺序 = 左上→右上→右下→左下：相邻叉积同号
    const cross = []
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4]
      cross.push((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x))
    }
    const sign = Math.sign(cross[0])
    ok(cross.every((v) => Math.sign(v) === sign), `${face} 应凸且有序：${cross.join(',')}`)
  }
})
t('面在「深度方向」上与观众一致：左右侧墙向内收、上下墙向内收', () => {
  const L = faceQuad('left')
  // 近棱（贴画幅左边）比远棱更靠左、更高（外扩）
  ok(L[0].x < L[1].x, '左面近棱更靠左')
  ok(L[0].y < L[1].y, '左面近上更靠上')
  const R = faceQuad('right')
  ok(R[1].x > R[0].x, '右面近棱更靠右')
})

console.log('== 内容映射（stage 坐标 = 面上的坐标）==')
t('前面 ≡ 恒等；后面 = 画幅整块贴到后墙', () => {
  const F = resolveLayer3D({ enabled: true, face: 'front' }, stage, BOX, { x: 0, y: 0, w: W, h: H })
  const B = resolveLayer3D({ enabled: true, face: 'back' }, stage, BOX, { x: 0, y: 0, w: W, h: H })
  closePt(F.quad[0], { x: 0, y: 0 }, 1e-9, '前面左上恒等')
  closePt(B.quad[0], { x: W / 2 - (W / 2) * S, y: H / 2 - (H / 2) * S }, 1e-9, '后面左上按 s 内收')
})
t('侧面：全画幅内容盒的近棱贴前面、远棱落在 z=W 处', () => {
  const cfg = resolveLayer3D({ enabled: true, face: 'left' }, stage, BOX, { x: 0, y: 0, w: W, h: H })
  const F = faceQuad('front')
  const rb = resolveBox3D(BOX, stage)
  // 近棱 == 前面左棱（严格）
  closePt(cfg.quad[0], F[0], 1e-9, '左面近上 == 前面左上')
  closePt(cfg.quad[3], F[3], 1e-9, '左面近下 == 前面左下')
  // 远棱 = (px=W, py=0/H) 投影
  const w0 = faceToWorld('left', W, 0, rb)
  const p0 = project3D(w0.x, w0.y, w0.z, rb)
  closePt(cfg.quad[1], { x: p0.x + W / 2, y: p0.y + H / 2 }, 1e-9, '左面远上')
})
t('内容盒缩小/平移：投影单调且始终在同一平面上（面内移动有效）', () => {
  const inner = { x: W * 0.25, y: H * 0.25, w: W * 0.5, h: H * 0.5 }
  const cfg = resolveLayer3D({ enabled: true, face: 'back' }, stage, BOX, inner)
  const outer = faceQuad('back')
  const minX = Math.min(...outer.map((p) => p.x))
  const maxX = Math.max(...outer.map((p) => p.x))
  const minY = Math.min(...outer.map((p) => p.y))
  const maxY = Math.max(...outer.map((p) => p.y))
  for (const p of cfg.quad) {
    ok(p.x >= minX - 1e-9 && p.x <= maxX + 1e-9, 'x 在后墙内')
    ok(p.y >= minY - 1e-9 && p.y <= maxY + 1e-9, 'y 在后墙内')
  }
  // 侧墙：同一内容盒平移 → 投影位置连续单调（不会跳变/被裁）
  const l1 = resolveLayer3D({ enabled: true, face: 'left' }, stage, BOX, { x: 100, y: 100, w: 400, h: 400 })
  const l2 = resolveLayer3D({ enabled: true, face: 'left' }, stage, BOX, { x: 500, y: 100, w: 400, h: 400 })
  ok(l2.quad[0].x > l1.quad[0].x, '内容右移 → 在左墙上更深（朝画面中心）')
})
t('前面：内容盒位置原样（WYSIWYG）', () => {
  const cfg = resolveLayer3D({ enabled: true, face: 'front' }, stage, BOX, { x: 10, y: 20, w: 100, h: 50 })
  const p = projectStagePoint(60, 45, cfg)
  close(p.x, 60, 1e-9); close(p.y, 45, 1e-9)
})
t('侧墙面内沿「深度」方向移动：位置滑杆仍单调有效', () => {
  const cfg = resolveLayer3D({ enabled: true, face: 'left' }, stage, BOX)
  const near = projectStagePoint(0, 0, cfg)
  const mid = projectStagePoint(W / 2, 0, cfg)
  ok(mid.x > near.x, '向画面中心方向推进')
  ok(Math.abs(mid.y - H / 2) < Math.abs(near.y - H / 2), '纵向随深度收缩（近大远小）')
})

console.log('== 深度 / 相机距离的单调性 ==')
t('深度越大 → 后墙收得越多（透视越强）', () => {
  const q1 = faceQuad('back', boxOf({ depth: 0.2 }))
  const q2 = faceQuad('back', boxOf({ depth: 0.8 }))
  ok(q2[0].x > q1[0].x, '深度大 → 左上角更靠中心（x 更大）')
  ok(q2[0].y > q1[0].y, '深度大 → 左上角更靠中心（y 更大）')
})
t('相机距离越大 → 后墙收得越少（透视越弱）', () => {
  const q1 = faceQuad('back', boxOf({ camera: 0.5 }))
  const q2 = faceQuad('back', boxOf({ camera: 3 }))
  ok(q2[0].x < q1[0].x, '相机远 → 左上角更靠外')
})
t('极端参数下处处有限（不炸）', () => {
  for (const face of FACE_IDS) {
    for (const depth of [0.05, 0.35, 1.5, 4]) {
      for (const camera of [0.15, 1, 8]) {
        const cfg = resolveLayer3D({ enabled: true, face }, stage, { enabled: true, depth, camera })
        for (const p of cfg.quad) { fin(p.x, `${face} d=${depth} c=${camera} x`); fin(p.y, `${face} y`) }
        const g = planPerspectiveGrid({ x: 0, y: 0, w: W, h: H }, cfg, 16)
        for (let i = 0; i < g.positions.length; i++) fin(g.positions[i], `${face} 顶点 ${i}`)
      }
    }
  }
})

console.log('== 仿射 / 网格 / 线框 ==')
t('未启用 affineAt 为平移单位阵', () => {
  const cfg = resolveLayer3D(undefined, stage, BOX)
  const m = affineAt(10, 20, cfg)
  eq(m.a, 1); eq(m.d, 1); eq(m.b, 0); eq(m.c, 0)
  eq(m.e, 10); eq(m.f, 20)
})
t('启用后 Jacobian 有限且在合理范围', () => {
  const cfg = resolveLayer3D({ enabled: true, face: 'left' }, stage, BOX)
  const m = affineAt(200, 400, cfg)
  ok(Number.isFinite(m.a) && Number.isFinite(m.d), '有限')
  ok(Math.abs(m.a) > 1e-6 && Math.abs(m.a) < 100, 'a 合理')
})
t('planPerspectiveGrid 顶点/索引数正确', () => {
  const cfg = resolveLayer3D({ enabled: true, face: 'left' }, stage, BOX)
  const g = planPerspectiveGrid({ x: 0, y: 0, w: 1920, h: 1080 }, cfg, 16)
  eq(g.seg, 16)
  eq(g.vertexCount, 17 * 17)
  eq(g.positions.length, 17 * 17 * 2)
  eq(g.uvs.length, 17 * 17 * 2)
  eq(g.indices.length, 16 * 16 * 6)
  eq(g.corners.length, 4)
})
t('侧墙（有透视非线性）：格内偏差随段数下降，自适应段数满足阈值', () => {
  const cfg = resolveLayer3D({ enabled: true, face: 'left' }, stage, BOX)
  const box = { x: 0, y: 0, w: W, h: H }
  const e8 = gridErrorAt(box, cfg, 8)
  const e16 = gridErrorAt(box, cfg, 16)
  const e32 = gridErrorAt(box, cfg, 32)
  ok(e16 < e8, `16 段应优于 8 段（${e16} < ${e8}）`)
  ok(e32 < e16, `32 段应优于 16 段（${e32} < ${e16}）`)
  const seg = chooseGridSeg(box, cfg)
  ok(seg >= 8 && seg <= 48 && seg % 4 === 0, `段数合法：${seg}`)
  ok(gridErrorAt(box, cfg, seg) <= 0.25 + 1e-9, `选定段数应满足阈值（实际 ${gridErrorAt(box, cfg, seg)}）`)
})
t('未启用时网格段数为 1（不白算）', () => {
  const cfg = resolveLayer3D(undefined, stage, BOX)
  eq(chooseGridSeg({ x: 0, y: 0, w: W, h: H }, cfg), 1)
})
t('线框 = 盒子本身：每个面的四角 = 该面上「内容坐标占 depth 那一段」的投影', () => {
  eq(planBoxWireframe({ ...BOX, enabled: false }, stage), null, '未启用无线框')
  const wire = planBoxWireframe(BOX, stage)
  ok(wire, '有线框')
  eq(wire.faces.length, 6)
  eq(wire.edges.length, 12)
  // 盒子角在内容坐标里的位置：后面 = 整幅；左面 = px∈[0,depth]；顶面 = py∈[0,depth]……
  const Dd = resolveBox3D(BOX, stage).depth
  const boxOfFace = {
    front: { x: 0, y: 0, w: W, h: H },
    back: { x: 0, y: 0, w: W, h: H },
    left: { x: 0, y: 0, w: Dd, h: H },
    right: { x: W - Dd, y: 0, w: Dd, h: H },
    top: { x: 0, y: 0, w: W, h: Dd },
    bottom: { x: 0, y: H - Dd, w: W, h: Dd }
  }
  for (const f of wire.faces) {
    const q = resolveLayer3D({ enabled: true, face: f.id }, stage, BOX, boxOfFace[f.id]).quad
    for (let i = 0; i < 4; i++) closePt(f.quad[i], q[i], 1e-9, `${f.id} 角${i}`)
  }
})
t('showWireframe 默认开、可关', () => {
  eq(defaultBox3D().showWireframe, true)
  eq(resolveBox3D({ enabled: true, showWireframe: false }, stage).showWireframe, false)
})

console.log('== 导出逐格贴图（裂痕修复的不变量）==')
t('每格「源→目标」缩放恒等于整幅缩放（不拉伸、不重复缩放）', () => {
  const seg = 16
  const tw = 1920
  const th = 1080
  const scw = tw / seg
  const sch = th / seg
  for (const [c, r] of [[0, 0], [3, 7], [15, 15]]) {
    const g = gridCellDrawRects(c, r, seg, tw, th, 1)
    close(g.sw / g.dw, scw, 1e-9, `格(${c},${r}) 横向缩放`)
    close(g.sh / g.dh, sch, 1e-9, `格(${c},${r}) 纵向缩放`)
  }
})
t('相邻格在公共边界采到同一源坐标（接缝两侧采样连续 → 无裂痕）', () => {
  const seg = 16
  const tw = 1920
  const th = 1080
  const scw = tw / seg
  // 第 c 格「左边界」(u=0) 与第 c-1 格「右边界」(u=1) 对应的源 x 必须相同
  const srcAtUnit = (g, u) => g.sx + ((u - g.dx) / g.dw) * g.sw
  for (let c = 1; c < seg; c++) {
    const left = gridCellDrawRects(c, 0, seg, tw, th, 1)
    const right = gridCellDrawRects(c - 1, 0, seg, tw, th, 1)
    const x1 = srcAtUnit(left, 0)
    const x2 = srcAtUnit(right, 1)
    close(x1, x2, 1e-9, `列 ${c} 边界源坐标`)
    close(x1, c * scw, 1e-9, `列 ${c} 边界应落在源格线上`)
  }
})
t('出血夹紧在源图内：绝不越界（越界会被 drawImage 按比例裁掉目标 → 外缘缺口）', () => {
  const seg = 16
  const tw = 1920
  for (let c = 0; c < seg; c++) {
    const g = gridCellDrawRects(c, 0, seg, tw, 1080, 5, 5)
    ok(g.sx >= -1e-9, `列 ${c} 左缘未越界：${g.sx}`)
    ok(g.sx + g.sw <= tw + 1e-9, `列 ${c} 右缘未越界：${g.sx + g.sw}`)
    // 目标外扩同样只在有邻居的一侧出现（外缘侧不外扩）
    ok(g.dx <= 1e-9, `列 ${c} 目标左缘不超出`)
    ok(g.dx + g.dw >= 1 - 1e-9, `列 ${c} 目标右缘不缩`)
  }
  // 内部格两侧都出血
  const mid = gridCellDrawRects(8, 0, seg, tw, 1080, 5, 5)
  ok(mid.sx < 8 * (tw / seg), '内部格左侧出血')
  ok(mid.sx + mid.sw > 9 * (tw / seg), '内部格右侧出血')
  // 首/末格只向内有出血，且不外扩
  const first = gridCellDrawRects(0, 0, seg, tw, 1080, 5, 5)
  close(first.sx, 0, 1e-9); close(first.dx, 0, 1e-9)
  const last = gridCellDrawRects(seg - 1, 0, seg, tw, 1080, 5, 5)
  close(last.sx + last.sw, tw, 1e-9)
  close(last.dx + last.dw, 1, 1e-9)
})
t('bleed=0 退化为「源矩形 = 格、目标 = 单位格」', () => {
  const g = gridCellDrawRects(2, 3, 16, 1920, 1080, 0)
  close(g.sx, 2 * 120, 1e-9); close(g.sw, 120, 1e-9)
  close(g.dx, 0, 1e-9); close(g.dw, 1, 1e-9)
})
t('目标侧外扩量 = 指定的 stage 像素（反推源出血的换算正确）', () => {
  // 模拟导出端：某格投影后横向边长 80 stage px，源格 120 px，要求目标每边外扩 0.75 stage px
  const PAD = 0.75
  const scw = 120
  const edgeW = 80
  const bleedX = (PAD * scw) / edgeW
  const g = gridCellDrawRects(1, 0, 16, 1920, 1080, bleedX, bleedX)
  const fx = -g.dx // 单位制下的外扩量
  close(fx * edgeW, PAD, 1e-9, '目标外扩换算回 stage px')
  close(g.sw / g.dw, scw, 1e-9, '缩放不受外扩影响')
})
t('接缝像素必被其中一格完整覆盖（覆盖率 = 1 → 抗锯齿不漏底色）', () => {
  const PAD = 0.75
  const cov = (lo, hi, x0, x1) => Math.max(0, Math.min(hi, x1) - Math.max(lo, x0))
  for (let k = 0; k < 20; k++) {
    const b = 10 + k / 20 // 接缝落在像素内部的任意相位
    // 格子 A 覆盖 (-∞, b+PAD]，格子 B 覆盖 [b-PAD, ∞)
    for (let px = 8; px <= 12; px++) {
      const x0 = px
      const x1 = px + 1
      const ca = cov(-1e9, b + PAD, x0, x1)
      const cb = cov(b - PAD, 1e9, x0, x1)
      ok(Math.max(ca, cb) >= 1 - 1e-9, `接缝 b=${b} 像素[${x0},${x1}) 覆盖不足：${ca}/${cb}`)
    }
  }
})

console.log('== 绘制范围（出血盒：内容不被"面的矩形"硬切）==')
t('invertMat3：H⁻¹(H(u,v)) 回到 (u,v)', () => {
  const q = [{ x: 300, y: 120 }, { x: 1600, y: 260 }, { x: 1500, y: 1000 }, { x: 200, y: 900 }]
  const Hm = homographyFromUnitSquare(q)
  const inv = invertMat3(Hm)
  ok(inv, '应可逆')
  for (const [u, v] of [[0, 0], [1, 1], [0.3, 0.7]]) {
    const p = mapUnitPoint(u, v, Hm)
    const back = mapUnitPoint(p.x, p.y, inv)
    close(back.x, u, 1e-9, `u 往返`)
    close(back.y, v, 1e-9, `v 往返`)
  }
})
t('未启用 3D / 前面 → 原样返回内容盒（不占额外显存）', () => {
  const base = { x: 0, y: 0, w: 1920, h: 1080 }
  const off = layer3DDrawBox({ enabled: true, face: 'back' }, stage, { ...BOX, enabled: false }, base)
  eq(off.w, 1920); eq(off.h, 1080)
  const front = layer3DDrawBox({ enabled: true, face: 'front' }, stage, BOX, base)
  eq(front.w, 1920); eq(front.h, 1080)
})
t('后面：出血盒 = 画幅按 1/s 外扩（画幅四角原像全在盒内）', () => {
  const box = layer3DDrawBox({ enabled: true, face: 'back' }, stage, BOX)
  const padX = (S === 0 ? 0 : 0.5 * (1 / S - 1)) * W
  const padY = (S === 0 ? 0 : 0.5 * (1 / S - 1)) * H
  close(box.x, -padX, 1.5, '左外扩')
  close(box.y, -padY, 1.5, '上外扩')
  close(box.w, W + padX * 2, 3, '宽')
  close(box.h, H + padY * 2, 3, '高')
  ok(Number.isInteger(box.x) && Number.isInteger(box.w), '整数（可直接做画布尺寸）')
  // 关键不变量：把画幅四角经 H⁻¹ 投回内容坐标，必须落在盒内
  const cfg = resolveLayer3D({ enabled: true, face: 'back' }, stage, BOX, box)
  const inv = invertMat3(cfg.H)
  for (const [X, Y] of [[0, 0], [W, 0], [W, H], [0, H]]) {
    const p = mapUnitPoint(X, Y, inv)
    const sx = cfg.srcX + p.x * cfg.srcW
    const sy = cfg.srcY + p.y * cfg.srcH
    ok(sx >= box.x - 1e-6 && sx <= box.x + box.w + 1e-6, `画幅角原像 x 在盒内（${sx}）`)
    ok(sy >= box.y - 1e-6 && sy <= box.y + box.h + 1e-6, `画幅角原像 y 在盒内（${sy}）`)
  }
})
t('后面：投影后的出血盒覆盖整个画幅 → 面边界处不再有硬切边', () => {
  const box = layer3DDrawBox({ enabled: true, face: 'back' }, stage, BOX)
  const cfg = resolveLayer3D({ enabled: true, face: 'back' }, stage, BOX, box)
  const q = cfg.quad
  const minX = Math.min(...q.map((p) => p.x))
  const maxX = Math.max(...q.map((p) => p.x))
  const minY = Math.min(...q.map((p) => p.y))
  const maxY = Math.max(...q.map((p) => p.y))
  ok(minX <= 0 && maxX >= W, `横向盖满画幅（${minX}..${maxX}）`)
  ok(minY <= 0 && maxY >= H, `纵向盖满画幅（${minY}..${maxY}）`)
})
t('侧墙/顶底面：出血按上限夹紧（深度方向无界 → 不许画布爆掉）', () => {
  const crossX = LAYER3D_BLEED_CROSS * W
  const crossY = LAYER3D_BLEED_CROSS * H
  const maxX = LAYER3D_BLEED_MAX * W
  const maxY = LAYER3D_BLEED_MAX * H
  for (const face of ['left', 'right', 'top', 'bottom']) {
    const box = layer3DDrawBox({ enabled: true, face }, stage, BOX)
    ok(box.x >= -maxX - 1 && box.y >= -maxY - 1, `${face} 左上不超上限`)
    ok(box.x + box.w <= W + maxX + 1 && box.y + box.h <= H + maxY + 1, `${face} 右下不超上限`)
    // 非深度轴只做小幅出血
    if (face === 'left' || face === 'right') {
      ok(box.y >= -crossY - 1 && box.y + box.h <= H + crossY + 1, `${face} 纵向只小幅出血`)
    } else {
      ok(box.x >= -crossX - 1 && box.x + box.w <= W + crossX + 1, `${face} 横向只小幅出血`)
    }
    ok(box.w >= W && box.h >= H, `${face} 至少不小于画幅`)
    ok(Number.isInteger(box.w) && Number.isInteger(box.h), `${face} 整数尺寸`)
  }
  // 深度方向朝"更深"的一侧外扩：左面往右扩、右面往左扩
  const l = layer3DDrawBox({ enabled: true, face: 'left' }, stage, BOX)
  ok(l.x + l.w > W + maxX * 0.9, '左面应朝 +px（更深）扩到上限')
  const r = layer3DDrawBox({ enabled: true, face: 'right' }, stage, BOX)
  ok(r.x < -maxX * 0.9, '右面应朝 -px（更深）扩到上限')
})
t('深度越大 → 出血越大（后面看得更"深"，可见范围更大）', () => {
  const a = layer3DDrawBox({ enabled: true, face: 'back' }, stage, boxOf({ depth: 0.2 }))
  const b = layer3DDrawBox({ enabled: true, face: 'back' }, stage, boxOf({ depth: 0.6 }))
  ok(b.w > a.w, `深度大出血大（${a.w} → ${b.w}）`)
})

console.log('== 默认值与激活判定 ==')
t('defaultLayer3D / isLayer3DActive', () => {
  const d = defaultLayer3D()
  eq(d.enabled, false)
  eq(d.face, 'front')
  eq(isLayer3DActive(d), false)
  eq(isLayer3DActive({ enabled: true, face: 'front' }), false)
  eq(isLayer3DActive({ enabled: false, face: 'left' }), false)
  eq(isLayer3DActive({ enabled: true, face: 'left' }), true)
  eq(isLayer3DActive(undefined), false)
})
t('project3D：前墙恒等，深处按 camera/(camera+z) 收缩', () => {
  const rb = resolveBox3D(BOX, stage)
  const p0 = project3D(100, 50, 0, rb)
  close(p0.x, 100, 1e-12); close(p0.y, 50, 1e-12)
  const p1 = project3D(100, 50, D, rb)
  close(p1.x, 100 * S, 1e-12); close(p1.s, S, 1e-12)
})
t('faceToWorld：内容在屏幕上正立（v=0 在上、u=0 在左）', () => {
  const rb = resolveBox3D(BOX, stage)
  const tl = faceToWorld('left', 0, 0, rb)
  const tr = faceToWorld('left', W, 0, rb)
  const bl = faceToWorld('left', 0, H, rb)
  ok(tl.z < tr.z, '左面：u 增大 → 深度增加（向左读到右）')
  ok(tl.y < bl.y, '左面：v 增大 → y 增大（向下）')
  const rl = faceToWorld('right', 0, 0, rb)
  const rr = faceToWorld('right', W, 0, rb)
  ok(rl.z > rr.z, '右面：u 增大 → 深度减小（保持不镜像）')
  const tt = faceToWorld('top', W / 2, 0, rb)
  const tb = faceToWorld('top', W / 2, H, rb)
  ok(tt.z < tb.z, '顶面：v 增大 → 深度增加')
  const bt = faceToWorld('bottom', W / 2, 0, rb)
  const bb = faceToWorld('bottom', W / 2, H, rb)
  ok(bt.z > bb.z, '底面：v 增大 → 深度减小')
})

console.log('\n== 跟随圆形图片的 3D 同构（环形频谱柱环境） ==')
t('同一「长方体 + 面」下：盒四角 → 投影四角（同构充要）', () => {
  const circleBox = { x: 420, y: 140, w: 800, h: 800 }
  const cfg = resolveLayer3D({ enabled: true, face: 'back' }, stage, BOX, circleBox)
  const boxPts = [
    { x: circleBox.x, y: circleBox.y },
    { x: circleBox.x + circleBox.w, y: circleBox.y },
    { x: circleBox.x + circleBox.w, y: circleBox.y + circleBox.h },
    { x: circleBox.x, y: circleBox.y + circleBox.h }
  ]
  for (let i = 0; i < 4; i++) {
    const p = projectStagePoint(boxPts[i].x, boxPts[i].y, cfg)
    close(p.x, cfg.quad[i].x, 1e-6, `角${i} x`)
    close(p.y, cfg.quad[i].y, 1e-6, `角${i} y`)
  }
})
t('圆形未启用 3D → 投影恒等（调用方退回原坐标，行为不变）', () => {
  const circleBox = { x: 100, y: 50, w: 640, h: 640 }
  const cfg = resolveLayer3D({ enabled: false }, stage, BOX, circleBox)
  eq(cfg.enabled, false, 'enabled')
  const p = projectStagePoint(777, 333, cfg)
  close(p.x, 777, 1e-12, 'x 恒等')
  close(p.y, 333, 1e-12, 'y 恒等')
})
t('跟随方的点落在圆形盒外：仍按同一 H 外推（环可超出圆形边界）', () => {
  const circleBox = { x: 420, y: 140, w: 800, h: 800 }
  const cfg = resolveLayer3D({ enabled: true, face: 'left' }, stage, BOX, circleBox)
  const outside = { x: circleBox.x + circleBox.w * 1.5, y: circleBox.y + circleBox.h / 2 }
  const p = projectStagePoint(outside.x, outside.y, cfg)
  fin(p.x, '外推 x'); fin(p.y, '外推 y')
  ok(p.x > cfg.quad[0].x, '外推点应仍在左侧之外（单调）')
})

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
