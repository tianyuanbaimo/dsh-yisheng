// 生成 DSH 插件市场索引（format 1）。
// 用法：
//   node scripts/make-index.mjs --git <40 位 sha>
//   node scripts/make-index.mjs --npm            # 发到 npm 之后
//   node scripts/make-index.mjs --timestamp 1760000000
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}

const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const repoUrl = (pkg.repository && pkg.repository.url ? pkg.repository.url : pkg.homepage || '')
  .replace(/\.git$/, '')
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repoUrl)) {
  throw new Error(`repository.url 不是 https://github.com/owner/repo：${repoUrl}`)
}

const gitSha = flag('git', '')
const useNpm = args.includes('--npm')
if (!useNpm && !/^[0-9a-f]{40}$/.test(gitSha)) {
  throw new Error('git 源需要 --git <40 位小写 sha>')
}
const timestamp = Number(flag('timestamp', String(Math.floor(Date.now() / 1000))))

const source = useNpm
  ? { type: 'npm' }
  : { type: 'git', url: repoUrl, commit: gitSha }

const index = {
  format: 1,
  title: {
    en: 'Personal memory & persona',
    zh: '长期记忆与人格',
  },
  description: {
    en: 'Plugins that give a DSH agent durable memory and a written persona across restarts.',
    zh: '给 DSH 智能体可跨重启的长期记忆与可改写人格的插件。',
  },
  metadata: {
    categories: {
      memory: { title: { en: 'Memory & persona', zh: '记忆与人格' } },
    },
    labels: {
      'local-first': { title: { en: 'Local-first data', zh: '数据本地' } },
      'zero-dependency': { title: { en: 'Zero dependency', zh: '零依赖' } },
    },
    sortKeys: {
      stars: { title: { en: 'Stars', zh: '星标' }, order: 'desc' },
    },
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'dsh-yisheng — memory & persona', zh: 'dsh-yisheng · 记忆与人格' },
      description: {
        en: 'Summary cards + detail shards, five-layer writes, three-way injection with a 2000-char budget, per-owner isolation, 90-day soft forgetting, and 32K-token rebirth into a new session. Zero runtime dependencies.',
        zh: '摘要卡＋细节外挂、五层写入、三路注入（2000 字预算）、归属隔离、90 天软遗忘、32K 转生开新会话。运行时零依赖。',
      },
      icon: './icon.svg',
      author: pkg.author || 'Bai Yuan',
      homepage: pkg.homepage || repoUrl,
      repository: { url: repoUrl },
      metadata: {
        category: 'memory',
        keywords: ['memory', 'persona', 'long-term', 'context', 'rebirth'],
        labels: ['local-first', 'zero-dependency'],
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: timestamp,
          source,
          engines: { dsh: (pkg.dsh && pkg.dsh.compatibility && pkg.dsh.compatibility.dshReleases) || '>=0.2.0' },
        },
      ],
    },
  ],
}

const out = path.join(root, 'market', 'index.json')
await fs.mkdir(path.dirname(out), { recursive: true })
await fs.writeFile(out, JSON.stringify(index, null, 2) + '\n', 'utf8')
console.log(`wrote ${out}`)
console.log(`  ${pkg.name}@${pkg.version}  source=${source.type}  ${source.type === 'git' ? source.commit : ''}`)
