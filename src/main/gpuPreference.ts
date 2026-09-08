// gpuPreference.ts —— Windows 每应用 GPU 偏好（Optimus/混合显卡下把本应用路由到独显/核显）。
//
// 写入位置与「设置 → 系统 → 屏幕 → 显卡」手动指定完全一致：
//   HKCU\Software\Microsoft\DirectX\UserGpuPreferences
//     <进程 exe 名> = "GpuPreference=<0|1|2>;"
//       0=系统决定 / 1=节能(核显) / 2=高性能(独显)
//
// Chromium/DXGI 在进程启动时读取该值 → 修改需重启应用生效。
// ⚠ 卸载或切回"自动"时必须删除该值，否则会一直把应用钉在指定 GPU 上
//   （详见 docs/export-gpu.md；将来做安装包时卸载器需清理）。

import { execFile } from 'child_process'
import { basename } from 'path'

const REG_BASE = 'HKCU:\\Software\\Microsoft\\DirectX'
const REG_PREF = `${REG_BASE}\\UserGpuPreferences`

export type DeviceMode = 'auto' | 'discrete' | 'integrated' | 'software' | 'ffmpeg'

/** 当前进程 exe 名：dev=electron.exe，打包后=产品 exe（注册表键须与启动应用的 exe 一致）。 */
export function currentExeName(): string {
  return basename(process.execPath)
}

/**
 * 写入/删除本应用的 GPU 偏好（与"导出设备"首选项联动）。
 * discrete→GpuPreference=2；integrated→1；auto/software→删除该值交还系统决定。
 * 返回是否成功（失败仅告警，不影响导出）。
 */
export function applyWindowsGpuPreference(mode: DeviceMode): Promise<boolean> {
  const exe = currentExeName()
  const gpu = mode === 'discrete' ? 2 : mode === 'integrated' ? 1 : null
  const ps =
    gpu === null
      ? `Remove-ItemProperty -Path '${REG_PREF}' -Name '${exe}' -ErrorAction SilentlyContinue; exit 0`
      : `New-Item -Path '${REG_BASE}' -Name 'UserGpuPreferences' -Force | Out-Null; ` +
        `Set-ItemProperty -Path '${REG_PREF}' -Name '${exe}' -Value 'GpuPreference=${gpu};'; exit 0`
  return new Promise<boolean>((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, (err) => {
      if (err) console.warn(`[GpuPreference] 注册表操作失败: ${err.message}`)
      else console.log(`[GpuPreference] ${exe} → ${gpu === null ? '已删除（系统决定）' : `GpuPreference=${gpu}${gpu === 2 ? '（高性能/独显）' : '（节能/核显）'}`}`)
      resolve(!err)
    })
  })
}
