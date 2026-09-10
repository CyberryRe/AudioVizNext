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
import type { PresetMeta, PresetParam, NumberParam, GradientValue, GradientParam } from '../presets/types'
import { defaultParams } from '../presets/types'
import {
  evaluateKeyframes, hasKeyframeNear, removeKeyframeNear, setKeyframe, setKeyframeEase,
  KEYFRAME_EASES,
  type Keyframe, type KeyframeEase, type KeyframeTracks
} from '../presets/keyframes'
import MediaSlot from './MediaSlot'
import { getScriptError } from '../presets/registry'
import { looksLikeGifName } from '../media/gifDetect'

interface Props {
  clip: Clip
  meta: PresetMeta
  getAsset: (id: string) => MediaAsset | undefined
  onSetParam: (key: string, value: unknown) => void
  /** 写入某参数的关键帧轨道（整轨替换） */
  onSetKeyframes: (key: string, track: import('../presets/keyframes').Keyframe[]) => void
  onBindAsset: (assetId: string) => void
  /** 更新 clip 的通用参数（如 GIF 速度） */
  onPatchClip?: (patch: Partial<Clip>) => void
  /** 当前播放头帧（用于关键帧打点/求值） */
  frame: number
}

/**
 * 滑块控件（数值输入 + 拖动条）。与 EffectControls 的 NumberSlider 同款；
 * 这里复制一份以免两组件互相 import（Panel 被 EffectControls 引用，反向 import 会绕圈）。
 */
function NumberSlider({ label, value, min, max, step, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}): React.JSX.Element {
  const barRef = useRef<HTMLDivElement>(null)

  const startDrag = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const el = barRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const update = (clientX: number): void => {
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const raw = min + ratio * (max - min)
      onChange(Math.round(raw / step) * step)
    }
    update(e.clientX)
    const move = (ev: MouseEvent): void => update(ev.clientX)
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const pct = ((value - min) / (max - min)) * 100

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 52px', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: 12, color: '#bbb' }}>{label}</span>
      <div
        ref={barRef}
        onMouseDown={startDrag}
        style={{ height: 12, background: '#111', border: '1px solid #333', borderRadius: 3, position: 'relative', cursor: 'ew-resize' }}
      >
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, background: '#2a6fa8', borderRadius: 3 }} />
        <div style={{ position: 'absolute', left: `calc(${pct}% - 4px)`, top: -3, width: 8, height: 18, background: '#ccc', borderRadius: 2 }} />
      </div>
      <input
        type="number"
        value={Math.round(value * 100) / 100}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (!Number.isNaN(v)) onChange(Math.max(min, Math.min(max, v)))
        }}
        style={{ ...numInputStyle, width: 52, textAlign: 'right', padding: '3px 5px' }}
      />
    </div>
  )
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

