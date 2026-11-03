/**
 * 「以某个账号的身份进入 Kiro 官网后台」所需的身份材料。
 *
 * 这些 cookie 与 profileArn 的推导规则跟「用哪个浏览器打开」无关：
 * 外部 Chrome（CDP 注入）与应用内无痕分区注入的是同一组值。
 * 抽出来是为了两处不各写一份——口径一旦分叉，就会出现「一个窗口能进、另一个停在登录页」。
 */
import { listAvailableProfiles } from './kiroApi'
import { log } from './logger'
import type { Account } from '../shared/types'

export const PORTAL_ORIGIN = 'https://app.kiro.dev'

/**
 * 门户认的会话 cookie。
 *
 * Idp / AccessToken / RefreshToken 三个是社交与 Builder ID 账号进后台的充分条件。
 * Enterprise（IdC / SSO）账号还必须带 ProfileArn，否则门户把会话判为 stale、停在登录页
 * —— 实测同一 token 补上该 cookie，user-status 立刻从 stale 变 active、user-id 也出现。
 * 对其它登录方式带上它无副作用（本就 active，加了仍 active），因此只要账号有 ARN 就一并注入。
 */
export function portalCookies(
  account: Account,
  profileArn: string
): { name: string; value: string }[] {
  const { accessToken, refreshToken } = account.credentials
  return [
    { name: 'Idp', value: account.idp },
    { name: 'AccessToken', value: accessToken },
    { name: 'RefreshToken', value: refreshToken },
    { name: 'ProfileArn', value: profileArn }
  ].filter((item) => !!item.value)
}

/**
 * 定出注入 cookie 用的 profileArn。
 *
 * 优先用账号已存的值。仅当 Enterprise 账号一次都没存过 ARN 时，才现场问一次
 * ListAvailableProfiles 补齐——否则这类账号打开官网只会停在登录页（stale）。
 * 失败或非 Enterprise 一律返回空串，即不注入 ProfileArn cookie。
 */
export async function resolvePortalArn(account: Account): Promise<string> {
  const stored = account.profileArn || account.credentials.profileArn
  if (stored) return stored
  if (account.idp !== 'Enterprise') return ''

  const { accessToken, region } = account.credentials
  if (!accessToken) return ''
  try {
    const [arn] = await listAvailableProfiles(accessToken, region)
    if (arn) log('info', '[KiroPortal] Enterprise 账号缺 profileArn，已现查补齐')
    return arn || ''
  } catch {
    return ''
  }
}
