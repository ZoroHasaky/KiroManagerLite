/**
 * 订阅降级：把账号的 Stripe 订阅切到 Kiro Free。
 *
 * Kiro/AWS 侧没有「改套餐 / 降级」的接口，降级全程在 Stripe 订阅门户
 * （billing.stripe.com）里完成。这里用纯 HTTP 复刻这条链路，不启动浏览器：
 *
 *   1. Kiro CreateSubscriptionToken（不带 subscriptionType）→ 管理门户 URL
 *   2. GET 门户 URL → 服务端渲染的 HTML 里内联了 bps 会话 ID 和临时密钥 ek
 *      （注意：用 DevTools 导出的 HAR 重放会 401，Authorization 头被脱敏了，
 *        ek 只能从 HTML 里取，它才是 XHR 的真实凭证）
 *   3. GET /v1/billing_portal/sessions/{bps}/subscriptions → 订阅 ID、订阅项 ID、当前价格
 *   4. POST 同一资源，把 recurring_items[0][price] 换成 Free 价格 ID
 *
 * 链路口径移植自 KiroAccountManager 的 stripePortal（2026-08-30 抓包验证）。
 * Stripe 改版导致解析失败时，优先检查 HTML 内联字段名与 KIRO_FREE_PRICE_ID。
 */
import { qEndpoint, awsInvocationId, AWS_SINGLE_ATTEMPT_HEADERS } from './kiroEndpoints'
import { httpRequest } from './net'
import { inAppChromeUserAgent } from './kiroPortal'
import type { Account, SwitchToFreeResult } from '../shared/types'

/**
 * Kiro 的 Stripe 商户号与「Kiro Free」价格 ID。
 * 商户级全局通用（所有账号同一商户），只有 Stripe 侧改版才需要更新。
 */
const KIRO_STRIPE_ACCOUNT = 'acct_1RoAWWIHUhwdEnrT'
const KIRO_FREE_PRICE_ID = 'price_1RpBqGIHUhwdEnrTbZ8CIM0l'

/** 门户页面按普通浏览器 UA 访问（不是 Kiro SDK 的 UA） */
const PORTAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'

/** 门户请求公共头（抓包复刻；CSRF 为 Stripe 固定占位值，服务端不做真实校验） */
function portalHeaders(
  cred: PortalCredential,
  extra?: Record<string, string>
): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: `Bearer ${cred.ek}`,
    'content-type': 'application/x-www-form-urlencoded',
    referer: cred.portalUrl,
    'stripe-account': KIRO_STRIPE_ACCOUNT,
    'stripe-livemode': 'true',
    'stripe-version': '2025-06-30.basil',
    'user-agent': PORTAL_UA,
    'x-requested-with': 'XMLHttpRequest',
    'x-stripe-csrf-token': 'fake-deprecated-token',
    ...extra
  }
}

/**
 * 用账号凭证向 Kiro 要一个 Stripe 门户链接。
 * 不带 subscriptionType 时拿到的是「管理订阅」门户，不是某个档位的结算页。
 *
 * 「打开订阅门户（无痕）」也走这里：那条路只要链接，不要门户里的订阅数据。
 * 门户会话是短时效凭证，取到就得马上打开，不能缓存。
 */
export async function fetchManagementUrl(account: Account): Promise<string> {
  const { accessToken } = account.credentials
  if (!accessToken) throw new Error('账号缺少 AccessToken')

  const body: Record<string, string> = {
    clientToken: awsInvocationId(),
    provider: 'STRIPE'
  }
  const profileArn = account.profileArn || account.credentials.profileArn
  if (profileArn) body.profileArn = profileArn

  const res = await httpRequest(`${qEndpoint(account.credentials.region)}/CreateSubscriptionToken`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'user-agent': inAppChromeUserAgent(),
      'amz-sdk-invocation-id': awsInvocationId(),
      ...AWS_SINGLE_ATTEMPT_HEADERS
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`CreateSubscriptionToken 失败：HTTP ${res.status}${text ? ` ${text.slice(0, 160)}` : ''}`)
  }

  const data = await res.json<{ encodedVerificationUrl?: string; message?: string }>()
  if (!data.encodedVerificationUrl) {
    throw new Error(data.message || 'CreateSubscriptionToken 没有返回门户链接')
  }
  return data.encodedVerificationUrl
}

