import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { EnsureResult } from '../main/mediaCache'
import type { ExportResult } from '../main/export'
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
  /** 首选项：读取 */
  getPreferences: (): Promise<Preferences> => ipcRenderer.invoke('avs:prefGet'),
  /** 首选项：保存（导出设备等，重启生效） */
  setPreferences: (p: Preferences): Promise<Preferences> => ipcRenderer.invoke('avs:prefSet', p),
  /** 探查可用导出设备（GPU 列表 + 硬件编码器可用性） */
  probeExportDevices: (): Promise<{ options: ExportDeviceOption[]; gpus: GpuInfo[]; virtualAdapters: string[] }> =>
    ipcRenderer.invoke('avs:exportDevices'),
  /** GPU 环境（过滤虚拟适配器后的真实 GPU 列表） */
  getGpuEnv: (): Promise<{ gpus: GpuInfo[]; virtualAdapters: string[]; hasVirtual: boolean }> =>
    ipcRenderer.invoke('avs:gpuEnv'),
  /**
   * E2E 测试台（仅当主进程设了 AVS_E2E_SPEC 环境变量时非 null）：
   * 渲染层据此在真实 Chrome 环境跑一次导出，结果经 e2eReport 打回主进程 stdout。
   */
  e2eSpec: ((): unknown => {
    try {
      const raw = process.env['AVS_E2E_SPEC']
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  })(),
  e2eReport: (payload: unknown): Promise<boolean> => ipcRenderer.invoke('avs:e2e:report', payload),
  /** E2E：导出产物自检（ffmpeg 解一遍，比较包数与解出帧数；不等 = 裸流被写坏） */
  e2eVerify: (outPath: string): Promise<{ packets: number; decoded: number; errors: number } | null> =>
    ipcRenderer.invoke('avs:e2e:verify', outPath),
  /** E2E：两个时间点的画面相似度（SSIM）——验证循环/时间轴映射 */
  e2eCompare: (outPath: string, t1: number, t2: number): Promise<number | null> =>
    ipcRenderer.invoke('avs:e2e:compare', outPath, t1, t2),
  /** E2E：把预览画布 PNG(base64) 落盘，用于目视验证 */
  e2eSavePng: (filePath: string, base64: string): Promise<boolean> =>
    ipcRenderer.invoke('avs:e2e:savePng', filePath, base64),
  /** 预设：列出已导入的用户预设（内置预设由渲染层 bundle 提供） */
  presetList: (): Promise<import('../main/presets').UserPresetMeta[]> => ipcRenderer.invoke('avs:presetList'),
  /** 预设：弹文件对话框导入 .avnpre，成功后返回安装后的元数据 */
  presetImport: (): Promise<{ ok: boolean; meta?: import('../main/presets').UserPresetMeta; error?: string }> =>
    ipcRenderer.invoke('avs:presetImport'),
  /** mediabunny 导出：开始写盘（截断已有文件，返回是否成功） */
  mbBegin: (outPath: string): Promise<boolean> => ipcRenderer.invoke('avs:mbBegin', outPath),
  /** mediabunny 导出：按绝对偏移写一块 MP4 字节 */
  mbWrite: (outPath: string, data: Uint8Array, position: number): Promise<boolean> =>
    ipcRenderer.invoke('avs:mbWrite', outPath, data, position),
  /** mediabunny 导出：关闭文件 */
  mbEnd: (outPath: string): Promise<boolean> => ipcRenderer.invoke('avs:mbEnd', outPath),
  /**
   * 数据目录（userData：preferences / presets / MediaCache / logs）可配置。
   * 改完**重启生效**；迁移可选 none/copy/move。
   */
  dataDir: {
    /** 当前数据目录 + 出厂默认 + 各条目占用 */
    info: (): Promise<{
      dir: string
      defaultDir: string
      source: 'flag' | 'config' | 'default'
      overridden: boolean
      configPath: string
      sizes: { name: string; bytes: number }[]
    }> => ipcRenderer.invoke('avs:dataDir:info'),
    /** 弹目录选择框并应用（返回是否成功/已取消） */
    choose: (migrate: 'none' | 'copy' | 'move'): Promise<{ ok: boolean; canceled?: boolean; error?: string; migrated?: string[]; errors?: string[] }> =>
      ipcRenderer.invoke('avs:dataDir:choose', migrate),
    /** 直接指定目录（不做对话框） */
    set: (dir: string, migrate: 'none' | 'copy' | 'move'): Promise<{ ok: boolean; error?: string; migrated?: string[]; errors?: string[] }> =>
      ipcRenderer.invoke('avs:dataDir:set', dir, migrate),
    /** 恢复出厂默认目录（配置清除，重启生效） */
    reset: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('avs:dataDir:reset'),
    /** 在文件管理器里打开数据目录 */
    reveal: (dir?: string): Promise<string> => ipcRenderer.invoke('avs:dataDir:reveal', dir),
    /** 立即重启应用（让数据目录/GPU 偏好生效） */
    relaunch: (): Promise<boolean> => ipcRenderer.invoke('avs:app:relaunch')
  },
  /** 关于 / 开源许可 */
  app: {
    about: (): Promise<{
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
    }> => ipcRenderer.invoke('avs:app:about'),
    /** 打开第三方许可清单（没有则打开所在目录） */
    openLicenses: (): Promise<{ ok: boolean; error?: string; dir: string; target: string }> =>
      ipcRenderer.invoke('avs:app:openLicenses')
  },
  mediaCache
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
