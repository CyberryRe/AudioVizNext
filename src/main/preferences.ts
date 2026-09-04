// preferences.ts —— 应用首选项持久化（userData/preferences.json）。
// 导出设备等偏好在启动时就需生效（Chromium GPU 开关只能启动时设），故写配置文件 + 重启生效。

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'

/**
 * 导出设备偏好（决定用哪块 GPU/哪种编码器做导出）：
 *  - 'auto'       自动（Chromium 默认 GPU + nvenc→amf→qsv→libx264 探测链）
 *  - 'discrete'   独显（Chromium force-high-performance-gpu；ffmpeg 优先 NVENC/AMF）
 *  - 'integrated' 核显（Chromium force-low-power-gpu；ffmpeg 优先 Quick Sync）
 *  - 'software'   纯软件（libx264，不用 WebCodecs 硬编）
 */
export type ExportDevicePref = 'auto' | 'discrete' | 'integrated' | 'software'

export interface Preferences {
  exportDevice: ExportDevicePref
}

export const PREF_DEFAULTS: Preferences = { exportDevice: 'auto' }

let cached: Preferences | null = null

export function preferencesPath(): string {
  return join(app.getPath('userData'), 'preferences.json')
}

/** 读取首选项（幂等缓存）。app ready 前即可调用（读 userData 路径不依赖 ready）。 */
export function loadPreferences(): Preferences {
  if (cached) return cached
  let p: Preferences = { ...PREF_DEFAULTS }
  try {
    const raw = readFileSync(preferencesPath(), 'utf8')
    const j = JSON.parse(raw) as Partial<Preferences>
    if (j && typeof j === 'object') {
      const v = j.exportDevice
      p.exportDevice = v === 'discrete' || v === 'integrated' || v === 'software' ? v : 'auto'
    }
  } catch { /* 无配置文件/损坏 → 默认 */ }
  cached = p
  return p
}

/** 保存首选项。 */
export function savePreferences(p: Preferences): Preferences {
  const next: Preferences = { exportDevice: p.exportDevice === 'discrete' || p.exportDevice === 'integrated' || p.exportDevice === 'software' ? p.exportDevice : 'auto' }
  cached = next
  try {
    writeFileSync(preferencesPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (e) {
    console.warn('[Preferences] 保存失败:', (e as Error)?.message)
  }
  return next
}
