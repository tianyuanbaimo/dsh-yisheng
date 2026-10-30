// GitHub OAuth 设备授权（不需要 git 二进制，也不需要在网页里复制 token）。
// 用法：node scripts/github-device-login.mjs --out .publish-tokens.json
// 流程：申请设备码 → 打印验证地址和一次性代码 → 轮询直到授权 → 把 token 写进 --out 指向的 JSON。
import { promises as fs } from 'node:fs'
import path from 'node:path'

// VS Code 的公开 OAuth 客户端：scope 为 repo 时会真的给出 repo 权限；
// GitHub CLI 的客户端用同一套设备流拿到的 token 是空权限，别换回去。
const CLIENT_ID = '01ab8ac9400c4e429b23'
const SCOPE = 'repo,read:user'
const args = process.argv.slice(2)
const outArg = args.indexOf('--out')
const out = path.resolve(outArg >= 0 ? args[outArg + 1] : '.publish-tokens.json')

const form = (body) => ({
  method: 'POST',
  headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
})

const start = await fetch('https://github.com/login/device/code', form({ client_id: CLIENT_ID, scope: SCOPE }))
if (!start.ok) throw new Error(`申请设备码失败：HTTP ${start.status} ${await start.text()}`)
const grant = await start.json()
if (!grant.device_code) throw new Error(`申请设备码失败：${JSON.stringify(grant)}`)

console.log('VERIFY_URL=' + grant.verification_uri)
console.log('USER_CODE=' + grant.user_code)
console.log(`（${grant.expires_in} 秒内有效，请在浏览器里打开上面地址并输入代码）`)

const deadline = Date.now() + Math.max(30, Number(grant.expires_in) || 900) * 1000
let interval = Math.max(5, Number(grant.interval) || 5) * 1000

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, interval))
  const poll = await fetch('https://github.com/login/oauth/access_token', form({
    client_id: CLIENT_ID,
    device_code: grant.device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  }))
  const body = await poll.json().catch(() => ({}))
  if (body.access_token) {
    await fs.writeFile(out, JSON.stringify({ github: body.access_token, scope: body.scope, created: new Date().toISOString() }, null, 2) + '\n', 'utf8')
    console.log('OK 已写入 ' + out)
    console.log('SCOPE=' + body.scope)
    process.exit(0)
  }
  if (body.error === 'authorization_pending') continue
  if (body.error === 'slow_down') { interval += 5000; continue }
  if (body.error === 'expired_token') throw new Error('设备码过期，请重跑一次')
  if (body.error === 'access_denied') throw new Error('授权被拒绝')
  throw new Error(`轮询失败：${JSON.stringify(body)}`)
}
throw new Error('超时，未完成授权')
