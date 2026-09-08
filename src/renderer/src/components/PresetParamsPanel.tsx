/**
 * PresetParamsPanel.tsx —— 预设样式参数面板（**由 preset.json 的 schema 自动生成**）。
 *
 * 组件化关键点：新增一个预设样式只要写 `presets/<分类>/<id>/preset.json`（声明参数），
 * 这里就自动出现对应控件（数值滑块 / 颜色 / 开关 / 下拉 / 图片引用），不需要改任何 UI 代码。
 * 参数带 `link` 时渲染 🔗 关联按钮（如缩放 X/Y 联动）。
 */
import { useState } from 'react'
import type { Clip, MediaAsset } from '../model/timeline'
import type { PresetMeta, PresetParam, NumberParam } from '../presets/types'
import { defaultParams } from '../presets/types'
import {
  evaluateKeyframes, hasKeyframeNear, removeKeyframeNear, setKeyframe,
  type KeyframeTracks
} from '../presets/keyframes'
import MediaSlot from './MediaSlot'

interface Props {
  clip: Clip
  meta: PresetMeta
  getAsset: (id: string) => MediaAsset | undefined
  onSetParam: (key: string, value: unknown) => void
  /** 写入某参数的关键帧轨道（整轨替换） */
  onSetKeyframes: (key: string, track: import('../presets/keyframes').Keyframe[]) => void
  onBindAsset: (assetId: string) => void
  /** 当前播放头帧（用于关键帧打点/求值） */
  frame: number
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }): React.JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: 12, color: '#bbb' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {children}
        {hint && <span style={{ fontSize: 10, color: '#777' }}>{hint}</span>}
      </div>
    </div>
  )
}

const numInputStyle: React.CSSProperties = {
  width: 62, background: '#111', color: '#ddd', border: '1px solid #333',
  borderRadius: 3, fontSize: 12, padding: '2px 4px'
}

