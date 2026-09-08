/**
 * presets.ts —— 主进程侧的用户预设管理（`.avnpre` 导入 / 列出）。
 *
 * 目录约定（与渲染层注册表对应）：
 *   <userData>/presets/<id>/preset.json     导入的预设声明
 *   <userData>/presets/<id>/assets/<name>   随包资源
 * 内置预设不走这里（它们随渲染层 bundle 打包，见 presets/registry.ts）。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { decodeAvnpre } from '../shared/avnpre'

export interface UserPresetMeta {
  format: 'avnpreset'
  version: number
  id: string
  name: string
  category: string
  clipType: string
  kind: string
  /** 内置绘制器 id（脚本实现时可为空串） */
  drawer: string
  /** 预设自带脚本源码（第三方预设的实现；导入时已获用户确认） */
  script?: string
  adjust?: boolean
  durationFrames: number
  color?: string
  desc?: string
  params: unknown[]
  assets?: { key: string; path: string; mime: string }[]
}

function presetsDir(): string {
  const dir = join(app.getPath('userData'), 'presets')
  try { mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
  return dir
}

/** 列出已导入的用户预设（读取每个目录的 preset.json；坏文件跳过）。 */
export function listUserPresets(): UserPresetMeta[] {
  const root = presetsDir()
  const out: UserPresetMeta[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return out
  }
  for (const name of dirs) {
    const file = join(root, name, 'preset.json')
    if (!existsSync(file)) continue
    try {
      const meta = JSON.parse(readFileSync(file, 'utf8')) as UserPresetMeta
      if (!meta || typeof meta.id !== 'string') continue
      // 资源路径补成绝对路径（渲染层转 avn-file:// 使用）
      meta.assets = (meta.assets ?? []).map((a) => ({ ...a, path: join(root, name, a.path) }))
      out.push(meta)
    } catch (e) {
      console.warn('[Preset] 读取失败:', file, (e as Error)?.message)
    }
  }
  return out
}

/** 只解码、不安装：供导入前弹「含脚本」确认框用。 */
export function inspectAvnpreFile(filePath: string): {
  ok: boolean
  error?: string
  id?: string
  name?: string
  impl?: 'builtin' | 'script'
  scriptChars?: number
} {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (e) {
    return { ok: false, error: `读取失败：${(e as Error)?.message ?? e}` }
  }
  const dec = decodeAvnpre(text)
  if (!dec.ok) return { ok: false, error: dec.error }
  const impl = dec.preset.implementation
  return {
    ok: true,
    id: dec.preset.id,
    name: dec.preset.name,
    impl: impl?.type === 'script' ? 'script' : 'builtin',
    scriptChars: impl?.type === 'script' ? impl.source.length : 0
  }
}

/** 导入一个 `.avnpre` 文件：解码校验 → 安装到 userData → 返回安装后的元数据。 */
export function importAvnpreFile(filePath: string): { ok: boolean; meta?: UserPresetMeta; error?: string } {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (e) {
    return { ok: false, error: `读取失败：${(e as Error)?.message ?? e}` }
  }
  const dec = decodeAvnpre(text)
  if (!dec.ok) return { ok: false, error: dec.error }

  const impl = dec.preset.implementation
  const root = presetsDir()
  const dir = join(root, dec.preset.id)
  try {
    mkdirSync(join(dir, 'assets'), { recursive: true })
    // 资源先落盘，再写 preset.json（声明里记相对路径）
    const assetDecls: { key: string; path: string; mime: string }[] = []
    for (const a of dec.assets) {
      const safe = a.name.replace(/[^\w.-]+/g, '_') || `${a.key}.bin`
      writeFileSync(join(dir, 'assets', safe), a.bytes)
      assetDecls.push({ key: a.key, path: `assets/${safe}`, mime: a.mime })
    }
    const meta: UserPresetMeta = {
      format: 'avnpreset',
      version: 1,
      id: dec.preset.id,
      name: dec.preset.name,
      category: dec.preset.category === 'visualization' ? 'visualization' : dec.preset.category === 'effect' ? 'effect' : 'image',
      clipType: dec.preset.clipType === 'visual' ? 'visual' : dec.preset.clipType === 'effect' ? 'effect' : 'image',
      kind: dec.preset.kind === 'visual' ? 'visual' : 'image',
      drawer: impl?.type === 'builtin' ? impl.drawer : (dec.preset.drawer ?? ''),
      script: impl?.type === 'script' ? impl.source : undefined,
      adjust: dec.preset.adjust === true,
      durationFrames: typeof dec.preset.durationFrames === 'number' && dec.preset.durationFrames > 0 ? dec.preset.durationFrames : 150,
      color: dec.preset.color,
      desc: dec.preset.desc,
      params: dec.preset.params,
      assets: assetDecls
    }
    writeFileSync(join(dir, 'preset.json'), JSON.stringify(meta, null, 2), 'utf8')
    return { ok: true, meta: { ...meta, assets: assetDecls.map((a) => ({ ...a, path: join(dir, a.path) })) } }
  } catch (e) {
    return { ok: false, error: `安装失败：${(e as Error)?.message ?? e}` }
  }
}
