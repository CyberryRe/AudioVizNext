import { useEffect, useState } from 'react'

interface DeviceOption {
  id: 'auto' | 'discrete' | 'integrated' | 'software'
  label: string
  available: boolean
  detail?: string
}

interface PreferencesDialogProps {
  onClose: () => void
}

/**
 * 首选项对话框（文件 → 首选项…）。
 * 当前只有「导出设备」一项：打开时运行时探查所有设备（GPU + 编码器），保存到 preferences.json。
 * 导出设备在 GPU 进程启动时生效，故切换后需重启应用。
 */
export default function PreferencesDialog({ onClose }: PreferencesDialogProps): React.JSX.Element {
  const [options, setOptions] = useState<DeviceOption[] | null>(null)
  const [current, setCurrent] = useState<string>('auto')
  const [savedId, setSavedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const api = (window as unknown as { api?: { probeExportDevices?: () => Promise<{ options: DeviceOption[] }>; getPreferences?: () => Promise<{ exportDevice: string }> } }).api
        if (api?.probeExportDevices) {
          const r = await api.probeExportDevices()
          setOptions(r.options)
        }
        if (api?.getPreferences) {
          const p = await api.getPreferences()
          setCurrent(p.exportDevice ?? 'auto')
        }
      } catch (e) {
        console.warn('[Prefs] 探查失败:', e)
        setErr('设备探查失败：' + String((e as Error)?.message ?? e))
      }
    })()
  }, [])

  const choose = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const api = (window as unknown as { api?: { setPreferences?: (p: { exportDevice: string }) => Promise<unknown> } }).api
      if (api?.setPreferences) {
        await api.setPreferences({ exportDevice: id })
      }
      setCurrent(id)
      setSavedId(id)
    } catch (e) {
      setErr('保存失败：' + String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const savedLabel = savedId ? options?.find((o) => o.id === savedId)?.label ?? savedId : null

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,.55)', fontFamily: 'inherit'
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ width: 460, background: '#1f1f1f', border: '1px solid #333', borderRadius: 6, padding: 18, boxShadow: '0 10px 30px rgba(0,0,0,.6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#eee' }}>首选项</span>
          <span style={{ cursor: 'pointer', color: '#999', fontSize: 14, padding: '0 4px' }} onClick={onClose} title="关闭">✕</span>
        </div>

        <div style={{ fontSize: 12, fontWeight: 700, color: '#bbb', marginBottom: 8 }}>导出设备</div>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
          选择导出时使用的 GPU / 编码器。切换后需重启应用生效。
        </div>

        {err && <div style={{ fontSize: 11, color: '#ff9d9d', marginBottom: 8 }}>{err}</div>}
        {options === null && !err && <div style={{ fontSize: 12, color: '#aaa', padding: '10px 0' }}>正在探查设备…</div>}

        {options && options.map((o) => (
          <label
            key={o.id}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', marginBottom: 6,
              background: current === o.id ? 'rgba(25,168,255,.08)' : '#171717',
              border: `1px solid ${current === o.id ? '#19a8ff' : '#333'}`,
              borderRadius: 4, cursor: o.available && !busy ? 'pointer' : 'not-allowed',
              opacity: o.available ? 1 : 0.45
            }}
          >
            <input
              type="radio"
              name="exportDevice"
              style={{ marginTop: 2, accentColor: '#19a8ff' }}
              checked={current === o.id}
              disabled={!o.available || busy}
              onChange={() => { void choose(o.id) }}
            />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12, color: '#ddd' }}>
                {o.label}
                {!o.available && <span style={{ color: '#888', marginLeft: 6 }}>（不可用）</span>}
              </span>
              {o.detail && <span style={{ display: 'block', fontSize: 10, color: '#777', marginTop: 2 }}>{o.detail}</span>}
            </span>
          </label>
        ))}

        {savedId && (
          <div style={{ marginTop: 8, fontSize: 11, color: '#b7e6b0' }}>
            已保存：{savedLabel}。重启应用后生效。
          </div>
        )}

        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{ background: '#2a2a2a', border: '1px solid #555', color: '#eee', padding: '6px 16px', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
