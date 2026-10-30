// 用 GitHub REST 推一个目录，不需要本机装 git。
// 用法：
//   node scripts/push-github.mjs --dir . --repo tianyuanbaimo/dsh-yisheng --token-file .publish-tokens.json --message "..."
// 行为：保证仓库存在（不存在就建，public、MIT、开 issue）→ 逐个文件建 blob → 建 tree → 建 commit → 强推 main。
import { promises as fs } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}

const dir = path.resolve(arg('dir', '.'))
const repoArg = arg('repo', '')
const tokenFile = path.resolve(arg('token-file', '.publish-tokens.json'))
const message = arg('message', 'chore: publish')
const branch = arg('branch', 'main')
const description = arg('description', 'DSH 的长期记忆与人格插件：零依赖，数据在本地磁盘')

const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', 'data', 'snapshots', 'handoffs'])
const SKIP_FILES = new Set(['.publish-tokens.json', 'pnpm-lock.yaml', 'desktop.ini', 'Thumbs.db'])
const SKIP_EXT = new Set(['.log'])

let token = process.env.GITHUB_TOKEN || ''
if (!token) {
  const raw = JSON.parse(await fs.readFile(tokenFile, 'utf8'))
  token = raw.github || raw.GITHUB || raw.token || ''
}
if (!token) throw new Error('没有 GitHub token（--token-file 或 GITHUB_TOKEN）')

const api = async (method, url, body) => {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-yisheng-publisher',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  return { ok: res.ok, status: res.status, data }
}

async function walk(root, rel = '') {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      files.push(...await walk(root, relPath))
      continue
    }
    if (!entry.isFile()) continue
    if (SKIP_FILES.has(entry.name)) continue
    if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue
    files.push(relPath)
  }
  return files
}

const me = await api('GET', '/user')
if (!me.ok) throw new Error(`读账号失败：HTTP ${me.status} ${JSON.stringify(me.data)}`)
const owner = me.data.login
const [ownerArg, repoArgName] = repoArg.includes('/') ? repoArg.split('/') : [owner, repoArg]
const repo = `${ownerArg}/${repoArgName}`
console.log(`账号：${owner}  目标仓库：${repo}`)

const probe = await api('GET', `/repos/${repo}`)
if (probe.status === 404) {
  const created = await api('POST', '/user/repos', {
    name: repoArgName,
    description,
    private: false,
    has_issues: true,
    has_wiki: false,
    license_template: 'mit',
  })
  if (!created.ok) throw new Error(`建仓库失败：HTTP ${created.status} ${JSON.stringify(created.data)}`)
  console.log('已创建仓库：' + created.data.html_url)
} else if (!probe.ok) {
  throw new Error(`读仓库失败：HTTP ${probe.status} ${JSON.stringify(probe.data)}`)
} else {
  console.log('仓库已存在：' + probe.data.html_url)
}

const files = await walk(dir)
console.log(`待推送 ${files.length} 个文件`)

const blobs = []
for (const rel of files) {
  const buf = await fs.readFile(path.join(dir, rel))
  const res = await api('POST', `/repos/${repo}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' })
  if (!res.ok) throw new Error(`建 blob 失败 ${rel}：HTTP ${res.status} ${JSON.stringify(res.data)}`)
  blobs.push({ path: rel, mode: '100644', type: 'blob', sha: res.data.sha })
}

const ref = await api('GET', `/repos/${repo}/git/ref/heads/${branch}`)
let parents = []
let baseTree
if (ref.ok) {
  const commit = await api('GET', `/repos/${repo}/git/commits/${ref.data.object.sha}`)
  baseTree = commit.data.tree.sha
  parents = [ref.data.object.sha]
  console.log('基于现有提交：' + ref.data.object.sha.slice(0, 7))
} else if (ref.status !== 404) {
  throw new Error(`读 ref 失败：HTTP ${ref.status} ${JSON.stringify(ref.data)}`)
}

const tree = await api('POST', `/repos/${repo}/git/trees`, { ...(baseTree ? { base_tree: baseTree } : {}), tree: blobs })
if (!tree.ok) throw new Error(`建 tree 失败：HTTP ${tree.status} ${JSON.stringify(tree.data)}`)

const commit = await api('POST', `/repos/${repo}/git/commits`, { message, tree: tree.data.sha, parents })
if (!commit.ok) throw new Error(`建 commit 失败：HTTP ${commit.status} ${JSON.stringify(commit.data)}`)

if (parents.length) {
  const patched = await api('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.data.sha, force: true })
  if (!patched.ok) throw new Error(`更新 ref 失败：HTTP ${patched.status} ${JSON.stringify(patched.data)}`)
} else {
  const created = await api('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.data.sha })
  if (!created.ok) throw new Error(`创建 ref 失败：HTTP ${created.status} ${JSON.stringify(created.data)}`)
}

console.log('COMMIT=' + commit.data.sha)
console.log('URL=' + `https://github.com/${repo}`)
