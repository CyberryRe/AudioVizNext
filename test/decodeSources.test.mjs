/**
 * decodeSources.test.mjs —— DecodeSourceManager / 共享会话缓存的纯逻辑单测。
 *
 * WebCodecs 真实解码只在 GUI(Chromium)；这里锁定不依赖解码器的接缝决策：
 *  - auForFrame：工程 sourceFrame → 源 AU 索引，与 <video>.currentTime 口径一致（保"导出=预览"像素一致）；
 *  - prepare 优雅降级：非 H.264 / 无 ffmpeg / 无 VideoDecoder / demux 抛错 → 该源不建会话、绝不 throw；
 *  - prepare 对重复源只 demux 一次（共享缓存去重）；
 *  - registerSrc → sessionForSrc 反查（渲染层用 effective src 定位；Node 无解码器→null 不崩）；
 *  - retireShared/disposeAllShared 幂等安全。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DecodeSourceManager,
  disposeAllShared,
  retireShared,
  sharedCacheSize
} from '../src/renderer/src/pixi/h264/decodeSources.ts'

// 每用例前清共享缓存（本文件单进程，避免用例间路径串扰）
test.beforeEach(() => { disposeAllShared() })

test('auForFrame 映射：工程帧 → 秒 → 源 AU', () => {
  const mgr = new DecodeSourceManager(30) // project fps 30
  const fake = { sourceFps: 60 } // 源 60fps
  assert.equal(mgr.auForFrame(fake, 0, 30), 0)
  assert.equal(mgr.auForFrame(fake, 30, 30), 60) // 1s*60
  assert.equal(mgr.auForFrame(fake, 15, 30), 30) // 0.5s*60
  assert.equal(mgr.auForFrame(fake, 1, 30), 2)   // 1/30s*60=2
})

test('auForFrame：无 fps / 异常降级', () => {
  const mgr = new DecodeSourceManager(30)
  assert.equal(mgr.auForFrame({ sourceFps: 30 }, 7, 0), 7) // fps 0 → 直返
  assert.equal(mgr.auForFrame({ sourceFps: 60 }, 30), 60)  // 默认 projectFps 30
})

test('prepare：无 WebCodecs(VideoDecoder) → 优雅返回 0 且不 throw', async () => {
  const mgr = new DecodeSourceManager(30, async () => ({ ok: true, es: { esPath: '/tmp/x.h264', esLen: 1234, sourceFps: 30, width: 100, height: 50, durationSec: 10 } }))
  const n = await mgr.prepare(['/tmp/a.mp4', '/tmp/a.mp4'])
  assert.equal(n, 0)
  assert.equal(sharedCacheSize(), 1) // 仅保留缓存项（session null），不重复建
})

test('prepare：demux 非 H.264/失败/抛错 → 隔离该源，不 throw', async () => {
  let calls = 0
  const mgr = new DecodeSourceManager(30, async (p) => {
    calls++
    if (p.includes('bad')) return { ok: false, es: null }
    if (p.includes('boom')) throw new Error('ffmpeg crashed')
    return { ok: true, es: { esPath: '/tmp/b.h264', esLen: 10, sourceFps: 30, width: 10, height: 10, durationSec: 1 } }
  })
  const n = await mgr.prepare(['/tmp/bad.mp4', '/tmp/boom.mp4'])
  assert.equal(n, 0)
  assert.equal(calls, 2)
})

test('prepare：单次调用内重复源只 demux 一次', async () => {
  let calls = 0
  const mgr = new DecodeSourceManager(30, async () => { calls++; return { ok: false, es: null } })
  await mgr.prepare(['/x.mp4', '/x.mp4', '/y.mp4', '/y.mp4'])
  assert.equal(calls, 2) // x、y 各一次
})

test('registerSrc → sessionForSrc 反查：Node 无解码器→null 不崩；未注册→null', () => {
  const mgr = new DecodeSourceManager(30, async () => ({ ok: false, es: null }))
  mgr.registerSrc('avn-file://%2Fp%2Fa.mp4', 'C:/p/a.mp4')
  // 无 WebCodecs → prepare 不建会话 → sessionForSrc null（渲染层会回退 <video>）
  assert.equal(mgr.sessionForSrc('avn-file://%2Fp%2Fa.mp4'), null)
  assert.equal(mgr.sessionForSrc('unknown'), null)
  assert.equal(mgr.sessionForPath('C:/p/a.mp4'), null)
})

test('retireShared / disposeAllShared 幂等安全', () => {
  retireShared('/no/such/path') // 不抛
  assert.equal(sharedCacheSize(), 0)
  disposeAllShared()            // 空缓存也不抛
})
