import { contextBridge } from 'electron'

/**
 * 通过 contextBridge 暴露给渲染进程的安全 API。
 * 后续功能（文件打开、导出、FFmpeg 等）在这里逐个扩展。
 */
const api = {
  version: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
