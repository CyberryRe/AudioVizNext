/**
 * layer3d.test.mjs —— 泛用 3D 投影底层单测（纯数学）。
 *
 * 模型：四角单应性（homography）。四角坐标相对「内容盒子」归一化 0..1。
 */
import {
  resolveLayer3D,
  projectStagePoint,
  affineAt,
  isLayer3DActive,
  layer3DHud,
  defaultLayer3D,
  layer3DClipOffset,
  planPerspectiveGrid,
  homographyFromUnitSquare,
  mapUnitPoint
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
function ok(v, msg) { if (!v) throw new Error(msg ?? '期望为真') }

const stage = { width: 1920, height: 1080 }

console.log('== 单应性核心 ==')
t('单位方形 → 自身：恒等映射', () => {
  const q = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  const H = homographyFromUnitSquare(q)
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1], [0.3, 0.7]]) {
    const p = mapUnitPoint(u, v, H)
    close(p.x, u, 1e-9, `u=${u} x`)
    close(p.y, v, 1e-9, `u=${u} y`)
  }
})
t('四角精确复原（错误应 <1e-9）', () => {
  const q = [{ x: 100, y: 50 }, { x: 1800, y: 200 }, { x: 1700, y: 900 }, { x: 200, y: 1000 }]
  const H = homographyFromUnitSquare(q)
  const src = [[0, 0], [1, 0], [1, 1], [0, 1]]
  src.forEach(([u, v], i) => {
    const p = mapUnitPoint(u, v, H)
    close(p.x, q[i].x, 1e-8, `角${i} x`)
    close(p.y, q[i].y, 1e-8, `角${i} y`)
  })
})
t('直线保持性：方形中线上三点共线', () => {
  const q = [{ x: 200, y: 100 }, { x: 1700, y: 300 }, { x: 1500, y: 950 }, { x: 100, y: 800 }]
  const H = homographyFromUnitSquare(q)
  const a = mapUnitPoint(0, 0.5, H)
  const b = mapUnitPoint(0.5, 0.5, H)
  const c = mapUnitPoint(1, 0.5, H)
  // 叉积 ≈ 0 → 共线
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  close(cross, 0, 1e-6, '共线叉积')
})
t('退化四边形（共线）安全回退单位阵', () => {
  const q = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]
  const H = homographyFromUnitSquare(q)
  ok(Number.isFinite(H.h11), 'h11 有限')
  const p = mapUnitPoint(0.5, 0.5, H)
  ok(Number.isFinite(p.x) && Number.isFinite(p.y), '映射有限')
})

console.log('== resolve / active ==')
t('未启用 → 恒等投影', () => {
  const cfg = resolveLayer3D(undefined, stage)
  eq(cfg.enabled, false)
  const p = projectStagePoint(100, 200, cfg)
  close(p.x, 100, 1e-9)
  close(p.y, 200, 1e-9)
  close(p.s, 1, 1e-9)
})
t('启用但四角为默认矩形 → isLayer3DActive=false（无扭曲）', () => {
  ok(!isLayer3DActive({ enabled: true, corners: defaultLayer3D().corners }))
  ok(!isLayer3DActive({ enabled: false, corners: [{ x: 0.1, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }))
  const warped = [{ x: 0.1, y: 0.1 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 0.9 }]
  ok(isLayer3DActive({ enabled: true, corners: warped }))
})
t('四角相对内容盒 → stage 像素', () => {
  const src = { x: 200, y: 100, w: 800, h: 400 }
  const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.8, y: 1 }, { x: 0.2, y: 1 }]
  const cfg = resolveLayer3D({ enabled: true, corners }, stage, src)
  close(cfg.quad[0].x, 200, 1e-9, '角0 x')
  close(cfg.quad[2].x, 200 + 0.8 * 800, 1e-9, '角2 x')
  close(cfg.quad[3].y, 100 + 400, 1e-9, '角3 y')
})

