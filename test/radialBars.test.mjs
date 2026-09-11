/**
 * radialBars.test.mjs —— 环形频谱柱绘制器单测（纯逻辑 + 假 2D 上下文）。
 *
 * 守的是两个回归点：
 *  ① **跟随 = 同面**：圆形贴了 3D 面时，环的**每一个**绘制点都必须经 env.followProject 投影，
 *     否则环会留在画幅平面上（看起来"没跟随到同一个面"）。
 *  ② **柱样式**：圆角/胶囊真的插入了圆角轮廓点，而不是只有开关没效果。
 */
import { readFileSync } from 'fs'
import { drawRadialBars, radialBarCornerRadii } from '../src/renderer/src/presets/drawers/radialBars.ts'
import { decodeAvnpre } from '../src/shared/avnpre.ts'
import { resolveLayer3D, projectStagePoint } from '../src/renderer/src/pixi/layer3d.ts'

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e?.message ?? e}`) }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg ?? 'eq'}：期望 ${b}，实际 ${a}`)
}
function ok(v, msg) { if (!v) throw new Error(msg ?? '期望为真') }
function close(a, b, eps, msg) {
  if (Math.abs(a - b) > eps) throw new Error(`${msg ?? 'close'}：期望 ≈${b}，实际 ${a}`)
}

/** 假 2D 上下文：只记录命令（含每次 fill/stroke 的路径点） */
function makeCtx() {
  const cmds = []
  let path = []
  return {
    cmds,
    ctx: {
      save() { cmds.push({ op: 'save' }) },
      restore() { cmds.push({ op: 'restore' }) },
      beginPath() { path = []; cmds.push({ op: 'beginPath' }) },
      moveTo(x, y) { path.push({ x, y }); cmds.push({ op: 'moveTo', x, y }) },
      lineTo(x, y) { path.push({ x, y }); cmds.push({ op: 'lineTo', x, y }) },
      closePath() { cmds.push({ op: 'closePath' }) },
      fill() { cmds.push({ op: 'fill', path: path.slice() }) },
      stroke() { cmds.push({ op: 'stroke', path: path.slice() }) },
      fillStyle: '', strokeStyle: '', globalAlpha: 1, shadowColor: '', shadowBlur: 0, lineWidth: 1
    }
  }
}

/** 假装有声：freqValue 只读 frames / freqBins / freq */
const fakeAudio = { frames: 2, freqBins: 8, freq: new Float32Array(16).fill(0.55), wave: new Float32Array(2), level: new Float32Array(2), onset: new Float32Array(2) }

// —— 声明取自**内置预设**（单一事实源）；顺便验证分发包与内置声明逐字一致 ——
const builtin = JSON.parse(readFileSync(new URL('../presets/visualizations/radial-bars/preset.json', import.meta.url), 'utf8'))
const dec = decodeAvnpre(readFileSync(new URL('../plugins/radial-bars.avnpre', import.meta.url), 'utf8'))
ok(dec.ok, `plugins/radial-bars.avnpre 应可解码：${dec.ok ? '' : dec.error}`)
const meta = {
  format: 'avnpreset',
  version: 1,
  id: builtin.id,
  name: builtin.name,
  category: 'visualization',
  clipType: 'visual',
  kind: 'visual',
  drawer: builtin.drawer,
  durationFrames: 300,
  params: builtin.params
}
const params = {}
for (const p of builtin.params) params[p.key] = p.default

const stage = { width: 1920, height: 1080 }
const box3d = { enabled: true, depth: 0.35, camera: 1 }
const circleBox = { x: 420, y: 140, w: 800, h: 800 }
const faceCfg = resolveLayer3D({ enabled: true, face: 'left' }, stage, box3d, circleBox)
const followCircle = { x: 960, y: 540, radius: 400, spinRad: 0, box: circleBox, layer3d: { enabled: true, face: 'left' } }
function makeEnv(extra = {}) {
  return {
    width: stage.width, height: stage.height, frame: 0, fps: 30, timeSec: 0, sourceFrame: 0,
    energy: 0.5, opacity: 1, tRel: 0, audio: fakeAudio, ...extra
  }
}
/** 取一次绘制里所有 fill 的路径点 */
function fillPoints(cmds) {
  const out = []
  for (const c of cmds) if (c.op === 'fill') out.push(...c.path)
  return out
}

