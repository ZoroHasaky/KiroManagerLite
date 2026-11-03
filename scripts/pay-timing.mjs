/**
 * 支付页打开耗时实测。
 *
 * 按 src/main/payment/chrome.ts 的同一批参数启动 Chrome，分段计时：
 *   进程启动 → DevToolsActivePort → /json/version → WebSocket → attach
 *   → 首个可求值上下文 → 表单出现
 * 并回读页面 PerformanceResourceTiming，看主文档和 Stripe JS 各自的耗时。
 *
 * 用法：
 *   node scripts/pay-timing.mjs <url> [runs] [--cache]
 *   --cache  多轮之间复用同一个 --disk-cache-dir（复现生产行为，测共享缓存的效果）
 *            不加则每轮都是全新 profile + 无磁盘缓存（纯冷启动）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const url = args.find((a) => a.startsWith('http'))
const runsArg = args.find((a) => /^\d+$/.test(a))
const runs = Number(runsArg || 3)
const useCache = args.includes('--cache')

if (!url) {
  console.error('用法: node scripts/pay-timing.mjs <url> [runs] [--cache]')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = process.hrtime.bigint()
const now = () => Number(process.hrtime.bigint() - t0) / 1e6

function candidates() {
  const local = process.env.LOCALAPPDATA || ''
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  return [
    join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ]
}
const exe = candidates().find((p) => existsSync(p))
if (!exe) {
  console.error('没有找到 Chrome/Edge')
  process.exit(1)
}

const CHROME_ARGS = (userDataDir, cacheDir) => [
  '--remote-debugging-port=0',
  `--user-data-dir=${userDataDir}`,
  ...(cacheDir ? [`--disk-cache-dir=${cacheDir}`, '--disk-cache-size=268435456'] : []),
  '--no-first-run',
  '--no-default-browser-check',
  '--test-type',
  '--disable-blink-features=AutomationControlled',
  '--disable-component-update',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-client-side-phishing-detection',
  '--disable-features=Translate,MediaRouter,OptimizationHints',
  '--window-size=1280,900',
  url
]

async function waitPort(userDataDir, deadlineMs = 20000) {
  const file = join(userDataDir, 'DevToolsActivePort')
  const start = now()
  while (now() - start < deadlineMs) {
    if (existsSync(file)) {
      try {
        const n = Number(readFileSync(file, 'utf8').split('\n')[0].trim())
        if (Number.isInteger(n) && n > 0) return { port: n, at: now() }
      } catch {}
    }
    await sleep(50)
  }
  throw new Error('等不到调试端口')
}

function makeCdp(ws) {
  let nextId = 1
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (typeof m.id === 'number') {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
    } else {
      events.push(m)
    }
  })
  return {
    events,
    send(method, params = {}, sid, timeoutMs = 20000) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          pending.delete(id)
          reject(new Error(method + ' 超时'))
        }, timeoutMs)
        pending.set(id, {
          resolve: (v) => { clearTimeout(t); resolve(v) },
          reject: (e) => { clearTimeout(t); reject(e) }
        })
        ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }))
      })
    }
  }
}

async function runOnce(runIndex, userDataDir, cacheDir) {
  const marks = {}
  const coldStart = now()
  const m = (k) => { marks[k] = Math.round(now() - coldStart) }
  m('spawn')
  const proc = spawn(exe, CHROME_ARGS(userDataDir, cacheDir), { stdio: 'ignore' })
  let procExitAt = null
  proc.once('exit', () => { procExitAt = now() })

  let ws
  let cdp
  let sessionId
  try {
    const { port, at } = await waitPort(userDataDir)
    marks.portFile = Math.round(at - coldStart)

    let wsUrl = ''
    while (!wsUrl) {
      try {
        const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
        wsUrl = v.webSocketDebuggerUrl || ''
      } catch {}
      if (!wsUrl) await sleep(30)
      if (now() - coldStart > 15000) throw new Error('/json/version 一直不可用')
    }
    m('devtoolsReady')

    ws = new WebSocket(wsUrl)
    cdp = makeCdp(ws)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('ws error')), { once: true })
    })
    m('wsOpen')

    const { targetInfos } = await cdp.send('Target.getTargets')
    const page = targetInfos.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
    if (!page) throw new Error('没有 page target')
    const attached = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    sessionId = attached.sessionId
    m('attached')

    // 记录网络层：主文档和 js.stripe.com 的请求/响应/完成
    const net = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (!msg.method || msg.sessionId !== sessionId) return
      if (msg.method === 'Network.requestWillBeSent') {
        net.push({ id: msg.params.requestId, kind: 'req', url: msg.params.request.url, ts: now() - coldStart, type: msg.params.type })
      } else if (msg.method === 'Network.responseReceived') {
        const e = net.find((n) => n.id === msg.params.requestId)
        if (e) { e.respAt = now() - coldStart; e.status = msg.params.response.status; e.remote = msg.params.response.remoteIPAddress }
      } else if (msg.method === 'Network.loadingFinished') {
        const e = net.find((n) => n.id === msg.params.requestId)
        if (e) { e.doneAt = now() - coldStart; e.bytes = msg.params.encodedDataLength }
      } else if (msg.method === 'Network.loadingFailed') {
        const e = net.find((n) => n.id === msg.params.requestId)
        if (e) { e.failed = msg.params.errorText; e.doneAt = now() - coldStart }
      }
    })

    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    m('domainsEnabled')

    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId, 8000)
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
      return r.result.value
    }

    // 首个可求值上下文
    for (let i = 0; i < 400; i++) {
      try {
        const ok = await evalJs('1')
        if (ok === 1) { m('firstEval'); break }
      } catch {}
      await sleep(50)
    }

    // 轮询页面状态，记录关键节点
    const timeline = []
    let last = ''
    let formAt = null
    let readyStateCompleteAt = null
    for (let i = 0; i < 900; i++) {
      let state
      try {
        state = await evalJs(`(() => {
          const q = (s) => !!document.querySelector(s)
          return {
            rs: document.readyState,
            href: location.href.slice(0, 80),
            title: document.title,
            bodyLen: document.body ? document.body.innerText.trim().length : 0,
            inputs: document.querySelectorAll('input').length,
            iframes: document.querySelectorAll('iframe').length,
            form: q('#billingName') || q('#billingAddressLine1') || q('#billingAddress-nameInput') || q('#billingAddress-addressLine1Input') || q('input[autocomplete*="address-line1" i]'),
            country: q('#billingCountry') || q('#billingAddress-countryInput') || q('select[autocomplete*="country" i]'),
            skeleton: !!document.querySelector('[class*="LOADING-container" i], [class*="Skeleton" i]')
          }
        })()`)
      } catch {
        await sleep(100)
        continue
      }
      const sig = `${state.rs}|${state.form}|${state.country}|${state.skeleton}|${state.bodyLen > 0}`
      if (sig !== last) {
        last = sig
        timeline.push({ t: Math.round(now() - coldStart), ...state })
      }
      if (state.rs === 'complete' && readyStateCompleteAt === null) readyStateCompleteAt = now() - coldStart
      if (state.form && formAt === null) {
        formAt = now() - coldStart
        m('formReady')
        break
      }
      if (now() - coldStart > 90000) break
      await sleep(100)
    }

    // 页面自身的性能时间线
    let perf = null
    try {
      perf = await evalJs(`(() => {
        const nav = performance.getEntriesByType('navigation')[0]
        const res = performance.getEntriesByType('resource')
          .map(r => ({ name: r.name.replace(/\\?.*$/, '').slice(-70), start: Math.round(r.startTime), dur: Math.round(r.duration), size: r.transferSize, init: r.initiatorType }))
          .filter(r => r.dur > 0)
          .sort((a, b) => b.dur - a.dur).slice(0, 8)
        return {
          nav: nav ? {
            ttfb: Math.round(nav.responseStart), dl: Math.round(nav.domContentLoadedEventEnd),
            load: Math.round(nav.loadEventEnd), dur: Math.round(nav.duration),
            transfer: nav.transferSize, enc: nav.encodedBodySize
          } : null,
          res
        }
      })()`)
    } catch {}

    const docReq = net.find((n) => n.type === 'Document')
    const stripeReq = net.filter((n) => /js\.stripe\.com/.test(n.url))
    const failed = net.filter((n) => n.failed)

    return {
      marks,
      readyStateCompleteAt: readyStateCompleteAt && Math.round(readyStateCompleteAt),
      formAt: formAt && Math.round(formAt),
      doc: docReq ? { status: docReq.status, ip: docReq.remote, ttfb: Math.round((docReq.respAt ?? 0) - docReq.ts), done: Math.round((docReq.doneAt ?? 0) - docReq.ts), bytes: docReq.bytes } : null,
      stripe: stripeReq.map((r) => ({ url: r.url.replace(/\?.*$/, '').slice(-60), status: r.status, ms: Math.round((r.doneAt ?? 0) - r.ts), bytes: r.bytes, ip: r.remote })),
      failedRequests: failed.map((f) => ({ url: f.url.slice(0, 90), err: f.failed })),
      timeline,
      perf
    }
  } finally {
    try { if (cdp && sessionId) await cdp.send('Browser.close', {}, undefined, 3000) } catch {}
    try { ws?.close() } catch {}
    try { proc.kill() } catch {}
    await sleep(600)
  }
}

const baseDir = mkdtempSync(join(tmpdir(), 'kiro-pay-timing-'))
console.log('浏览器:', exe)
console.log('URL:', url.slice(0, 70) + '…')
console.log('模式:', useCache ? '每轮全新 profile + 共享磁盘缓存（生产行为）' : '每轮全新 profile、无磁盘缓存（纯冷启动）')
console.log('')

// 先测一次纯网络基线（不经过 Chrome）
console.log('── Node 直连基线 ──')
for (const target of ['https://js.stripe.com/v3/', 'https://checkout.stripe.com/']) {
  const t = Date.now()
  try {
    const r = await fetch(target, { signal: AbortSignal.timeout(15000) })
    await r.text()
    console.log(`  ${target}  ${Date.now() - t}ms  ${r.status}`)
  } catch (e) {
    console.log(`  ${target}  失败 ${Date.now() - t}ms  ${e.message}`)
  }
}
console.log('')

const results = []
const sharedCache = useCache ? join(baseDir, 'cache') : ''
if (sharedCache) mkdirSync(sharedCache, { recursive: true })
for (let i = 0; i < runs; i++) {
  // profile 每轮都是新的（cookie 隔离），只有缓存目录在 --cache 下复用
  const dir = mkdtempSync(join(baseDir, `run${i}-`))
  console.log(`── 第 ${i + 1} 轮 ──`)
  try {
    const r = await runOnce(i, dir, sharedCache)
    results.push(r)
    console.log('  分段耗时(ms):', JSON.stringify(r.marks))
    console.log('  表单可填:', r.formAt, 'ms   readyState=complete:', r.readyStateCompleteAt, 'ms')
    if (r.doc) console.log('  主文档:', JSON.stringify(r.doc))
    if (r.stripe.length) console.log('  js.stripe.com:', JSON.stringify(r.stripe))
    if (r.failedRequests.length) console.log('  失败请求:', JSON.stringify(r.failedRequests))
    if (r.perf?.nav) console.log('  页面 navigation:', JSON.stringify(r.perf.nav))
    if (r.perf?.res?.length) console.log('  最慢资源:', JSON.stringify(r.perf.res.slice(0, 5)))
    console.log('  状态时间线:')
    for (const t of r.timeline) {
      console.log(`    ${String(t.t).padStart(6)}ms  rs=${t.rs.padEnd(10)} form=${t.form ? 'Y' : '-'} country=${t.country ? 'Y' : '-'} skel=${t.skeleton ? 'Y' : '-'} inputs=${t.inputs} iframes=${t.iframes} body=${t.bodyLen}`)
    }
  } catch (e) {
    console.log('  失败:', e.message)
  }
  console.log('')
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log('── 汇总 ──')
console.log('轮次  spawn→端口  端口→DevTools  连接  表单可填')
for (let i = 0; i < results.length; i++) {
  const r = results[i]
  console.log(
    `  ${i + 1}    ${String(r.marks.portFile).padStart(5)}ms   ${String(r.marks.devtoolsReady - r.marks.portFile).padStart(5)}ms      ${String(r.marks.wsOpen).padStart(5)}ms  ${String(r.formAt).padStart(6)}ms`
  )
}
try { rmSync(baseDir, { recursive: true, force: true }) } catch {}
