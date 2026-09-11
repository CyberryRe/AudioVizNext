/**
 * dataDir.ts —— **可配置的数据目录**（userData）。
 *
 * userData 下面挂着这些东西，用户的磁盘占用大头都在这里：
 *   preferences.json   首选项
 *   presets/           导入的预设（.avnpre 装出来的）
 *   MediaCache/        视频代理缓存（可能几个 GB）
 *   logs/              崩溃/诊断日志
 *
 * 默认位置是 `%APPDATA%\<应用名>`；允许用户改到别的盘/目录（比如缓存想放 SSD、或 C 盘紧张）。
 * 解析优先级：
 *   ① 命令行 `--user-data-dir=<path>`（临时覆盖，便于测试/多开）
 *   ② `<出厂默认目录>/datadir.json` 里的 `userDataDir`（首选项对话框写）
 *   ③ 出厂默认
 *
 * ⚠ 必须在 **app ready 之前** 调用 `applyUserDataOverride()`：`app.setPath('userData', …)` 之后，
 *   所有 `app.getPath('userData')`（日志/缓存/预设/首选项）都会自动跟着走。
 */
import { app } from 'electron'
import { join, isAbsolute, resolve, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, cpSync, renameSync, statSync, unlinkSync } from 'fs'

/** 切换数据目录时"搬运"的条目（Chromium 自己的 profile 缓存不搬，重建即可） */
const MIGRATE_ITEMS = ['preferences.json', 'presets', 'MediaCache', 'logs'] as const

/** 迁移方式：不动 / 复制（两边都留） / 移动（旧的删掉） */
export type MigrateMode = 'none' | 'copy' | 'move'

export interface DataDirInfo {
  /** 当前进程实际使用的数据目录 */
  dir: string
  /** 出厂默认目录（"恢复默认"回到这里） */
  defaultDir: string
  /** 生效来源 */
  source: 'flag' | 'config' | 'default'
  /** 是否已偏离出厂默认 */
  overridden: boolean
  /** 出厂默认目录下的引导配置路径（datadir.json） */
  configPath: string
}

let state: DataDirInfo | null = null

function configPathIn(defaultDir: string): string {
  return join(defaultDir, 'datadir.json')
}

/** 出厂默认目录：不随 --user-data-dir 变化（否则"恢复默认"会回到被覆盖的位置） */
function factoryDefaultDir(): string {
  // ⚠ ready 之前 app.getPath('appData')/getName() 未必可用 → 退回环境变量与包名，
  //   否则这里会算成相对路径，datadir.json 就永远找不到（"改了目录没反应"）。
  let appData = ''
  try {
    appData = app.getPath('appData')
  } catch { /* ready 前可能不可用 */ }
  if (!appData || !isAbsolute(appData)) {
    appData = process.env.APPDATA || process.env.HOME || process.env.USERPROFILE || ''
  }
  let name = ''
  try {
    name = app.getName()
  } catch { /* ignore */ }
  if (!name) name = 'AudioVizNext'
  if (!appData || !isAbsolute(appData)) {
    // 实在拿不到 → 用 userData 的父目录（正常情况下就是 appData）
    try {
      return join(dirname(app.getPath('userData')), name)
    } catch {
      return join(process.cwd(), name)
    }
  }
  return join(appData, name)
}

/** 诊断落盘（仅当 AVS_DATADIR_DEBUG=1）：数据目录解析过程与结果 */
function debugLog(msg: string): void {
  if (process.env['AVS_DATADIR_DEBUG'] !== '1') return
  try {
    const p = join(process.env.TEMP || process.env.TMP || '.', 'avn-datadir-debug.txt')
    writeFileSync(p, `${new Date().toISOString()} ${msg}\n`, { flag: 'a' })
  } catch { /* ignore */ }
}