export default function PresetParamsPanel({ clip, meta, getAsset, onSetParam, onSetKeyframes, onBindAsset, frame }: Props): React.JSX.Element {
  const params = { ...defaultParams(meta), ...(clip.params ?? {}) }
  const kf: KeyframeTracks = clip.keyframes ?? {}
  // clip 内相对进度（关键帧打点/求值都基于它）
  const tRel = clip.durationFrames > 0 ? (frame - clip.startFrame) / clip.durationFrames : 0
  const inClip = frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames
  // 每个带 link 的参数一个开关（🔗 = 跟随 X）
  const [linked, setLinked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(meta.params.filter((p) => p.link).map((p) => [p.key, true]))
  )

  const groups: { name: string; items: PresetParam[] }[] = []
  for (const p of meta.params) {
    const name = p.group ?? '参数'
    const g = groups.find((x) => x.name === name)
    if (g) g.items.push(p)
    else groups.push({ name, items: [p] })
  }

  const set = (p: PresetParam, v: unknown): void => {
    onSetParam(p.key, v)
    // 关联：Y 跟随 X
    if (p.key === 'scaleX' && linked['scaleY']) onSetParam('scaleY', v)
    if (p.key === 'scaleY' && linked['scaleY']) { /* 由 X 驱动，忽略 */ }
  }

  const renderParam = (p: PresetParam): React.JSX.Element => {
    const value = params[p.key]
    switch (p.type) {
      case 'number': {
        const track = kf[p.key]
        const kfVal = evaluateKeyframes(track, tRel)
        const staticVal = typeof value === 'number' ? value : p.default
        // 有轨道 → 显示关键帧求值结果（跟随播放头动画）；无轨道 → 静态值
        const v = kfVal ?? staticVal
        const shown = p.percent ? Math.round(v * 1000) / 10 : Math.round(v * 100) / 100
        const isScaleY = p.key === 'scaleY' && linked['scaleY']
        const atKf = hasKeyframeNear(track, tRel)
        const canKf = !!(p as NumberParam).keyframe
        const write = (nv: number): void => {
          if (track && track.length) onSetKeyframes(p.key, setKeyframe(track, tRel, nv))
          else onSetParam(p.key, nv)
        }
        return (
          <Row key={p.key} label={p.label} hint={p.unit && !p.percent ? p.unit : p.percent ? '%' : undefined}>
            <input
              type="range"
              min={p.min}
              max={p.max}
              step={p.step}
              value={v}
              disabled={isScaleY}
              onChange={(e) => write(Number(e.target.value))}
              style={{ flex: 1, accentColor: '#2a7de1', opacity: isScaleY ? 0.5 : 1 }}
            />
            <input
              type="number"
              min={p.min}
              max={p.max}
              step={p.step}
              value={shown}
              disabled={isScaleY}
              onChange={(e) => {
                const raw = Number(e.target.value)
                if (!Number.isFinite(raw)) return
                write(p.percent ? raw / 100 : raw)
              }}
              style={{ ...numInputStyle, opacity: isScaleY ? 0.5 : 1 }}
            />
            {canKf && (
              <span
                title={atKf ? '删除此处的关键帧' : inClip ? '在播放头处添加关键帧' : '播放头不在该 clip 范围内'}
                onClick={() => {
                  if (!inClip) return
                  onSetKeyframes(p.key, atKf ? removeKeyframeNear(track, tRel) : setKeyframe(track, tRel, v))
                }}
                style={{
                  cursor: inClip ? 'pointer' : 'not-allowed',
                  fontSize: 12,
                  color: atKf ? '#19a8ff' : inClip ? '#888' : '#555',
                  opacity: inClip ? 1 : 0.5
                }}
              >{atKf ? '◆' : '◇'}</span>
            )}
            {canKf && track && track.length > 0 && (
              <span
                title={`该参数有 ${track.length} 个关键帧（点击清除全部）`}
                onClick={() => onSetKeyframes(p.key, [])}
                style={{ cursor: 'pointer', fontSize: 10, color: '#e0b34c' }}
              >{track.length}⏱</span>
            )}
            {p.link && (
              <span
                title={linked[p.key] ? '已关联（跟随上方 X）' : '取消关联'}
                onClick={() => setLinked((s) => ({ ...s, [p.key]: !s[p.key] }))}
                style={{ cursor: 'pointer', fontSize: 13, color: linked[p.key] ? '#19a8ff' : '#777' }}
              >🔗</span>
            )}
          </Row>
        )
      }
      case 'color':
        return (
          <Row key={p.key} label={p.label}>
            <input
              type="color"
              value={typeof value === 'string' ? value : p.default}
              onChange={(e) => set(p, e.target.value)}
              style={{ width: 40, height: 22, background: 'transparent', border: '1px solid #333', borderRadius: 3, padding: 0 }}
            />
            <span style={{ fontSize: 11, color: '#888' }}>{String(value ?? p.default)}</span>
          </Row>
        )
      case 'bool':
        return (
          <Row key={p.key} label={p.label}>
            <input type="checkbox" checked={!!value} onChange={(e) => set(p, e.target.checked)} />
          </Row>
        )
      case 'select':
        return (
          <Row key={p.key} label={p.label}>
            <select
              value={String(value ?? p.default)}
              onChange={(e) => set(p, e.target.value)}
              style={{ ...numInputStyle, width: 130 }}
            >
              {p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Row>
        )
      case 'image': {
        // 引用素材库里的图片（如「圆形」的边框纹理）
        const src = typeof value === 'string' ? value : ''
        const asset = clip.assetId && src === clip.src ? getAsset(clip.assetId) : undefined
        return (
          <Row key={p.key} label={p.label}>
            <select
              value={src}
              onChange={(e) => set(p, e.target.value)}
              style={{ ...numInputStyle, width: 150 }}
            >
              <option value="">（无）</option>
              {/* 目前可从已绑定素材中选择；后续可扩展为完整素材库列表 */}
              {clip.src && <option value={clip.src}>{asset?.name ?? '当前绑定素材'}</option>}
            </select>
            <span style={{ fontSize: 10, color: '#777' }}>{src ? '已选' : '默认描边'}</span>
          </Row>
        )
      }
    }
  }

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>
        {meta.name}
        <span style={{ fontSize: 11, color: '#777', fontWeight: 400, marginLeft: 6 }}>
          {meta.source === 'user' ? '（导入的预设）' : '（内置预设）'}
        </span>
      </div>
      {meta.desc && <div style={{ fontSize: 11, color: '#888', marginBottom: 12, lineHeight: 1.5 }}>{meta.desc}</div>}

      {meta.clipType === 'image' && (
        <>
          <div style={{ fontSize: 12, color: '#bbb', marginBottom: 6 }}>关联图片素材</div>
          <MediaSlot clip={clip} getAsset={getAsset} onBind={onBindAsset} />
          <div style={{ marginBottom: 14 }} />
        </>
      )}

      {groups.map((g) => (
        <div key={g.name} style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#cfcfcf', margin: '10px 0 8px' }}>{g.name}</div>
          {g.items.map(renderParam)}
        </div>
      ))}
    </div>
  )
}
