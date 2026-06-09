import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const siteDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(siteDir, '..')
const buildRoot = path.join(siteDir, 'build')
const buildHelpDir = path.join(buildRoot, 'help')
const publishDir = path.join(repoRoot, 'frontend', 'public', 'help')

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function cleanDir(dir) {
  ensureDir(dir)
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true })
  }
}

function copyRecursive(src, dst) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    ensureDir(dst)
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dst, name))
    }
    return
  }
  ensureDir(path.dirname(dst))
  fs.copyFileSync(src, dst)
}

function ensureIndex(dir) {
  const indexPath = path.join(dir, 'index.html')
  const redirect = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="0; url=toc.html" />
  <title>SheetBot 用户手册</title>
</head>
<body>
  <p>正在跳转到用户手册首页...</p>
  <script>location.replace('toc.html');</script>
</body>
</html>
`
  fs.writeFileSync(indexPath, redirect, 'utf-8')
}

function createExtensionlessAliases(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stat = fs.statSync(full)
    if (!stat.isFile()) continue
    if (!entry.endsWith('.html')) continue
    if (entry === 'index.html') continue
    const aliasName = entry.slice(0, -'.html'.length)
    const aliasPath = path.join(dir, aliasName)
    const content = fs.readFileSync(full)
    fs.writeFileSync(aliasPath, content)
  }
}

function main() {
  if (!fs.existsSync(buildRoot)) {
    throw new Error(`构建目录不存在: ${buildRoot}`)
  }
  const sourceDir = fs.existsSync(buildHelpDir) ? buildHelpDir : buildRoot
  cleanDir(publishDir)
  for (const entry of fs.readdirSync(sourceDir)) {
    copyRecursive(path.join(sourceDir, entry), path.join(publishDir, entry))
  }
  ensureIndex(publishDir)
  createExtensionlessAliases(publishDir)
  console.log(`[PUBLISH] 已发布到 ${path.relative(repoRoot, publishDir)}`)
}

main()
