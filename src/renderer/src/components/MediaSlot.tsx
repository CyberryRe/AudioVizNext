/**
 * MediaSlot.tsx —— 素材拖入槽（「关联素材」）。从 EffectControls 拆出，
 * 供预设参数面板复用（避免组件间循环 import）。
 */
import { useState } from 'react'
import type { Clip, MediaAsset } from '../model/timeline'

export default function MediaSlot({ clip, getAsset, onBind }: {
  clip: Clip
  getAsset: (id: string) => MediaAsset | undefined
  onBind: (assetId: string) => void
}): React.JSX.Element {
  const [over, setOver] = useState(false)
  const bound = clip.assetId ? getAsset(clip.assetId) : undefined
  const boundName = bound?.name ?? clip.name

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setOver(false)
    // 读取素材 id
    try {
      const raw = e.dataTransfer.getData('application/x-avn-asset')
      if (raw) {
        const p = JSON.parse(raw)
        if (p.assetId) { onBind(p.assetId); return }
      }
    } catch { /* ignore */ }
    const stash = (window as unknown as Record<string, unknown>)._avsPendingDrag as { type: 'asset'; assetId: string } | undefined
    if (stash?.type === 'asset') { onBind(stash.assetId) }
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      style={{
        border: `1px dashed ${over ? '#19a8ff' : '#555'}`,
        borderRadius: 4,
        padding: '12px 10px',
        textAlign: 'center',
        color: over ? '#19a8ff' : '#aaa',
        fontSize: 12,
        background: over ? 'rgba(25,168,255,.08)' : 'transparent',
        cursor: 'pointer',
        transition: 'border-color .15s, color .15s'
      }}
      title="从素材库拖入媒体素材以快速填充"
    >
      {bound ? (
        <>
          <div style={{ color: '#eee', marginBottom: 3 }}>{boundName}</div>
          <div style={{ fontSize: 11, color: '#777' }}>{bound.kind} · 已绑定</div>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 3 }}>＋ 拖入媒体素材</div>
          <div style={{ fontSize: 11, color: '#777' }}>从左侧素材库拖入</div>
        </>
      )}
    </div>
  )
}
