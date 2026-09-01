import { contextBridge, ipcRenderer } from 'electron'

/**
 * 通过 contextBridge 暴露给渲染进程的安全 API。
 * 后续功能（文件打开、导出、FFmpeg 等）在这里逐个扩展。
 */
const api = {
  version: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  },
  /** 窗口控制（标题栏自绘按钮） */
  window: {
    minimize: (): void => ipcRenderer.send('win:minimize'),
    maximize: (): void => ipcRenderer.send('win:maximize'),
    close: (): void => ipcRenderer.send('win:close')
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