console.log('== 内置声明 ==')
t('内置 preset.json 含 barStyle（圆角可调）且默认为圆角', () => {
  const p = builtin.params.find((x) => x.key === 'barStyle')
  ok(p, 'barStyle 参数存在')
  eq(p.type, 'select')
  eq(p.default, 'round')
  eq(p.options.length, 3)
})
t('内置声明的 drawer 就是本绘制器', () => {
  eq(builtin.id, 'radial-bars')
  eq(builtin.drawer, 'radial-bars')
  eq(builtin.category, 'visualization')
})
t('分发包与内置声明逐字一致（生成脚本单一事实源）', () => {
  eq(dec.preset.implementation.type, 'builtin')
  eq(dec.preset.implementation.drawer, 'radial-bars')
  eq(JSON.stringify(dec.preset.params), JSON.stringify(builtin.params))
  eq(dec.preset.desc, builtin.desc)
})

console.log('== 跟随 = 逐顶点投影（核心回归）==')
t('开启跟随时，每个绘制点都经过 env.followProject', () => {
  const { ctx, cmds } = makeCtx()
  const marker = (x, y) => ({ x: x + 100000, y })
  drawRadialBars(ctx, makeEnv({ followCircle, followProject: marker }), { ...params, innerRing: true }, meta)
  const pts = fillPoints(cmds)
  ok(pts.length > 100, `应有大量绘制点（实际 ${pts.length}）`)
  const minX = Math.min(...pts.map((p) => p.x))
  ok(minX > 100000, `所有点都应位移（最小 x=${minX}）`)
  // 内圈描边同样要走投影
  const stroke = cmds.find((c) => c.op === 'stroke')
  ok(stroke && stroke.path.length > 32, '内圈描边点足够多')
  ok(Math.min(...stroke.path.map((p) => p.x)) > 100000, '内圈也经过投影')
})
t('圆形贴左面时，环确实落在左面（投影后整体压进画面左半）', () => {
  const fp = (x, y) => { const p = projectStagePoint(x, y, faceCfg); return { x: p.x, y: p.y } }
  const { ctx, cmds } = makeCtx()
  drawRadialBars(ctx, makeEnv({ followCircle, followProject: fp }), { ...params, innerRing: true }, meta)
  const pts = fillPoints(cmds)
  const minX = Math.min(...pts.map((p) => p.x))
  const maxX = Math.max(...pts.map((p) => p.x))
  const minY = Math.min(...pts.map((p) => p.y))
  const maxY = Math.max(...pts.map((p) => p.y))
  // 左墙的投影只可能落在画面左半（未投影时环心在 960，会铺满整个画幅）
  ok(maxX < stage.width / 2, `环应整体落在画面左半（实际 maxX=${maxX}）`)
  ok(minX > -stage.width * 0.1 && maxX < stage.width, `x 在画幅内（${minX}..${maxX}）`)
  ok(minY > -stage.height * 0.1 && maxY < stage.height * 1.1, `y 在画幅内（${minY}..${maxY}）`)
  // 反证：未投影的话环心在 960、半径 500+ → 最右会远超 960
  ok(maxX < 600, '明显不是未投影的画幅平面坐标')
})
t('不跟随时（未开/圆形未启用 3D）：退回恒等，点即 stage 坐标', () => {
  const { ctx, cmds } = makeCtx()
  drawRadialBars(ctx, makeEnv({ followCircle: null, followProject: undefined }), { ...params, followCircle: false }, meta)
  const pts = fillPoints(cmds)
  const cx = 960, cy = 540
  const maxR = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy)))
  ok(maxR < 900, `应围绕画幅中心（实际最大半径 ${maxR}）`)
})

