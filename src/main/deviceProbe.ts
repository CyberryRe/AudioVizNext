// deviceProbe.ts —— 运行时探查导出设备：枚举真实 GPU（按厂商白名单过滤虚拟显示适配器）+ 编码器可用性。
//
// 背景：GameViewer/UU远程等工具会装"驱动级虚拟显示适配器"，在 Win32_VideoController 里表现为
// 一块普通显卡，但没有任何真实编码器。这里按 PNP 厂商 ID 白名单（NVIDIA/Intel/AMD）只保留真实 GPU，
// 其余一律标为 virtualAdapters 忽略——设备列表、WebCodecs 路由都基于过滤后的真实 GPU。

import { execFileSync } from 'child_process'
import { probeHwEncoder } from './export'

export type GpuVendor = 'nvidia' | 'intel' | 'amd' | 'other'

export interface GpuInfo {
  name: string
  kind: 'discrete' | 'integrated'
  vendor: GpuVendor
}

export interface ExportDeviceOption {
  id: 'auto' | 'discrete' | 'integrated' | 'software'
  label: string
  available: boolean
  detail?: string
}

export interface GpuEnv {
  /** 过滤掉虚拟适配器后的真实 GPU */
  gpus: GpuInfo[]
  /** 被忽略的虚拟显示适配器名称 */
  virtualAdapters: string[]
  hasVirtual: boolean
}

let _gpuEnv: GpuEnv | null = null

/** 由 PNPDeviceID(VEN_xxxx) 与 AdapterCompatibility 判定厂商。 */
function vendorOf(compatLower: string, pnpUpper: string): GpuVendor {
  if (/VEN_10DE/.test(pnpUpper) || compatLower.includes('nvidia')) return 'nvidia'
  if (/VEN_8086/.test(pnpUpper) || compatLower.includes('intel')) return 'intel'
  if (/VEN_1002|VEN_1022/.test(pnpUpper) || compatLower.includes('amd') || compatLower.includes('advanced micro')) return 'amd'
  return 'other'
}

/** PowerShell 枚举视频控制器并做厂商白名单过滤。 */
function enumerateGpus(): GpuEnv {
  const env: GpuEnv = { gpus: [], virtualAdapters: [], hasVirtual: false }
  try {
    const ps =
      'Get-CimInstance Win32_VideoController | ForEach-Object { ' +
      '[PSCustomObject]@{ name = $_.Name; compat = $_.AdapterCompatibility; pnp = $_.PNPDeviceID } ' +
      '} | ConvertTo-Json -Compress'
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024
    })
    const parsed = JSON.parse(out.trim())
    const items: { name?: string; compat?: string; pnp?: string }[] = Array.isArray(parsed) ? parsed : [parsed]
    for (const it of items) {
      const name = String(it.name ?? '').trim()
      if (!name) continue
      const compat = String(it.compat ?? '').toLowerCase()
      const pnp = String(it.pnp ?? '').toUpperCase()
      const vendor = vendorOf(compat, pnp)
      if (vendor === 'other') {
        // 虚拟显示适配器 / Microsoft 基础渲染等：真实 GPU 之外一律忽略
        env.virtualAdapters.push(name)
        continue
      }
      env.gpus.push({ name, kind: vendor === 'intel' ? 'integrated' : 'discrete', vendor })
    }
    env.hasVirtual = env.virtualAdapters.length > 0
    if (env.hasVirtual) {
      console.warn(`[DeviceProbe] 忽略虚拟显示适配器（无真实编码器）: ${env.virtualAdapters.join('、')}`)
    }
  } catch {
    /* PowerShell 不可用/失败 → 空列表，选项仅按编码器探测出 */
  }
  return env
}

/** 取 GPU 环境（模块级缓存，运行期显卡列表不变）。 */
export function getGpuEnv(): GpuEnv {
  if (!_gpuEnv) _gpuEnv = enumerateGpus()
  return _gpuEnv
}

/** 探查全部导出设备选项（真实 GPU 列表 + 编码器可用性），供首选项页展示。 */
export async function probeExportDevices(): Promise<{ options: ExportDeviceOption[]; gpus: GpuInfo[]; virtualAdapters: string[] }> {
  const env = getGpuEnv()

  const [nvencOk, qsvOk, amfOk] = await Promise.all([
    probeHwEncoder('h264_nvenc'),
    probeHwEncoder('h264_qsv'),
    probeHwEncoder('h264_amf')
  ]).catch(() => [false, false, false] as [boolean, boolean, boolean])

  const discreteNames = env.gpus.filter((g) => g.kind === 'discrete').map((g) => g.name)
  const integNames = env.gpus.filter((g) => g.kind === 'integrated').map((g) => g.name)
  const virtualNote = env.hasVirtual
    ? ` 已忽略虚拟适配器：${env.virtualAdapters.join('、')}`
    : ''

  const options: ExportDeviceOption[] = [
    {
      id: 'auto',
      label: '自动（推荐）',
      available: true,
      detail: `由系统选择 GPU；编码器按 NVENC → AMF → Quick Sync → libx264 探测。${virtualNote}`
    },
    {
      id: 'discrete',
      label: '独立显卡（NVENC / AMF 硬件编码）',
      available: nvencOk || amfOk,
      detail: discreteNames.length
        ? `检测到：${discreteNames.join('、')}`
        : nvencOk || amfOk
          ? '硬件编码可用，但未枚举到独显名称'
          : '未检测到可用的独显编码器'
    },
    {
      id: 'integrated',
      label: '核显 / 集成显卡（Quick Sync 硬件编码）',
      available: qsvOk,
      detail: integNames.length
        ? `检测到：${integNames.join('、')}`
        : qsvOk
          ? 'QSV 可用，但未枚举到核显名称'
          : '未检测到可用的 QSV 编码器'
    },
    {
      id: 'software',
      label: '纯软件（libx264，兼容性最好）',
      available: true,
      detail: '不依赖 GPU，速度较慢'
    }
  ]

  return { options, gpus: env.gpus, virtualAdapters: env.virtualAdapters }
}