export default function PresetParamsPanel({ clip, meta, getAsset, onSetParam, onSetKeyframes, onBindAsset, onPatchClip, frame }: Props): React.JSX.Element {
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

  /** 按 borderStyle 互斥展示边框相关参数，避免面板臃肿 */
  const borderStyle = String(params.borderStyle ?? 'vinyl')
  const paramVisible = (p: PresetParam): boolean => {
    // 仅对圆形边框相关 key 做条件显示；其它预设参数恒显示
    const condKeys: Record<string, string[]> = {
      borderColor: ['solid'],
      borderTexture: ['texture'],
      vinylBase: ['vinyl'],
      vinylGroove: ['vinyl'],
      vinylSheen: ['vinyl'],
      colorVinyl: ['color-vinyl'],
      colorVinylGroove: ['color-vinyl'],
      colorVinylSheen: ['color-vinyl']
    }
    const need = condKeys[p.key]
    if (need) {
      if (params.borderStyle === undefined && p.key === 'borderColor') return true
      if (params.borderStyle === undefined) return !need.includes('vinyl') && !need.includes('color-vinyl')
      return need.includes(borderStyle)
    }
    // 跟随圆形图片开启时，隐藏手动布局（位置/半径），避免两套参数打架
    if (params.followCircle === true && meta.params.some((x) => x.key === 'followCircle')) {
      if (p.key === 'posX' || p.key === 'posY' || p.key === 'baseRadius') return false
    }
    return true
  }

  const groups: { name: string; items: PresetParam[] }[] = []
  for (const p of meta.params) {
    if (!paramVisible(p)) continue
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
      case 'gradient': {
        const spec = p as GradientParam
        const g: GradientValue = (() => {
          const raw = value as Partial<GradientValue> | undefined
          const fb = spec.default
          if (!raw || typeof raw !== 'object' || !Array.isArray(raw.stops) || raw.stops.length < 2) return fb
          return {
            type: raw.type === 'radial' ? 'radial' : 'linear',
            angle: Number.isFinite(raw.angle) ? (raw.angle as number) : fb.angle,
            stops: raw.stops.map((s) => ({ t: Math.min(1, Math.max(0, s.t)), color: s.color }))
          }
        })()
        const emit = (next: GradientValue): void => onSetParam(p.key, next)
        const css = `linear-gradient(${g.angle}deg, ${g.stops
          .slice()
          .sort((a, b) => a.t - b.t)
          .map((s) => `${s.color} ${(s.t * 100).toFixed(1)}%`)
          .join(', ')})`
        return (
          <div key={p.key} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: '#bbb', marginBottom: 6 }}>{p.label}</div>
            <div style={{ height: 18, borderRadius: 3, border: '1px solid #333', background: g.type === 'radial' ? `radial-gradient(circle, ${g.stops.map((s) => `${s.color} ${(s.t * 100).toFixed(1)}%`).join(', ')})` : css, marginBottom: 6 }} />
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, fontSize: 11, color: '#999' }}>
              <select
                value={g.type}
                onChange={(e) => emit({ ...g, type: e.target.value === 'radial' ? 'radial' : 'linear' })}
                style={{ ...numInputStyle, width: 72 }}
              >
                <option value="linear">线性</option>
                <option value="radial">径向</option>
              </select>
              {g.type === 'linear' && (
                <>
                  <span>角度</span>
                  <input
                    type="number"
                    min={-360}
                    max={360}
                    step={1}
                    value={g.angle}
                    onChange={(e) => emit({ ...g, angle: Number(e.target.value) || 0 })}
                    style={{ ...numInputStyle, width: 56 }}
                  />
                  <span>°</span>
                  <button
                    type="button"
                    style={{ ...btnStyle(), padding: '2px 6px' }}
                    onClick={() => emit({ ...g, angle: (g.angle + 180) % 360 })}
                    title="反转渐变方向"
                  >
                    反向
                  </button>
                </>
              )}
              <button
                type="button"
                style={{ ...btnStyle(), padding: '2px 6px', marginLeft: 'auto' }}
                disabled={g.stops.length <= 2}
                onClick={() => {
                  if (g.stops.length <= 2) return
                  const next = g.stops.slice(0, -1)
                  emit({ ...g, stops: next })
                }}
              >
                −节点
              </button>
              <button
                type="button"
                style={{ ...btnStyle(), padding: '2px 6px' }}
                onClick={() => {
                  const sorted = g.stops.slice().sort((a, b) => a.t - b.t)
                  const last = sorted[sorted.length - 1]
                  const prev = sorted[sorted.length - 2] ?? { t: 0, color: last.color }
                  const t = Math.min(1, (prev.t + last.t) / 2 + 0.15)
                  emit({ ...g, stops: [...sorted, { t, color: last.color }] })
                }}
              >
                +节点
              </button>
            </div>
            {g.stops
              .map((s, i) => ({ s, i }))
              .sort((a, b) => a.s.t - b.s.t)
              .map(({ s, i }) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <input
                    type="color"
                    value={/^#([0-9a-f]{6})$/i.test(s.color) ? s.color : '#ffffff'}
                    onChange={(e) => {
                      const stops = g.stops.map((x, j) => (j === i ? { ...x, color: e.target.value } : x))
                      emit({ ...g, stops })
                    }}
                    style={{ width: 28, height: 20, background: 'transparent', border: '1px solid #333', borderRadius: 3, padding: 0 }}
                  />
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={s.t}
                    onChange={(e) => {
                      const t = Number(e.target.value)
                      const stops = g.stops.map((x, j) => (j === i ? { ...x, t } : x))
                      emit({ ...g, stops })
                    }}
                    style={{ flex: 1, accentColor: '#2a7de1' }}
                  />
                  <span style={{ width: 36, fontSize: 10, color: '#888', textAlign: 'right' }}>{Math.round(s.t * 100)}%</span>
                  <span
                    title="删除此色标"
                    onClick={() => {
                      if (g.stops.length <= 2) return
                      emit({ ...g, stops: g.stops.filter((_, j) => j !== i) })
                    }}
                    style={{ cursor: g.stops.length > 2 ? 'pointer' : 'not-allowed', color: g.stops.length > 2 ? '#c66' : '#555', fontSize: 12 }}
                  >
                    ×
                  </span>
                </div>
              ))}
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
          {meta.source === 'user' ? (meta.script ? '（第三方脚本）' : '（导入的预设）') : '（内置预设）'}
        </span>
      </div>
      {meta.desc && <div style={{ fontSize: 11, color: '#888', marginBottom: 12, lineHeight: 1.5 }}>{meta.desc}</div>}
      {(() => {
        const err = getScriptError(meta.id) ?? meta.scriptError
        if (!err) return null
        return (
          <div style={{ fontSize: 11, color: '#ff8080', background: 'rgba(180,40,40,.15)', border: '1px solid #803030', borderRadius: 4, padding: '6px 8px', marginBottom: 10, lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
            脚本错误：{err}
          </div>
        )
      })()}

      {meta.clipType === 'image' && (
        <>
          <div style={{ fontSize: 12, color: '#bbb', marginBottom: 6 }}>关联图片素材</div>
          <MediaSlot clip={clip} getAsset={getAsset} onBind={onBindAsset} />
          <div style={{ marginBottom: 14 }} />
        </>
      )}

      {/* GIF 动画速度：仅当关联的是 GIF 素材时显示（静态图忽略该参数） */}
      {looksLikeGifName(clip.src) && onPatchClip && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#cfcfcf', margin: '10px 0 8px' }}>GIF 动画</div>
          <NumberSlider
            label="速度"
            value={clip.gifSpeed ?? 1}
            min={0.25}
            max={8}
            step={0.25}
            onChange={(v) => onPatchClip({ gifSpeed: v })}
          />
          <div style={{ fontSize: 10, color: '#777', lineHeight: 1.5 }}>
            每个 GIF 帧占用 {Math.round((clip.gifSpeed ?? 1) * 100) / 100} 个时间轴帧
            （1 = 一帧换一帧；越大越慢）。按时间轴帧驱动，导出 ≡ 预览。
          </div>
        </div>
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
