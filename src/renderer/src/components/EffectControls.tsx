import { useRef, useState } from 'react'
import type { Project, Clip, MediaAsset } from '../model/timeline'
import MediaSlot from './MediaSlot'
import PresetParamsPanel from './PresetParamsPanel'
import { getPreset } from '../presets/registry'
import type { Layer3DStyle } from '../pixi/layer3d'
import { defaultLayer3D } from '../pixi/layer3d'

interface EffectControlsProps {
  selectedClipId: string | null
  project: Project
  getAsset: (id: string) => MediaAsset | undefined
  onUpdateClipParams: (clipId: string, patch: Partial<Clip>) => void
  /** 更新预设参数（键 = preset.json 的 params[].key） */
  onSetPresetParam: (clipId: string, key: string, value: unknown) => void
  /** 写入预设参数的关键帧轨道（整轨替换） */
  onSetClipKeyframes: (clipId: string, key: string, track: import('../presets/keyframes').Keyframe[]) => void
  /** 当前播放头帧（关键帧打点/求值用） */
  playheadFrame: number
  onBindAssetToClip: (clipId: string, assetId: string) => void
}

/** 滑块控件：label + 数值输入 + 拖动改值 */
function NumberSlider({ label, value, min, max, step, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
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
    <div style={{ display: 'grid', gridTemplateColumns: '52px 1fr 52px', alignItems: 'center', gap: 8, marginBottom: 9 }}>
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


/** 左上：效果控件 —— 视频循环 clip 的参数面板（关联素材 / 缩放 / 位置） */
export default function EffectControls({ selectedClipId, project, getAsset, onUpdateClipParams, onSetPresetParam, onSetClipKeyframes, playheadFrame, onBindAssetToClip }: EffectControlsProps): React.JSX.Element {
  // 查找选中的 clip
  let selectedClip: Clip | null = null
  let selectedClipName: string | null = null
  if (selectedClipId) {
    for (const clips of Object.values(project.clips)) {
      const c = clips.find((x) => x.id === selectedClipId)
      if (c) { selectedClip = c; selectedClipName = c.name; break }
    }
  }

  // 是否为「视频循环」clip（视频类型 + 有 transform）
  const isVideoLoop = !!selectedClip && selectedClip.type === 'video'
  // 是否为「单次播放」音频 clip（仅可编辑关联的音乐，时长上限为歌曲完整时长）
  const isSinglePlay = !!selectedClip && selectedClip.type === 'audio' && !!selectedClip.clampToSource
  // 是否为歌词类 clip（滚动歌词等）
  const isLyrics = !!selectedClip && selectedClip.type === 'text' && !!selectedClip.isLyrics
  // 预设样式 clip（可视化 / 图片样式）：参数面板由 preset.json 的 schema 自动生成
  const presetMeta = getPreset(selectedClip?.presetId)
  const t = selectedClip?.transform
  // XY 关联（缩放联动）
  const [linkXY, setLinkXY] = useState(false)

  const setTransform = (patch: Partial<NonNullable<Clip['transform']>>): void => {
    if (!selectedClipId) return
    const next = { ...(t ?? { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }), ...patch }
    onUpdateClipParams(selectedClipId, { transform: next })
  }

  // 歌词样式更新
  const setLyrics = (patch: Partial<NonNullable<Clip['lyrics']>>): void => {
    if (!selectedClipId) return
    const cur = selectedClip?.lyrics ?? {}
    onUpdateClipParams(selectedClipId, { lyrics: { ...cur, ...patch } })
  }

  const setLayer3D = (patch: Partial<Layer3DStyle>): void => {
    if (!selectedClipId) return
    const cur = selectedClip?.layer3d ?? {}
    onUpdateClipParams(selectedClipId, { layer3d: { ...cur, ...patch } })
  }

  const lyricStyle = selectedClip?.lyrics ?? {}
  const layer3d = selectedClip?.layer3d ?? {}
  const showLayer3D = !!selectedClip && selectedClip.type !== 'audio'
  const lyricAligns = [
    { v: 'left', label: '左对齐' },
    { v: 'center', label: '居中' },
    { v: 'right', label: '右对齐' }
  ] as const

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="tabline">
        <span className="tab active">效果控件</span>
        <span style={{ marginLeft: 'auto', color: '#888' }}>☰</span>
      </div>
      <div className="panel-head" style={{ flex: 'none' }}>
        <span>{selectedClipName ? selectedClipName : '(未选择剪辑)'}</span>
        <span className="dots">▣</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14, color: 'var(--text-muted)' }}>
        {!selectedClip ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-faint)' }}>
            在时间轴中选择剪辑以查看效果控件
          </div>
        ) : presetMeta ? (
          <PresetParamsPanel
            clip={selectedClip}
            meta={presetMeta}
            getAsset={getAsset}
            frame={playheadFrame}
            onSetParam={(key, value) => selectedClipId && onSetPresetParam(selectedClipId, key, value)}
            onSetKeyframes={(key, track) => selectedClipId && onSetClipKeyframes(selectedClipId, key, track)}
            onBindAsset={(assetId) => selectedClipId && onBindAssetToClip(selectedClipId, assetId)}
            onPatchClip={(patch) => selectedClipId && onUpdateClipParams(selectedClipId, patch)}
          />
        ) : isVideoLoop ? (
          <div>
            {/* 关联素材 */}
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>关联素材</div>
            <MediaSlot clip={selectedClip} getAsset={getAsset} onBind={(id) => selectedClipId && onBindAssetToClip(selectedClipId, id)} />
            <div style={{ fontSize: 11, color: '#888', margin: '6px 0 16px' }}>从素材库拖动媒体素材到上方槽位即可快速填充。</div>

            {/* 缩放 */}
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>缩放</div>
            <NumberSlider label="X 缩放" value={t?.scaleX ?? 1} min={0.05} max={4} step={0.01} onChange={(v) => setTransform({ scaleX: v, ...(linkXY ? { scaleY: v } : {}) })} />
            {!linkXY && (
              <NumberSlider label="Y 缩放" value={t?.scaleY ?? 1} min={0.05} max={4} step={0.01} onChange={(v) => setTransform({ scaleY: v })} />
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
              <input
                type="checkbox"
                id="xy-link"
                checked={linkXY}
                onChange={(e) => setLinkXY(e.target.checked)}
                style={{ accentColor: '#19a8ff' }}
              />
              <label htmlFor="xy-link" style={{ fontSize: 12, color: '#bbb' }}>XY 关联</label>
            </div>

            {/* 位置（在画幅内移动素材，画幅本身固定） */}
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>位置</div>
            <NumberSlider label="X 位置" value={t?.x ?? 0} min={-0.5} max={0.5} step={0.005} onChange={(v) => setTransform({ x: v })} />
            <NumberSlider label="Y 位置" value={t?.y ?? 0} min={-0.5} max={0.5} step={0.005} onChange={(v) => setTransform({ y: v })} />
            <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>素材在画幅内移动，画幅（遮罩）固定不变。</div>
          </div>
        ) : isSinglePlay ? (
          <div>
            {/* 关联音乐（唯一可编辑内容） */}
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>关联的音乐</div>
            <MediaSlot clip={selectedClip} getAsset={getAsset} onBind={(id) => selectedClipId && onBindAssetToClip(selectedClipId, id)} />
            <div style={{ fontSize: 11, color: '#888', margin: '6px 0 8px' }}>从素材库拖动音频素材到上方槽位即可填充。</div>
            <div style={{ fontSize: 11, color: '#888' }}>
              单次播放音频：拖拽 Clip 尾部调整时长，最多到关联歌曲的完整时长为止。
            </div>
          </div>
        ) : isLyrics ? (
          <div>
            {/* 1. 关联素材（LRC 歌词） */}
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>关联素材</div>
            <MediaSlot clip={selectedClip} getAsset={getAsset} onBind={(id) => selectedClipId && onBindAssetToClip(selectedClipId, id)} />
            <div style={{ fontSize: 11, color: '#888', margin: '6px 0 16px' }}>从素材库拖入 LRC 歌词文本，随播放滚动高亮当前句。</div>

            {/* 2. 字体 */}
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>字体</div>
            <select
              value={lyricStyle.fontFamily ?? 'sans-serif'}
              onChange={(e) => setLyrics({ fontFamily: e.target.value })}
              style={{ width: '100%', background: '#1d1d1d', border: '1px solid #333', color: '#eee', padding: '6px 8px', fontSize: 12, borderRadius: 3, marginBottom: 14 }}
            >
              {['sans-serif', 'serif', 'monospace', 'KaiTi', 'Microsoft YaHei', 'SimHei'].map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
              ))}
            </select>

            {/* 3. 对齐 */}
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>对齐</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
              {lyricAligns.map((a) => (
                <span
                  key={a.v}
                  onClick={() => setLyrics({ align: a.v })}
                  style={{
                    flex: 1,
                    textAlign: 'center',
                    padding: '6px 0',
                    fontSize: 12,
                    borderRadius: 3,
                    cursor: 'pointer',
                    background: (lyricStyle.align ?? 'center') === a.v ? '#1a5a9a' : '#333',
                    color: (lyricStyle.align ?? 'center') === a.v ? '#fff' : '#ccc',
                    border: '1px solid #444'
                  }}
                >
                  {a.label}
                </span>
              ))}
            </div>

            {/* 4. 字号 */}
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>字号</div>
            <NumberSlider label="字号" value={lyricStyle.fontSize ?? 48} min={16} max={160} step={1} onChange={(v) => setLyrics({ fontSize: v })} />

            {/* 5. 缩放大小 */}
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>缩放大小</div>
            <NumberSlider label="缩放" value={lyricStyle.scale ?? 1} min={0.2} max={4} step={0.05} onChange={(v) => setLyrics({ scale: v })} />

            {/* 5.5 位置（在画幅内移动歌词） */}
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>位置</div>
            <NumberSlider label="X 位置" value={lyricStyle.x ?? 0} min={-0.5} max={0.5} step={0.005} onChange={(v) => setLyrics({ x: v })} />
            <NumberSlider label="Y 位置" value={lyricStyle.y ?? 0} min={-0.5} max={0.5} step={0.005} onChange={(v) => setLyrics({ y: v })} />
            <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>歌词在画幅内移动，画幅（遮罩）固定不变。</div>
            <NumberSlider label="平面旋转" value={lyricStyle.rotateZ ?? 0} min={-180} max={180} step={1} onChange={(v) => setLyrics({ rotateZ: v })} />
            {/* 透视轴旋转见下方「3D 层变换」 */}
            {/* 6. 字颜色 */}
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>字颜色</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <input
                type="color"
                value={lyricStyle.color ?? '#ffffff'}
                onChange={(e) => setLyrics({ color: e.target.value })}
                style={{ width: 36, height: 28, padding: 0, border: '1px solid #444', background: 'transparent', cursor: 'pointer' }}
              />
              <span style={{ fontSize: 11, color: '#999' }}>{lyricStyle.color ?? '#ffffff'}</span>
            </div>

            {/* 7. 辉光开关 + 颜色 */}
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>辉光</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <input
                type="checkbox"
                id="lyric-glow"
                checked={lyricStyle.glowEnabled ?? true}
                onChange={(e) => setLyrics({ glowEnabled: e.target.checked })}
                style={{ accentColor: '#19a8ff' }}
              />
              <label htmlFor="lyric-glow" style={{ fontSize: 12, color: '#bbb' }}>启用辉光</label>
            </div>
            {(lyricStyle.glowEnabled ?? true) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="color"
                  value={lyricStyle.glowColor ?? '#00e5ff'}
                  onChange={(e) => setLyrics({ glowColor: e.target.value })}
                  style={{ width: 36, height: 28, padding: 0, border: '1px solid #444', background: 'transparent', cursor: 'pointer' }}
                />
                <span style={{ fontSize: 11, color: '#999' }}>辉光颜色</span>
              </div>
            )}
          </div>
        ) : (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)', paddingTop: 40 }}>
            <div style={{ marginBottom: 8 }}>已选中剪辑</div>
            <div style={{ color: 'var(--accent)' }}>{selectedClipName}</div>
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-faint)' }}>
              该剪辑类型暂无可编辑参数（「视频循环」支持素材/缩放/位置，「单次播放」仅关联音乐）
            </div>
          </div>
        )}

        {showLayer3D && (
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #2a2a2a' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>3D 透视变换（四角）</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <input
                type="checkbox"
                id="clip-l3d"
                checked={layer3d.enabled === true}
                onChange={(e) => {
                  // 首次启用时写入默认四角（=内容盒自身，恒等），避免 corners 为空导致回退
                  if (e.target.checked) {
                    setLayer3D({ enabled: true, corners: layer3d.corners ?? defaultLayer3D().corners })
                  } else {
                    setLayer3D({ enabled: false })
                  }
                }}
                style={{ accentColor: '#19a8ff' }}
              />
              <label htmlFor="clip-l3d" style={{ fontSize: 12, color: '#bbb' }}>启用四角透视</label>
            </div>
            {layer3d.enabled === true && (() => {
              const corners = layer3d.corners ?? defaultLayer3D().corners
              const labels = ['左上', '右上', '右下', '左下']
              const setCorner = (i: number, axis: 'x' | 'y', v: number): void => {
                const next = corners.map((p) => ({ ...p })) as typeof corners
                next[i][axis] = v
                setLayer3D({ corners: next })
              }
              return (
                <>
                  <div style={{ fontSize: 11, color: '#888', lineHeight: 1.5, marginBottom: 8 }}>
                    四角坐标相对「内容盒子」：默认 (0,0)(1,0)(1,1)(0,1) = 不扭曲。
                    移动内容（位置/缩放）时四角自动跟随，<b style={{ color: '#9ad' }}>形状严格锁定</b>。
                    也可直接在预览里拖拽绿点。
                  </div>
                  {corners.map((p, i) => (
                    <div key={i} style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 11, color: '#9ad', marginBottom: 2 }}>{labels[i]}</div>
                      <NumberSlider label={`  X`} value={p.x} min={-1} max={2} step={0.005} onChange={(v) => setCorner(i, 'x', v)} />
                      <NumberSlider label={`  Y`} value={p.y} min={-1} max={2} step={0.005} onChange={(v) => setCorner(i, 'y', v)} />
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setLayer3D({ corners: defaultLayer3D().corners })}
                    style={{
                      marginTop: 6,
                      width: '100%',
                      padding: '5px 8px',
                      fontSize: 12,
                      color: '#ccc',
                      background: '#2a2a2a',
                      border: '1px solid #3a3a3a',
                      borderRadius: 4,
                      cursor: 'pointer'
                    }}
                  >
                    重置四角
                  </button>
                </>
              )
            })()}
          </div>
        )}
      </div>
    </div>
  )
}
