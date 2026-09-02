import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { EnsureResult } from '../main/mediaCache'

/**
 * 通过 contextBridge 暴露给渲染进程的安全 API。
 * 媒体缓存(MediaCache)：请求把视频源转码为代理(参考 Pr 媒体缓存)。
 */
const mediaCache = {
  /** 请求源视频的转码代理；立即返回状态(cached/transcoding/queued/noffmpeg/missing/error) */
  ensure: (srcPath: string): Promise<EnsureResult> =>
    ipcRenderer.invoke('avs:mediaCache', 'ensure', srcPath),
  /** 探测视频信息(真实帧率/duration/宽高)，无 ffprobe 返回 null */
  probe: (srcPath: string): Promise<{ original: string; info: { durationSec: number; fps: number; width: number; height: number } | null }> =>
    ipcRenderer.invoke('avs:mediaCache', 'probe', srcPath),
  /** 是否有可用 ffmpeg */
  hasFfmpeg: (): Promise<boolean> => ipcRenderer.invoke('avs:mediaCache', 'hasFfmpeg'),
  /** 缓存目录绝对路径 */
  cacheDir: (): Promise<string> => ipcRenderer.invoke('avs:mediaCache', 'cacheDir'),
  /** 订阅某源代理转码完成/失败事件；返回取消订阅函数 */
  onProxyReady: (cb: (e: { original: string; proxy: unknown; error: string | null }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { original: string; proxy: unknown; error: string | null }): void => cb(payload)
    ipcRenderer.on('avs:mediaCache:ready', listener)
    return () => ipcRenderer.removeListener('avs:mediaCache:ready', listener)
  }
}

const api = {
  version: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  },
  /**
   * 解析拖入/选择文件的磁盘绝对路径（Electron ≥32 已移除 File.path，改用 WebUtils.getPathForFile）。
   * 非磁盘文件返回空字符串。
   */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  mediaCache
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
