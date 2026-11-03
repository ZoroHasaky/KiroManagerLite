/**
 * 支付页的读取与填写。
 *
 * 填充规则移植自 KiroAccountManager 的「应用内支付」：
 * 字段 id / autocomplete 选择器、国家省份的下拉匹配、地址在 classic 与
 * 新版 iframe 两种布局下的差异，都沿用同一套口径，避免两边行为漂移。
 *
 * 与参考实现的区别只在「怎么把字敲进去」：那边跑在内置 BrowserWindow 里，
 * 用 executeJavaScript + sendInputEvent；这里控制的是外部真实 Chrome，
 * 所以走 CDP 的 Input.dispatchKeyEvent（真实按键事件），DOM 写入只作兜底。
 */
import { CdpConnection } from './cdp'
import { sleep } from '../utils'
import type { BrowserInstance } from './chrome'

/** 支付页状态探测结果 */
export interface PageProbe {
  url: string
  /** Stripe 新版页面的结构标记（data-checkout-variant），仅用于日志 */
  variant: string
  skeleton: boolean
  errorPage: boolean
  blank: boolean
  /** 是否已经渲染出地址表单 */
  form: boolean
  country: { found: boolean; value: string | null }
  province: { found: boolean; value: string | null; options: number }
  fields: Record<'name' | 'line1' | 'line2' | 'city' | 'district' | 'zip', { found: boolean; value: string }>
  success: boolean
  loadFailed: boolean
  expired: boolean
}

/**
 * 页面探测。
 * 选择器依据 Stripe Checkout 真实 DOM：classic 用 billingName / billingAddressLine1，
 * 新版 habanero iframe 用 billingAddress-nameInput / addressLine1Input，
 * autocomplete 带 billing 前缀的形态两者都覆盖。
 */
const PROBE_JS = `(() => {
  const vis = (el) => !!el && el.offsetParent !== null
  const field = (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s)
      if (vis(el)) return { found: true, value: (el.value || '').trim() }
    }
    return { found: false, value: '' }
  }
  const selValue = (sel) => {
    if (!sel) return null
    const opt = (sel.selectedOptions || [])[0]
    return ((opt && opt.text) || sel.value || '').trim() || null
  }
  const f = {
    name: field(['#billingName', '#billingAddress-nameInput', 'input[autocomplete*="cc-name" i]', 'input[autocomplete="billing name"]', 'input[name="billingName"]']),
    line1: field(['#billingAddressLine1', '#billingAddress-addressLine1Input', 'input[autocomplete*="address-line1" i]', 'input[name="billingAddressLine1"]', 'input[name="addressLine1"]']),
    line2: field(['#billingAddress-addressLine2Input', 'input[autocomplete*="address-line2" i]', 'input[name="addressLine2"]']),
    city: field(['#billingLocality', '#billingAddress-localityInput', 'input[autocomplete*="address-level2" i]', 'input[name="billingLocality"]']),
    district: field(['#billingDependentLocality', 'input[autocomplete*="address-level3" i]', 'input[name="billingDependentLocality"]']),
    zip: field(['#billingPostalCode', '#billingAddress-postalCodeInput', 'input[autocomplete*="postal-code" i]', 'input[name="billingPostalCode"]'])
  }
  const countrySelect = document.querySelector('#billingCountry, #billingAddress-countryInput, select[autocomplete*="country" i]')
  const provinceSelect = document.querySelector('#billingAdministrativeArea, #billingAddress-administrativeAreaInput, select[autocomplete*="address-level1" i]')
  const onStripe = /(^|\\.)stripe\\.com$/i.test(location.hostname)
  const bodyText = ((document.body && document.body.textContent) || '').replace(/[\\u2018\\u2019]/g, "'").slice(0, 5000)
  const skeleton = !!document.querySelector('[class*="LOADING-container" i], [class*="Skeleton" i]') ||
    (document.readyState !== 'complete' && !document.querySelector('input, select, button'))
  const errorPage = location.href.startsWith('chrome-error:') ||
    !!document.querySelector('#main-frame-error, #errorPageContainer, .neterr')
  const blank = !document.body || (document.body.innerText || '').trim().length === 0
  return {
    url: location.href,
    variant: document.documentElement.getAttribute('data-checkout-variant') || '',
    skeleton, errorPage, blank,
    form: f.line1.found || f.city.found || f.zip.found,
    country: { found: !!countrySelect && vis(countrySelect), value: countrySelect ? selValue(countrySelect) : null },
    province: {
      found: !!provinceSelect && vis(provinceSelect),
      value: provinceSelect ? selValue(provinceSelect) : null,
      options: provinceSelect ? provinceSelect.options.length : 0
    },
    fields: f,
    success: /success/i.test(location.href) ||
      (onStripe && /payment (is )?(complete|success)|thanks for your order|支付成功|付款成功/i.test(bodyText)),
    loadFailed: onStripe && /we couldn'?t load checkout|couldn'?t be loaded|something went wrong\\. please try again/i.test(bodyText),
    expired: onStripe && (
      /\\/expired/.test(location.pathname) ||
      /no longer (valid|available)|session has expired|already (been )?completed|已过期|已失效|已超时|已完成付款|结账会话已/i.test(bodyText)
    )
  }
})()`

