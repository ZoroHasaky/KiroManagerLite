/**
 * 应用内支付：一次只维护一个外部 Chrome 会话。
 *
 * 流程是「打开 → 等表单渲染出来 → 选国家/省 → 填地址 → 填卡」。
 * 填完就停手：付款按钮和 3DS 验证都留给用户在浏览器里自己确认——
 * 那两步涉及真实扣款和风控，自动点会带来不必要的风险。
 *
 * 状态通过 payment:update 推给界面，界面据此显示进度。
 */
import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { join } from 'path'
import { closeBrowserQuietly, isDisconnectedError, launchBrowser, type BrowserInstance } from './chrome'
import { PaymentPage } from './page'
import { generateBillingAddress } from './addressGen'
import { sendToRenderer } from '../utils'
import { log } from '../logger'
import type {
  PaymentAddress,
  PaymentCardInfo,
  PaymentPhase,
  PaymentStartInput,
  PaymentUpdate
} from '../../shared/types'

export type {
  PaymentAddress,
  PaymentCardInfo,
  PaymentPhase,
  PaymentStartInput,
  PaymentUpdate
}

/** 表单出现后放慢探测节奏，减少对页面的干扰 */
const PROBE_INTERVAL_MS = 1200
/** 表单出现前快一点，用户点了按钮就想马上看到进度 */
const PROBE_FAST_INTERVAL_MS = 400
/** 表单出现多久之后放慢探测节奏 */
const PROBE_FAST_WINDOW_MS = 15_000
/**
 * 自动化总时长上限。
 *
 * 之前到点就报错退出，但结算链接本身有 24 小时有效期，用户完全可能中途去处理别的事。
 * 现在到点只是停掉「自动填充」，循环本身继续跑，页面里手动刷新、手动填好的内容
 * 仍然能被接上；只有用户关掉浏览器窗口才真正结束会话。
 */
const PROBE_LIFETIME_MS = 30 * 60 * 1000
/** 地址字段连续多少轮找不到就不再自动填，提示用户手动补全 */
const ADDRESS_MAX_ATTEMPTS = 12
/**
 * 探测连续失败多少次后暂停自动填充。
 * 页面在导航途中读不到 DOM 是正常的，不算故障；只有持续读不到才说明页面结构不认识。
 */
const PROBE_ERROR_LIMIT = 20

interface ActiveSession {
  accountId: string
  instance: BrowserInstance
  page: PaymentPage
  stopped: boolean
}

let active: ActiveSession | null = null

function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function notify(getWindow: () => BrowserWindow | null, update: PaymentUpdate): void {
  sendToRenderer(getWindow(), 'payment:update', update)
}

/** 关掉当前支付会话（退出应用、切换账号、用户主动关闭都会走到这里） */
export async function closePaymentSession(getWindow?: () => BrowserWindow | null): Promise<void> {
  const current = active
  if (!current) return
  active = null
  current.stopped = true
  await closeBrowserQuietly(current.instance)
  if (getWindow) notify(getWindow, { accountId: current.accountId, phase: 'closed' })
}

/** 退出路径上的同步收尾：不能等异步清理，直接杀掉浏览器进程 */
export function shutdownPaymentSessionSync(): void {
  const current = active
  if (!current) return
  active = null
  current.stopped = true
  void closeBrowserQuietly(current.instance)
}

/** 当前是否有正在进行的支付会话 */
export function hasPaymentSession(): boolean {
  return !!active
}

/**
 * 支付浏览器的共享磁盘缓存目录。
 *
 * 放在用户数据目录下、跨会话保留：Stripe 的静态资源带一年缓存头，
 * 留着就能让下次打开支付窗口直接命中（实测表单出现从 5–30 秒降到 1–2 秒）。
 * 只共享 HTTP 缓存，cookie 仍在每次新建的临时 profile 里。
 */
function paymentCacheDir(): string {
  return join(app.getPath('userData'), 'payment-cache')
}

/**
 * 打开浏览器并自动填充支付页。
 *
 * 同一时刻只允许一个会话：切到另一个账号时先把上一个关掉，
 * 避免用户同时对着两个结算页付款。
 */