console.log('== 柱样式（圆润度）==')
t('圆角半径：尖角 0 ＜ 圆角 ＜ 胶囊（胶囊 ≤ 切向半宽）', () => {
  const sharp = radialBarCornerRadii('sharp', 120, 6, 10)
  const round = radialBarCornerRadii('round', 120, 6, 10)
  const pill = radialBarCornerRadii('pill', 120, 6, 10)
  eq(sharp.rcOut, 0, '尖角无圆角')
  ok(round.rcOut > 0, '圆角应 > 0')
  ok(pill.rcOut >= round.rcOut, '胶囊 ≥ 圆角')
  ok(pill.rcOut <= 10 + 1e-9, '胶囊不得超过切向半宽')
  ok(round.rcOut < pill.rcOut, '胶囊应更圆')
})
t('短柱不被圆角吃掉（半径随柱长夹紧）', () => {
  const r = radialBarCornerRadii('pill', 3, 2, 2)
  ok(r.rcOut <= 1.5 + 1e-9, `柱长 3 → 圆角 ≤ 1.5（实际 ${r.rcOut}）`)
  eq(radialBarCornerRadii('pill', 0.2, 2, 2).rcOut, 0, '极短柱直接方角')
})
t('胶囊样式的轮廓点比尖角多（圆角真的画进去了）', () => {
  const a = makeCtx()
  drawRadialBars(a.ctx, makeEnv({ followCircle: null }), { ...params, followCircle: false, barStyle: 'sharp', innerRing: false }, meta)
  const b = makeCtx()
  drawRadialBars(b.ctx, makeEnv({ followCircle: null }), { ...params, followCircle: false, barStyle: 'pill', innerRing: false }, meta)
  const na = a.cmds.filter((c) => c.op === 'lineTo').length
  const nb = b.cmds.filter((c) => c.op === 'lineTo').length
  ok(nb > na, `胶囊应插入更多采样点（sharp=${na}，pill=${nb}）`)
  // 每根柱一次 fill
  eq(a.cmds.filter((c) => c.op === 'fill').length, Math.round(params.barCount))
})
t('尖角样式不额外插点（几何与旧版一致）', () => {
  const { ctx, cmds } = makeCtx()
  drawRadialBars(ctx, makeEnv({ followCircle: null }), { ...params, followCircle: false, barStyle: 'sharp', innerRing: false }, meta)
  const n = Math.round(params.barCount)
  const lines = cmds.filter((c) => c.op === 'lineTo').length
  // 每根柱：内弧 1 + 两个外角端点 + 外弧 1 ≈ 4~5 段
  ok(lines <= n * 5, `尖角不应有大量插点（${lines} vs n=${n}）`)
})

console.log('== 确定性与健壮性 ==')
t('同一 (env, params) 两次绘制命令完全一致（确定性）', () => {
  const a = makeCtx()
  drawRadialBars(a.ctx, makeEnv({ followCircle }), params, meta)
  const b = makeCtx()
  drawRadialBars(b.ctx, makeEnv({ followCircle }), params, meta)
  eq(JSON.stringify(a.cmds), JSON.stringify(b.cmds))
})
t('无音频（audio=null）不崩，仍有柱体', () => {
  const { ctx, cmds } = makeCtx()
  drawRadialBars(ctx, makeEnv({ audio: null, followCircle: null }), { ...params, followCircle: false }, meta)
  ok(cmds.filter((c) => c.op === 'fill').length >= 8, '至少画出最小柱长的柱')
})
t('save/restore 配对', () => {
  const { ctx, cmds } = makeCtx()
  drawRadialBars(ctx, makeEnv({ followCircle }), params, meta)
  eq(cmds.filter((c) => c.op === 'save').length, cmds.filter((c) => c.op === 'restore').length)
})
t('圆角不影响环心：柱体起点仍在内半径上', () => {
  const { ctx, cmds } = makeCtx()
  const fc = { x: 960, y: 540, radius: 400, spinRad: 0, box: circleBox }
  drawRadialBars(ctx, makeEnv({ followCircle: fc }), { ...params, barStyle: 'pill' }, meta)
  const pts = fillPoints(cmds)
  const r0 = 400 * (1 + params.ringPad)
  const minR = Math.min(...pts.map((p) => Math.hypot(p.x - fc.x, p.y - fc.y)))
  close(minR, r0, 1.5, '最近点应贴在内半径上')
})

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