/** 定位输入框：只读不聚焦。
 *  这里绝不能顺手 focus()：已填好的字段也会走一次定位，
 *  一旦定位就抢焦点，视觉上就会看到焦点在几个卡输入框之间来回跳。 */
const LOCATE_JS = `((rulesJson) => {
  const rules = JSON.parse(rulesJson)
  const vis = (el) => !!el && el.offsetParent !== null
  for (const r of rules) {
    const el = document.querySelector(r)
    if (!vis(el)) continue
    return { found: true, value: el.value || '', focused: document.activeElement === el }
  }
  return { found: false, value: '', focused: false }
})`

/** 聚焦并滚动到输入框；只在确定要往里打字时才调用 */
const FOCUS_JS = `((rulesJson) => {
  const rules = JSON.parse(rulesJson)
  const vis = (el) => !!el && el.offsetParent !== null
  for (const r of rules) {
    const el = document.querySelector(r)
    if (!vis(el)) continue
    el.scrollIntoView({ block: 'center' })
    try { el.focus({ preventScroll: true }) } catch (e) { el.focus() }
    return { found: true, focused: document.activeElement === el }
  }
  return { found: false, focused: false }
})`

/** 读回某个字段当前值（校验用） */
const VALUE_JS = `((rulesJson) => {
  const rules = JSON.parse(rulesJson)
  const vis = (el) => !!el && el.offsetParent !== null
  for (const r of rules) {
    const el = document.querySelector(r)
    if (vis(el)) return { found: true, value: el.value || '', focused: document.activeElement === el }
  }
  return { found: false, value: '', focused: false }
})`

/**
 * 取元素中心坐标，用于真实鼠标点击。
 * 先滚到可视区再量，避免元素在视口外时坐标算到屏幕外。
 * 坐标是相对当前 frame 视口的，跨进程 iframe 里执行时正好对得上它自己的坐标系。
 */
const RECT_JS = `((rulesJson) => {
  const rules = JSON.parse(rulesJson)
  const vis = (el) => !!el && el.offsetParent !== null
  for (const r of rules) {
    const el = document.querySelector(r)
    if (!vis(el)) continue
    el.scrollIntoView({ block: 'center' })
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    return {
      found: true,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      value: el.value || '',
      focused: document.activeElement === el
    }
  }
  return { found: false, x: 0, y: 0, value: '', focused: false }
})`

/** 兜底：走原生 setter + input/change 事件，React 受控输入也能收到 */
const SET_VALUE_JS = `((payload) => {
  const rules = JSON.parse(payload.rulesJson)
  const vis = (el) => !!el && el.offsetParent !== null
  for (const r of rules) {
    const el = document.querySelector(r)
    if (!vis(el)) continue
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set
    el.focus()
    if (setter) setter.call(el, payload.text); else el.value = payload.text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { found: true, value: el.value }
  }
  return { found: false, value: '' }
})`

