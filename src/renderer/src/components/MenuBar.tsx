import { useState } from 'react'
import type { StageRatio } from '../model/timeline'
import PreferencesDialog from './PreferencesDialog'

interface StageConfig {
  ratioId: string
  width: number
  height: number
  orientation: 'landscape' | 'portrait'
}

interface MenuBarProps {
  stageConfig: StageConfig
  onSetStage: (next: StageConfig) => void
  ratios: StageRatio[]
  stageSizeFor: (ratio: number, mainLength: number, orientation?: 'landscape' | 'portrait') => { width: number; height: number }
  /** 点「文件>导出」触发（由 App 承接完整导出流程） */
  onExport?: () => void
}

/** 只保留 文件 / 序列 / 帮助 三个菜单 */
const FILES = ['新建项目', '打开项目…', '保存', '另存为…', '—', '导入', '导出', '—', '首选项…', '退出']
const HELPS = ['关于 AudioVizNext', '文档']

/** 标准分辨率预设（主边长度） */
const MAIN_LENGTHS = [720, 1080, 1440, 1920, 2160, 3840]

export default function MenuBar({ stageConfig, onSetStage, ratios, stageSizeFor, onExport }: MenuBarProps): React.JSX.Element {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [seqOpen, setSeqOpen] = useState(false)
  const [prefsOpen, setPrefsOpen] = useState(false)

  const closeAll = (): void => { setOpenMenu(null); setSeqOpen(false) }

  // 选中的比例对象
  const ratioObj = ratios.find((r) => r.id === stageConfig.ratioId) ?? ratios[0]
  const isPortrait = stageConfig.orientation === 'portrait'

  const pickRatio = (r: StageRatio): void => {
    const portrait = r.ratio < 1
    const orientation = portrait ? 'portrait' : 'landscape'
    // 保持主边长度不变，重算另一维
    const size = stageSizeFor(r.ratio, portrait ? stageConfig.height : stageConfig.width, orientation)
    onSetStage({
      ratioId: r.id,
      width: size.width,
      height: size.height,
      orientation
    })
    setSeqOpen(false)
  }

  const pickMainLength = (len: number): void => {
    const size = stageSizeFor(ratioObj.ratio, len, isPortrait ? 'portrait' : 'landscape')
    onSetStage({
      ...stageConfig,
      width: size.width,
      height: size.height
    })
  }

  return (
    <div
      style={{
        height: 44,
        background: '#202020',
        borderBottom: '1px solid #090909',
        display: 'flex',
        alignItems: 'stretch',
        gap: 2,
        padding: '0 14px',
        flex: 'none',
        position: 'relative',
        zIndex: 30
      }}
      onMouseDown={closeAll}
    >
      <span style={{ fontSize: 18, fontWeight: 700, marginRight: 4, color: '#eee', alignSelf: 'center' }}>◆</span>

      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        {/* 文件 */}
        <MenuRoot label="文件(F)" open={openMenu === 'file'} onToggle={() => setOpenMenu(openMenu === 'file' ? null : 'file')}>
          {FILES.map((it, j) =>
            it === '—' ? (
              <div key={j} style={{ height: 1, background: '#3a3a3a', margin: '5px 10px' }} />
            ) : it === '导出' ? (
              <MenuItem key={j} label={it} onClick={() => { closeAll(); onExport?.() }} />
            ) : it === '首选项…' ? (
              <MenuItem key={j} label={it} onClick={() => { closeAll(); setPrefsOpen(true) }} />
            ) : (
              <MenuItem key={j} label={it} onClick={closeAll} />
            )
          )}
        </MenuRoot>

        {/* 序列 */}
        <MenuRoot label="序列(S)" open={openMenu === 'seq'} onToggle={() => { setOpenMenu(openMenu === 'seq' ? null : 'seq'); setSeqOpen(false) }}>
          <MenuItem label="新建序列" onClick={closeAll} />
          <div style={{ height: 1, background: '#3a3a3a', margin: '5px 10px' }} />
          <MenuItem label="序列设置…" onClick={() => { setOpenMenu(null); setSeqOpen(true) }} active />
        </MenuRoot>

        {/* 帮助 */}
        <MenuRoot label="帮助(H)" open={openMenu === 'help'} onToggle={() => setOpenMenu(openMenu === 'help' ? null : 'help')}>
          {HELPS.map((it, j) => (
            <MenuItem key={j} label={it} onClick={closeAll} />
          ))}
        </MenuRoot>
      </div>

      {/* 序列设置弹层（比例参数 + 分辨率） */}
      {seqOpen && (
        <div
          style={{
            position: 'absolute',
            top: 44,
            left: 118,
            width: 300,
            background: '#262626',
            border: '1px solid #111',
            borderRadius: 4,
            boxShadow: '0 8px 24px rgba(0,0,0,.55)',
            padding: 14,
            zIndex: 40
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: '#eee' }}>序列设置</div>

          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>比例参数</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 14 }}>
            {ratios.map((r) => (
              <div
                key={r.id}
                onClick={() => pickRatio(r)}
                style={{
                  padding: '6px 0',
                  textAlign: 'center',
                  fontSize: 12,
                  borderRadius: 3,
                  cursor: 'pointer',
                  background: r.id === stageConfig.ratioId ? '#1a5a9a' : '#333',
                  color: r.id === stageConfig.ratioId ? '#fff' : '#ccc',
                  border: '1px solid #444'
                }}
              >
                {r.name}
              </div>
            ))}
          </div>

          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>分辨率</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <input
              type="number"
              value={stageConfig.width}
              min={16}
              onChange={(e) => {
                const w = Math.max(16, Number(e.target.value) || 16)
                onSetStage({ ...stageConfig, width: w })
              }}
              onMouseDown={(e) => e.stopPropagation()}
              style={{ width: 80, background: '#1d1d1d', border: '1px solid #444', color: '#eee', padding: '5px 8px', fontSize: 12, borderRadius: 3 }}
            />
            <span style={{ color: '#888', fontSize: 12 }}>×</span>
            <input
              type="number"
              value={stageConfig.height}
              min={16}
              onChange={(e) => {
                const h = Math.max(16, Number(e.target.value) || 16)
                onSetStage({ ...stageConfig, height: h })
              }}
              onMouseDown={(e) => e.stopPropagation()}
              style={{ width: 80, background: '#1d1d1d', border: '1px solid #444', color: '#eee', padding: '5px 8px', fontSize: 12, borderRadius: 3 }}
            />
            <span style={{ color: '#888', fontSize: 12 }}>{isPortrait ? '竖屏' : '横屏'}</span>
          </div>

          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>预设主边长度</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {MAIN_LENGTHS.map((len) => {
              const active = isPortrait ? stageConfig.height === len : stageConfig.width === len
              return (
                <div
                  key={len}
                  onClick={() => pickMainLength(len)}
                  style={{
                    padding: '3px 8px',
                    fontSize: 11,
                    borderRadius: 3,
                    cursor: 'pointer',
                    background: active ? '#1a5a9a' : '#333',
                    color: active ? '#fff' : '#bbb'
                  }}
                >
                  {len}p
                </div>
              )
            })}
          </div>

          <div style={{ marginTop: 14, fontSize: 11, color: '#777' }}>
            当前 {stageConfig.width}×{stageConfig.height}（{ratioObj.name}）
          </div>
        </div>
      )}

      {/* 工作区 */}
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'stretch', gap: 18, color: '#ddd' }}>
        {['导入', '编辑', '导出', '效果'].map((w, i) => (
          <span key={w} style={{ display: 'flex', alignItems: 'center', borderBottom: i === 1 ? '2px solid #d7d7d7' : 'none', cursor: 'default', fontSize: 13 }}>
            {w}
          </span>
        ))}
      </span>

      {/* 首选项对话框（文件 → 首选项…） */}
      {prefsOpen && <PreferencesDialog onClose={() => setPrefsOpen(false)} />}
    </div>
  )
}

/** 菜单根（可下拉） */
function MenuRoot({ label, open, onToggle, children }: {
  label: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <span
        onMouseEnter={() => { if (open) onToggle() }}
        onMouseDown={(e) => { e.stopPropagation(); onToggle() }}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0 7px',
          fontSize: 13,
          color: open ? '#fff' : '#ddd',
          background: open ? '#333' : 'transparent',
          cursor: 'default',
          whiteSpace: 'nowrap',
          borderRadius: 3
        }}
      >
        {label}
      </span>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            background: '#262626',
            border: '1px solid #111',
            borderRadius: 4,
            minWidth: 190,
            boxShadow: '0 6px 18px rgba(0,0,0,.5)',
            padding: '4px 0',
            zIndex: 35
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      )}
    </div>
  )
}

/** 菜单项 */
function MenuItem({ label, onClick, active }: { label: string; onClick: () => void; active?: boolean }): React.JSX.Element {
  return (
    <div
      style={{
        padding: '6px 18px 6px 24px',
        fontSize: 13,
        color: '#ddd',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#1a5a9a' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
      onClick={onClick}
    >
      {label}
      {active && <span style={{ color: '#19a8ff', fontSize: 11 }}>▸</span>}
    </div>
  )
}
