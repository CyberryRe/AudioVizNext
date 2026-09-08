/// <reference types="vite/client" />
/**
 * presets/registry.ts —— 预设注册表（内置 + 用户导入）与**实现解析**。
 *
 * 预设的"实现"有两条来源，统一成同一个 `PresetDrawer` 供预览/导出调用：
 *   1) `drawer`：内置绘制器 id（`presets/drawers/*.ts`，随 app 编译）——内置预设用；
 *   2) `script`：**预设包自带的 JS 源码**（`.avnpre` 的 `implementation.source`，或目录里的
 *      `render.js`）——第三方预设用它携带自己的实现，导入后由 `compileScript` 编译并缓存。
 *
 * ⚠ 安全模型：`script` 以**渲染进程权限**运行（同 VS Code 扩展的信任模型），因此：
 *   - 导入时主进程会弹确认框；用户明确同意才安装；
 *   - 脚本只能拿到受控的 `(ctx, env, params, meta, api)`，其中 api 是白名单工具函数；
 *   - 不提供任何文件/网络/preload 能力（脚本若自己想办法绕，等于用户已同意运行未知代码）。
 *   数据驱动的预设（只带参数，引用内置 drawer）永远是安全默认。
 */
import type { EffectCategory, EffectTemplate } from '../model/demo'
import type { PresetDrawer, PresetMeta, PresetRenderEnv, PresetCtx, PresetParam } from './types'
import { defaultParams } from './types'
import { drawImageShape } from './drawers/imageShape'
import { drawParticleWaveform } from './drawers/particleWaveform'
import { drawGaussianBlur } from './drawers/gaussianBlur'
import { evaluateKeyframes, paramAt, setKeyframe, removeKeyframeNear } from './keyframes'
import { waveValue, freqValue, levelAt, onsetAt, isBeatFrame, birthFrameOf, WAVE_SAMPLES, FREQ_BINS } from '../media/audioAnalysis'
import * as DSP from '../media/audioAlgorithms'
import { mixColor } from '../model/timeline'

/** 内置绘制器表（数据驱动预设只能引用这里的 id） */
export const DRAWERS: Record<string, PresetDrawer> = {
  'image-shape': drawImageShape,
  'particle-waveform': drawParticleWaveform,
  'gaussian-blur': drawGaussianBlur
}