/** 原生 select 选择（input + change 双事件，React 才能感知） */
const SELECT_JS = `((payload) => {
  const sel = document.querySelector(payload.sel)
    || document.querySelector('select[autocomplete*="' + payload.autoContains + '"]')
  if (!sel || sel.offsetParent === null) return { ok: false, error: 'no-select' }
  const words = (payload.matchWords || []).map((w) => String(w).toLowerCase())
  const opt = [...sel.options].find((o) => {
    if (payload.value && o.value === payload.value) return true
    const t = (o.text || '').toLowerCase()
    return words.some((w) => t.includes(w) || (o.value || '').toLowerCase() === w)
  })
  if (!opt) return { ok: false, error: 'no-option' }
  sel.value = opt.value
  sel.dispatchEvent(new Event('input', { bubbles: true }))
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, value: (opt.text || '').trim() }
})`

/** 字段选择器表，与参考实现逐条一致 */
export const FILL_RULES = {
  name: ['#billingName', '#billingAddress-nameInput', 'input[autocomplete*="cc-name" i]', 'input[autocomplete="billing name"]', 'input[name="billingName"]'],
  line1: ['#billingAddressLine1', '#billingAddress-addressLine1Input', 'input[autocomplete*="address-line1" i]', 'input[name="billingAddressLine1"]', 'input[name="addressLine1"]'],
  line2: ['#billingAddress-addressLine2Input', 'input[autocomplete*="address-line2" i]', 'input[name="addressLine2"]'],
  city: ['#billingLocality', '#billingAddress-localityInput', 'input[autocomplete*="address-level2" i]', 'input[name="billingLocality"]'],
  district: ['#billingDependentLocality', 'input[autocomplete*="address-level3" i]', 'input[name="billingDependentLocality"]'],
  zip: ['#billingPostalCode', '#billingAddress-postalCodeInput', 'input[autocomplete*="postal-code" i]', 'input[name="billingPostalCode"]'],
  cardNumber: ['#cardNumber', '#payment-numberInput', 'input[autocomplete="cc-number"]'],
  cardExpiry: ['#cardExpiry', '#payment-expiryInput', 'input[autocomplete="cc-exp"]'],
  cardCvc: ['#cardCvc', '#payment-cvcInput', 'input[autocomplete="cc-csc"]']
} as const

export type FieldKey = keyof typeof FILL_RULES

/** 一个可执行脚本的上下文（主页面 / 同进程子帧 / 跨进程 iframe） */
export interface FrameRunner {
  label: string
  sessionId: string
  contextId?: number
}

const randInt = (min: number, max: number): number => Math.floor(min + Math.random() * (max - min))
const sleepJitter = (min: number, max: number): Promise<void> => sleep(randInt(min, max))

/**
 * 字符 → CDP 按键描述。
 *
 * key/code/vk 三个字段都要对得上，页面和风控侧看到的才是一个正常的物理按键。
 * 只覆盖支付表单实际会出现的字符（字母、数字、空格和几个符号）；
 * 其它字符（中文等）退回「只带 text 的 keyDown」，由浏览器按输入法文本插入处理。
 */
interface KeyStroke {
  key: string
  code: string
  vk: number
  /** 需要按住 Shift 的字符（大写字母、常见符号） */
  shift?: boolean
  /** 带 text 的 keyDown 才会触发 keypress；非打印键为空 */
  text?: string
}

