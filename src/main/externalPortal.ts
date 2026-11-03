/**
 * 用系统安装的 Chrome（或 Edge）以一次性身份打开 Kiro 官网后台。
 *
 * 为什么不用内置浏览器：官网是重前端应用，跑在用户真实的 Chrome 里，
 * 指纹、扩展、证书链都是原生的，不会出现「同一个页面内置窗口比 Chrome 卡」的观感差异；
 * 同时用临时 profile，用户自己浏览器里的登录态一点都不会被读到，关窗即删。
 *
 * 会话怎么建立：cookie 注入必须早于门户的首个请求，所以先以 about:blank 启动，
 * 连上 CDP 写入该账号的会话 cookie，再导航过去。直接带 URL 启动的话，
 * 首屏请求发出去时 cookie 还没写进去，页面只会停在登录页。
 *
 * 与 browser.ts 的 openUrl(privateMode) 的区别也在这里：那条路只负责「开个无痕窗口」，
 * 没法把账号身份塞进去。账号后台必须带上 cookie，于是复用支付模块那套
 * 「拉起进程 → 读调试端口 → 手写 CDP」的链路。
 */
import { launchBrowser, resolveBrowserPath, type BrowserInstance } from './payment/chrome'
import { PORTAL_ORIGIN, portalCookies, resolvePortalArn } from './portalAuth'
import { openAccountPortalInApp } from './kiroPortal'
import { getSettings } from './store'
import { acceptLanguageFor, normalizePortalLocale } from '../shared/portalLocale'
import { log } from './logger'
import type { Account } from '../shared/types'

/** 本进程开出来的门户窗口：退出时统一收掉，临时 profile 才不会留在磁盘上 */
const opened = new Set<BrowserInstance>()

/** 无痕窗口的尺寸：略小于常见桌面可用区，避免顶到屏幕边缘 */
const WINDOW_WIDTH = 1440
const WINDOW_HEIGHT = 960

export interface PortalOpenResult {
  url: string
  /** 实际使用的浏览器；走内置浏览器兜底时为 '应用内浏览器' */
  browser: string
}

/**
 * 打开官网后台并以该账号身份登录。
 *
 * 每次点击都开一个新窗口：临时 profile 一次性使用，关掉即没有痕迹，
 * 这样也不会出现「点了 A 账号却进了 B 账号后台」的串号问题。
 */
export async function openAccountPortal(account: Account): Promise<PortalOpenResult> {
  const { accessToken, refreshToken } = account.credentials
  if (!accessToken && !refreshToken) throw new Error('账号缺少凭证，无法登录官网')

  /*
   * 没装 Chrome/Edge 时退回内置浏览器：这条路比不上原生 Chrome，
   * 但「点开就能进后台」比「弹一句让你先装浏览器」有用得多。
   * 这里只做存在性判断，真正启动仍交给 launchBrowser 自己探测——
   * 显式传 exePath 会把浏览器名改成「自定义浏览器」，界面提示就失真了。
   */
  if (!resolveBrowserPath()) {
    log('warn', '[KiroPortal] 未找到 Chrome/Edge，改用内置浏览器打开官网')
    return openAccountPortalInApp(account)
  }

  const profileArn = await resolvePortalArn(account)
  /*
   * 地区取设置里的「浏览器地区」：--lang 会同时决定 navigator.language 与
   * Accept-Language（Chromium 自己生成，带 q 降级项，和真实浏览器一致）。
   * 临时 profile 没有用户自己的语言偏好，不传的话门户只会用系统默认地区。
   */
  const instance = await launchBrowser({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    incognito: true,
    lang: normalizePortalLocale(getSettings().portalLocale)
  })
  opened.add(instance)

  /*
   * 关闭只做一次。
   * close() 内部会断开 CDP，而断开又会触发下面的 onClose——不加这个门闩，
   * 两条路径会同时跑 killTree 与临时目录清理。门闩必须在调用 close() 之前置位：
   * close() 一进去就 await 网络往返，那一刻 onClose 可能已经回调了。
   */
  let closing: Promise<void> | null = null
  const shutdown = (): Promise<void> => {
    if (closing) return closing
    closing = instance.close().catch(() => undefined)
    return closing
  }

  /*
   * 用户关窗后 CDP 连接断开，此时把进程与临时 profile 一起收掉。
   * 不做这一步的话，关掉的每个窗口都会在系统临时目录里留一份几十 MB 的 profile。
   */
  instance.cdp.onClose(() => {
    opened.delete(instance)
    void shutdown()
  })

  try {
    await instance.cdp.send('Network.enable', {}, instance.sessionId, 8000)

    for (const { name, value } of portalCookies(account, profileArn)) {
      await instance.cdp.send(
        'Network.setCookie',
        {
          name,
          value,
          // 只给 url，域名与 path 由 Chrome 按它推导，避免两者不一致时被拒
          url: `${PORTAL_ORIGIN}/`,
          secure: true,
          httpOnly: true,
          sameSite: 'Lax'
        },
        instance.sessionId,
        8000
      )
    }

    /*
     * 请求头仍显式设置一次：--lang 生成的是 Chromium 自己的 q 权重表
     * （如 ja-JP 会变成 `ja,en-US;q=0.9,en;q=0.8`），而内置浏览器用的是
     * acceptLanguageFor 的口径。门户按 Accept-Language 选语言时两边应当一致。
     */
    await instance.cdp
      .send(
        'Network.setExtraHTTPHeaders',
        { headers: { 'Accept-Language': acceptLanguageFor(getSettings().portalLocale) } },
        instance.sessionId,
        8000
      )
      .catch(() => undefined)

    const nav = await instance.cdp.send<{ errorText?: string }>(
      'Page.navigate',
      { url: PORTAL_ORIGIN },
      instance.sessionId,
      30_000
    )
    if (nav.errorText) throw new Error(`打开官网失败：${nav.errorText}`)

    await instance.cdp
      .send('Page.bringToFront', {}, instance.sessionId, 5000)
      .catch(() => undefined)

    log('info', `[KiroPortal] 已用 ${instance.name} 无痕窗口以 ${account.email} 的身份打开官网后台`)
    return { url: PORTAL_ORIGIN, browser: instance.name }
  } catch (error) {
    // cookie 注入或导航失败：别留一个停在 about:blank 的空窗口
    opened.delete(instance)
    await shutdown()
    throw error
  }
}

/** 应用退出时收掉所有门户窗口 */
export function shutdownExternalPortalsSync(): void {
  for (const instance of opened) {
    // 退出路径等不了异步清理，先同步杀掉进程，再尽力走一次 close 收临时目录
    instance.killSync()
    void instance.close().catch(() => undefined)
  }
  opened.clear()
}

