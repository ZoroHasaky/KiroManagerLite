// 提取本机 kiro-cli 已登录账号，输出可直接粘贴到本程序「输入 JSON 导入」的 JSON。
//
// kiro-cli 的凭证不在 Kiro IDE 的 ~/.aws/sso/cache 里，而是存在
//   %LOCALAPPDATA%\Kiro-Cli\data.sqlite3 的 auth_kv 表
// 两条记录：kirocli:odic:device-registration（clientId / clientSecret / region）
//          kirocli:odic:token（access / refresh token、过期时间）
//
// 只读这个库，不写、不刷新 kiro-cli 自己的凭证：AWS 的 refresh token 不会随刷新轮换，
// 所以这里换一次 access token 拉取邮箱与用量，不会把 kiro-cli 踢下线。
//
// 输出走本程序的精简 JSON 导入格式（email / refreshToken / clientId / clientSecret /
// provider / region），粘贴后由程序自己联网校验并补齐订阅、用量。
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DB_PATH = join(process.env.LOCALAPPDATA || '', 'Kiro-Cli', 'data.sqlite3')
const ORIGIN = 'https://app.kiro.dev'
const PORTAL = `${ORIGIN}/service/KiroWebPortalService/operation`
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function fail(message) {
  console.error(`\n[失败] ${message}\n`)
  process.exitCode = 1
}

/** 用 refresh token 换一个可用的 access token（不写回 kiro-cli） */
async function refreshAccessToken(reg, tok) {
  const res = await fetch(`https://oidc.${reg.region || 'us-east-1'}.amazonaws.com/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: reg.client_id,
      clientSecret: reg.client_secret,
      refreshToken: tok.refresh_token,
      grantType: 'refresh_token'
    })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.accessToken) {
    throw new Error(`刷新 Token 失败：HTTP ${res.status} ${data.error_description || data.error || ''}`.trim())
  }
  return data
}

/** 打开门户首页拿 CSRF token 与 UserId cookie，再用 CBOR 调一个操作 */
async function portalCall(accessToken, refreshToken, operation, body = {}) {
  const { encode, decode } = await import('cbor-x')
  const authCookie = `Idp=BuilderId; AccessToken=${accessToken}; RefreshToken=${refreshToken}`
  const home = await fetch(ORIGIN, {
    headers: { accept: 'text/html', 'user-agent': CHROME_UA, cookie: authCookie }
  })
  const html = await home.text()
  const csrf = html.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1]
  const userId = home.headers.getSetCookie().find((c) => c.startsWith('UserId='))?.split(';')[0]
  if (!csrf || !userId) throw new Error('门户没有下发 CSRF token / UserId，凭证可能已失效')

  const res = await fetch(`${PORTAL}/${operation}`, {
    method: 'POST',
    headers: {
      accept: 'application/cbor',
      'content-type': 'application/cbor',
      'smithy-protocol': 'rpc-v2-cbor',
      'x-csrf-token': csrf,
      'user-agent': CHROME_UA,
      cookie: `${authCookie}; ${userId}`
    },
    body: Buffer.from(encode(body))
  })
  const raw = Buffer.from(await res.arrayBuffer())
  if (!res.ok) {
    let detail = ''
    try {
      const err = decode(raw)
      detail = [err.__type?.split('#').pop(), err.message].filter(Boolean).join(': ')
    } catch {
      detail = raw.toString('utf-8').slice(0, 120)
    }
    throw new Error(`${operation} 失败：HTTP ${res.status} ${detail}`.trim())
  }
  return decode(raw)
}

async function main() {
  if (!process.env.LOCALAPPDATA) return fail('找不到 LOCALAPPDATA，本脚本只支持 Windows')

  let db
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true })
  } catch {
    return fail(`打不开 kiro-cli 数据库：${DB_PATH}\n请确认已安装 kiro-cli 并至少登录过一次`)
  }

  const read = (key) => {
    try {
      const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(key)
      return row?.value ? JSON.parse(row.value) : null
    } catch {
      return null
    }
  }

  const reg = read('kirocli:odic:device-registration')
  const tok = read('kirocli:odic:token')
  if (!reg?.client_id || !reg?.client_secret || !tok?.refresh_token) {
    return fail(
      'kiro-cli 当前没有已登录的账号。\n' +
        '请先在终端运行 kiro-cli 并完成登录，再双击本脚本。'
    )
  }

  console.log('已读取 kiro-cli 凭证：')
  console.log(`  clientId : ${reg.client_id}`)
  console.log(`  region   : ${reg.region || 'us-east-1'}`)
  console.log(`  scopes   : ${(reg.scopes || []).join(', ')}`)
  console.log('\n正在刷新 Token 并查询账号信息…')

  const refreshed = await refreshAccessToken(reg, tok)
  const usage = await portalCall(
    refreshed.accessToken,
    refreshed.refreshToken || tok.refresh_token,
    'GetUserUsageAndLimits',
    { isEmailRequired: true, origin: 'KIRO_IDE' }
  )

  const email = usage?.userInfo?.email || ''
  const sub = usage?.subscriptionInfo || {}
  const credit = usage?.usageBreakdownList?.find(
    (b) => (b.resourceType || b.type) === 'CREDIT' || b.displayName === 'Credits'
  )
  const current = credit?.currentUsageWithPrecision ?? credit?.currentUsage ?? 0
  const limit = credit?.usageLimitWithPrecision ?? credit?.usageLimit ?? 0

  // 程序精简 JSON 导入格式：provider 必须显式给出，否则会被当成社交登录
  const item = {
    email,
    refreshToken: tok.refresh_token,
    clientId: reg.client_id,
    clientSecret: reg.client_secret,
    provider: 'BuilderId',
    region: reg.region || 'us-east-1'
  }

  const output = JSON.stringify([item], null, 2)
  const outFile = join(process.cwd(), 'kiro-cli-account.json')
  writeFileSync(outFile, output, 'utf8')

  console.log('\n===== 账号信息 =====')
  console.log(`  邮箱     : ${email || '(接口未返回)'}`)
  console.log(`  订阅     : ${sub.subscriptionTitle || '未知'} (${sub.type || '?'})`)
  console.log(`  用量     : ${current} / ${limit}`)
  console.log(`  管理目标 : ${sub.subscriptionManagementTarget || '?'}`)
  console.log(`\n已写入文件：${outFile}`)
  console.log('\n===== 可复制的 JSON（粘贴到程序「导入 → 输入 JSON 导入」）=====\n')
  console.log(output)
  console.log('\n' + '='.repeat(60))
}

main().catch((error) => fail(error?.message || String(error)))
