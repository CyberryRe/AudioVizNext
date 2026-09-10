/**
 * PresetParamsPanel.tsx —— 预设样式参数面板（**由 preset.json 的 schema 自动生成**）。
 *
 * 关键帧交互（对齐 Pr 习惯）：
 *  - 「+ 关键帧」独立按钮：在播放头用**当前显示值**打点（不必先改数值）
 *  - ◆/◇：同位置删/加；有轨道后改滑块 = 自动在播放头写关键帧（auto-key）
 *  - 曲线编辑器：选中关键帧后可改插值（线性/缓入缓出/缓入/缓出/保持），并拖点改 t/v
 *
 * 典型「入 100% → 出 100%」用法（需 3 个点，两端同值不会互斥）：
 *  播放头在 clip 起点 → +关键帧(0%) → 中点改 100% → 终点改 0%。
 */
import { useMemo, useRef, useState } from 'react'
import type { Clip, MediaAsset } from '../model/timeline'
import type { PresetMeta, PresetParam, NumberParam } from '../presets/types'
import { defaultParams } from '../presets/types'
import {
  evaluateKeyframes, hasKeyframeNear, removeKeyframeNear, setKeyframe, setKeyframeEase,
  KEYFRAME_EASES,
  type Keyframe, type KeyframeEase, type KeyframeTracks
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

const btnStyle = (active = false): React.CSSProperties => ({
  cursor: 'pointer',
  fontSize: 11,
  padding: '1px 6px',
  borderRadius: 3,
  border: `1px solid ${active ? '#19a8ff' : '#444'}`,
  background: active ? 'rgba(25,168,255,.15)' : '#1a1a1a',
  color: active ? '#19a8ff' : '#aaa',
  whiteSpace: 'nowrap'
})

/** 参数曲线编辑器：横轴 t∈[0,1]，纵轴 v∈[min,max]；可拖点、点选后改 ease */
function KeyframeCurve({
  track, min, max, playheadT, selectedT, onSelect, onChange
}: {
  track: Keyframe[]
  min: number
  max: number
  playheadT: number
  selectedT: number | null
  onSelect: (t: number) => void
  onChange: (next: Keyframe[]) => void
}): React.JSX.Element {
  const ref = useRef<SVGSVGElement>(null)
  const W = 280
  const H = 72
  const padL = 8
  const padR = 8
  const padT = 8
  const padB = 8
  const iw = W - padL - padR
  const ih = H - padT - padB
  const span = max - min || 1

  const xOf = (t: number): number => padL + t * iw
  const yOf = (v: number): number => padT + (1 - (v - min) / span) * ih
  const tOf = (x: number): number => Math.min(1, Math.max(0, (x - padL) / iw))
  const vOf = (y: number): number => {
    const r = 1 - (y - padT) / ih
    return min + Math.min(1, Math.max(0, r)) * span
  }

  const samples = useMemo(() => {
    const pts: string[] = []
    const n = 48
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const v = evaluateKeyframes(track, t) ?? min
      pts.push(`${xOf(t).toFixed(1)},${yOf(v).toFixed(1)}`)
    }
    return pts.join(' ')
  }, [track, min, max])

  const dragIdx = useRef<number | null>(null)

  const localXY = (e: React.MouseEvent): { x: number; y: number } | null => {
    const svg = ref.current
    if (!svg) return null
    const r = svg.getBoundingClientRect()
    return {
      x: ((e.clientX - r.left) / r.width) * W,
      y: ((e.clientY - r.top) / r.height) * H
    }
  }

  return (
    <svg
      ref={ref}
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      style={{ display: 'block', background: '#0d0d0d', border: '1px solid #333', borderRadius: 4, marginBottom: 8, cursor: 'crosshair' }}
      onMouseDown={(e) => {
        const p = localXY(e)
        if (!p) return
        // 命中已有点则拖动；否则在点击处插入新点
        let hit = -1
        for (let i = 0; i < track.length; i++) {
          const dx = xOf(track[i].t) - p.x
          const dy = yOf(track[i].v) - p.y
          if (dx * dx + dy * dy < 64) { hit = i; break }
        }
        if (hit >= 0) {
          dragIdx.current = hit
          onSelect(track[hit].t)
        } else {
          const nt = tOf(p.x)
          const nv = Math.round(vOf(p.y) / (span > 0 && span < 2 ? 0.01 : 1)) * (span > 0 && span < 2 ? 0.01 : 1)
          const next = setKeyframe(track, nt, Math.min(max, Math.max(min, nv)))
          dragIdx.current = next.findIndex((k) => Math.abs(k.t - nt) <= 1e-4)
          onChange(next)
          onSelect(nt)
        }
      }}
      onMouseMove={(e) => {
        if (dragIdx.current === null) return
        const p = localXY(e)
        if (!p) return
        const i = dragIdx.current
        if (i < 0 || i >= track.length) return
        const nt = tOf(p.x)
        const nv = Math.min(max, Math.max(min, vOf(p.y)))
        const next = [...track]
        // 首尾点可拖 t；中间点自由拖
        next[i] = { ...next[i], t: nt, v: nv }
        next.sort((a, b) => a.t - b.t)
        onChange(next)
        onSelect(nt)
      }}
      onMouseUp={() => { dragIdx.current = null }}
      onMouseLeave={() => { dragIdx.current = null }}
    >
      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#333" strokeWidth={1} />
      <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="#333" strokeWidth={1} />
      {/* 播放头 */}
      <line x1={xOf(playheadT)} y1={padT} x2={xOf(playheadT)} y2={H - padB} stroke="#c45c26" strokeWidth={1} strokeDasharray="3 2" />
      <polyline points={samples} fill="none" stroke="#2a7de1" strokeWidth={1.5} />
      {track.map((k, i) => {
        const sel = selectedT !== null && Math.abs(k.t - selectedT) < 1e-3
        return (
          <circle
            key={`${k.t}-${i}`}
            cx={xOf(k.t)}
            cy={yOf(k.v)}
            r={sel ? 5 : 3.5}
            fill={sel ? '#19a8ff' : '#ddd'}
            stroke="#111"
            strokeWidth={1}
          />
        )
      })}
    </svg>
  )
}