interface PortalCredential {
  bps: string
  ek: string
  portalUrl: string
}

/** 加载门户 HTML，取出 bps 会话 ID 与 ek 临时密钥（短时效，取到就得马上用） */
async function loadPortalCredential(portalUrl: string): Promise<PortalCredential> {
  const res = await httpRequest(portalUrl, {
    headers: { accept: 'text/html', 'user-agent': PORTAL_UA }
  })
  if (!res.ok) throw new Error(`打开 Stripe 门户失败：HTTP ${res.status}`)

  const html = await res.text()
  // HTML 内联 JSON 会被 &quot; 转义，直接按值的形态匹配，不依赖字段名的转义格式
  const bps = html.match(/bps_[A-Za-z0-9]+/)?.[0]
  const ek = html.match(/ek_live_[A-Za-z0-9+/=_-]+/)?.[0]
  if (!bps || !ek) {
    throw new Error(
      !bps && !ek
        ? '门户页面里没有 bps 会话和临时密钥（链接可能已过期，或 Stripe 改版）'
        : !bps
          ? '门户页面里没有 bps 会话 ID'
          : '门户页面里没有临时密钥 session_api_key'
    )
  }
  return { bps, ek, portalUrl }
}

interface PortalSubscription {
  subId: string
  siId: string
  currentPriceId: string
  currentProductName?: string
  /** false = 下周期自动续费；true = 已设置到期不续费 */
  cancelAtPeriodEnd?: boolean
  /** 当前周期结束（下次续费 / 失效）时间戳（秒） */
  currentPeriodEnd?: number
  /** 已安排周期末的计划变更 */
  hasUpdateScheduled?: boolean
  transitionAt?: number
  /** 已安排的下期账单是 $0 的 Free */
  upcomingIsFree?: boolean
}

/** 查询门户里的当前订阅（订阅 ID / 订阅项 ID / 当前价格 / 续费状态） */
async function fetchPortalSubscription(cred: PortalCredential): Promise<PortalSubscription> {
  const url =
    `https://billing.stripe.com/v1/billing_portal/sessions/${cred.bps}/subscriptions` +
    `?expand%5B%5D=data.items.price_details.product`
  const res = await httpRequest(url, { headers: portalHeaders(cred) })
  const data = (await res.json().catch(() => ({}))) as {
    error?: { message?: string }
    data?: Array<{
      id?: string
      items?: unknown
      cancel_at_period_end?: boolean
      current_period_end?: number
      has_update_scheduled?: boolean
      transition_at?: number
      upcoming_invoice?: {
        amount_due?: number
        lines?: { data?: Array<{ price_details?: { id?: string } }> }
      }
    }>
  }

  if (!res.ok) {
    throw new Error(
      `读取门户订阅失败：HTTP ${res.status}${data.error?.message ? `：${data.error.message}` : ''}`
    )
  }

  const sub = data.data?.[0]
  if (!sub?.id) throw new Error('门户里没有找到订阅')

  // items 在带 expand 时是 {data:[...]}，不带时可能是数组，两种都兼容
  const rawItems = sub.items
  type Item = { id?: string; price_details?: { id?: string; product?: { name?: string } | Array<{ name?: string }> } }
  const items: Item[] =
    rawItems && typeof rawItems === 'object' && Array.isArray((rawItems as { data?: unknown }).data)
      ? ((rawItems as { data: Item[] }).data)
      : Array.isArray(rawItems)
        ? (rawItems as Item[])
        : []

  const item = items[0]
  if (!item?.id || !item.price_details?.id) throw new Error('没有找到订阅项')

  const product = item.price_details.product
  const productName = Array.isArray(product) ? product[0]?.name : product?.name

  const upcomingFirstPrice = sub.upcoming_invoice?.lines?.data?.[0]?.price_details?.id
  const upcomingIsFree =
    sub.has_update_scheduled === true &&
    (upcomingFirstPrice === KIRO_FREE_PRICE_ID || sub.upcoming_invoice?.amount_due === 0)

  return {
    subId: sub.id,
    siId: item.id,
    currentPriceId: item.price_details.id,
    currentProductName: productName,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    currentPeriodEnd: sub.current_period_end,
    hasUpdateScheduled: sub.has_update_scheduled,
    transitionAt: sub.transition_at,
    upcomingIsFree
  }
}