console.log('== 投影 ==')
t('默认四角下投影恒等（源盒内点不动）', () => {
  const cfg = resolveLayer3D({ enabled: true, corners: defaultLayer3D().corners }, stage)
  const p = projectStagePoint(960, 540, cfg)
  close(p.x, 960, 1e-6)
  close(p.y, 540, 1e-6)
})
t('收窄上边 → 顶部点被拉向中心', () => {
  const corners = [{ x: 0.3, y: 0 }, { x: 0.7, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  const cfg = resolveLayer3D({ enabled: true, corners }, stage)
  const top = projectStagePoint(0, 0, cfg)
  close(top.x, 0.3 * 1920, 1e-6, '左上角应到 0.3*W')
  const mid = projectStagePoint(960, 540, cfg)
  ok(mid.x > 0.3 * 1920 && mid.x < 0.7 * 1920, '中点应在收窄范围内')
})

console.log('== 仿射 ==')
t('未启用 affineAt 为平移单位阵', () => {
  const cfg = resolveLayer3D(undefined, stage)
  const m = affineAt(10, 20, cfg)
  eq(m.a, 1); eq(m.d, 1); eq(m.b, 0); eq(m.c, 0)
  eq(m.e, 10); eq(m.f, 20)
})
t('启用后 Jacobian 有限且在合理范围', () => {
  const corners = [{ x: 0.2, y: 0.1 }, { x: 0.85, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 0.9 }]
  const cfg = resolveLayer3D({ enabled: true, corners }, stage)
  const m = affineAt(960, 400, cfg)
  ok(Number.isFinite(m.a) && Number.isFinite(m.d), '有限')
  ok(Math.abs(m.a) > 1e-4 && Math.abs(m.a) < 10, 'a 合理')
})

console.log('== HUD ==')
t('未启用无 HUD；启用返回四角/源矩形/中心', () => {
  eq(layer3DHud(resolveLayer3D(undefined, stage)), null)
  const corners = [{ x: 0.2, y: 0.2 }, { x: 0.9, y: 0.1 }, { x: 0.8, y: 0.9 }, { x: 0.1, y: 0.8 }]
  const cfg = resolveLayer3D({ enabled: true, corners }, stage)
  const hud = layer3DHud(cfg)
  ok(hud)
  eq(hud.corners.length, 4)
  close(hud.corners[0].x, 0.2 * 1920, 0.1)
  close(hud.srcRect.w, 1920, 0.1)
  ok(hud.center.x > 0 && hud.center.y > 0, '中心有效')
})

t('defaultLayer3D 返回单位四角 + enabled=false', () => {
  const d = defaultLayer3D()
  eq(d.enabled, false)
  eq(d.corners.length, 4)
  close(d.corners[0].x, 0, 1e-9)
  close(d.corners[2].y, 1, 1e-9)
})

console.log('== 形状锁定（四角相对内容盒 → 内容移动形状不变）==')
t('内容盒整体平移后，相对形状不变（映射点相对盒同比例）', () => {
  const corners = [{ x: 0.2, y: 0.1 }, { x: 0.9, y: 0.15 }, { x: 0.85, y: 0.9 }, { x: 0.1, y: 0.95 }]
  const boxA = { x: 100, y: 100, w: 800, h: 600 }
  const boxB = { x: 500, y: 450, w: 800, h: 600 } // 只平移，不改尺寸
  const cfgA = resolveLayer3D({ enabled: true, corners }, stage, boxA)
  const cfgB = resolveLayer3D({ enabled: true, corners }, stage, boxB)
  // 在盒 A 内取 (0.3,0.7) 的点
  const xA = boxA.x + 0.3 * boxA.w
  const yA = boxA.y + 0.7 * boxA.h
  const xB = boxB.x + 0.3 * boxB.w
  const yB = boxB.y + 0.7 * boxB.h
  const pA = projectStagePoint(xA, yA, cfgA)
  const pB = projectStagePoint(xB, yB, cfgB)
  // 投影点也应整体平移相同量
  close(pB.x - pA.x, boxB.x - boxA.x, 1e-6, 'dx 一致')
  close(pB.y - pA.y, boxB.y - boxA.y, 1e-6, 'dy 一致')
})
t('四角不动、内容盒整体等比缩放 → 投影点随之等比缩放（无漂移）', () => {
  const corners = [{ x: 0.1, y: 0 }, { x: 0.9, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  const boxA = { x: 0, y: 0, w: 1000, h: 1000 }
  const boxB = { x: 0, y: 0, w: 2000, h: 2000 } // 原地放大 2×
  const cfgA = resolveLayer3D({ enabled: true, corners }, stage, boxA)
  const cfgB = resolveLayer3D({ enabled: true, corners }, stage, boxB)
  // 取「相对盒同一位置」的单位点 (0.25,0.75)
  const pA = projectStagePoint(0.25 * boxA.w, 0.75 * boxA.h, cfgA)
  const pB = projectStagePoint(0.25 * boxB.w, 0.75 * boxB.h, cfgB)
  // 四角（相对盒）不变 → 映射相对盒相同，只是盒放大 2× → 投影点应整体 2×
  close(pB.x, pA.x * 2, 1e-6, 'x 等比')
  close(pB.y, pA.y * 2, 1e-6, 'y 等比')
})

console.log('== layer3DClipOffset（诊断用，兼容保留）==')
t('preset 只认 params.pos（忽略 transform）', () => {
  const o = layer3DClipOffset({ enabled: true }, 'preset', { x: 0.1, y: -0.2 }, { posX: 0.05, posY: 0 })
  close(o.dx, 0.05, 1e-9)
  close(o.dy, 0, 1e-9)
})
t('media 只认 transform', () => {
  const o = layer3DClipOffset({ enabled: true }, 'media', { x: 0.1, y: -0.2 }, { posX: 0.05, posY: 0.5 })
  close(o.dx, 0.1, 1e-9)
  close(o.dy, -0.2, 1e-9)
})
t('未启用 → 偏移为 0', () => {
  const o = layer3DClipOffset({ enabled: false }, 'media', { x: 0.3, y: 0.3 })
  eq(o.dx, 0); eq(o.dy, 0)
})

console.log('== 细分网格（消折痕）==')
t('planPerspectiveGrid 顶点/索引数正确', () => {
  const corners = [{ x: 0.1, y: 0 }, { x: 0.9, y: 0.05 }, { x: 1, y: 1 }, { x: 0, y: 0.95 }]
  const cfg = resolveLayer3D({ enabled: true, corners }, stage)
  const g = planPerspectiveGrid({ x: 0, y: 0, w: 1920, h: 1080 }, cfg, 16)
  eq(g.vertexCount, 17 * 17)
  eq(g.positions.length, 17 * 17 * 2)
  eq(g.uvs.length, 17 * 17 * 2)
  eq(g.indices.length, 16 * 16 * 6)
  eq(g.corners.length, 4)
})
t('细分网格逐顶点投影：格内插值误差随 seg 单调下降', () => {
  const corners = [{ x: 0.05, y: 0 }, { x: 0.6, y: 0.1 }, { x: 0.95, y: 1 }, { x: 0.1, y: 0.9 }]
  const cfg = resolveLayer3D({ enabled: true, corners }, stage)
  const box = { x: 0, y: 0, w: 1920, h: 1080 }
  const maxDev = (seg) => {
    let m = 0
    for (let r = 0; r < seg; r++) {
      for (let c = 0; c < seg; c++) {
        const u0 = c / seg, u1 = (c + 1) / seg, v0 = r / seg, v1 = (r + 1) / seg
        const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2
        const q00 = projectStagePoint(box.x + box.w * u0, box.y + box.h * v0, cfg)
        const q10 = projectStagePoint(box.x + box.w * u1, box.y + box.h * v0, cfg)
        const q01 = projectStagePoint(box.x + box.w * u0, box.y + box.h * v1, cfg)
        const q11 = projectStagePoint(box.x + box.w * u1, box.y + box.h * v1, cfg)
        const tu = (uc - u0) / (u1 - u0), tv = (vc - v0) / (v1 - v0)
        const ax = (q00.x * (1 - tu) + q10.x * tu) * (1 - tv) + (q01.x * (1 - tu) + q11.x * tu) * tv
        const ay = (q00.y * (1 - tu) + q10.y * tu) * (1 - tv) + (q01.y * (1 - tu) + q11.y * tu) * tv
        const real = projectStagePoint(box.x + box.w * uc, box.y + box.h * vc, cfg)
        m = Math.max(m, Math.hypot(ax - real.x, ay - real.y))
      }
    }
    return m
  }
  const d1 = maxDev(1), d4 = maxDev(4), d16 = maxDev(16)
  ok(d4 < d1, `seg=4 应优于 seg=1（${d4} < ${d1}）`)
  ok(d16 < d4, `seg=16 应优于 seg=4（${d16} < ${d4}）`)
  ok(d16 < 10, `seg=16 格内偏差应 <10px（实际 ${d16}）`)
})

console.log('\n== 旧工程迁移 ==')
t('旧轴模型字段 → 四角（不崩、四角有效）', () => {
  const cfg = resolveLayer3D(
    { enabled: true, axisX: 0.5, axisY: 0.5, axisAngle: 0, rotate: 40, vpX: 0.5, vpY: 0.5, focal: 0.9 },
    stage
  )
  ok(cfg.quad.length === 4)
  for (const p of cfg.quad) ok(Number.isFinite(p.x) && Number.isFinite(p.y), '角坐标有限')
})

// ===== 跟随圆形图片的 3D 同构（环形频谱柱环境） =====
// 语义：跟随方（环形频谱）把自身每个绘制点经「圆形图片的内容盒 + 圆形自己的 layer3d」
// 投影一次 → 环与圆处于同一套单应性 = 严格同构（与 drawer 内 followProject 完全一致）。
console.log('\n== 跟随圆形的 3D 同构 ==')
t('同一「盒子+layer3d」下：盒四角 → 投影四角（同构充要）', () => {
  const circleBox = { x: 420, y: 140, w: 800, h: 800 }
  const corners = [{ x: -0.05, y: 0.1 }, { x: 0.95, y: -0.05 }, { x: 1.1, y: 0.95 }, { x: 0.0, y: 1.05 }]
  const cfg = resolveLayer3D({ enabled: true, corners }, stage, circleBox)
  // 盒四角（stage 像素）投影后必须恰好等于 quad（因为四角相对该盒归一化）
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

t('圆形圆心 → 投影中心附近（跟随点与圆心同构，不漂移）', () => {
  const circleBox = { x: 420, y: 140, w: 800, h: 800 }
  const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] // 恒等
  const cfg = resolveLayer3D({ enabled: true, corners }, stage, circleBox)
  const cx = circleBox.x + circleBox.w / 2
  const cy = circleBox.y + circleBox.h / 2
  const p = projectStagePoint(cx, cy, cfg)
  close(p.x, cx, 1e-6, '圆心 x（恒等应不动）')
  close(p.y, cy, 1e-6, '圆心 y（恒等应不动）')
})

t('圆形未启用 3D → 投影恒等（调用方退回原坐标，行为不变）', () => {
  const circleBox = { x: 100, y: 50, w: 640, h: 640 }
  const cfg = resolveLayer3D({ enabled: false }, stage, circleBox)
  eq(cfg.enabled, false, 'enabled')
  const p = projectStagePoint(777, 333, cfg)
  close(p.x, 777, 1e-12, 'x 恒等')
  close(p.y, 333, 1e-12, 'y 恒等')
})

t('跟随方的点落在圆形盒外：仍按同一 H 外推（环可超出圆形边界）', () => {
  const circleBox = { x: 420, y: 140, w: 800, h: 800 }
  const corners = [{ x: 0, y: 0 }, { x: 0.8, y: 0.1 }, { x: 0.9, y: 1 }, { x: 0.1, y: 0.9 }]
  const cfg = resolveLayer3D({ enabled: true, corners }, stage, circleBox)
  // 圆外一点（比盒更靠右）→ 投影结果有限且仍在盒右侧（H 是整体映射，外推合理）
  const outside = { x: circleBox.x + circleBox.w * 1.5, y: circleBox.y + circleBox.h / 2 }
  const p = projectStagePoint(outside.x, outside.y, cfg)
  ok(Number.isFinite(p.x) && Number.isFinite(p.y), '外推坐标有限')
  ok(p.x > cfg.quad[0].x, '外推点应仍在左侧之外（单调向右）')
})

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
