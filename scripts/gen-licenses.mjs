/**
 * gen-licenses.mjs —— 生成第三方组件清单 `THIRD-PARTY-NOTICES.md`（仓库根 + resources/licenses/）。
 *
 * 运行：npm run licenses   （`npm run dist` 会自动先跑一次）
 *
 * 内容：
 *   1) 本项目的许可证（根 LICENSE）
 *   2) 非 npm 组件：随包分发的 ffmpeg/ffprobe（GPLv3，见 FFMPEG-NOTICE.txt）与 Electron/Chromium
 *   3) npm **生产依赖**（package-lock.json 里非 dev 的包 = 会被打进渲染层 bundle 的代码）
 *   4) 附录：各包自带 LICENSE 原文（按内容去重，保留各自版权行——MIT/ISC/BSD 都要求这么做）
 *
 * ⚠ 只覆盖 npm 与随包二进制；新增"非 npm 的随包组件"时，在这里的 EXTRA_COMPONENTS 里补一条。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources', 'licenses')
mkdirSync(outDir, { recursive: true })

/** 非 npm、但随安装包一起分发的组件 */
const EXTRA_COMPONENTS = [
  {
    name: 'FFmpeg / FFprobe',
    version: '8.0.1-essentials_build (gyan.dev)',
    license: 'GPL-3.0-or-later',
    note: '以独立进程调用（未链接）。许可证全文与源码获取方式见 FFMPEG-NOTICE.txt / GPL-3.0.txt'
  },
  {
    name: 'Electron（含 Chromium、Node.js、V8）',
    version: `electron ${depVersion('electron') ?? '?'}`,
    license: 'MIT（Chromium/Node 为 BSD-3-Clause 等，见随包文件）',
    note: '安装目录下 LICENSE.electron.txt 与 LICENSES.chromium.html'
  }
]

