/**
 * layer3d.test.mjs —— 泛用 3D 投影底层单测（纯数学）。
 */
import {
  resolveLayer3D,
  projectStagePoint,
  affineAt,
  isLayer3DActive,
  layer3DHud,
  defaultLayer3D,
  offsetResolvedLayer3D,
  layer3DClipOffset,
  planPerspectiveGrid
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

console.log('== resolve / active ==')
t('未启用 → 恒等投影', () => {
  const cfg = resolveLayer3D(undefined, stage)
  eq(cfg.enabled, false)
  const p = projectStagePoint(100, 200, cfg)
  close(p.x, 100, 1e-9)
  close(p.y, 200, 1e-9)
  close(p.s, 1, 1e-9)
})
t('isLayer3DActive：enabled 且 rotate≠0', () => {
  ok(!isLayer3DActive({ enabled: true, rotate: 0 }))
  ok(isLayer3DActive({ enabled: true, rotate: 30 }))
  ok(!isLayer3DActive({ enabled: false, rotate: 30 }))
})

console.log('== 投影 ==')
t('轴上点旋转后不动', () => {
  const cfg = resolveLayer3D({ enabled: true, axisX: 0.5, axisY: 0.5, axisAngle: 0, rotate: 40, vpX: 0.5, vpY: 0.5, focal: 0.9 }, stage)
  const p = projectStagePoint(960, 540, cfg)
  close(p.x, 960, 0.5)
  close(p.y, 540, 0.5)
  close(p.z, 0, 1e-6)
})
t('轴一侧点产生深度，透视向 VP 收缩', () => {
  const cfg = resolveLayer3D({ enabled: true, axisX: 0.5, axisY: 0.5, axisAngle: 0, rotate: 35, vpX: 0.5, vpY: 0.5, focal: 0.9 }, stage)
  // 轴水平时法线朝 +Y（屏幕向下）。轴下方 y>540 → perp>0 → z>0
  const down = projectStagePoint(960, 800, cfg)
  ok(down.z > 0, '下方应有正深度')
  ok(down.s < 1, '应缩小')
  ok(Math.abs(down.y - 540) < Math.abs(800 - 540), '应向 VP Y 靠拢')
})

console.log('== 仿射 ==')
t('未启用 affineAt 为平移单位阵', () => {
  const cfg = resolveLayer3D(undefined, stage)
  const m = affineAt(10, 20, cfg)
  eq(m.a, 1); eq(m.d, 1); eq(m.b, 0); eq(m.c, 0)
  eq(m.e, 10); eq(m.f, 20)
})
t('启用后中心 Jacobian 有限且接近缩放', () => {
  const cfg = resolveLayer3D({ enabled: true, axisAngle: 0, rotate: 20, axisX: 0.5, axisY: 0.5, vpX: 0.5, vpY: 0.5, focal: 0.9 }, stage)
  const m = affineAt(960, 400, cfg)
  ok(Number.isFinite(m.a) && Number.isFinite(m.d), '有限')
  ok(Math.abs(m.a) > 0.01 && Math.abs(m.a) < 2, 'a 合理')
})

console.log('== HUD ==')
t('未启用无 HUD；启用有轴线与 VP', () => {
  eq(layer3DHud(resolveLayer3D(undefined, stage)), null)
  const cfg = resolveLayer3D({ enabled: true, rotate: 10, axisX: 0.3, axisY: 0.4, vpX: 0.6, vpY: 0.5 }, stage)
  const hud = layer3DHud(cfg)
  ok(hud)
  close(hud.vp.x, 0.6 * 1920, 0.1)
  ok(hud.axis.x2 > hud.axis.x1)
})

t('defaultLayer3D 字段齐全', () => {
  const d = defaultLayer3D()
  ok(typeof d.depth === 'number' && typeof d.vpX === 'number')
})
t('depth 优先于 focal；更小 depth → 更强透视（s 更小）', () => {
  const stage = { width: 1920, height: 1080 }
  const near = resolveLayer3D({ enabled: true, rotate: 40, depth: 0.2, axisX: 0.5, axisY: 0.5, vpX: 0.5, vpY: 0.5 }, stage)
  const far = resolveLayer3D({ enabled: true, rotate: 40, depth: 2.5, axisX: 0.5, axisY: 0.5, vpX: 0.5, vpY: 0.5 }, stage)
  const pNear = projectStagePoint(960, 900, near)
  const pFar = projectStagePoint(960, 900, far)
  ok(pNear.s < pFar.s, '小纵深应缩小更多')
})
t('offsetResolvedLayer3D：轴与 VP 同步平移', () => {
  const stage = { width: 1920, height: 1080 }
  const cfg = resolveLayer3D({ enabled: true, rotate: 10, axisX: 0.5, axisY: 0.5, vpX: 0.5, vpY: 0.5 }, stage)
  const off = offsetResolvedLayer3D(cfg, 100, -50)
  close(off.axisX, cfg.axisX + 100, 1e-9)
  close(off.vpX, cfg.vpX + 100, 1e-9)
  close(off.axisY, cfg.axisY - 50, 1e-9)
})
t('layer3DClipOffset：preset 只认 params.pos（忽略 transform）', () => {
  const stage = { width: 1920, height: 1080 }
  const style = { enabled: true }
  const o = layer3DClipOffset(style, stage, 'preset', { x: 0.1, y: -0.2 }, { posX: 0.05, posY: 0 })
  // 预设层内容位移只来自 params；transform 不参与内容绘制 → 不得叠加
  close(o.dx, 0.05 * 1920, 0.01)
  close(o.dy, 0, 0.01)
})
t('layer3DClipOffset：media 只认 transform', () => {
  const stage = { width: 1920, height: 1080 }
  const style = { enabled: true }
  const o = layer3DClipOffset(style, stage, 'media', { x: 0.1, y: -0.2 }, { posX: 0.05, posY: 0.5 })
  close(o.dx, 0.1 * 1920, 0.01)
  close(o.dy, -0.2 * 1080, 0.01)
})
t('未启用 layer3d → 偏移为 0', () => {
  const stage = { width: 1920, height: 1080 }
  const o = layer3DClipOffset({ enabled: false }, stage, 'media', { x: 0.3, y: 0.3 })
  eq(o.dx, 0); eq(o.dy, 0)
})

console.log('== 形状锁定（轴跟随量 = 内容位移量 → Δs≡0）==')
t('轴/VP 与内容同幅平移时缩放 s 不变', () => {
  const style = { enabled: true, axisAngle: 0, rotate: 45, depth: 0.9, axisX: 0.5, axisY: 0.5, vpX: 0.5, vpY: 0.5 }
  const base = resolveLayer3D(style, stage)
  const pts = [[100, 100], [960, 540], [1800, 900]]
  const s0 = pts.map(([x, y]) => projectStagePoint(x, y, base))
  for (const [dx, dy] of [[200, 0], [0, 150], [-300, 80]]) {
    const moved = offsetResolvedLayer3D(base, dx, dy)
    pts.forEach(([x, y], i) => {
      const p = projectStagePoint(x + dx, y + dy, moved)
      close(p.s, s0[i].s, 1e-9, `点${i} 缩放漂移`)
      close(p.z, s0[i].z, 1e-9, `点${i} 深度漂移`)
    })
  }
})

console.log('== 细分网格（消折痕）==')
t('planPerspectiveGrid 顶点/索引数正确', () => {
  const cfg = resolveLayer3D({ enabled: true, rotate: 40, axisX: 0.5, axisY: 0.5, vpX: 0.5, vpY: 0.5 }, stage)
  const g = planPerspectiveGrid({ x: 0, y: 0, w: 1920, h: 1080 }, cfg, 16)
  eq(g.vertexCount, 17 * 17)
  eq(g.positions.length, 17 * 17 * 2)
  eq(g.uvs.length, 17 * 17 * 2)
  eq(g.indices.length, 16 * 16 * 6)
  eq(g.corners.length, 4)
})
t('细分网格逐顶点投影：格内插值误差随 seg 单调下降', () => {
  const style = { enabled: true, axisAngle: 0, rotate: 60, depth: 0.9, axisX: 0.5, axisY: 0.5, vpX: 0.5, vpY: 0.5 }
  const cfg = resolveLayer3D(style, stage)
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

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
