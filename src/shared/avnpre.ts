/**
 * shared/avnpre.ts —— `.avnpre` 预设包格式：设计、编码、解码。
 *
 * 格式（UTF-8 JSON，扩展名 `.avnpre`）：
 * ```jsonc
 * {
 *   "format": "avnpre",          // 魔数（必填，用于识别）
 *   "version": 1,                 // 格式版本
 *   "createdBy": "AudioVizNext",  // 可选来源标记
 *   "createdAt": "2026-09-08T…",  // 可选时间
 *   "preset": { …PresetMeta… },   // 预设声明（元数据 + 参数 schema + drawer id）
 *   "assets": [                   // 可选：随包携带的图片资源（base64）
 *     { "key": "border", "name": "border.png", "mime": "image/png", "data": "<base64>" }
 *   ]
 * }
 * ```
 *
 * 安全设计：`.avnpre` **只携带声明、参数与资源，绝不携带可执行代码**。
 * 绘制逻辑一律由内置 drawer（`presets/drawers/*`）提供；`preset.drawer` 必须是已知 id，
 * 否则导入被拒绝。因此导入第三方预设包不会引入任意代码执行。
 *
 * 本模块不依赖 DOM/Node，主进程与渲染进程共用（主进程用它做导入校验）。
 */

export const AVNPRE_FORMAT = 'avnpre'
export const AVNPRE_VERSION = 1
/** 单包资源总大小上限（解码后字节数），防 zip-bomb/超大文件 */
export const AVNPRE_MAX_ASSET_BYTES = 8 * 1024 * 1024

/** 内置 drawer 白名单（与 presets/registry.ts 的 DRAWERS 对应；这里是导入侧的防御性校验） */
export const KNOWN_DRAWERS = ['image-shape', 'particle-waveform', 'gaussian-blur', 'spectrum-bars', 'radial-bars'] as const

/** 单份脚本实现的大小上限（字符数），防超大/混淆载荷 */
export const AVNPRE_MAX_SCRIPT_CHARS = 256 * 1024

export interface AvnpreAsset {
  key: string
  name: string
  mime: string
  /** base64（不含 data: 前缀） */
  data: string
}

/**
 * 预设的**实现**。两种：
 *  - `{ type:'builtin', drawer:'particle-waveform' }`：引用内置绘制器（安全默认，无代码）；
 *  - `{ type:'script', source:'…js…' }`：随包携带的 JS 源码，导入后由 registry.compileScript 编译执行。
 *    ⚠ 脚本以渲染进程权限运行（同 VS Code 扩展信任模型）→ 导入时必须用户确认。
 */
export type AvnpreImplementation =
  | { type: 'builtin'; drawer: string }
  | { type: 'script'; source: string; language?: 'js' }

export interface AvnprePresetDecl {
  id: string
  name: string
  category?: string
  clipType?: string
  kind?: string
  /** 内置绘制器 id（implementation.type==='builtin' 时用；兼容旧字段） */
  drawer?: string
  durationFrames?: number
  color?: string
  desc?: string
  adjust?: boolean
  params: unknown[]
  assets?: { key: string; path: string; mime: string }[]
  /** 实现（优先于 drawer 字段） */
  implementation?: AvnpreImplementation
}

export interface AvnpreFile {
  format: string
  version: number
  createdBy?: string
  createdAt?: string
  preset: AvnprePresetDecl
  assets?: AvnpreAsset[]
}

export type AvnpreDecodeResult =
  | { ok: true; preset: AvnprePresetDecl; assets: { key: string; name: string; mime: string; bytes: Uint8Array }[] }
  | { ok: false; error: string }

/** 编码为 `.avnpre` 文本（导入端的对称实现，供"导出预设"使用）。 */
export function encodeAvnpre(
  preset: AvnprePresetDecl,
  assets: { key: string; name: string; mime: string; bytes: Uint8Array }[] = []
): string {
  const file: AvnpreFile = {
    format: AVNPRE_FORMAT,
    version: AVNPRE_VERSION,
    createdBy: 'AudioVizNext',
    createdAt: new Date().toISOString(),
    preset,
    assets: assets.map((a) => ({ key: a.key, name: a.name, mime: a.mime, data: bytesToBase64(a.bytes) }))
  }
  return JSON.stringify(file, null, 2)
}