function depVersion(pkg) {
  try {
    return JSON.parse(readFileSync(join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version
  } catch {
    return null
  }
}

/** package-lock.json（v2/v3）里非 dev 的包 = 生产依赖（会被打进 bundle 的第三方代码） */
function productionPackages() {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  const out = []
  for (const [path, info] of Object.entries(lock.packages ?? {})) {
    if (!path) continue // 根包
    if (info.dev || info.link) continue
    if (path.includes('node_modules/@types/')) continue // 纯类型声明，不随包分发
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
    out.push({ name, version: info.version ?? '?', dir: join(root, path) })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

const LICENSE_FILE_RE = /^(LICEN[CS]E|COPYING|NOTICE)(\..*)?$/i

function licenseTextOf(dir) {
  let files = []
  try {
    files = readdirSync(dir).filter((f) => LICENSE_FILE_RE.test(f))
  } catch {
    return null
  }
  for (const f of files.sort()) {
    const p = join(dir, f)
    try {
      if (statSync(p).isFile() && statSync(p).size < 200 * 1024) {
        return { file: f, text: readFileSync(p, 'utf8').trim() }
      }
    } catch { /* 跳过 */ }
  }
  return null
}

function declaredLicense(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const l = pkg.license ?? pkg.licenses
    if (typeof l === 'string') return l
    if (Array.isArray(l)) return l.map((x) => x.type ?? x).join(' OR ')
    if (l && typeof l === 'object') return String(l.type ?? '?')
    return '?'
  } catch {
    return '?'
  }
}

/** 作者字段（合成许可证文本时的版权行用） */
function authorOf(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const a = pkg.author
    if (typeof a === 'string') return a.replace(/\s*<[^>]*>/, '').replace(/\s*\([^)]*\)/, '').trim()
    if (a && typeof a === 'object' && typeof a.name === 'string') return a.name
    return ''
  } catch {
    return ''
  }
}

/**
 * 有些包声明了 MIT/ISC 却没随包放 LICENSE（npm 允许）——按声明与作者字段补一份标准文本，
 * 并在附录里标注来源，避免"清单里有它、原文里没有"。
 */
function synthesizeLicense(dir, license) {
  const id = license.toUpperCase()
  const who = authorOf(dir) || 'the package authors'
  const year = new Date().getFullYear()
  if (id === 'MIT') {
    return {
      file: '(根据 package.json 的 license/author 字段合成)',
      text: `MIT License\n\nCopyright (c) ${year} ${who}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.`
    }
  }
  if (id === 'ISC') {
    return {
      file: '(根据 package.json 的 license/author 字段合成)',
      text: `ISC License\n\nCopyright (c) ${year} ${who}\n\nPermission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted, provided that the above\ncopyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH\nREGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY\nAND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,\nINDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM\nLOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR\nOTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR\nPERFORMANCE OF THIS SOFTWARE.`
    }
  }
  return null
}

const projectLicense = readFileSync(join(root, 'LICENSE'), 'utf8').trim()
copyFileSync(join(root, 'LICENSE'), join(outDir, 'LICENSE'))

/** 本项目自身信息（写在清单开头：AGPL 分发时需要版权声明 + 源码获取方式） */
const SELF = {
  name: 'AudioVizNext',
  copyright: 'Copyright (c) 2026 CyberryRe',
  license: 'AGPL-3.0-or-later',
  source: 'https://github.com/CyberryRe/AudioVizNext'
}

const pkgs = productionPackages()
const rows = []
const appendix = []
const seen = new Set()
for (const p of pkgs) {
  const lic = declaredLicense(p.dir)
  const own = licenseTextOf(p.dir)
  const text = own ?? synthesizeLicense(p.dir, lic)
  rows.push({ name: p.name, version: p.version, license: lic, hasText: !!text, synthesized: !own && !!text })
  if (text && !seen.has(text.text)) {
    seen.add(text.text)
    appendix.push({ holder: `${p.name}@${p.version}（${lic}）`, file: text.file, text: text.text })
  }
}
const missing = rows.filter((r) => !r.hasText).map((r) => r.name)

const totalBytes = rows.length
let md = `# Third-Party Notices / 第三方组件许可

**${SELF.name}** — ${SELF.copyright}
本项目以 **${SELF.license}** 发布（GNU Affero General Public License v3.0 或更高版本），
许可证全文见 [LICENSE](LICENSE)；对应源码：${SELF.source}

> **再分发/修改时必须遵守 AGPL-3.0**：修改后分发（含通过网络提供服务，§13）必须以同一许可证
> 提供**完整对应源码**，并保留本版权声明与许可证文本。项目名称与图标不随许可证授权（保留商标权）。
> 商业闭源授权需另行联系作者。
>
> 本文件由 \`npm run licenses\` 自动生成（脚本：\`scripts/gen-licenses.mjs\`），
> 同时存在于**仓库根**与**安装包的 \`resources/licenses/\`**（应用内：首选项 → 关于 → 开源许可）。
> 修改依赖后请重新生成并提交。

## 1. 随包分发的非 npm 组件

下面这些不是 npm 依赖，但会随安装包一起分发（各自版权归其作者）：

| 组件 | 版本 | 许可证 | 说明 |
|---|---|---|---|
${EXTRA_COMPONENTS.map((c) => `| ${c.name} | ${c.version} | ${c.license} | ${c.note} |`).join('\n')}

## 2. npm 生产依赖（${totalBytes} 个）

这些包会被打包进渲染层 bundle（或随 node_modules 一起分发），是实际随程序分发的代码。
许可证均与本项目的 AGPL-3.0 兼容（MIT/ISC/BSD/MPL-2.0：MPL 部分仍按 MPL 分发其自身文件）。

| 包 | 版本 | 许可证 | 附带原文 |
|---|---|---|---|
${rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} | ${r.hasText ? (r.synthesized ? '✓*' : '✓') : '—'} |`).join('\n')}

> \`✓*\` = 该包未随包提供 LICENSE 文件，原文按其 \`license\`/\`author\` 字段合成（见附录）。

## 3. 许可证原文

按内容去重后共 ${appendix.length} 份（MIT/ISC/BSD 等要求随分发保留各自的版权声明）。

${appendix.map((a, i) => `### 3.${i + 1} ${a.holder}\n\n\`\`\`\n${a.text}\n\`\`\`\n`).join('\n')}
`

writeFileSync(join(outDir, 'THIRD-PARTY-NOTICES.md'), md, 'utf8')
writeFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), md, 'utf8')

console.log(`[licenses] 生产依赖 ${rows.length} 个；许可证原文 ${appendix.length} 份（其中合成 ${rows.filter((r) => r.synthesized).length} 份）`)
console.log(`[licenses] 写入：THIRD-PARTY-NOTICES.md（根 + resources/licenses/）、resources/licenses/LICENSE`)
if (missing.length) console.log(`[licenses] 注意：以下包既无原文也无法合成，仅有声明字段：${missing.join(', ')}`)
