/**
 * audioBlob —— 把"本地音频文件的 avn-file:// 源"异步解析成 blob: URL 给 `<audio>` 播放。
 *
 * 动机：Chromium 媒体栈对 avn-file:// 自定义流式协议上的 mp3 等音频(走 FFmpegDemuxer)
 * 做随机区间读不可靠，会 `PIPELINE_ERROR_READ / MEDIA_ERR_NETWORK(code 2)` 无声。
 * blob: URL 走 Chromium 进程内原生解码器，对原生音频(mp3/wav/m4a/flac)稳定。
 * 实现：主进程 fs 整读 → IPC 回传 Uint8Array → new Blob + createObjectURL(按源缓存)。
 *
 * 用法(在 Monitor 顶层，勿在 map/循环内调 hook)：
 *   - 组件顶层 `useEffect(() => initAudioBlob(l.src), [l.src])` 确保发起构建(幂等)
 *   - `<audio src={resolvedAudioBlob(l.src) ?? l.src}>`  就绪即 blob，未就绪原素材(fail-safe)
 *   - `useEffect(() => subscribeAudioBlob(() => bump), [])` 任一源就绪后触发一次重渲染换源
 */

import { useEffect, useState } from 'react'

const blobBySrc = new Map<string, string>() // avn-src → blob: URL(已就绪)
const inflight = new Map<string, Promise<string | null>>() // avn-src → 进行中
const listeners = new Set<() => void>() // 任一源就绪后触发重渲染

function pathFromAvn(src: string): string | null {
  if (!src || !src.startsWith('avn-file://')) return null
  try {
    const u = new URL(src)
    const p = decodeURIComponent(u.hostname)
    return p && p.length > 1 ? p : null
  } catch {
    return null
  }
}

function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
    m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/opus',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm'
  }
  return map[ext] ?? 'application/octet-stream'
}

function hasApi(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { api?: { readFileBytes?: unknown } }).api?.readFileBytes
}

function notify(): void {
  for (const cb of listeners) cb()
}

/** 确保某 avn 源已开始(或已完成)blob 构建；就绪后写缓存并通知订阅者。幂等，每源一次。 */
export function initAudioBlob(src: string): void {
  if (blobBySrc.has(src) || inflight.has(src) || !pathFromAvn(src) || !hasApi()) return
  const p = pathFromAvn(src)!
  const job = window.api.readFileBytes(p)
    .then((bytes) => {
      if (!bytes || bytes.byteLength === 0) return null // 空/失败 → 回退原素材
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeFor(p) }))
      blobBySrc.set(src, url)
      return url
    })
    .catch(() => null) // fail-safe：回退原素材
    .finally(() => { inflight.delete(src) })
  inflight.set(src, job)
  // 成功就绪后通知组件换源
  void job.then((u) => { if (u) notify() })
}

/** 已解析成功的 blob URL；未就绪返回 null（调用方回退原素材）。 */
export function resolvedAudioBlob(src: string): string | null {
  return blobBySrc.get(src) ?? null
}

/** 订阅任一源就绪事件；返回退订函数。 */
export function subscribeAudioBlob(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** React Hook：订阅任一音频源就绪时 bump state，供组件重渲染换 blob 源。 */
export function useAudioBlobTick(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => subscribeAudioBlob(() => setTick((t) => t + 1)), [])
  return tick
}
