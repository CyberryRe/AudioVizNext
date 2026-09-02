/**
 * mediaProxy —— 渲染层「媒体代理」桥接（参考 Pr 媒体缓存，见主进程 mediaCache.ts）。
 *
 * 目标：把"原始视频素材"换成"已转码的编辑友好代理(proxy.mp4)"来喂给 Pixi 视频管线，
 * 让高码率/异型编码素材更稳、重复载入更快。缓存以源绝对路径为键，跨工程复用。
 *
 * 职责与原则（fail-safe）：
 *  - 仅处理"本地文件视频"(avn-file:// 协议，能解出磁盘路径)；图片/非本地/无 api 一律原样返回。
 *  - 转码是后台异步：第一次遇到某源时发起 ensure，得到 proxy 前**先用原素材渲染**（不阻塞、不改行为）。
 *  - proxy 就绪后调用注册的 onSwap(original, proxy)，由渲染器把该源重建为代理（同时可继续用原素材）。
 *  - 任何失败(无 ffmpeg / 源缺失 / 转码报错)都静默回退原素材，绝不让预览变黑。
 */

export interface ProxyEvent {
  original: string // 源 avn-file:// URL（渲染层视角的 key）
  proxySrc: string // 代理 avn-file:// URL
  originalPath: string // 源磁盘绝对路径
}

type SwapCb = (e: ProxyEvent) => void

const proxyByOriginal = new Map<string, string>() // original avn-src → proxy avn-src（仅已就绪）
const requested = new Set<string>() // 已发起过 ensure 的 original avn-src
const listeners = new Set<SwapCb>()

/** 从 avn-file:// 解出磁盘绝对路径；非该协议返回 null */
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

function avnUrl(absPath: string): string {
  return `avn-file://${encodeURIComponent(absPath)}`
}

/** 是否有 mediaCache IPC 桥（Electron 渲染层才有） */
function hasApi(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { api?: { mediaCache?: unknown } }).api?.mediaCache
}

/** 当前应使用的有效源：已有代理用代理，否则用原素材（若未请求则后台发起 ensure）。 */
export function effectiveVideoSrc(src: string): string {
  if (proxyByOriginal.has(src)) return proxyByOriginal.get(src)!
  // 仅本地文件视频才值得代理；其余原样
  if (!pathFromAvn(src)) return src
  if (!hasApi()) return src
  // 每会话对某源只请求一次（ensure 幂等；后续由主进程 onProxyReady 推送就绪换代理）。
  // 避免 rAF 播放中每帧重复 IPC。拿不到代理时静默回退原素材（fail-safe），不阻塞渲染。
  if (!requested.has(src)) {
    requested.add(src)
    const p = pathFromAvn(src)!
    window.api.mediaCache.ensure(p)
      .then((r) => {
        if (r.state === 'cached' && r.proxy?.proxyPath) {
          applyReady(src, p, avnUrl(r.proxy.proxyPath))
        }
      })
      .catch(() => { /* 回退原素材 */ })
  }
  return src
}

/** 某个 original 源是否已有就绪代理 */
export function hasProxy(src: string): boolean {
  return proxyByOriginal.has(src)
}

/** 订阅某源代理就绪事件；返回退订函数 */
export function onProxySwap(cb: SwapCb): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** 登记就绪代理并通知订阅者（供内部 ensure 完成事件/主进程推送驱动） */
function applyReady(original: string, originalPath: string, proxySrc: string): void {
  if (proxyByOriginal.get(original) === proxySrc) return
  proxyByOriginal.set(original, proxySrc)
  const e: ProxyEvent = { original, proxySrc, originalPath }
  for (const cb of listeners) cb(e)
}

/** 初始化：订阅主进程"代理转码完成"推送，把仍在用原素材的源切到代理 */
export function initMediaProxy(onSwap: SwapCb): () => void {
  const offSwap = onProxySwap(onSwap)
  if (!hasApi()) return offSwap
  const offMain = window.api.mediaCache.onProxyReady((e) => {
    if (e.error || !e.proxy) return
    const pm = e.proxy as { proxyPath?: string }
    if (!pm?.proxyPath) return
    const original = avnUrl(e.original)
    applyReady(original, e.original, avnUrl(pm.proxyPath))
  })
  return () => { offSwap(); offMain() }
}
