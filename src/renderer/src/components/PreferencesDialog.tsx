import { useEffect, useState } from 'react'

interface DeviceOption {
  id: 'auto' | 'discrete' | 'integrated' | 'software'
  label: string
  available: boolean
  detail?: string
}

interface DataDirInfo {
  dir: string
  defaultDir: string
  source: 'flag' | 'config' | 'default'
  overridden: boolean
  configPath: string
  sizes: { name: string; bytes: number }[]
}

interface AboutInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  licensesDir: string
  noticesFile: string | null
  license: string
  copyright: string
  sourceUrl: string
}

interface PreferencesDialogProps {
  onClose: () => void
}

const fmtBytes = (n: number): string => {
  if (!n) return '0'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

/**
 * 首选项对话框（文件 → 首选项…）。
 *  - 「导出设备」：运行时探查所有设备（GPU + 编码器），保存到 preferences.json（重启生效）
 *  - 「数据目录」：userData（预设 / 视频缓存 / 日志 / 首选项）放哪由用户决定，
 *    可选是否把现有数据搬过去（不动 / 复制 / 移动），改完重启生效
 */
export default function PreferencesDialog({ onClose }: PreferencesDialogProps): React.JSX.Element {
  const [options, setOptions] = useState<DeviceOption[] | null>(null)
  const [current, setCurrent] = useState<string>('auto')
  const [savedId, setSavedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // —— 数据目录 ——
  const api = (window as unknown as { api?: Record<string, unknown> }).api as
    | {
        dataDir?: {
          info: () => Promise<DataDirInfo>
          choose: (m: MigrateMode) => Promise<{ ok: boolean; canceled?: boolean; error?: string; migrated?: string[]; errors?: string[] }>
          set: (dir: string, m: MigrateMode) => Promise<{ ok: boolean; error?: string; migrated?: string[]; errors?: string[] }>
          reset: () => Promise<{ ok: boolean; error?: string }>
          reveal: (dir?: string) => Promise<string>
          relaunch: () => Promise<boolean>
        }
        app?: {
          about: () => Promise<AboutInfo>
          openLicenses: () => Promise<{ ok: boolean; error?: string; dir: string; target: string }>
        }
      }
    | undefined
  const dd = api?.dataDir
  const appApi = api?.app
  const [ddInfo, setDdInfo] = useState<DataDirInfo | null>(null)
  const [migrate, setMigrate] = useState<MigrateMode>('copy')
  const [ddMsg, setDdMsg] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [manual, setManual] = useState('')
  const [about, setAbout] = useState<AboutInfo | null>(null)
  const [licMsg, setLicMsg] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const a = (window as unknown as { api?: { probeExportDevices?: () => Promise<{ options: DeviceOption[] }>; getPreferences?: () => Promise<{ exportDevice: string }> } }).api
        if (a?.probeExportDevices) {
          const r = await a.probeExportDevices()
          setOptions(r.options)
        }
        if (a?.getPreferences) {
          const p = await a.getPreferences()
          setCurrent(p.exportDevice ?? 'auto')
        }
      } catch (e) {
        console.warn('[Prefs] 探查失败:', e)
        setErr('设备探查失败：' + String((e as Error)?.message ?? e))
      }
      try {
        if (dd?.info) {
          const info = await dd.info()
          setDdInfo(info)
          setManual(info.dir)
        }
      } catch (e) {
        console.warn('[Prefs] 读取数据目录失败:', e)
      }
      try {
        if (appApi?.about) setAbout(await appApi.about())
      } catch (e) {
        console.warn('[Prefs] 读取版本信息失败:', e)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyResult = (r: { ok: boolean; canceled?: boolean; error?: string; migrated?: string[]; errors?: string[] }): void => {
    if (!r.ok) {
      setDdMsg(r.canceled ? '已取消' : `失败：${r.error ?? '未知错误'}`)
      return
    }
    const moved = r.migrated?.length ? `，已搬运 ${r.migrated.join('、')}` : ''
    const warn = r.errors?.length ? `（部分失败：${r.errors.join('；')}）` : ''
    setDdMsg(`已设置，重启后生效${moved}${warn}`)
    setPending(true)
  }

  const pick = async (): Promise<void> => {
    if (!dd || busy) return
    setBusy(true)
    setDdMsg(null)
    try {
      applyResult(await dd.choose(migrate))
      setDdInfo(await dd.info())
    } catch (e) {
      setDdMsg(`失败：${String((e as Error)?.message ?? e)}`)
    } finally {
      setBusy(false)
    }
  }

  const useManual = async (): Promise<void> => {
    if (!dd || busy || !manual.trim()) return
    setBusy(true)
    setDdMsg(null)
    try {
      applyResult(await dd.set(manual.trim(), migrate))
      setDdInfo(await dd.info())
    } catch (e) {
      setDdMsg(`失败：${String((e as Error)?.message ?? e)}`)
    } finally {
      setBusy(false)
    }
  }

  const resetDir = async (): Promise<void> => {
    if (!dd || busy) return
    setBusy(true)
    setDdMsg(null)
    try {
      const r = await dd.reset()
      if (r.ok) {
        setDdMsg('已恢复出厂默认目录，重启后生效')
        setPending(true)
      } else {
        setDdMsg(`失败：${r.error ?? '未知错误'}`)
      }
      setDdInfo(await dd.info())
    } finally {
      setBusy(false)
    }
  }

  const choose = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const a = (window as unknown as { api?: { setPreferences?: (p: { exportDevice: string }) => Promise<unknown> } }).api
      if (a?.setPreferences) {
        await a.setPreferences({ exportDevice: id })
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
  const sizeLabel = ddInfo ? ddInfo.sizes.map((s) => `${s.name} ${fmtBytes(s.bytes)}`).join(' · ') : ''

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,.55)', fontFamily: 'inherit'
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ width: 560, maxHeight: '86vh', overflow: 'auto', background: '#1f1f1f', border: '1px solid #333', borderRadius: 6, padding: 18, boxShadow: '0 10px 30px rgba(0,0,0,.6)' }}>
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

        {/* —— 数据目录（预设 / 视频缓存 / 日志 / 首选项） —— */}
        {dd && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid #333' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#bbb', marginBottom: 8 }}>数据目录</div>
            <div style={{ fontSize: 11, color: '#888', lineHeight: 1.6, marginBottom: 8 }}>
              预设、视频代理缓存（可能几个 GB）、日志与首选项都放在这里。
              默认在 <span style={{ color: '#9ad' }}>%APPDATA%\AudioVizNext</span>；可以改到别的盘/目录，改完重启生效。
            </div>
            {ddInfo && (
              <>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <input
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                    spellCheck={false}
                    style={{ flex: 1, minWidth: 0, background: '#141414', border: '1px solid #333', color: '#ddd', padding: '5px 8px', fontSize: 11, borderRadius: 3 }}
                  />
                  <button onClick={() => { void dd.reveal(ddInfo.dir) }} style={btnStyle}>打开目录</button>
                </div>
                <div style={{ fontSize: 10, color: '#777', marginBottom: 8 }}>
                  当前：{ddInfo.dir}
                  {ddInfo.overridden ? `（已自定义，来源 ${ddInfo.source === 'flag' ? '命令行参数' : '首选项'}）` : '（默认）'}
                  {sizeLabel ? ` · ${sizeLabel}` : ''}
                </div>
              </>
            )}

            <div style={{ fontSize: 11, color: '#aaa', marginBottom: 6 }}>切换方式</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {([
                { v: 'copy', label: '复制数据过去（两边都留）' },
                { v: 'move', label: '移动数据过去（旧的删掉）' },
                { v: 'none', label: '只换目录（数据留在原处）' }
              ] as const).map((o) => (
                <span
                  key={o.v}
                  onClick={() => setMigrate(o.v)}
                  style={{
                    flex: 1, textAlign: 'center', padding: '5px 0', fontSize: 11, borderRadius: 3, cursor: 'pointer',
                    background: migrate === o.v ? '#1a5a9a' : '#262626',
                    color: migrate === o.v ? '#fff' : '#bbb',
                    border: '1px solid #3a3a3a'
                  }}
                >
                  {o.label}
                </span>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => { void pick() }} disabled={busy} style={btnStyle}>选择目录并应用…</button>
              <button onClick={() => { void useManual() }} disabled={busy || !manual.trim()} style={btnStyle}>用上面这个路径</button>
              <button onClick={() => { void resetDir() }} disabled={busy} style={btnStyle}>恢复默认</button>
              {pending && <button onClick={() => { void dd.relaunch() }} style={{ ...btnStyle, borderColor: '#19a8ff', color: '#cfe9ff' }}>立即重启</button>}
            </div>
            {ddMsg && <div style={{ marginTop: 8, fontSize: 11, color: ddMsg.startsWith('失败') ? '#ff9d9d' : '#b7e6b0' }}>{ddMsg}</div>}
            <div style={{ marginTop: 6, fontSize: 10, color: '#777' }}>
              小技巧：多开/临时试数据可以给快捷方式加 <span style={{ color: '#9ad' }}>--user-data-dir=D:\某目录</span>，只影响这一次启动。
            </div>
          </div>
        )}

        {/* —— 关于 / 开源许可 —— */}
        {appApi?.about && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid #333' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#bbb', marginBottom: 8 }}>关于</div>
            {about ? (
              <>
                <div style={{ fontSize: 11, color: '#aaa', lineHeight: 1.7, marginBottom: 8 }}>
                  <div>
                    <span style={{ color: '#ddd' }}>{about.name}</span> v{about.version}
                    <span style={{ color: '#777' }}> · {about.license} · {about.copyright}</span>
                  </div>
                  <div style={{ color: '#777' }}>
                    Electron {about.electron} · Chromium {about.chrome} · Node {about.node}
                  </div>
                  <div style={{ color: '#777' }}>
                    AGPL-3.0 要求随分发提供对应源码：
                    <span style={{ color: '#9ad', wordBreak: 'break-all' }}>{about.sourceUrl}</span>
                  </div>
                  <div style={{ color: '#777', marginTop: 4 }}>
                    随包分发 FFmpeg/FFprobe（GPLv3，独立进程调用）与 Electron/Chromium；安装包未做代码签名，
                    首次运行如遇 SmartScreen 提示请点「更多信息 → 仍要运行」。
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button
                    onClick={() => {
                      void (async () => {
                        try {
                          const r = await appApi.openLicenses()
                          setLicMsg(r.ok ? `已打开：${r.target}` : `打开失败：${r.error ?? '未知错误'}`)
                        } catch (e) {
                          setLicMsg(`打开失败：${String((e as Error)?.message ?? e)}`)
                        }
                      })()
                    }}
                    style={btnStyle}
                  >
                    开源许可（第三方组件清单）
                  </button>
                  <span style={{ fontSize: 10, color: '#777' }}>安装目录 resources/licenses/</span>
                </div>
                {licMsg && <div style={{ marginTop: 6, fontSize: 10, color: '#999', wordBreak: 'break-all' }}>{licMsg}</div>}
              </>
            ) : (
              <div style={{ fontSize: 11, color: '#777' }}>正在读取版本信息…</div>
            )}
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

type MigrateMode = 'none' | 'copy' | 'move'

const btnStyle: React.CSSProperties = {
  background: '#2a2a2a', border: '1px solid #555', color: '#eee',
  padding: '5px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap'
}
