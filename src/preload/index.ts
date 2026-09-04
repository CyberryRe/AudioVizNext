import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { EnsureResult } from '../main/mediaCache'
import type { AudioClipInput, ExportResult, ExportVideoParams } from '../main/export'
import type { DecodeMediaMeta } from '../main/decodeMedia'
import type { Preferences } from '../main/preferences'
import type { ExportDeviceOption, GpuInfo } from '../main/deviceProbe'

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
  /**
   * 读取磁盘文件全部字节（返回 Uint8Array）。用于把本地音频打包成 blob: URL 播放——
   * Chromium 的 FFmpegDemuxer 对 avn-file:// 自定义流式协议不可靠(PIPELINE_ERROR_READ)，
   * blob 走进程内原生解码器则万无一失。
   */
  readFileBytes: (filePath: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('avs:readFileBytes', filePath) as Promise<Uint8Array>,
  /** 导出：弹保存对话框返回用户选择的 .mp4 路径（取消返回 null） */
  exportSaveDialog: (): Promise<string | null> => ipcRenderer.invoke('avs:exportSaveDialog'),
  /** 导出：是否有可用 ffmpeg */
  exportHasFfmpeg: (): Promise<boolean> => ipcRenderer.invoke('avs:exportHasFfmpeg'),
  /** 导出：开始会话（spawn 视频编码器；返回所选编码器） */
  exportBegin: (p: ExportVideoParams): Promise<{ ok: boolean; error?: string; encoder?: string }> =>
    ipcRenderer.invoke('avs:exportBegin', p),
  /** 导出：逐帧送一帧 NV12（当前会话 pixelInput:'nv12' 时 ffmpeg rawvideo 直读）；旧 PNG 会话兼容同一通道 */
  exportFrame: (png: Uint8Array): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('avs:exportFrame', png),
  /** 导出：结束会话并合成（含音频计划） */
  exportEnd: (audio: AudioClipInput[]): Promise<ExportResult> => ipcRenderer.invoke('avs:exportEnd', audio),
  /** 导出(annexb)：开始复用会话（WebCodecs 裸流 → ffmpeg -c:v copy） */
  exportMuxBegin: (p: ExportVideoParams): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('avs:exportMuxBegin', p),
  /** 导出(annexb)：送一块 H.264 Annex-B 裸流 */
  exportMuxChunk: (bytes: Uint8Array): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('avs:exportMuxChunk', bytes),
  /** 导出(annexb)：结束复用会话并混音频合成 */
  exportMuxEnd: (audio: AudioClipInput[]): Promise<ExportResult> => ipcRenderer.invoke('avs:exportMuxEnd', audio),
  /** 首选项：读取 */
  getPreferences: (): Promise<Preferences> => ipcRenderer.invoke('avs:prefGet'),
  /** 首选项：保存（导出设备等，重启生效） */
  setPreferences: (p: Preferences): Promise<Preferences> => ipcRenderer.invoke('avs:prefSet', p),
  /** 探查可用导出设备（GPU 列表 + 硬件编码器可用性） */
  probeExportDevices: (): Promise<{ options: ExportDeviceOption[]; gpus: GpuInfo[] }> =>
    ipcRenderer.invoke('avs:exportDevices'),
  /** WebCodecs 预解码：请求把源视频轨拆成 H.264 Annex-B 临时 ES */
  decodeDemux: (srcPath: string): Promise<{ ok: boolean; es: DecodeMediaMeta | null }> =>
    ipcRenderer.invoke('avs:decodeMedia', 'demux', srcPath),
  mediaCache
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