function readConfig(defaultDir: string): string | null {
  try {
    // ⚠ 去掉可能的 UTF-8 BOM：用户用记事本手改配置时会带上，JSON.parse 会直接失败 →
    //   表现为"改了目录没反应"，很难查。
    const raw = readFileSync(configPathIn(defaultDir), 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(raw) as { userDataDir?: unknown }
    const v = j?.userDataDir
    return typeof v === 'string' && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

/** 命令行 --user-data-dir=<path>（也支持 `--user-data-dir <path>`） */
function flagDir(): string | null {
  const argv = process.argv
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--user-data-dir=')) {
      const v = a.slice('--user-data-dir='.length).replace(/^"|"$/g, '')
      if (v) return v
    } else if (a === '--user-data-dir' && argv[i + 1]) {
      return argv[i + 1]
    }
  }
  return null
}

/** 目录可用性：能建出来、能写文件（不可用则回退默认，绝不把应用卡死） */
function ensureUsableDir(dir: string): { ok: boolean; dir: string; error?: string } {
  const abs = isAbsolute(dir) ? resolve(dir) : resolve(process.cwd(), dir)
  try {
    mkdirSync(abs, { recursive: true })
    const probe = join(abs, '.avn-write-test')
    writeFileSync(probe, 'ok', 'utf8')
    unlinkSync(probe)
    return { ok: true, dir: abs }
  } catch (e) {
    return { ok: false, dir: abs, error: (e as Error)?.message ?? String(e) }
  }
}

/**
 * 应用"数据目录覆盖"。**必须在 app ready 之前调用一次**。
 * 返回生效信息（也可之后用 getDataDirInfo() 取）。
 */
export function applyUserDataOverride(): DataDirInfo {
  const defaultDir = factoryDefaultDir()
  const baseline = app.getPath('userData')
  const flag = flagDir()
  const cfg = readConfig(defaultDir)
  const candidate = flag ?? cfg
  let dir = baseline
  let source: DataDirInfo['source'] = 'default'

  debugLog(`resolve: baseline=${baseline} default=${defaultDir} flag=${flag ?? '-'} config=${cfg ?? '-'} configFile=${configPathIn(defaultDir)}`)

  if (candidate) {
    const r = ensureUsableDir(candidate)
    if (r.ok) {
      dir = r.dir
      source = flag ? 'flag' : 'config'
    } else {
      console.warn(`[DataDir] 自定义数据目录不可用，回退默认：${candidate}（${r.error}）`)
      debugLog(`candidate unusable: ${candidate} → ${r.error}`)
    }
  } else if (baseline !== defaultDir) {
    // Chromium 自己处理了 --user-data-dir（Electron 版本差异）：视为 flag 覆盖
    dir = baseline
    source = 'flag'
  }

  if (dir !== baseline) {
    try {
      mkdirSync(dir, { recursive: true })
      app.setPath('userData', dir)
      // Chromium 的 profile/session 目录默认跟着 userData；一并显式设置，避免只搬了一半
      try {
        app.setPath('sessionData', dir)
      } catch { /* 某些版本没有 sessionData */ }
    } catch (e) {
      console.warn('[DataDir] setPath(userData) 失败，回退默认:', (e as Error)?.message)
      debugLog(`setPath failed: ${(e as Error)?.message}`)
      dir = baseline
      source = 'default'
    }
  }

  state = {
    dir: app.getPath('userData'),
    defaultDir,
    source,
    overridden: app.getPath('userData') !== defaultDir,
    configPath: configPathIn(defaultDir)
  }
  debugLog(`applied: dir=${state.dir} source=${state.source} overridden=${state.overridden}`)
  return state
}

/** 当前数据目录信息（未调用过 apply 时按默认算） */
export function getDataDirInfo(): DataDirInfo {
  if (state) return state
  const defaultDir = factoryDefaultDir()
  const dir = app.getPath('userData')
  const flag = flagDir()
  const cfg = readConfig(defaultDir)
  return {
    dir,
    defaultDir,
    source: flag ? 'flag' : cfg && resolve(cfg) === resolve(dir) ? 'config' : dir === defaultDir ? 'default' : 'config',
    overridden: dir !== defaultDir,
    configPath: configPathIn(defaultDir)
  }
}

/** 复制/移动一个条目（跨盘 rename 失败时自动退回"复制+删除"） */
function moveItem(from: string, to: string, mode: MigrateMode): string | null {
  if (mode === 'none') return null
  if (!existsSync(from)) return null
  try {
    if (mode === 'move') {
      try {
        renameSync(from, to)
      } catch {
        cpSync(from, to, { recursive: true, force: true })
        rmSync(from, { recursive: true, force: true })
      }
    } else {
      cpSync(from, to, { recursive: true, force: true })
    }
    return null
  } catch (e) {
    return `${from}：${(e as Error)?.message ?? e}`
  }
}

export interface SetDataDirResult {
  ok: boolean
  info: DataDirInfo
  /** 已搬运的条目名 */
  migrated: string[]
  /** 搬运失败的原因（逐条） */
  errors: string[]
  error?: string
}

/**
 * 设置数据目录（写引导配置，**重启后生效**）。
 * @param dir   目标目录；null = 恢复出厂默认
 * @param migrate 是否把当前数据搬过去（none/copy/move）
 */
export function setDataDir(dir: string | null, migrate: MigrateMode = 'none'): SetDataDirResult {
  const info = getDataDirInfo()
  const migrated: string[] = []
  const errors: string[] = []

  if (dir === null) {
    // 恢复默认：删掉引导配置即可（当前数据留在原处）
    try {
      if (existsSync(info.configPath)) rmSync(info.configPath, { force: true })
    } catch (e) {
      return { ok: false, info, migrated, errors, error: `清除配置失败：${(e as Error)?.message ?? e}` }
    }
    return { ok: true, info, migrated, errors }
  }

  const r = ensureUsableDir(dir)
  if (!r.ok) return { ok: false, info, migrated, errors, error: `目录不可用：${r.error}` }
  const target = r.dir
  if (resolve(target) === resolve(info.dir)) {
    return { ok: false, info, migrated, errors, error: '目标目录与当前数据目录相同' }
  }
  // 防呆：不要把数据目录设到当前目录的子目录里（会自己套自己）
  if (resolve(target).startsWith(resolve(info.dir) + '\\') || resolve(info.dir).startsWith(resolve(target) + '\\')) {
    return { ok: false, info, migrated, errors, error: '目标目录不能是当前数据目录的子目录/父目录' }
  }

  // 搬运（在写入配置之前做：搬完再切换，失败也能看到原因）
  for (const name of MIGRATE_ITEMS) {
    const from = join(info.dir, name)
    const to = join(target, name)
    const err = moveItem(from, to, migrate)
    if (err) errors.push(err)
    else if (migrate !== 'none' && existsSync(to)) migrated.push(name)
  }

  try {
    mkdirSync(info.defaultDir, { recursive: true })
    writeFileSync(info.configPath, JSON.stringify({ userDataDir: target }, null, 2), 'utf8')
  } catch (e) {
    return { ok: false, info, migrated, errors, error: `写入配置失败：${(e as Error)?.message ?? e}` }
  }
  return { ok: true, info, migrated, errors }
}

/** 递归统计目录占用（字节） */
function duSize(p: string): number {
  try {
    const st = statSync(p)
    if (!st.isDirectory()) return st.size
    let total = 0
    for (const name of readdirSync(p)) {
      total += duSize(join(p, name))
    }
    return total
  } catch {
    return 0
  }
}

/** 数据目录里各条目的占用（字节），供 UI 展示"这个目录有多大" */
export function dataDirSizes(): { name: string; bytes: number }[] {
  const root = getDataDirInfo().dir
  const out: { name: string; bytes: number }[] = []
  for (const name of MIGRATE_ITEMS) {
    const p = join(root, name)
    out.push({ name, bytes: existsSync(p) ? duSize(p) : 0 })
  }
  out.push({ name: '总计', bytes: out.reduce((s, x) => s + x.bytes, 0) })
  return out
}
