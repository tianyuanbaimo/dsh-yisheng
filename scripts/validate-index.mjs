// 按 format 1 的规则校验 market/index.json，规则抄自 @deepseek-ai/dsh-plugin-market-index。
// 用法：node scripts/validate-index.mjs [index.json]
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'market', 'index.json')
const indexUrl = 'https://raw.githubusercontent.com/tianyuanbaimo/dsh-yisheng/main/market/index.json'

const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const NUMERIC = '(?:0|[1-9]\\d*)'
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const SEMVER = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`, 'u')
const COMMIT = /^[0-9a-f]{40}$/u
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u

const problems = []
const fail = (at, why) => problems.push(`${at} ${why}`)
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

function text(v, at) {
  if (typeof v !== 'string' || v.trim() === '') return fail(at, 'must be a non-empty string')
  return v
}
function localized(v, at) {
  if (typeof v === 'string') return text(v, at)
  if (!isObject(v)) return fail(at, 'must be a string or a localized object')
  for (const [lang, member] of Object.entries(v)) {
    if (!LANGUAGE_ID.test(lang)) fail(`${at}.${lang}`, 'must be a lowercase language id')
    text(member, `${at}.${lang}`)
  }
  if (!Object.hasOwn(v, 'en')) fail(at, 'must contain en')
}
function httpUrl(v, at, protocols) {
  const s = text(v, at)
  if (typeof s !== 'string') return
  let url
  try { url = new URL(s) } catch { return fail(at, 'must be an absolute URL') }
  if (!protocols.includes(url.protocol)) fail(at, `must use ${protocols.join(' or ')}`)
  if (url.username || url.password) fail(at, 'must not contain credentials')
  return url
}
function declared(id, at, declaredIds) {
  text(id, at)
  if (!Object.hasOwn(declaredIds, id)) fail(at, `references undeclared id ${JSON.stringify(id)}`)
  return id
}

const raw = await fs.readFile(file, 'utf8')
const index = JSON.parse(raw)
const meta = isObject(index.metadata) ? index.metadata : {}
const categories = isObject(meta.categories) ? meta.categories : {}
const labels = isObject(meta.labels) ? meta.labels : {}
const sortKeys = isObject(meta.sortKeys) ? meta.sortKeys : {}
for (const [id] of Object.entries(categories)) localized(categories[id].title, `$.metadata.categories.${id}.title`)
for (const [id] of Object.entries(labels)) localized(labels[id].title, `$.metadata.labels.${id}.title`)
for (const [id, def] of Object.entries(sortKeys)) {
  localized(def.title, `$.metadata.sortKeys.${id}.title`)
  if (def.order !== 'asc' && def.order !== 'desc') fail(`$.metadata.sortKeys.${id}.order`, 'must be asc or desc')
}

if (index.format !== 1) fail('$.format', 'must be 1')
localized(index.title, '$.title')
if (Object.hasOwn(index, 'description')) localized(index.description, '$.description')
if (!Array.isArray(index.plugins) || index.plugins.length === 0) fail('$.plugins', 'must be a non-empty array')

const seenNames = new Set()
for (const [i, plugin] of (Array.isArray(index.plugins) ? index.plugins : []).entries()) {
  const at = `$.plugins[${i}]`
  if (!isObject(plugin)) { fail(at, 'must be an object'); continue }
  const name = text(plugin.name, `${at}.name`)
  if (typeof name === 'string') {
    if (name.length > 214 || !PACKAGE_NAME.test(name)) fail(`${at}.name`, 'must be a valid npm package name')
    if (seenNames.has(name)) fail(`${at}.name`, `duplicates ${name}`)
    seenNames.add(name)
  }
  if (Object.hasOwn(plugin, 'title')) localized(plugin.title, `${at}.title`)
  if (Object.hasOwn(plugin, 'description')) localized(plugin.description, `${at}.description`)
  if (Object.hasOwn(plugin, 'author')) text(plugin.author, `${at}.author`)
  if (Object.hasOwn(plugin, 'homepage')) httpUrl(plugin.homepage, `${at}.homepage`, ['https:', 'http:'])
  if (Object.hasOwn(plugin, 'repository')) {
    if (!isObject(plugin.repository)) fail(`${at}.repository`, 'must be an object')
    else {
      httpUrl(plugin.repository.url, `${at}.repository.url`, ['https:', 'http:'])
      if (Object.hasOwn(plugin.repository, 'directory')) {
        const d = text(plugin.repository.directory, `${at}.repository.directory`)
        if (typeof d === 'string' && d.split('/').some((s) => s === '.' || s === '..' || !PATH_SEGMENT.test(s))) {
          fail(`${at}.repository.directory`, 'must be a relative directory path')
        }
      }
    }
  }
  if (Object.hasOwn(plugin, 'icon')) {
    const icon = text(plugin.icon, `${at}.icon`)
    if (typeof icon === 'string' && !icon.startsWith('data:')) {
      let resolved
      try { resolved = new URL(icon, indexUrl) } catch { fail(`${at}.icon`, 'must be a URL reference') }
      if (resolved && resolved.protocol !== 'https:' && resolved.origin !== new URL(indexUrl).origin) {
        fail(`${at}.icon`, 'must resolve to https or the index origin')
      }
    }
  }
  const pm = isObject(plugin.metadata) ? plugin.metadata : {}
  if (Object.hasOwn(pm, 'category')) declared(pm.category, `${at}.metadata.category`, categories)
  for (const [j, label] of (Array.isArray(pm.labels) ? pm.labels : []).entries()) {
    declared(label, `${at}.metadata.labels[${j}]`, labels)
  }
  for (const [id] of Object.entries(isObject(pm.sortKeys) ? pm.sortKeys : {})) {
    declared(id, `${at}.metadata.sortKeys.${id}`, sortKeys)
  }
  if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) { fail(`${at}.versions`, 'must be a non-empty array'); continue }
  const seenVersions = new Set()
  for (const [j, version] of plugin.versions.entries()) {
    const vAt = `${at}.versions[${j}]`
    if (!isObject(version)) { fail(vAt, 'must be an object'); continue }
    const v = text(version.version, `${vAt}.version`)
    if (typeof v === 'string') {
      if (!SEMVER.test(v)) fail(`${vAt}.version`, 'must be an exact SemVer version')
      if (seenVersions.has(v)) fail(`${vAt}.version`, `duplicates ${v}`)
      seenVersions.add(v)
    }
    const ts = version.publishTimestamp
    if (!Number.isInteger(ts) || ts < 0 || ts >= 1e11) fail(`${vAt}.publishTimestamp`, 'must be integer Unix seconds in [0, 1e11)')
    const src = version.source
    if (!isObject(src)) { fail(`${vAt}.source`, 'must be an object'); continue }
    if (src.type === 'git') {
      const commit = text(src.commit, `${vAt}.source.commit`)
      if (typeof commit === 'string' && !COMMIT.test(commit)) fail(`${vAt}.source.commit`, 'must be a lowercase 40-hex commit')
      const url = httpUrl(src.url, `${vAt}.source.url`, ['https:'])
      if (url) {
        if (url.href !== src.url) fail(`${vAt}.source.url`, 'must be a canonical URL')
        if (!/^(?:\/[^/]+){2,}$/u.test(url.pathname)) fail(`${vAt}.source.url`, 'must name a repository')
        if (/\.(?:tgz|tar\.gz)$/iu.test(url.pathname)) fail(`${vAt}.source.url`, 'must not be a tarball')
      }
      if (Object.hasOwn(src, 'path')) {
        const p = text(src.path, `${vAt}.source.path`)
        if (typeof p === 'string' && p.split('/').some((s) => s === '.' || s === '..' || !PATH_SEGMENT.test(s))) {
          fail(`${vAt}.source.path`, 'must be a relative directory path')
        }
      }
    } else if (src.type === 'npm') {
      if (Object.hasOwn(src, 'registry')) httpUrl(src.registry, `${vAt}.source.registry`, ['https:', 'http:'])
    } else {
      fail(`${vAt}.source.type`, 'must be "npm" or "git"')
    }
    if (Object.hasOwn(version, 'engines')) {
      if (!isObject(version.engines)) fail(`${vAt}.engines`, 'must be an object')
      else if (Object.hasOwn(version.engines, 'dsh')) {
        const range = text(version.engines.dsh, `${vAt}.engines.dsh`)
        if (typeof range === 'string') {
          if (range.startsWith('workspace:')) fail(`${vAt}.engines.dsh`, 'must not be a workspace: range')
          else if (!/^[<>=^~|*\s\d.xX-]|^\d/.test(range)) fail(`${vAt}.engines.dsh`, 'must look like a SemVer range')
        }
      }
    }
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} 处不合规：`)
  for (const p of problems) console.error('  ' + p)
  process.exit(1)
}
console.log(`✓ ${path.basename(file)} 符合 format 1（${index.plugins.length} 个插件，${index.plugins.map((p) => p.name + '@' + p.versions.map((v) => v.version).join(',')).join('; ')}）`)