export async function startPaymentSession(
  payload: PaymentStartInput,
  getWindow: () => BrowserWindow | null
): Promise<{ browser: string }> {
  if (!/^https:\/\//i.test(payload.url)) throw new Error('仅支持 https 支付链接')

  await closePaymentSession(getWindow)

  const address = payload.address || generateBillingAddress()
  notify(getWindow, { accountId: payload.accountId, phase: 'opening' })

  const instance = await launchBrowser({ url: payload.url, cacheDir: paymentCacheDir() })
  const page = new PaymentPage(instance)
  const session: ActiveSession = {
    accountId: payload.accountId,
    instance,
    page,
    stopped: false
  }
  active = session

  log('info', `[Payment] 已用 ${instance.name} 打开支付页（跟随系统代理）`)

  // 后台跑填充流程，不阻塞 IPC 返回：界面要立刻拿到「已打开」的结果
  void runFillLoop(session, payload, address, getWindow)

  return { browser: instance.name }
}

/**
 * 填充主循环。
 *
 * 设计原则：只有「用户关掉浏览器窗口」才结束会话。
 * 页面加载慢、网络抖动、Stripe 暂时报错、用户中途手动刷新——这些都是可以恢复的，
 * 一律回到等待状态继续探测，等页面真的出来再填。
 *
 * 早期的做法是遇到错误页 / 加载失败 / 探测连续失败就直接退出，结果是
 * 页面稍微慢一点就永久放弃，用户手动刷新出来了也不会再自动填。
 */
async function runFillLoop(
  session: ActiveSession,
  payload: PaymentStartInput,
  address: PaymentAddress,
  getWindow: () => BrowserWindow | null
): Promise<void> {
  const startedAt = Date.now()
  let formReady = false
  let loadingNotified = false
  let cardStageDone = !payload.card
  let addressStageDone = false
  let addressAttempts = 0
  let filledNotified = false
  let consecutiveErrors = 0
  /** 自动填充是否已暂停（超时或多次读不到页面），暂停后只观察不操作 */
  let paused = false
  /** Chrome 网络错误页出现过几次，以及是否已经自动重载过 */
  let errorPageSeen = 0
  let reloaded = false
  /** 上一次「仍在等待」提示对应的秒数，避免同一秒重复推送 */
  let lastWaitNotice = 0

  const push = (phase: PaymentPhase, detail?: string): void => {
    if (session.stopped) return
    notify(getWindow, { accountId: payload.accountId, phase, detail })
  }

  /** 用户关窗或连接断开：这是唯一真正的结束条件 */
  const isClosed = (): boolean =>
    session.instance.closedByUser || session.instance.cdp.isClosed

  try {
    await session.page.bootstrap()
    push('page-loading')
    loadingNotified = true
    await session.page.bringToFront()

    while (!session.stopped) {
      if (isClosed()) {
        if (!session.stopped) push('closed', '浏览器窗口已关闭')
        active = null
        return
      }

      let probe
      let runner
      try {
        const result = await session.page.probe()
        probe = result.probe
        runner = result.runner
        consecutiveErrors = 0
      } catch (error) {
        if (isDisconnectedError(error) || session.instance.closedByUser) {
          if (!session.stopped) push('closed', '浏览器窗口已关闭')
          active = null
          return
        }
        /*
         * 读不到页面：导航途中、iframe 重建、页面正在刷新都会这样。
         * 不退出，退到慢速轮询继续等——用户手动刷新出来的页面同样能接上。
         */
        consecutiveErrors++
        if (consecutiveErrors === PROBE_ERROR_LIMIT && !paused) {
          push('page-loading', '暂时读不到支付页内容，仍在等待页面加载…')
        }
        await sleep(PROBE_INTERVAL_MS)
        continue
      }

      // 终态：成功和链接过期是真的不需要再操作了
      if (probe.success) {
        push('success')
        log('info', '[Payment] 支付成功')
        return
      }
      if (probe.expired) {
        push('expired', '结算链接已过期，请回到订阅管理重新生成')
        return
      }

      /*
       * 以下都是「页面还没准备好」而不是故障：
       *  - errorPage：DNS / 证书 / 断网，用户可能正在切代理
       *  - loadFailed：Stripe 自己报无法加载，刷新一次常常就好
       *  - 表单没出现：还在渲染，或者用户正在手动刷新
       * 统一回到等待状态，不清空已填进度。
       */
      if (!probe.form) {
        if (!loadingNotified) {
          push('page-loading')
          loadingNotified = true
        } else if (formReady) {
          // 之前填过、现在表单没了（用户刷新了页面）：下一轮重新填
          formReady = false
          cardStageDone = !payload.card
          addressStageDone = false
          addressAttempts = 0
          filledNotified = false
          errorPageSeen = 0
          reloaded = false
          push('page-loading', '页面已重新加载，正在等待表单…')
        }

        /*
         * 页面一直没出来时，定期把「已等待多久」告诉界面。
         * Stripe 首次加载在代理下可能要二三十秒，只显示一句静态文案
         * 会让人以为程序卡死了。
         */
        const waitedSec = Math.round((Date.now() - startedAt) / 1000)
        if (waitedSec >= 10 && waitedSec % 10 === 0 && waitedSec !== lastWaitNotice) {
          lastWaitNotice = waitedSec
          push('page-loading', `仍在等待支付页加载（已 ${waitedSec} 秒），页面出来后会自动填写`)
        }

        if (probe.errorPage) {
          errorPageSeen++
          /*
           * Chrome 网络错误页：多半是首次请求没建起连接（代理刚切、DNS 还没通）。
           * 稳定出现几次后自动重载一次——比干等有效，也省得用户自己去点刷新。
           * 只重载一次，避免在真正断网时无限刷新。
           */
          if (!reloaded && errorPageSeen >= 3) {
            reloaded = true
            log('info', '[Payment] 支付页打不开，自动重载一次')
            push('page-loading', '支付页打不开，正在自动重试…')
            await session.page.reload().catch(() => undefined)
            errorPageSeen = 0
            await sleep(PROBE_FAST_INTERVAL_MS)
            continue
          }
          push(
            'page-loading',
            reloaded
              ? '支付页仍然打不开，请检查代理或网络后手动刷新页面'
              : '支付页打不开（网络或 DNS 异常），仍在等待；修复网络或代理后刷新页面即可'
          )
        } else if (probe.loadFailed) {
          push('page-loading', 'Stripe 暂时无法加载结算页，仍在等待；可在浏览器里刷新页面重试')
        }

        await sleep(formReady ? PROBE_INTERVAL_MS : PROBE_FAST_INTERVAL_MS)
        continue
      }

      // 表单出现了：如果之前判定过暂停，这里自动恢复
      if (paused) {
        paused = false
        log('info', '[Payment] 页面已就绪，恢复自动填充')
      }

      if (!formReady) {
        formReady = true
        loadingNotified = false
        push('filling')
      }

      // 卡在前：卡号区块在地址上方，且不受国家选择影响
      if (!cardStageDone && payload.card) {
        try {
          const result = await session.page.fillCard(payload.card)
          // 卡号字段可能还没渲染出来，没找到就下一轮再试，别当成填完了
          cardStageDone = Object.values(result).every((v) => v !== 'missing')
          if (cardStageDone) log('info', '[Payment] 卡信息已填入')
        } catch (error) {
          if (isDisconnectedError(error)) {
            push('closed', '浏览器窗口已关闭')
            active = null
            return
          }
          // 卡号在跨进程 iframe 里时偶尔会先失败一次，下一轮重试
        }
      }

      if (!addressStageDone) {
        if (++addressAttempts > ADDRESS_MAX_ATTEMPTS) {
          // 只是不再自动填地址，会话继续，用户手动填完仍然能被后续检测看到
          push('filled', '部分账单字段没能自动填上，请在浏览器里手动补全')
          addressStageDone = true
        } else {
          const countryOk = await session.page.ensureCountry().catch(() => false)
          if (!countryOk) {
            await sleep(PROBE_INTERVAL_MS)
            continue
          }

          const provinceOk = await session.page
            .ensureProvince(address.provinceZh, address.provinceEn)
            .catch(() => false)
          if (!provinceOk) {
            await sleep(PROBE_INTERVAL_MS)
            continue
          }

          // 表单落在子帧里（新版 habanero）时地址字段布局不同：line1 = 区，line2 = 街道
          const useIframeLayout = runner.label !== 'main'
          try {
            const result = await session.page.fillAddress(address, useIframeLayout)
            addressStageDone = Object.values(result).every((v) => v !== 'missing')
            if (addressStageDone) log('info', '[Payment] 账单地址已填入')
          } catch (error) {
            if (isDisconnectedError(error)) {
              push('closed', '浏览器窗口已关闭')
              active = null
              return
            }
            await sleep(PROBE_INTERVAL_MS)
            continue
          }
        }
      }

      // 两个阶段都完成后只提示一次；之后继续慢速轮询，等成功 / 过期 / 关窗
      if (!filledNotified && cardStageDone && addressStageDone) {
        filledNotified = true
        push('filled', '账单地址与卡信息已填入，请在浏览器里确认并付款')
      }

      /*
       * 自动化跑满 30 分钟就停手，但不结束会话：
       * 用户可能还在慢慢付款，或中途刷新了页面需要重新填。
       */
      if (!paused && Date.now() - startedAt > PROBE_LIFETIME_MS) {
        paused = true
        push('filled', '自动填充已运行 30 分钟，之后只观察页面状态；需要重新填充请关闭弹窗后重新打开')
        log('info', '[Payment] 自动填充时长到上限，转为只观察')
      }

      // 都填完了就慢速轮询，只盯着「成功 / 过期 / 关窗」
      await sleep(PROBE_INTERVAL_MS + randInt(100, 400))
    }
  } catch (error) {
    if (session.stopped) return
    if (isDisconnectedError(error) || session.instance.closedByUser) {
      push('closed', '浏览器窗口已关闭')
    } else {
      push('error', error instanceof Error ? error.message : String(error))
      log('warn', `[Payment] 自动填充失败：${error instanceof Error ? error.message : String(error)}`)
    }
    active = null
  }
}