const KEY_STROKES: Record<string, KeyStroke> = (() => {
  const map: Record<string, KeyStroke> = {}
  for (let i = 0; i < 26; i++) {
    const lower = String.fromCharCode(97 + i)
    const upper = lower.toUpperCase()
    map[lower] = { key: lower, code: `Key${upper}`, vk: 65 + i, text: lower }
    map[upper] = { key: upper, code: `Key${upper}`, vk: 65 + i, shift: true, text: upper }
  }
  for (let i = 0; i <= 9; i++) {
    map[String(i)] = { key: String(i), code: `Digit${i}`, vk: 48 + i, text: String(i) }
  }
  const symbols: Array<[string, string, number]> = [
    [' ', 'Space', 32],
    ['-', 'Minus', 189],
    ['/', 'Slash', 191],
    ['.', 'Period', 190],
    [',', 'Comma', 188],
    ['@', 'Digit2', 50],
    ['#', 'Digit3', 51],
    ['+', 'Equal', 187],
    ['(', 'Digit9', 57],
    [')', 'Digit0', 48],
    ["'", 'Quote', 222],
    ['&', 'Digit7', 55]
  ]
  for (const [ch, code, vk] of symbols) {
    // 符号在美式布局里大多要按 Shift
    const needsShift = !/[a-z0-9]/.test(ch) && ch !== ' '
    map[ch] = { key: ch, code, vk, ...(needsShift ? { shift: true } : {}), text: ch }
  }
  return map
})()

/** 取字符对应的按键描述；表里没有的字符走纯文本插入 */
function keyStrokeFor(ch: string): KeyStroke {
  return (
    KEY_STROKES[ch] ?? {
      key: ch,
      code: '',
      vk: 0,
      text: ch
    }
  )
}

/**
 * 字段值的容错比较。
 *
 * Stripe 的卡输入框会边输入边格式化：卡号被插成 "4242 4242 4242 4242"，
 * 有效期把 "0934" 变成 "09/34"。按原样逐字符比较会一律判失败，
 * 于是调用方以为没填进去、下一轮又重填一遍——用户看到的就是卡号三个框
 * 被反复过了一遍。这里按「数字序列相同」比较，只对确实含数字的值放宽。
 */
function fieldValueMatches(got: string, want: string): boolean {
  if (got === want) return true
  // 纯文本字段（姓名、城市）必须完全一致，否则空串之间会被误判为相等
  if (!/\d/.test(want)) return false
  const digits = (s: string): string => s.replace(/\D/g, '')
  return digits(got) === digits(want) && digits(want).length > 0
}

/**
 * 一个已连接页面的控制器。
 *
 * 只做三件事：读页面状态、把文字敲进指定字段、选中下拉项。
 * 不点提交按钮、不碰 3DS —— 这两步留给用户自己确认。
 */
export class PaymentPage {
  private readonly cdp: CdpConnection
  private readonly sessionId: string
  /** 跨进程 iframe 的会话：sessionId → 是否已启用 Runtime */
  private readonly childSessions = new Set<string>()
  private readonly enabledRuntime = new Set<string>()
  /** 同进程子帧的默认执行上下文：frameId → contextId */
  private readonly frameContexts = new Map<string, number>()
  /** 上一次鼠标落点，作为下一次移动轨迹的起点；没有则随机取一个 */
  private lastPointer: { x: number; y: number } | null = null

  constructor(private readonly instance: BrowserInstance) {
    this.cdp = instance.cdp
    this.sessionId = instance.sessionId
  }

