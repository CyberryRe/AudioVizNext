/**
 * dist-hash.mjs —— 安装包发布辅助：算 SHA256 + 生成 Release 说明。
 *
 * 运行：npm run dist:hash      （先跑 `npm run dist` 出安装包）
 *
 * 产出（都在 release/ 下）：
 *   SHA256SUMS.txt    sha256sum 兼容格式（<hash>  <文件名>），供用户校验下载完整性
 *   RELEASE-NOTES.md  由 .github/RELEASE-NOTES-TEMPLATE.md 填充版本/日期/哈希/文件大小
 *                     → 直接复制到 GitHub Release 说明里
 *
 * 为什么必须给哈希：安装包**未做代码签名**（见 electron-builder.yml 的签名说明），
 * Windows SmartScreen 会提示"未知发布者"，用户需要一个可自证完整性的手段。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(root, 'release')
if (!existsSync(releaseDir)) {
  console.error('[dist:hash] 没有 release/ 目录，先跑 `npm run dist`')
  process.exit(1)
}

const artifacts = readdirSync(releaseDir)
  .filter((f) => /\.(exe|zip|7z|msi|dmg|AppImage)$/i.test(f))
  .sort()
if (!artifacts.length) {
  console.error('[dist:hash] release/ 里没有安装包（.exe 等），先跑 `npm run dist`')
  process.exit(1)
}

const lines = []
const rows = []
for (const f of artifacts) {
  const p = join(releaseDir, f)
  const buf = readFileSync(p)
  const hash = createHash('sha256').update(buf).digest('hex')
  lines.push(`${hash}  ${f}`)
  rows.push({ file: f, hash, mb: (statSync(p).size / 1048576).toFixed(1) })
  console.log(`${f}\n  sha256: ${hash}\n  大小: ${rows[rows.length - 1].mb} MB`)
}
writeFileSync(join(releaseDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n', 'utf8')
console.log(`[dist:hash] 已写 release/SHA256SUMS.txt`)

const tplPath = join(root, '.github', 'RELEASE-NOTES-TEMPLATE.md')
if (existsSync(tplPath)) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const date = new Date().toISOString().slice(0, 10)
  let out = readFileSync(tplPath, 'utf8')
  out = out
    .replaceAll('{{VERSION}}', version)
    .replaceAll('{{DATE}}', date)
    .replaceAll('{{ARTIFACTS}}', rows.map((r) => `| ${r.file} | ${r.mb} MB | \`${r.hash}\` |`).join('\n'))
  writeFileSync(join(releaseDir, 'RELEASE-NOTES.md'), out, 'utf8')
  console.log('[dist:hash] 已写 release/RELEASE-NOTES.md（可直接贴到 GitHub Release）')
} else {
  console.log('[dist:hash] 未找到 .github/RELEASE-NOTES-TEMPLATE.md，跳过说明生成')
}