export default function PresetParamsPanel({ clip, meta, getAsset, onSetParam, onSetKeyframes, onBindAsset, frame }: Props): React.JSX.Element {
  const params = { ...defaultParams(meta), ...(clip.params ?? {}) }
  const kf: KeyframeTracks = clip.keyframes ?? {}
  // clip 内相对进度（关键帧打点/求值都基于它）
  const tRel = clip.durationFrames > 0
    ? Math.min(1, Math.max(0, (frame - clip.startFrame) / clip.durationFrames))
    : 0
  const inClip = frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames
  const [linked, setLinked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(meta.params.filter((p) => p.link).map((p) => [p.key, true]))
  )
  /** 曲线编辑器：当前展开的参数 key + 选中的关键帧 t */
  const [curveKey, setCurveKey] = useState<string | null>(null)
  const [selKfT, setSelKfT] = useState<number | null>(null)

  const groups: { name: string; items: PresetParam[] }[] = []
  for (const p of meta.params) {
    const name = p.group ?? '参数'
    const g = groups.find((x) => x.name === name)
    if (g) g.items.push(p)
    else groups.push({ name, items: [p] })
  }

  const set = (p: PresetParam, v: unknown): void => {
    onSetParam(p.key, v)
    if (p.key === 'scaleX' && linked['scaleY']) onSetParam('scaleY', v)
  }

  const addKeyframeAtPlayhead = (p: NumberParam, v: number): void => {
    if (!inClip) return
    const track = kf[p.key]
    onSetKeyframes(p.key, setKeyframe(track, tRel, v))
    setCurveKey(p.key)
    setSelKfT(tRel)
  }

  const renderParam = (p: PresetParam): React.JSX.Element => {
    const value = params[p.key]
    switch (p.type) {
      case 'number': {
        const track = kf[p.key]
        const kfVal = evaluateKeyframes(track, tRel)
        const staticVal = typeof value === 'number' ? value : p.default
        const v = kfVal ?? staticVal
        const shown = p.percent ? Math.round(v * 1000) / 10 : Math.round(v * 100) / 100
        const isScaleY = p.key === 'scaleY' && linked['scaleY']
        const atKf = hasKeyframeNear(track, tRel)
        const canKf = !!(p as NumberParam).keyframe
        // 有轨道 → auto-key（改值即在播放头打点）；无轨道 → 只改静态参数
        const applyVal = (key: string, nv: number): void => {
          const tr = kf[key]
          if (tr && tr.length) onSetKeyframes(key, setKeyframe(tr, tRel, nv))
          else onSetParam(key, nv)
        }
        const write = (nv: number): void => {
          applyVal(p.key, nv)
          // XY 等比关联：scaleY.link === 'scaleX' 时，改 X 必须同步写 Y（否则「绑定」是假的）
          if (p.key === 'scaleX' && linked['scaleY']) applyVal('scaleY', nv)
        }
        const curveOpen = curveKey === p.key && !!track && track.length > 0
        const selKf = track && selKfT !== null
          ? track.reduce((best, k) => (Math.abs(k.t - selKfT) < Math.abs(best.t - selKfT) ? k : best), track[0])
          : null
        return (
          <div key={p.key}>
            <Row label={p.label} hint={p.unit && !p.percent ? p.unit : p.percent ? '%' : undefined}>
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
                  title={inClip ? '在播放头添加关键帧（使用当前值）' : '播放头不在该 clip 范围内'}
                  onClick={() => addKeyframeAtPlayhead(p as NumberParam, v)}
                  style={{ ...btnStyle(inClip), opacity: inClip ? 1 : 0.5, cursor: inClip ? 'pointer' : 'not-allowed' }}
                >
                  +帧
                </span>
              )}
              {canKf && (
                <span
                  title={atKf ? '删除此处的关键帧' : inClip ? '在此添加/强调关键帧' : '播放头不在该 clip 范围内'}
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
                  title="展开/收起曲线编辑器"
                  onClick={() => {
                    setCurveKey(curveOpen ? null : p.key)
                    if (!curveOpen) setSelKfT(track[0]?.t ?? null)
                  }}
                  style={{ ...btnStyle(curveOpen) }}
                >
                  曲线
                </span>
              )}
              {canKf && track && track.length > 0 && (
                <span
                  title={`该参数有 ${track.length} 个关键帧（点击清除全部）`}
                  onClick={() => { onSetKeyframes(p.key, []); if (curveKey === p.key) setCurveKey(null) }}
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
            {curveOpen && track && (
              <div style={{ margin: '0 0 10px 64px', padding: '6px 8px', background: '#151515', border: '1px solid #2a2a2a', borderRadius: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 11, color: '#999' }}>
                  <span>曲线</span>
                  <select
                    value={selKf?.ease ?? 'linear'}
                    onChange={(e) => {
                      const ease = e.target.value as KeyframeEase
                      onSetKeyframes(p.key, setKeyframeEase(track, selKfT ?? tRel, ease))
                    }}
                    style={{ ...numInputStyle, width: 90 }}
                    title="选中关键帧 → 下一关键帧 的插值"
                  >
                    {KEYFRAME_EASES.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
                  </select>
                  <span style={{ color: '#666' }}>选中点后可改插值；空白处点击可加点</span>
                </div>
                <KeyframeCurve
                  track={track}
                  min={p.min}
                  max={p.max}
                  playheadT={tRel}
                  selectedT={selKfT}
                  onSelect={setSelKfT}
                  onChange={(next) => onSetKeyframes(p.key, next)}
                />
                <div style={{ fontSize: 10, color: '#666', lineHeight: 1.4 }}>
                  横轴=clip 进度，纵轴=参数值。两端同值不会互斥——中间再打一个点即可做出「入/出」包络。
                  {selKf?.ease && selKf.ease !== 'linear' ? ` 当前选中：${KEYFRAME_EASES.find((e) => e.value === selKf.ease)?.label}` : ''}
                </div>
              </div>
            )}
          </div>
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

      <div style={{ fontSize: 10, color: '#666', marginTop: 12, lineHeight: 1.5, borderTop: '1px solid #2a2a2a', paddingTop: 8 }}>
        关键帧：把播放头移到 clip 内 → 点「+帧」打点 → 挪播放头改数值（自动打点）→ 「曲线」调缓动。
        做淡入淡出请打 3 个点（起点/峰值/终点），两端同值不会互相覆盖。
      </div>
    </div>
  )
}
