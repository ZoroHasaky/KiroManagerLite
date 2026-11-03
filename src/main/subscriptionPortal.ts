/**
 * 用系统浏览器的无痕窗口打开账号的 Stripe 订阅门户。
 *
 * 与「切换 Free」的区别是这里不替用户操作 Stripe：Kiro/AWS 没有取消订阅的直接接口，
 * 有些变更（改支付方式、下载发票、取消订阅）只能在门户里手动做。本模块只负责
 * 「取一条该账号的管理门户链接 → 交给无痕浏览器打开」，后续操作全在用户手里。
 *
 * 门户链接由 CreateSubscriptionToken 现取，是短时效凭证，不能缓存复用，
 * 因此每次点击都要重新请求一次。
 */
import { openUrl } from './browser'
import { fetchManagementUrl } from './subscriptionDowngrade'
import { log } from './logger'
import type { Account, BrowserOpenInfo } from '../shared/types'

export interface SubscriptionPortalOpenInfo extends BrowserOpenInfo {
  /** 实际打开的门户链接（短时效，仅供界面提示，不要落盘） */
  url: string
}

export async function openSubscriptionPortal(
  account: Account
): Promise<SubscriptionPortalOpenInfo> {
  if (!account.credentials.accessToken) {
    throw new Error('账号缺少 AccessToken，无法打开订阅门户')
  }

  const url = await fetchManagementUrl(account).catch((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error)
    /*
     * 未订阅（或已回到 Free）的账号换不到管理门户，上游回 400/404 加一句英文。
     * 这里的按钮是「管理已有订阅」，把它翻成能看懂的话，别把上游原文直接弹出来。
     */
    if (/HTTP (400|404)/.test(text)) {
      throw new Error(`该账号可能没有可管理的订阅（未订阅或已是 Free）：${text}`)
    }
    throw error
  })
  /*
   * 走系统浏览器的无痕窗口，而不是应用内的 CDP 实例：
   * Stripe 门户会做设备指纹与 3DS 之类的校验，用户自己的浏览器更可靠；
   * 这里也不需要往页面里注入任何账号凭证。
   */
  const info = await openUrl(url, true)
  log(
    'info',
    `[订阅门户] 已用 ${info.browser ?? '默认浏览器'}${info.privateMode ? ' 无痕' : ''}窗口打开 ${account.email} 的订阅门户`
  )
  return { ...info, url }
}
