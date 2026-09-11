import { useState } from 'react'
import type { Project, Clip, MediaAsset } from '../model/timeline'
import MediaSlot from './MediaSlot'
import NumberSlider from './NumberSlider'
import PresetParamsPanel from './PresetParamsPanel'
import { getPreset } from '../presets/registry'
import type { Box3D, FaceId, Layer3DStyle } from '../pixi/layer3d'
import { FACE_LABELS } from '../pixi/layer3d'

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
  /** 工程级长方体（3D 舞台）；未启用时附着面选择不生效 */
  const box: Box3D | undefined = project.box3d
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

        {showLayer3D && (() => {
          // 长方体是否启用决定本区块能否真正生效（参数在 顶部菜单 → 序列设置 → 3D 长方体）
          const boxEnabled = box?.enabled === true
          const face: FaceId | 'off' = layer3d.enabled !== true ? 'off' : (layer3d.face ?? 'front')
          const onPick = (v: FaceId | 'off'): void => {
            if (v === 'off') setLayer3D({ enabled: false, face: layer3d.face ?? 'front' })
            else setLayer3D({ enabled: true, face: v })
          }
          return (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #2a2a2a' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>3D 附着面（长方体舞台）</div>
              <div style={{ fontSize: 11, color: '#888', lineHeight: 1.6, marginBottom: 10 }}>
                长方体固定正对观众，<b style={{ color: '#9ad' }}>前面 = 画幅平面</b>（等价现在的 2D）。
                选一个面 = 把该剪辑贴到那个平面上，六个面共用同一台相机 → 透视自洽。
                <br />
                <b style={{ color: '#9ad' }}>面是无限平面，不是渲染范围</b>：内容按自己的位置/大小落到面上，
                超出长方体也照常渲染（只被画幅裁）。左/右/顶/底面用画幅坐标 1:1 当深度
                （横向/纵向 = 进深方向），所以调「深度」不会挪动或拉扁它们。
              </div>
              {!boxEnabled && (
                <div style={{ fontSize: 11, color: '#d8a94a', lineHeight: 1.5, marginBottom: 8 }}>
                  ⚠ 3D 长方体当前未启用（序列设置 → 3D 长方体）。未启用时下面的选择不产生任何透视。
                </div>
              )}
              <select
                value={face}
                onChange={(e) => onPick(e.target.value as FaceId | 'off')}
                style={{ width: '100%', background: '#1d1d1d', border: '1px solid #333', color: '#eee', padding: '6px 8px', fontSize: 12, borderRadius: 3 }}
              >
                <option value="off">关闭（不透视）</option>
                <option value="front">前面（= 画幅平面，不变）</option>
                {(['back', 'left', 'right', 'top', 'bottom'] as FaceId[]).map((f) => (
                  <option key={f} value={f}>{FACE_LABELS[f]}</option>
                ))}
              </select>
              {face !== 'off' && face !== 'front' && (
                <div style={{ fontSize: 11, color: '#7fbf7f', marginTop: 6 }}>
                  已贴在「{FACE_LABELS[face as FaceId]}」：位置/缩放滑杆仍然有效（在面内移动/缩放）。
                </div>
              )}
            </div>
          )
        })()}
      </div>
    </div>
  )
}