  /** 打开调试域并开始跟踪 iframe；重复调用无副作用 */
  async bootstrap(): Promise<void> {
    /*
     * 先挂事件再 enable：Runtime.enable 会立刻把当前已有的执行上下文成批推过来，
     * 反过来的话这批事件就全丢了，之后只能在页面重新导航时碰运气。
     */
    this.cdp.on('Target.attachedToTarget', (params, eventSessionId) => {
      // 只认本页面发起的自动附加（浏览器级事件没有 sessionId）
      if (eventSessionId !== this.sessionId) return
      const childSession = String(params.sessionId || '')
      if (!childSession) return
      this.childSessions.add(childSession)
      void this.cdp
        .send('Runtime.enable', {}, childSession, 8000)
        .then(() => this.enabledRuntime.add(childSession))
        .catch(() => this.childSessions.delete(childSession))
    })

    // 跨进程 iframe 被销毁时，对应会话也一起作废
    this.cdp.on('Target.detachedFromTarget', (params, eventSessionId) => {
      if (eventSessionId !== this.sessionId) return
      const childSession = String(params.sessionId || '')
      if (childSession) this.childSessions.delete(childSession)
    })

    // 同进程子帧：记录默认执行上下文，后面可以直接在里面执行脚本
    this.cdp.on('Runtime.executionContextCreated', (params, eventSessionId) => {
      if (eventSessionId !== this.sessionId) return
      const ctx = params.context as
        | { id?: number; auxData?: { frameId?: string; isDefault?: boolean } }
        | undefined
      const frameId = ctx?.auxData?.frameId
      if (!ctx?.id || !frameId || !ctx.auxData?.isDefault) return
      this.frameContexts.set(frameId, ctx.id)
    })

    this.cdp.on('Runtime.executionContextDestroyed', (params, eventSessionId) => {
      if (eventSessionId !== this.sessionId) return
      const id = Number(params.executionContextId)
      for (const [frameId, contextId] of this.frameContexts) {
        if (contextId === id) this.frameContexts.delete(frameId)
      }
    })

    // 整页导航后旧上下文全部失效
    this.cdp.on('Runtime.executionContextsCleared', (_params, eventSessionId) => {
      if (eventSessionId !== this.sessionId) return
      this.frameContexts.clear()
    })

    if (!this.enabledRuntime.has(this.sessionId)) {
      await this.cdp.send('Page.enable', {}, this.sessionId)
      await this.cdp.send('Runtime.enable', {}, this.sessionId)
      this.enabledRuntime.add(this.sessionId)
    }

    try {
      await this.cdp.send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        this.sessionId,
        8000
      )
    } catch {
      // 老版本 Chrome 不支持时退化为只填主页面
    }
  }

  /** 在指定上下文执行脚本 */
  private async evalIn<T>(
    runner: FrameRunner,
    expression: string,
    timeoutMs = 15_000
  ): Promise<T> {
    const res = await this.cdp.send<{
      result?: { value?: unknown }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        ...(runner.contextId ? { contextId: runner.contextId } : {})
      },
      runner.sessionId,
      timeoutMs
    )
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description || res.exceptionDetails.text || '页面脚本异常'
      )
    }
    return res.result?.value as T
  }

  /** 主页面 */
  private get mainRunner(): FrameRunner {
    return { label: 'main', sessionId: this.sessionId }
  }

  /** 所有可执行的上下文：主页面 → 同进程子帧 → 跨进程 iframe */
  private runners(): FrameRunner[] {
    const list: FrameRunner[] = [this.mainRunner]
    for (const [frameId, contextId] of this.frameContexts) {
      list.push({ label: `frame:${frameId.slice(0, 8)}`, sessionId: this.sessionId, contextId })
    }
    for (const sessionId of this.childSessions) {
      list.push({ label: `oif:${sessionId.slice(0, 8)}`, sessionId })
    }
    return list
  }

  /** 依次在各上下文里试，返回第一个满足条件的结果 */
  private async firstMatch<T>(
    expression: string,
    accept: (value: T) => boolean
  ): Promise<{ runner: FrameRunner; value: T } | null> {
    for (const runner of this.runners()) {
      try {
        const value = await this.evalIn<T>(runner, expression, 6000)
        if (accept(value)) return { runner, value }
      } catch {
        // 帧已销毁 / 上下文失效：跳过
      }
    }
    return null
  }

  /** 读页面状态。
   *
   *  探测顺序有讲究：先读主页面（绝大多数情况表单就在主页面），
   *  主页面已经有表单就直接返回，不必再去扫子帧。
   *  只有主页面没有表单时才去子帧找——新版 Stripe 把表单放进 js.stripe.com
   *  的跨进程 iframe，但那种情况下主页面通常也没有表单，扫一遍就能确定。
   *
   *  早先的写法是「先在所有上下文里找表单，找不到再读主页面」，
   *  等于每轮探测都要把所有帧跑一遍，页面加载期间帧一多就明显拖慢。
   */
  async probe(): Promise<{ probe: PageProbe; runner: FrameRunner }> {
    const main = await this.evalIn<PageProbe>(this.mainRunner, PROBE_JS, 8000)
    if (main.form) return { probe: main, runner: this.mainRunner }

    const hit = await this.firstMatch<PageProbe>(PROBE_JS, (p) => !!p?.form)
    if (hit) return { probe: hit.value, runner: hit.runner }

    return { probe: main, runner: this.mainRunner }
  }

  /** 当前地址（任何上下文读到即可，用于判断是否还在结算页） */
  async bringToFront(): Promise<void> {
    try {
      await this.cdp.send('Page.bringToFront', {}, this.sessionId, 5000)
    } catch {
      /* 窗口可能已经关掉 */
    }
  }

  /** 重新加载当前页面（Chrome 网络错误页时用它自动重试一次） */
  async reload(): Promise<void> {
    await this.cdp.send('Page.reload', { ignoreCache: false }, this.sessionId, 30_000)
  }

  /**
   * 用真实鼠标点击元素中心，把焦点交过去。
   *
   * 比 JS focus() 多出 pointerdown / mousedown / pointerup / mouseup / click
   * 这一串事件——真实点输入框必然会产生这些，只调 focus() 的话页面只能收到一个
   * focus 事件，是个明显的程序化特征。
   *
   * 鼠标先沿一条带缓动的轨迹移到目标再按下，不瞬移。
   * @returns 点击后元素是否拿到了焦点
   */
  private async clickElement(
    runner: FrameRunner,
    rules: string
  ): Promise<{ found: boolean; value: string; focused: boolean }> {
    const rect = await this.evalIn<{
      found: boolean
      x: number
      y: number
      value: string
      focused: boolean
    }>(runner, `(${RECT_JS})(${JSON.stringify(rules)})`, 6000)

    if (!rect?.found) return { found: false, value: '', focused: false }

    // 目标点抖一下，避免每次都点正中心
    const x = Math.round(rect.x + (Math.random() * 6 - 3))
    const y = Math.round(rect.y + (Math.random() * 6 - 3))
    await this.moveMouseTo(x, y, runner.sessionId)

    await this.cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 },
      runner.sessionId,
      5000
    )
    await sleepJitter(50, 120)
    await this.cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 },
      runner.sessionId,
      5000
    )

    await sleepJitter(60, 150)
    // 回读焦点状态：点击可能落在遮罩上没生效
    const check = await this.evalIn<{ found: boolean; value: string; focused: boolean }>(
      runner,
      `(${VALUE_JS})(${JSON.stringify(rules)})`,
      6000
    ).catch(() => null)
    return {
      found: !!check?.found,
      value: check?.value || '',
      focused: !!check?.focused
    }
  }

  /**
   * 鼠标沿缓动轨迹移动到目标点。
   *
   * 直线瞬移是脚本特征；真人移动有加速-减速、轻微过冲和手抖。
   * 这里用 ease-out 插值 + 垂直方向的正弦抖动，步数和耗时都带随机。
   */
  private async moveMouseTo(x: number, y: number, sessionId: string): Promise<void> {
    const from = this.lastPointer ?? {
      x: Math.max(0, x + randInt(-160, 160)),
      y: Math.max(0, y + randInt(-120, 120))
    }
    const dist = Math.hypot(x - from.x, y - from.y)
    // 距离越远步数越多，但给个上下限，免得横跨整屏发上百条命令
    const steps = Math.max(5, Math.min(28, Math.round(dist / 16) + randInt(-2, 3)))
    const stepMs = Math.max(6, Math.min(40, (dist / randInt(500, 1200)) * 1000 / steps))
    // 远距离时先稍微冲过目标再回拉，像真人收不住手
    const overshoot = dist > 60 ? Math.min(14, dist * 0.06) : 0
    const ux = dist > 0 ? (x - from.x) / dist : 0
    const uy = dist > 0 ? (y - from.y) / dist : 0
    const jitterAmp = Math.min(5, 1 + dist / 140)
    const phase = Math.random() * Math.PI * 2
    const freq = 1.4 + Math.random() * 1.6

    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      // ease-out：起步快、接近目标时减速
      const eased = 1 - (1 - t) * (1 - t)
      const wobble = Math.sin(t * Math.PI * freq + phase) * jitterAmp * (1 - t)
      const px = Math.round(from.x + (x + ux * overshoot - from.x) * eased - uy * wobble)
      const py = Math.round(from.y + (y + uy * overshoot - from.y) * eased + ux * wobble)
      await this.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: px, y: py, buttons: 0 },
        sessionId,
        5000
      )
      await sleep(stepMs * (0.6 + Math.random() * 0.8))
    }

    // 过冲后回到真实目标
    if (overshoot > 0) {
      await this.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x, y, buttons: 0 },
        sessionId,
        5000
      )
      await sleepJitter(20, 60)
    }

    this.lastPointer = { x, y }
  }

  /**
   * 逐字符真实按键输入。
   *
   * 走 Input.dispatchKeyEvent（keyDown → keyUp），页面收到的是一套完整的
   * keydown / keypress / beforeinput / input / keyup 事件序列，和真人敲键盘一致。
   * 之前用的 Input.insertText 只有 beforeinput / input，缺了按键事件——
   * 任何监听键盘的检测都能一眼看出不是人在打字。
   *
   * sessionId 决定发给哪个目标：跨进程 iframe 的字段要发到它自己的会话。
   */
  private async typeText(text: string, sessionId: string): Promise<void> {
    for (const ch of text) {
      const stroke = keyStrokeFor(ch)
      const base = {
        key: stroke.key,
        code: stroke.code,
        windowsVirtualKeyCode: stroke.vk,
        nativeVirtualKeyCode: stroke.vk,
        modifiers: stroke.shift ? 8 : 0
      }
      await this.cdp.send(
        'Input.dispatchKeyEvent',
        {
          type: stroke.text ? 'keyDown' : 'rawKeyDown',
          ...base,
          ...(stroke.text ? { text: stroke.text, unmodifiedText: stroke.text } : {})
        },
        sessionId,
        5000
      )
      // 按下到抬起的间隔：多数 25–70ms，像正常打字节奏
      await sleepJitter(25, 70)
      await this.cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', ...base },
        sessionId,
        5000
      )
      // 字间停顿：多数 40–110ms，偶尔一个长停顿（换手、思考）
      await sleep(Math.random() < 0.09 ? randInt(140, 320) : randInt(40, 110))
    }
  }

  /**
   * 填一个字段。
   * 已有值的字段直接跳过，绝不覆盖用户手填的内容。
   * @returns 'filled' | 'skipped' | 'missing'
   */
  async fillField(key: FieldKey, text: string): Promise<'filled' | 'skipped' | 'missing'> {
    const rules = JSON.stringify(FILL_RULES[key])

    // 先只读定位：已有值就直接跳过，不碰焦点
    const located = await this.firstMatch<{ found: boolean; value: string }>(
      `(${LOCATE_JS})(${JSON.stringify(rules)})`,
      (v) => !!v?.found
    )
    if (!located) return 'missing'
    if (located.value.value.trim().length > 0) return 'skipped'

    // 确定要打字了才点击聚焦，避免焦点在已填好的字段间乱跳
    const clicked = await this.clickElement(located.runner, rules).catch(() => null)
    if (!clicked?.focused) {
      // 真实点击没拿到焦点（可能被遮罩挡住）：退回 JS 聚焦，再不行才 DOM 写入
      const focused = await this.evalIn<{ found: boolean; focused: boolean }>(
        located.runner,
        `(${FOCUS_JS})(${JSON.stringify(rules)})`,
        6000
      ).catch(() => null)
      if (!focused?.focused) {
        return this.setValueDirect(located.runner, rules, text)
      }
    }

    // 输入命令要发到「字段所在的那个会话」：跨进程 iframe 有自己的 sessionId
    const targetSession = located.runner.sessionId
    await this.typeText(text, targetSession)
    await sleepJitter(80, 200)

    const check = await this.evalIn<{ found: boolean; value: string }>(
      located.runner,
      `(${VALUE_JS})(${JSON.stringify(rules)})`,
      6000
    ).catch(() => null)
    // 页面自己格式化过的值（4242 4242 / 09/34）也算填成功
    if (check && fieldValueMatches(check.value, text)) return 'filled'

    return this.setValueDirect(located.runner, rules, text)
  }

  /** DOM 兜底写入：原生 setter + input/change，React 受控输入也认 */
  private async setValueDirect(
    runner: FrameRunner,
    rules: string,
    text: string
  ): Promise<'filled' | 'missing'> {
    const fallback = await this.evalIn<{ found: boolean; value: string }>(
      runner,
      `(${SET_VALUE_JS})(${JSON.stringify({ rulesJson: rules, text })})`,
      6000
    ).catch(() => null)
    return fallback && fieldValueMatches(fallback.value, text) ? 'filled' : 'missing'
  }

  /** 把国家选成中国（CN）。已经是中国时直接返回 true */
  async ensureCountry(): Promise<boolean> {
    const { probe } = await this.probe()
    const current = (probe.country.value || '').toLowerCase()
    if (current.includes('china') || current.includes('中国') || current === 'cn') return true

    const payload = {
      sel: '#billingCountry, #billingAddress-countryInput',
      autoContains: 'country',
      value: 'CN',
      matchWords: ['china', '中国']
    }
    const hit = await this.firstMatch<{ ok: boolean }>(
      `(${SELECT_JS})(${JSON.stringify(payload)})`,
      (v) => !!v?.ok
    )
    if (hit) {
      // 选完国家后 Stripe 会重渲染省份列表，等它一下
      await sleepJitter(500, 900)
      return true
    }
    return false
  }

  /**
   * 选中省份。
   * 省份列表要等国家变成 CN 之后才填充，第一项是占位符，所以要求 option > 1。
   */
  async ensureProvince(provinceZh: string, provinceEn: string): Promise<boolean> {
    const { probe } = await this.probe()
    const current = probe.province.value || ''
    if (current.includes(provinceZh) || current.toLowerCase().includes(provinceEn.toLowerCase())) {
      return true
    }
    if (probe.province.options <= 1) return false

    const payload = {
      sel: '#billingAdministrativeArea, #billingAddress-administrativeAreaInput',
      autoContains: 'address-level1',
      value: provinceZh,
      matchWords: [provinceEn.toLowerCase(), provinceZh]
    }
    const hit = await this.firstMatch<{ ok: boolean }>(
      `(${SELECT_JS})(${JSON.stringify(payload)})`,
      (v) => !!v?.ok
    )
    if (hit) {
      await sleepJitter(250, 550)
      return true
    }
    return false
  }

  /**
   * 填账单地址。
   * classic 布局：line1 = 街道，另有独立的区字段；
   * 新版 iframe 布局：line1 = 区，line2 = 街道，没有独立区字段。
   */
  async fillAddress(address: {
    name: string
    zip: string
    city: string
    district: string
    street: string
  }, useIframeLayout: boolean): Promise<Record<string, string>> {
    const plan: Array<[FieldKey, string]> = useIframeLayout
      ? [
          ['name', address.name],
          ['line1', address.district],
          ['line2', address.street],
          ['city', address.city],
          ['zip', address.zip]
        ]
      : [
          ['name', address.name],
          ['line1', address.street],
          ['city', address.city],
          ['district', address.district],
          ['zip', address.zip]
        ]

    const result: Record<string, string> = {}
    for (const [key, value] of plan) {
      result[key] = await this.fillField(key, value)
      await sleepJitter(150, 400)
    }
    return result
  }

  /** 填卡号 / 有效期 / 安全码；有效期传 MMYY，让页面自己格式化成 MM/YY */
  async fillCard(card: { number: string; expiry: string; cvc: string }): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    result.cardNumber = await this.fillField('cardNumber', card.number)
    await sleepJitter(200, 450)
    result.cardExpiry = await this.fillField('cardExpiry', card.expiry)
    await sleepJitter(200, 450)
    result.cardCvc = await this.fillField('cardCvc', card.cvc)
    return result
  }
}
