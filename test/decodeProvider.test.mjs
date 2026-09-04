/**
 * decodeProvider.test.mjs —— 纯 Node 验证 H264DecodeProvider 的决策逻辑
 * （feed 滞回窗口 / 背压 / 缓存与淘汰 / current 命中），用注入 mock 替代真实 WebCodecs。
 *
 * 运行：node --experimental-strip-types test/decodeProvider.test.mjs
 */
import { H264DecodeProvider } from '../src/renderer/src/pixi/h264/decoder.ts'

let pass = 0, fail = 0
const order = []
async function t(name, fn) {
  order.push(name)
  try { await fn(); pass++; console.log('  ok  ' + name) }
  catch (e) { fail++; console.error('FAIL  ' + name + '\n      ' + (e?.stack || e?.message || e)) }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert') }
function eq(a, b, m) { if (a !== b) throw new Error((m || 'eq') + `: ${a} != ${b}`) }

/** 造一个简单 mock VideoDecoder：decode 立即产出 1x1 ImageBitmap 桩帧。 */
function makeMockVideoDecoderFactory() {
  const handles = []
  // 必须用普通 function（非箭头）才能被 `new VideoDecoder()` 调用
  const factory = function MockVideoDecoder(init) {
    this.config = null
    this.configured = false
    this.decodeQueueSize = 0
    this.closed = false
    this.resetCalls = 0
    const self = this
    this.configure = function (c) { self.config = c; self.configured = true }
    this.decode = function (chunk) {
      if (!self.configured) throw new Error('decode before configure')
      self.decodeQueueSize = 2 // 模拟短暂排队
      const frame = { timestamp: chunk.timestamp, displayWidth: 2, displayHeight: 2, close() {} }
      init.output(frame)
      self.decodeQueueSize = 0
    }
    this.flush = function () { return Promise.resolve() }
    this.close = function () { self.closed = true }
    this.reset = function () { self.resetCalls++ }
    handles.push(self)
    return self
  }
  return { factory, handles }
}

/** Polyfill WebCodecs 全局（Node 无），让真实 decoder.ts 代码路径在纯 Node 可跑。 */
function polyfillWebCodecs() {
  if (typeof globalThis.EncodedVideoChunk === 'undefined') {
    globalThis.EncodedVideoChunk = function EncodedVideoChunk(init) {
      this.data = init.data
      this.timestamp = init.timestamp
      this.type = init.type
    }
  }
  if (typeof globalThis.VideoFrame === 'undefined') {
    globalThis.VideoFrame = function VideoFrame() {}
  }
}

/** Range reader：读 [0, esLen) 合成一段真实可被 esUtils 索引的 ES？为简，直接给内存缓冲。 */
function memReader(buf) {
  return {
    async read(start, end) {
      return buf.subarray(start, Math.min(end, buf.length)).slice()
    }
  }
}

/** 构造一段有 K 个 AU 的 ES：每个 AU 一个 NAL（首 AU 关键帧 type5，其余 type1）。 */
function makeEsBytes(auCount) {
  // 每个 NAL: [00 00 00 01][header][payload 3 字节]
  const parts = []
  for (let a = 0; a < auCount; a++) {
    const hdr = a === 0 ? 0x65 : 0x41 // type5(IDR) | type1
    parts.push(new Uint8Array([0, 0, 0, 1, hdr, 1, 2, 3]))
  }
  // 拼接
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

// 本测试用 mock：真实 webcodecs 在 GUI 才跑。info 需要 description —— mock 下不真配置，无需提供，
// 但 _open() 逻辑要求 description，否则 errored。故给个假 description 让状态走到 ready。
function mkProvider(auCount, lookahead, maxFrames, frameConverter) {
  const bytes = makeEsBytes(auCount)
  const decoderCtl = makeMockVideoDecoderFactory()
  polyfillWebCodecs()
  const prevVD = globalThis.VideoDecoder
  globalThis.VideoDecoder = decoderCtl.factory
  const prov = new H264DecodeProvider({
    reader: memReader(bytes),
    info: { esLen: bytes.length, sourceFps: 30, width: 2, height: 2, codec: 'avc1.640032', description: new Uint8Array([1, 0, 0, 0]) },
    lookaheadFrames: lookahead,
    maxFrames,
    available: true,
    frameConverter: frameConverter ?? (async (f) => ({ width: 2, height: 2, close() {} }))
  })
  const restore = () => { globalThis.VideoDecoder = prevVD }
  return { prov, decoderCtl, bytes, restore }
}

// 每个用例都要等 _open()（buildIndex + configure）完成。
async function ready(p) {
  while (p.prov.status === 'opening' || p.prov.status === 'unavailable') {
    await new Promise((r) => setTimeout(r, 1))
  }
}
/** 用例收尾：dispose provider + 恢复全局 VideoDecoder */
function cleanup(mk) {
  try { mk.prov.dispose() } catch { /* 忽略 */ }
  mk.restore()
}

const main = async () => {
  await t('open 后 ready：AU 索引数与 ES AU 数一致', async () => {
    const mk = mkProvider(30, 8, 48)
    try { await ready(mk); eq(mk.prov.status, 'ready', 'status ready'); eq(mk.prov.auCount, 30, 'AU 数=30') }
    finally { cleanup(mk) }
  })

  await t('setPlayhead 驱动 feed 与缓存命中', async () => {
    const mk = mkProvider(40, 16, 48)
    try {
      await ready(mk)
      mk.prov.setPlayhead(0)
      await new Promise((r) => setTimeout(r, 20))
      assert(mk.prov.has(0), 'AU0 应已解码进缓存')
      assert(mk.prov.has(5), 'AU5 应已预解码(lookahead 内)')
      const got = mk.prov.current(0)
      assert(got && got.bitmap, 'current(0) 应命中')
      assert(!mk.prov.has(40), '超出范围不应有缓存')
    } finally { cleanup(mk) }
  })

  await t('cache 满后淘汰：保留离 pivot 近的', async () => {
    const mk = mkProvider(100, 8, 16) // maxFrames=16
    try {
      await ready(mk)
      mk.prov.setPlayhead(0)
      await new Promise((r) => setTimeout(r, 5))
      const before = mk.prov.cacheSize
      assert(before > 0 && before <= 16, `缓存<=16，实际 ${before}`)
      for (let p = 10; p < 60; p += 5) {
        mk.prov.setPlayhead(p)
        await new Promise((r) => setTimeout(r, 1))
      }
      await new Promise((r) => setTimeout(r, 5))
      assert(mk.prov.cacheSize <= 16, '仍受上限约束')
      assert(mk.prov.has(59) || mk.prov.has(55) || mk.prov.has(50), '应保有一部分接近最新播头的帧')
      const early = mk.prov.has(0)
      if (mk.prov.cacheSize === 16) assert(!early, '播头走后 AU0 应被淘汰')
    } finally { cleanup(mk) }
  })

  await t('current(miss) 返回 null 并计数', async () => {
    const mk = mkProvider(30, 8, 48)
    try {
      await ready(mk)
      mk.prov.setPlayhead(0)
      await new Promise((r) => setTimeout(r, 5))
      const miss = mk.prov.current(29)
      assert(miss === null, '未预解码的 AU 返回 null')
      assert(mk.prov.misses >= 1, 'misses 计数应增加')
    } finally { cleanup(mk) }
  })

  await t('awaitUntil 在 feed 覆盖后返回 true', async () => {
    const mk = mkProvider(30, 16, 48)
    try {
      await ready(mk)
      const ok = await mk.prov.awaitUntil(10, 2000)
      assert(ok === true, 'awaitUntil(10) 应 true')
      assert(mk.prov.has(10), 'AU10 已缓存')
    } finally { cleanup(mk) }
  })

  await t('dispose 幂等且清空', async () => {
    const mk = mkProvider(30, 8, 48)
    try {
      await ready(mk)
      mk.prov.setPlayhead(0)
      await new Promise((r) => setTimeout(r, 3))
      mk.prov.dispose()
      mk.prov.dispose()
      eq(mk.prov.status, 'disposed', 'disposed')
      eq(mk.prov.cacheSize, 0, '缓存清空')
    } finally { mk.restore() }
  })

  console.log(`\n${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}
main()