/** 解码 + 严格校验 `.avnpre` 文本。任何非法输入都返回 { ok:false, error }，绝不抛。 */
export function decodeAvnpre(text: string): AvnpreDecodeResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `不是合法的 JSON：${(e as Error)?.message ?? e}` }
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: '文件内容不是对象' }
  const f = raw as Partial<AvnpreFile>
  if (f.format !== AVNPRE_FORMAT) return { ok: false, error: `不是 .avnpre 文件（format=${String(f.format)}）` }
  if (typeof f.version !== 'number' || f.version > AVNPRE_VERSION) {
    return { ok: false, error: `不支持的版本 ${String(f.version)}（本程序最高 ${AVNPRE_VERSION}）` }
  }
  const p = f.preset
  if (!p || typeof p !== 'object') return { ok: false, error: '缺少 preset' }
  if (typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(p.id)) {
    return { ok: false, error: 'preset.id 非法（仅允许字母数字-_，最长 64）' }
  }
  if (typeof p.name !== 'string' || !p.name.trim()) return { ok: false, error: '缺少 preset.name' }
  if (!Array.isArray(p.params)) return { ok: false, error: 'preset.params 必须是数组' }

  // —— 实现校验：内置 drawer 必须在白名单内；脚本实现有大小上限 ——
  const impl = p.implementation
  if (impl) {
    if (impl.type === 'builtin') {
      if (typeof impl.drawer !== 'string' || !(KNOWN_DRAWERS as readonly string[]).includes(impl.drawer)) {
        return { ok: false, error: `未知 drawer "${String(impl.drawer)}"（本程序仅支持：${KNOWN_DRAWERS.join('、')}）` }
      }
    } else if (impl.type === 'script') {
      if (typeof impl.source !== 'string' || !impl.source.trim()) return { ok: false, error: '脚本实现为空' }
      if (impl.source.length > AVNPRE_MAX_SCRIPT_CHARS) {
        return { ok: false, error: `脚本过大（>${(AVNPRE_MAX_SCRIPT_CHARS / 1024).toFixed(0)}KB）` }
      }
      if (impl.language && impl.language !== 'js') return { ok: false, error: `不支持的脚本语言 "${impl.language}"` }
    } else {
      return { ok: false, error: 'implementation.type 必须是 builtin 或 script' }
    }
  } else if (typeof p.drawer !== 'string' || !(KNOWN_DRAWERS as readonly string[]).includes(p.drawer)) {
    return { ok: false, error: `缺少实现（drawer 或 implementation），或 drawer "${String(p.drawer)}" 未知` }
  }

  for (const item of p.params) {
    const q = item as { key?: unknown; type?: unknown }
    if (!q || typeof q.key !== 'string' || typeof q.type !== 'string') {
      return { ok: false, error: 'preset.params 每项必须有 key 与 type' }
    }
    if (!['number', 'color', 'bool', 'select', 'image', 'gradient'].includes(q.type)) {
      return { ok: false, error: `不支持的参数类型 "${q.type}"` }
    }
  }

  const out: { key: string; name: string; mime: string; bytes: Uint8Array }[] = []
  let total = 0
  for (const a of f.assets ?? []) {
    if (!a || typeof a.key !== 'string' || typeof a.data !== 'string') {
      return { ok: false, error: 'assets 每项必须有 key 与 data' }
    }
    const bytes = base64ToBytes(a.data)
    if (!bytes) return { ok: false, error: `资源 "${a.key}" 的 base64 非法` }
    total += bytes.byteLength
    if (total > AVNPRE_MAX_ASSET_BYTES) {
      return { ok: false, error: `资源总大小超过上限 ${(AVNPRE_MAX_ASSET_BYTES / 1048576).toFixed(0)}MB` }
    }
    out.push({ key: a.key, name: typeof a.name === 'string' ? a.name : `${a.key}.bin`, mime: typeof a.mime === 'string' ? a.mime : 'application/octet-stream', bytes })
  }
  return { ok: true, preset: p, assets: out }
}

// ===== base64（不依赖 Buffer/atob，两端通用） =====

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? B64[b2 & 63] : '='
  }
  return out
}

export function base64ToBytes(s: string): Uint8Array | null {
  const clean = s.replace(/[\s]/g, '')
  if (clean.length % 4 !== 0) return null
  const out: number[] = []
  for (let i = 0; i < clean.length; i += 4) {
    const c = [0, 0, 0, 0].map((_, k) => {
      const ch = clean[i + k]
      if (ch === '=') return 0
      const v = B64.indexOf(ch)
      return v < 0 ? -1 : v
    })
    if (c.some((v) => v < 0)) return null
    out.push((c[0] << 2) | (c[1] >> 4))
    if (clean[i + 2] !== '=') out.push(((c[1] & 15) << 4) | (c[2] >> 2))
    if (clean[i + 3] !== '=') out.push(((c[2] & 3) << 6) | c[3])
  }
  return new Uint8Array(out)
}