/** 提交切换：把订阅项的价格换成 Free */
async function postSwitchPrice(
  cred: PortalCredential,
  sub: PortalSubscription,
  targetPriceId: string
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const url = `https://billing.stripe.com/v1/billing_portal/sessions/${cred.bps}/subscriptions/${sub.subId}`
  // form 编码要和浏览器一致：recurring_items[0][id] = 订阅项、[quantity] = 1、[price] = 目标价格
  const body = new URLSearchParams({
    'recurring_items[0][id]': sub.siId,
    'recurring_items[0][quantity]': '1',
    'recurring_items[0][price]': targetPriceId
  }).toString()

  const res = await httpRequest(url, {
    method: 'POST',
    headers: portalHeaders(cred, { origin: 'https://billing.stripe.com' }),
    body
  })
  const data = (await res.json().catch(() => ({}))) as {
    status?: string
    error?: { message?: string }
  }
  if (!res.ok) {
    return {
      ok: false,
      error: `HTTP ${res.status}${data.error?.message ? `：${data.error.message}` : ''}`
    }
  }
  return { ok: true, status: data.status }
}

/**
 * 把账号订阅切到 Kiro Free。
 *
 * Stripe 的降级默认「周期末生效」：当前周期保持原计划、下周期起 Free，
 * 所以成功时返回 scheduledToFree，不承诺立即变更。
 * 已经是 Free、已安排切换、或已设置到期不续费的账号都按「无需变更」处理，
 * 不算失败——批量跑时这些是正常结果。
 */
export async function switchSubscriptionToFree(account: Account): Promise<SwitchToFreeResult> {
  try {
    const portalUrl = await fetchManagementUrl(account)
    // secret 短时效，取到链接就得立刻加载门户，不能缓存
    const cred = await loadPortalCredential(portalUrl)
    const sub = await fetchPortalSubscription(cred)

    const base = {
      subId: sub.subId,
      previousPlan: sub.currentProductName || sub.currentPriceId
    }

    // 已经是 Free
    if (sub.currentPriceId === KIRO_FREE_PRICE_ID) {
      return { success: true, alreadyFree: true, ...base }
    }
    // 已安排周期末切 Free，重复提交没意义
    if (sub.upcomingIsFree === true) {
      return {
        success: true,
        alreadyScheduled: true,
        transitionAt: sub.transitionAt,
        ...base
      }
    }
    // 已设置到期不续费：下周期不扣款，按业务口径无需切
    if (sub.cancelAtPeriodEnd === true) {
      return { success: true, wontRenew: true, ...base }
    }

    const result = await postSwitchPrice(cred, sub, KIRO_FREE_PRICE_ID)
    if (!result.ok) {
      return { success: false, error: result.error || '切换请求失败', ...base }
    }
    if (result.status && result.status !== 'active') {
      return { success: false, error: `订阅状态异常：${result.status}`, ...base }
    }

    return {
      success: true,
      switched: true,
      scheduledToFree: true,
      transitionAt: sub.currentPeriodEnd,
      ...base
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
