// deviceProbe.ts —— 运行时探查导出设备：枚举本机 GPU（友好名称）+ 探测可用硬件编码器。

import { execFileSync } from 'child_process'
import { probeHwEncoder } from './export'

export interface ExportDeviceOption {
  id: 'auto' | 'discrete' | 'integrated' | 'software'
  label: string
  available: boolean
  detail?: string
}

export interface GpuInfo {
  name: string
  kind: 'discrete' | 'integrated'
}

/** 用 PowerShell 枚举视频控制器（Win32_VideoController，含友好名称与厂商）。 */
function listGpus(): GpuInfo[] {
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
    const outList: GpuInfo[] = []
    for (const it of items) {
      const name = String(it.name ?? '').trim()
      if (!name) continue
      const compat = String(it.compat ?? '').toLowerCase()
      const pnp = String(it.pnp ?? '').toUpperCase()
      const isIntel = compat.includes('intel') || pnp.includes('VEN_8086')
      // NVIDIA/AMD/其余厂商 → 视为独显；Intel → 核显（笔记本混合模式的主流形态）
      outList.push({ name, kind: isIntel ? 'integrated' : 'discrete' })
    }
    return outList
  } catch {
    return []
  }
}

/** 探查全部导出设备选项（GPU 列表 + 编码器可用性），供首选项页展示。 */
export async function probeExportDevices(): Promise<{ options: ExportDeviceOption[]; gpus: GpuInfo[] }> {
  const gpus = listGpus()

  const [nvencOk, qsvOk, amfOk] = await Promise.all([
    probeHwEncoder('h264_nvenc'),
    probeHwEncoder('h264_qsv'),
    probeHwEncoder('h264_amf')
  ]).catch(() => [false, false, false] as [boolean, boolean, boolean])

  const discreteNames = gpus.filter((g) => g.kind === 'discrete').map((g) => g.name)
  const integNames = gpus.filter((g) => g.kind === 'integrated').map((g) => g.name)

  const options: ExportDeviceOption[] = [
    {
      id: 'auto',
      label: '自动（推荐）',
      available: true,
      detail: '由系统选择 GPU；编码器按 NVENC → AMF → Quick Sync → libx264 依次探测'
    },
    {
      id: 'discrete',
      label: '独立显卡（NVENC / AMF 硬件编码）',
      available: nvencOk || amfOk,
      detail: discreteNames.length
        ? `检测到：${discreteNames.join('、')}`
        : nvencOk || amfOk
          ? '未枚举到独显名称，但硬件编码可用'
          : '未检测到可用的独显编码器'
    },
    {
      id: 'integrated',
      label: '核显 / 集成显卡（Quick Sync 硬件编码）',
      available: qsvOk,
      detail: integNames.length
        ? `检测到：${integNames.join('、')}`
        : qsvOk
          ? '未枚举到核显名称，但 QSV 可用'
          : '未检测到可用的 QSV 编码器'
    },
    {
      id: 'software',
      label: '纯软件（libx264，兼容性最好）',
      available: true,
      detail: '不依赖 GPU，速度较慢'
    }
  ]

  return { options, gpus }
}
