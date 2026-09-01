/**
 * 时间轴模型测试（纯 Node）
 * 验证 resolveTimeline / 不变量 / 排序等核心逻辑。
 * 运行：node test/model.test.mjs
 */
import {
  createProject,
  createTrack,
  createClip,
  sortClips,
  resolveTimeline,
  resizeClip,
  bindAssetToClip
} from '../src/renderer/src/model/timeline.ts'

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log('  ✓ ' + name)
  } catch (e) {
    fail++
    console.log('  ✗ ' + name + ' — ' + e.message)
  }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`)
}
function truthy(v, msg) {
  if (!v) throw new Error(msg || 'expected truthy')
}

// ===== 构造一个简单工程 =====
function buildProject() {
  const p = createProject({ fps: 30 })
  const v1 = createTrack({ id: 'v1', name: 'V1', kind: 'video', order: 0 })
  const t1 = createTrack({ id: 't1', name: 'T1', kind: 'text', order: 1 })
  const a1 = createTrack({ id: 'a1', name: 'A1', kind: 'audio', order: 2 })
  p.tracks = [v1, t1, a1]

  const video = createClip({ id: 'c-video', trackId: 'v1', type: 'video', startFrame: 0, durationFrames: 90, sourceStartFrame: 0, sourceDurationFrames: 90, src: 'vid.mp4' })
  const text = createClip({ id: 'c-text', trackId: 't1', type: 'text', startFrame: 30, durationFrames: 30, content: 'Hello' })
  const audio = createClip({ id: 'c-audio', trackId: 'a1', type: 'audio', startFrame: 10, durationFrames: 40, src: 'a.mp3', volume: 0.5 })

  p.clips = { v1: sortClips([video]), t1: sortClips([text]), a1: sortClips([audio]) }
  return p
}

console.log('== 不变量 ==')
t('空列表通过', () => { sortClips([]) })
t('排序正确', () => {
  const c1 = createClip({ startFrame: 30 })
  const c2 = createClip({ startFrame: 0 })
  const sorted = sortClips([c1, c2])
  eq(sorted[0].startFrame, 0, '最小 startFrame 在前')
})
t('重叠抛出', () => {
  const c1 = createClip({ startFrame: 0, durationFrames: 30 })
  const c2 = createClip({ startFrame: 10, durationFrames: 30 })
  let threw = false
  try { sortClips([c1, c2]) } catch { threw = true }
  truthy(threw, '应抛重叠错误')
})

console.log('== resolveTimeline ==')
const p = buildProject()

t('视频在帧 0 活跃', () => {
  const s = resolveTimeline(0, p)
  eq(s.videos.length, 1, 'videos 数量')
  eq(s.videos[0].id, 'c-video', '视频 id')
  eq(s.videos[0].sourceFrame, 0, 'sourceFrame=0')
})
t('视频在帧 45 源帧映射', () => {
  const s = resolveTimeline(45, p)
  eq(s.videos[0].sourceFrame, 45, 'sourceFrame=45')
})
t('视频在帧 90 不在活跃区间（半开）', () => {
  const s = resolveTimeline(90, p)
  eq(s.videos.length, 0, '第 90 帧视频已结束')
})
t('视频在帧 89 仍活跃', () => {
  const s = resolveTimeline(89, p)
  eq(s.videos.length, 1, '第 89 帧仍活跃')
})
t('文字在帧 30-60 活跃', () => {
  const s = resolveTimeline(30, p)
  eq(s.texts.length, 1, '文字数量')
  eq(s.texts[0].content, 'Hello', '文字内容')
})
t('文字在帧 29 不活跃', () => {
  const s = resolveTimeline(29, p)
  eq(s.texts.length, 0, '帧29无文字')
})
t('音频音量透传', () => {
  const s = resolveTimeline(10, p)
  eq(s.audios[0].volume, 0.5, '音量=0.5')
})
t('zIndex 轨道序决定层', () => {
  const s = resolveTimeline(45, p)
  const videoZ = s.videos[0].zIndex
  const textZ = s.texts[0].zIndex
  truthy(videoZ > textZ, 'order 小的轨道 zIndex 更高（更靠前）')
})

console.log('== mute/solo ==')
t('mute 轨道音量归零', () => {
  const p2 = buildProject()
  p2.tracks.find((t) => t.id === 'a1').muted = true
  const s = resolveTimeline(10, p2)
  eq(s.audios[0].volume, 0, 'mute 后音量=0')
})
t('solo 轨道排除同类其他轨道', () => {
  const p2 = buildProject()
  const a2 = createTrack({ id: 'a2', name: 'A2', kind: 'audio', order: 3 })
  p2.tracks.push(a2)
  const extra = createClip({ id: 'c-extra', trackId: 'a2', type: 'audio', startFrame: 0, durationFrames: 90, src: 'b.mp3' })
  p2.clips.a2 = sortClips([extra])
  // a1 设 solo，a2 不设 → a2 的音频应被排除
  p2.tracks.find((t) => t.id === 'a1').solo = true
  const s = resolveTimeline(10, p2)
  eq(s.audios.length, 1, '只保留 solo 轨道的音频')
  eq(s.audios[0].id, 'c-audio', 'solo 的是 a1 的 c-audio')
})
t('disabled 轨道跳过', () => {
  const p2 = buildProject()
  p2.tracks.find((t) => t.id === 'v1').disabled = true
  const s = resolveTimeline(0, p2)
  eq(s.videos.length, 0, 'disabled 轨道无视频')
})

console.log('== resizeClip 时长上限（单次播放） ==')
t('无上限时 resize 自由', () => {
  const clips = sortClips([createClip({ id: 'c1', type: 'audio', startFrame: 0, durationFrames: 30 })])
  const next = resizeClip(clips, 'c1', 120)
  eq(next[0].durationFrames, 120, '无 maxDurationFrames 可拉长')
})
t('有 maxDurationFrames 时 resize 被钳制', () => {
  const clips = sortClips([createClip({ id: 'c1', type: 'audio', startFrame: 0, durationFrames: 30, maxDurationFrames: 60 })])
  const next = resizeClip(clips, 'c1', 500)
  eq(next[0].durationFrames, 60, '拖到尾拉不过 60 帧')
})
t('maxDurationFrames 内可自由调整', () => {
  const clips = sortClips([createClip({ id: 'c1', type: 'audio', startFrame: 0, durationFrames: 30, maxDurationFrames: 60 })])
  const next = resizeClip(clips, 'c1', 45)
  eq(next[0].durationFrames, 45, '上限内可设 45')
})

console.log('== bindAssetToClip 单次播放钳制 ==')
t('clampToSource 绑定后时长钳制到源时长', () => {
  const asset = { id: 'a1', kind: 'audio', name: 'song.mp3', src: 'x.mp3', durationSec: 2, byteSize: 1, addedAt: 0 }
  const clip = createClip({ id: 'c1', type: 'audio', clampToSource: true, durationFrames: 30, maxDurationFrames: 30 })
  const next = bindAssetToClip(clip, asset)
  // 2 秒 × 30fps = 60 帧；模板位 30 帧 → 被钳制为 min(30,60)=30
  eq(next.durationFrames, 30, '默认时长 30 < 源 60，保持 30')
  eq(next.maxDurationFrames, 60, 'maxDurationFrames = 源 60')
  // 再 resize 到 100 → 被钳制到 60
  const resized = resizeClip([next], 'c1', 100)
  eq(resized[0].durationFrames, 60, '拖尾最多到歌曲完整时长 60')
})
t('clampToSource 绑定后源更短则收紧', () => {
  const asset = { id: 'a1', kind: 'audio', name: 'short.mp3', src: 'x.mp3', durationSec: 1, byteSize: 1, addedAt: 0 }
  const clip = createClip({ id: 'c1', type: 'audio', clampToSource: true, durationFrames: 90, maxDurationFrames: 90 })
  const next = bindAssetToClip(clip, asset)
  // 1 秒 × 30 = 30 帧 < 90 → 收紧为 30
  eq(next.durationFrames, 30, '时长收紧到源 30')
  eq(next.maxDurationFrames, 30, 'maxDurationFrames = 30')
})

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
