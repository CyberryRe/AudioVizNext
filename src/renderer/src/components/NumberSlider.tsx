import { useRef } from 'react'

/**
 * 滑块控件：label + 拖动条 + 数值输入。
 * 效果控件面板与「序列设置（3D 长方体）」共用，避免两处各写一份。
 */
export default function NumberSlider({ label, value, min, max, step, onChange, title }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  /** 悬停提示（可选） */
  title?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  const startDrag = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const el = ref.current
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
    <div
      title={title}
      style={{ display: 'grid', gridTemplateColumns: '52px 1fr 52px', alignItems: 'center', gap: 8, marginBottom: 9 }}
    >
      <span style={{ fontSize: 12, color: '#bbb' }}>{label}</span>
      <div
        ref={ref}
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
        style={{ width: 52, background: '#1d1d1d', border: '1px solid #333', color: '#eee', padding: '3px 5px', fontSize: 11, borderRadius: 3, textAlign: 'right' }}
      />
    </div>
  )
}
