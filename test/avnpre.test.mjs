/**
 * avnpre.test.mjs —— `.avnpre` 预设包格式的编解码单测（纯逻辑，Node 模式）。
 * 运行：npm test（node --experimental-strip-types test/avnpre.test.mjs）
 */
import { decodeAvnpre, encodeAvnpre, base64ToBytes, bytesToBase64, KNOWN_DRAWERS } from '../src/shared/avnpre.ts'

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.error(`  ✗ ${name}\n    ${e?.message ?? e}`)
  }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg ?? 'eq'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
}
function ok(v, msg) {
  if (!v) throw new Error(msg ?? '期望为真')
}

console.log('== base64 往返 ==')
t('bytesToBase64 / base64ToBytes 往返一致', () => {
  const src = new Uint8Array([0, 1, 2, 250, 255, 128, 64, 3])
  const back = base64ToBytes(bytesToBase64(src))
  ok(back, '解码失败')
  eq(back.length, src.length, '长度')
  for (let i = 0; i < src.length; i++) eq(back[i], src[i], `byte ${i}`)
})
t('空数组 / 非法 base64', () => {
  eq(bytesToBase64(new Uint8Array(0)), '')
  eq(base64ToBytes('abc'), null, '长度非 4 倍数应拒绝')
  eq(base64ToBytes('!!!!'), null, '非法字符应拒绝')
})

console.log('== 合法预设包 ==')
const preset = {
  id: 'my-ripple',
  name: '我的粒子波纹',
  category: 'visualization',
  clipType: 'visual',
  kind: 'visual',
  drawer: 'particle-waveform',
  durationFrames: 240,
  params: [
    { key: 'density', label: '密度', type: 'number', min: 1, max: 600, step: 1, default: 120 },
    { key: 'color', label: '主色', type: 'color', default: '#3fe0ff' }
  ]
}
const assetBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const text = encodeAvnpre(preset, [{ key: 'border', name: 'border.png', mime: 'image/png', bytes: assetBytes }])

t('编码→解码 往返保留声明与参数', () => {
  const r = decodeAvnpre(text)
  ok(r.ok, `解码失败：${r.ok ? '' : r.error}`)
  eq(r.preset.id, 'my-ripple')
  eq(r.preset.drawer, 'particle-waveform')
  eq(r.preset.params.length, 2)
  eq(r.assets.length, 1)
  eq(r.assets[0].key, 'border')
  eq(r.assets[0].bytes.length, assetBytes.length)
  eq(r.assets[0].bytes[0], 137, 'PNG 魔数第 1 字节')
  eq(r.assets[0].bytes[1], 80, 'PNG 魔数第 2 字节')
})
t('无资源包也能解码', () => {
  const r = decodeAvnpre(encodeAvnpre(preset))
  ok(r.ok, '解码失败')
  eq(r.assets.length, 0)
})

console.log('== 防御性校验（一律 ok:false，不抛） ==')
const bad = (mut, name, expect) => t(name, () => {
  const obj = JSON.parse(text)
  mut(obj)
  const r = decodeAvnpre(JSON.stringify(obj))
  eq(r.ok, false, '应被拒绝')
  if (expect) ok(String(r.error).includes(expect), `错误信息应含 "${expect}"，实际：${r.error}`)
})
bad((o) => { o.format = 'zip' }, 'format 不符 → 拒绝', 'avnpre')
bad((o) => { o.version = 99 }, '版本过高 → 拒绝', '版本')
bad((o) => { delete o.preset }, '缺少 preset → 拒绝', 'preset')
bad((o) => { o.preset.id = '../evil' }, 'id 含路径穿越 → 拒绝', 'id')
bad((o) => { o.preset.drawer = 'evil-drawer' }, '未知 drawer → 拒绝', 'drawer')
bad((o) => { o.preset.params = [{ key: 'x' }] }, '参数缺 type → 拒绝', 'key 与 type')
bad((o) => { o.preset.params = [{ key: 'x', type: 'exec' }] }, '参数类型非法 → 拒绝', '不支持的参数类型')
bad((o) => { o.assets = [{ key: 'a', data: '!!!' }] }, '资源 base64 非法 → 拒绝', 'base64')
t('非 JSON / 非对象 → 拒绝', () => {
  eq(decodeAvnpre('not json').ok, false)
  eq(decodeAvnpre('[]').ok, false)
})
t('资源超限 → 拒绝', () => {
  const obj = JSON.parse(text)
  obj.assets = [{ key: 'big', name: 'big.bin', mime: 'application/octet-stream', data: bytesToBase64(new Uint8Array(9 * 1024 * 1024)) }]
  const r = decodeAvnpre(JSON.stringify(obj))
  eq(r.ok, false, '应拒绝超大资源')
  ok(String(r.error).includes('上限'), r.error)
})
t('内置 drawer 白名单非空且与实现一致', () => {
  ok(KNOWN_DRAWERS.includes('image-shape'))
  ok(KNOWN_DRAWERS.includes('particle-waveform'))
})

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