/** 暴露给第三方脚本的白名单 API（`api.xxx`） */
export const PRESET_SCRIPT_API = {
  // —— 关键帧 ——
  paramAt,
  evaluateKeyframes,
  setKeyframe,
  removeKeyframeNear,
  // —— 帧对齐取样（逐帧分析数据）——
  waveValue,
  freqValue,
  levelAt,
  onsetAt,
  isBeatFrame,
  birthFrameOf,
  WAVE_SAMPLES,
  FREQ_BINS,
  // —— 内置音频算法库（避免各样式重复造轮子）——
  dsp: DSP,
  // —— 颜色/数值工具 ——
  mixColor,
  /** 数值夹取 */
  clamp: (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v)),
  lerp: (a: number, b: number, t: number): number => a + (b - a) * t,
  /** 确定性 hash（同一 n 在任何环境给出同一 [0,1)） */
  hash: (n: number): number => {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
    return x - Math.floor(x)
  },
  /** #rrggbb → rgba() 字符串 */
  hexWithAlpha: (hex: string, a: number): string => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
    if (!m) return hex
    const n = parseInt(m[1], 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, a))})`
  }
} as const

export type PresetScriptApi = typeof PRESET_SCRIPT_API

// 内置预设：构建时静态收集仓库根 presets/ 下所有 preset.json
const builtinModules = import.meta.glob('../../../../presets/**/preset.json', { eager: true }) as Record<
  string,
  { default?: PresetMeta } | PresetMeta
>

const registry = new Map<string, PresetMeta>()
/** 脚本实现编译缓存：id → drawer（源变了会重建） */
const scriptCache = new Map<string, { src: string; drawer: PresetDrawer | null; error?: string }>()

function normalizeMeta(raw: unknown, source: 'builtin' | 'user'): PresetMeta | null {
  const m = raw as PresetMeta | undefined
  if (!m || typeof m !== 'object') return null
  if (m.format !== 'avnpreset' || typeof m.id !== 'string' || !m.id) return null
  if (typeof m.name !== 'string' || !Array.isArray(m.params)) return null
  const hasDrawer = typeof m.drawer === 'string' && !!DRAWERS[m.drawer]
  const hasScript = typeof (m as { script?: unknown }).script === 'string' && !!(m as { script?: string }).script
  if (!hasDrawer && !hasScript) {
    console.warn(`[Preset] ${m.id} 既无可用 drawer 也无 script → 跳过`)
    return null
  }
  const cat = m.category === 'visualization' ? 'visualization' : m.category === 'effect' ? 'effect' : 'image'
  const ct = m.clipType === 'visual' ? 'visual' : m.clipType === 'effect' ? 'effect' : 'image'
  return {
    ...m,
    version: typeof m.version === 'number' ? m.version : 1,
    category: cat,
    clipType: ct,
    kind: m.kind === 'visual' ? 'visual' : 'image',
    durationFrames: typeof m.durationFrames === 'number' && m.durationFrames > 0 ? m.durationFrames : 150,
    params: m.params as PresetParam[],
    source
  }
}

/** 编译预设自带脚本 → drawer。失败返回 null（并记录原因，不影响其他预设）。 */
export function compileScript(meta: PresetMeta): PresetDrawer | null {
  const src = (meta as { script?: string }).script
  if (!src) return null
  const hit = scriptCache.get(meta.id)
  if (hit && hit.src === src) return hit.drawer
  try {
    // 脚本体即绘制体，作用域内提供 ctx/env/params/meta/api
    const fn = new Function(
      'ctx', 'env', 'params', 'meta', 'api',
      `"use strict";\n${src}\n`
    ) as (ctx: PresetCtx, env: PresetRenderEnv, params: Record<string, unknown>, meta: PresetMeta, api: PresetScriptApi) => void
    const drawer: PresetDrawer = (ctx, env, params, m) => fn(ctx, env, params, m, PRESET_SCRIPT_API)
    scriptCache.set(meta.id, { src, drawer })
    console.log(`[Preset] 脚本实现已编译：${meta.id}`)
    return drawer
  } catch (e) {
    const error = String((e as Error)?.message ?? e)
    scriptCache.set(meta.id, { src, drawer: null, error })
    console.warn(`[Preset] 脚本编译失败 ${meta.id}: ${error}`)
    return null
  }
}

/** 取某预设的实现（脚本优先，其次内置 drawer）。 */
export function drawerFor(meta: PresetMeta | undefined): PresetDrawer | null {
  if (!meta) return null
  const script = compileScript(meta)
  if (script) return script
  return DRAWERS[meta.drawer] ?? null
}

/** 载入内置预设（幂等）。**模块加载即执行**——Worker 里也直接用 getPreset/drawPreset，不能依赖 App 调用初始化。 */
function loadBuiltins(): void {
  for (const [path, mod] of Object.entries(builtinModules)) {
    const raw = (mod as { default?: unknown }).default ?? mod
    const meta = normalizeMeta(raw, 'builtin')
    if (meta) registry.set(meta.id, meta)
    else console.warn('[Preset] 内置预设无效:', path)
  }
}

loadBuiltins()

/** 载入/刷新用户预设（来自 userData，主进程提供）。 */
export async function refreshUserPresets(): Promise<void> {
  for (const [id, m] of Array.from(registry)) if (m.source === 'user') registry.delete(id)
  if (typeof window === 'undefined' || typeof window.api?.presetList !== 'function') return
  try {
    const list = await window.api.presetList()
    for (const raw of list) {
      const meta = normalizeMeta(raw, 'user')
      if (meta) registry.set(meta.id, meta)
    }
  } catch (e) {
    console.warn('[Preset] 读取用户预设失败:', (e as Error)?.message)
  }
}

/** 初始化（App 启动时调一次）。 */
export async function initPresetRegistry(): Promise<PresetMeta[]> {
  loadBuiltins()
  await refreshUserPresets()
  return listPresets()
}

export function listPresets(): PresetMeta[] {
  return Array.from(registry.values())
}

export function getPreset(id: string | undefined): PresetMeta | undefined {
  return id ? registry.get(id) : undefined
}

export function presetOrDefaultParams(meta: PresetMeta, params: Record<string, unknown> | undefined): Record<string, unknown> {
  return { ...defaultParams(meta), ...(params ?? {}) }
}

/** 用预设的实现绘制一层（预览与导出共用）。 */
export function drawPreset(
  ctx: PresetCtx,
  meta: PresetMeta,
  env: PresetRenderEnv,
  params: Record<string, unknown> | undefined
): void {
  const drawer = drawerFor(meta)
  if (!drawer) return
  drawer(ctx, env, presetOrDefaultParams(meta, params), meta)
}

/** 由预设生成「效果面板」的分类结构（与基础素材模板合并，见 App.tsx）。 */
export function presetCategories(): EffectCategory[] {
  const cats: EffectCategory[] = [
    { id: 'visualization', name: '可视化', icon: '◎', items: [] },
    { id: 'image-style', name: '图片样式', icon: '▧', items: [] },
    { id: 'effect', name: '效果', icon: '✦', items: [] }
  ]
  for (const meta of listPresets()) {
    const catId = meta.category === 'visualization' ? 'visualization' : meta.category === 'effect' ? 'effect' : 'image-style'
    const cat = cats.find((c) => c.id === catId) ?? cats[1]
    cat.items.push({
      id: `preset:${meta.id}`,
      name: meta.name,
      kind: meta.kind,
      clipType: meta.clipType,
      durationFrames: meta.durationFrames,
      color: meta.color,
      desc: meta.desc,
      presetId: meta.id
    } as EffectTemplate & { presetId: string })
  }
  return cats.filter((c) => c.items.length > 0)
}
