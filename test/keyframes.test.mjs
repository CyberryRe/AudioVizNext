/**
 * keyframes.test.mjs —— 关键帧内置 API 的单测（纯逻辑，Node 模式）。
 * 运行：npm test
 */
import {
  evaluateKeyframes, paramAt, setKeyframe, removeKeyframeNear, hasKeyframeNear, isValidKeyframes, KEYFRAME_EPS,
  setKeyframeEase, easeProgress
} from '../src/renderer/src/presets/keyframes.ts'

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e?.message ?? e}`) }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg ?? 'eq'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
}
function close(a, b, eps, msg) {
  if (Math.abs(a - b) > eps) throw new Error(`${msg ?? 'close'}：期望 ≈${b}，实际 ${a}`)
}
function ok(v, msg) { if (!v) throw new Error(msg ?? '期望为真') }

console.log('== evaluateKeyframes ==')
t('无轨道/空轨道 → null（调用方回落静态值）', () => {
  eq(evaluateKeyframes(undefined, 0.5), null)
  eq(evaluateKeyframes([], 0.5), null)
})
t('单点 → 恒定值', () => {
  eq(evaluateKeyframes([{ t: 0.3, v: 7 }], 0), 7)
  eq(evaluateKeyframes([{ t: 0.3, v: 7 }], 0.9), 7)
})
t('线性插值中点', () => {
  const track = [{ t: 0, v: 0 }, { t: 1, v: 100 }]
  close(evaluateKeyframes(track, 0.5), 50, 1e-9)
  close(evaluateKeyframes(track, 0.25), 25, 1e-9)
})
t('范围外夹取端点（不外推）', () => {
  const track = [{ t: 0.2, v: 10 }, { t: 0.8, v: 20 }]
  eq(evaluateKeyframes(track, 0), 10)
  eq(evaluateKeyframes(track, 1), 20)
})
t('多点分段插值', () => {
  const track = [{ t: 0, v: 0 }, { t: 0.5, v: 10 }, { t: 1, v: 0 }]
  close(evaluateKeyframes(track, 0.25), 5, 1e-9)
  close(evaluateKeyframes(track, 0.75), 5, 1e-9)
})

console.log('== paramAt（预设对外 API） ==')
t('无关键帧 → 用静态参数', () => {
  eq(paramAt({ r: 12 }, undefined, 'r', 0.5, 99), 12)
})
t('有关键帧 → 关键帧优先于静态参数', () => {
  const kf = { r: [{ t: 0, v: 0 }, { t: 1, v: 40 }] }
  close(paramAt({ r: 999 }, kf, 'r', 0.5, 99), 20, 1e-9)
})
t('都缺失 → 用 schema 默认值', () => {
  eq(paramAt({}, {}, 'r', 0.5, 7), 7)
})
t('参数非数值 → 用默认值', () => {
  eq(paramAt({ r: 'x' }, undefined, 'r', 0.5, 7), 7)
})

console.log('== 编辑 ==')
t('setKeyframe 插入并保持升序', () => {
  let track = setKeyframe(undefined, 0.5, 1)
  track = setKeyframe(track, 0.2, 2)
  track = setKeyframe(track, 0.9, 3)
  eq(track.map((k) => k.t).join(','), '0.2,0.5,0.9')
})
t('setKeyframe 同位置替换（容差内）', () => {
  let track = setKeyframe(undefined, 0.5, 1)
  track = setKeyframe(track, 0.5 + KEYFRAME_EPS / 2, 42)
  eq(track.length, 1)
  eq(track[0].v, 42)
})
t('setKeyframe 夹取 t 到 [0,1]', () => {
  eq(setKeyframe(undefined, -1, 5)[0].t, 0)
  eq(setKeyframe(undefined, 2, 5)[0].t, 1)
})
t('removeKeyframeNear / hasKeyframeNear', () => {
  const track = setKeyframe(setKeyframe(undefined, 0.25, 1), 0.75, 2)
  ok(hasKeyframeNear(track, 0.25))
  const left = removeKeyframeNear(track, 0.25)
  eq(left.length, 1)
  ok(!hasKeyframeNear(left, 0.25))
  ok(hasKeyframeNear(left, 0.75))
})

console.log('== 校验 ==')
t('isValidKeyframes：合法/非法', () => {
  ok(isValidKeyframes(undefined), 'undefined 合法')
  ok(isValidKeyframes({ a: [] }), '空轨道合法')
  ok(isValidKeyframes({ a: [{ t: 0, v: 1 }, { t: 1, v: 2 }] }), '升序合法')
  ok(isValidKeyframes({ a: [{ t: 0, v: 1, ease: 'ease' }, { t: 1, v: 2 }] }), '带 ease 合法')
  ok(!isValidKeyframes({ a: [{ t: 1, v: 1 }, { t: 0, v: 2 }] }), '降序应非法')
  ok(!isValidKeyframes({ a: [{ t: 0 }] }), '缺 v 应非法')
  ok(!isValidKeyframes({ a: [{ t: 2, v: 1 }] }), 't 越界应非法')
  ok(!isValidKeyframes({ a: [{ t: 0, v: 1, ease: 'nope' }] }), '非法 ease 应非法')
  ok(!isValidKeyframes({ a: 5 }), '非数组应非法')
  ok(!isValidKeyframes([]), '顶层数组应非法')
})

console.log('== 缓动 ==')
t('easeProgress 各模式', () => {
  eq(easeProgress('linear', 0.5), 0.5)
  eq(easeProgress('hold', 0.9), 0)
  close(easeProgress('easeIn', 0.5), 0.25, 1e-9)
  close(easeProgress('easeOut', 0.5), 0.75, 1e-9)
  close(easeProgress('ease', 0.5), 0.5, 1e-9)
  ok(easeProgress('ease', 0.25) < 0.25, 'ease 在前半段慢于线性')
  ok(easeProgress('ease', 0.75) > 0.75, 'ease 在后半段快于线性')
})
t('evaluateKeyframes 使用左端 ease', () => {
  const track = [{ t: 0, v: 0, ease: 'easeIn' }, { t: 1, v: 100 }]
  close(evaluateKeyframes(track, 0.5), 25, 1e-9)
})
t('setKeyframe 替换时保留 ease', () => {
  let track = setKeyframe(undefined, 0, 0, 'easeOut')
  track = setKeyframe(track, 0, 10)
  eq(track[0].ease, 'easeOut')
  eq(track[0].v, 10)
})
t('setKeyframeEase 最近点', () => {
  let track = setKeyframe(setKeyframe(undefined, 0, 0), 1, 1)
  track = setKeyframeEase(track, 0.02, 'ease')
  eq(track[0].ease, 'ease')
})

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
