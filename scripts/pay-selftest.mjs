/**
 * 支付模块的端到端自检（不依赖 Electron）。
 *
 * 用一个本地 HTTP 页面模拟 Stripe 结算页（同样的 id / autocomplete），
 * 走完整的「启动 Chrome → 连 CDP → 探测 → 选国家/省 → 填地址 → 填卡」链路，
 * 最后回读输入框的值确认真的填进去了。
 *
 * 运行：node scripts/pay-selftest.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// ── 本地假结算页 ──────────────────────────────────────────────────
const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Checkout</title>
<style>body{font-family:sans-serif;padding:24px;max-width:520px}input,select{display:block;width:100%;margin:6px 0 14px;padding:8px;box-sizing:border-box}</style>
</head><body>
<h2>Test Checkout</h2>
<label>Card number<input id="cardNumber" autocomplete="cc-number"></label>
<label>Expiry<input id="cardExpiry" autocomplete="cc-exp"></label>
<label>CVC<input id="cardCvc" autocomplete="cc-csc"></label>
<label>Country<select id="billingCountry" autocomplete="country">
  <option value="US">United States</option>
  <option value="CN">中国</option>
</select></label>
<label>Province<select id="billingAdministrativeArea" autocomplete="address-level1">
  <option value="">请选择</option>
  <option value="浙江省">浙江省 — Zhejiang Sheng</option>
  <option value="广东省">广东省 — Guangdong Sheng</option>
</select></label>
<label>Name<input id="billingName" autocomplete="cc-name"></label>
<label>Address line 1<input id="billingAddressLine1" autocomplete="address-line1"></label>
<label>City<input id="billingLocality" autocomplete="address-level2"></label>
<label>District<input id="billingDependentLocality" autocomplete="address-level3"></label>
<label>ZIP<input id="billingPostalCode" autocomplete="postal-code"></label>
<script>
  // 模拟 Stripe 的联动：选中国后才填充省份列表
  document.getElementById('billingCountry').addEventListener('change', (e) => {
    const sel = document.getElementById('billingAdministrativeArea')
    if (e.target.value === 'CN') {
      sel.innerHTML = '<option value="">请选择</option><option value="浙江省">浙江省 — Zhejiang Sheng</option><option value="广东省">广东省 — Guangdong Sheng</option>'
    }
  })
  // 模拟 Stripe 的有效期格式化：输入 MMYY 自动变 MM/YY
  const exp = document.getElementById('cardExpiry')
  exp.addEventListener('input', () => {
    const d = exp.value.replace(/\\D/g, '').slice(0, 4)
    exp.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d
  })
</script>
</body></html>`

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const url = `http://127.0.0.1:${port}/`
console.log('假结算页:', url)

// ── 浏览器启动（与 src/main/payment/chrome.ts 同一套参数）──────────
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
  server.close()
  process.exit(1)
}
console.log('浏览器:', exe)

const userDataDir = mkdtempSync(join(tmpdir(), 'kiro-pay-test-'))
const proc = spawn(exe, [
  '--remote-debugging-port=0',
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  '--window-size=1000,900',
  url
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitPort() {
  const file = join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        const n = Number(readFileSync(file, 'utf8').split('\n')[0].trim())
        if (Number.isInteger(n) && n > 0) return n
      } catch {}
    }
    await sleep(100)
  }
  throw new Error('等不到调试端口')
}

let cdp
let sessionId
try {
  const devPort = await waitPort()
  let wsUrl = ''
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${devPort}/json/version`)).json()
      wsUrl = v.webSocketDebuggerUrl || ''
    } catch {}
    if (!wsUrl) await sleep(150)
  }
  if (!wsUrl) throw new Error('调试端点未就绪')

  // 手写 CDP（与 src/main/payment/cdp.ts 同协议）
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (typeof m.id === 'number') {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
    }
  })
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('ws error')), { once: true })
  })
  cdp = {
    send(method, params = {}, sid, timeoutMs = 15000) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error(method + ' 超时')) }, timeoutMs)
        pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
        ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }))
      })
    },
    close: () => ws.close()
  }

  const { targetInfos } = await cdp.send('Target.getTargets')
  const page = targetInfos.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
  const attached = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  sessionId = attached.sessionId

  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }

  // 等页面渲染
  for (let i = 0; i < 40; i++) {
    const ready = await evalJs(`!!document.querySelector('#billingAddressLine1')`).catch(() => false)
    if (ready) break
    await sleep(150)
  }

  // ── 探测（同 PROBE_JS 的核心判定）──────────────────────────────
  const probe = await evalJs(`(() => {
    const vis = (el) => !!el && el.offsetParent !== null
    const val = (s) => { const el = document.querySelector(s); return vis(el) ? (el.value || '').trim() : null }
    return {
      form: !!document.querySelector('#billingAddressLine1'),
      country: val('#billingCountry'),
      province: val('#billingAdministrativeArea'),
      provinceOptions: document.querySelector('#billingAdministrativeArea').options.length
    }
  })()`)
  console.log('初始探测:', JSON.stringify(probe))
  if (!probe.form) throw new Error('没有探测到表单')

  // ── 选国家 CN（React 兼容的双事件）─────────────────────────────
  const countryRes = await evalJs(`(() => {
    const sel = document.querySelector('#billingCountry')
    const opt = [...sel.options].find(o => o.value === 'CN')
    if (!opt) return { ok: false }
    sel.value = opt.value
    sel.dispatchEvent(new Event('input', { bubbles: true }))
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, value: sel.options[sel.selectedIndex].text }
  })()`)
  console.log('选国家:', JSON.stringify(countryRes))
  await sleep(400)

  // ── 选省份 ────────────────────────────────────────────────────
  const provRes = await evalJs(`(() => {
    const sel = document.querySelector('#billingAdministrativeArea')
    if (sel.options.length <= 1) return { ok: false, reason: 'options 未填充' }
    const opt = [...sel.options].find(o => o.value === '浙江省')
    if (!opt) return { ok: false, reason: 'no-option' }
    sel.value = opt.value
    sel.dispatchEvent(new Event('input', { bubbles: true }))
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, value: sel.options[sel.selectedIndex].text }
  })()`)
  console.log('选省份:', JSON.stringify(provRes))

  // ── 填字段（聚焦 + Input.insertText，与 page.ts 同一路径）──────
  const FILL = {
    name: '#billingName',
    line1: '#billingAddressLine1',
    city: '#billingLocality',
    district: '#billingDependentLocality',
    zip: '#billingPostalCode',
    cardNumber: '#cardNumber',
    cardExpiry: '#cardExpiry',
    cardCvc: '#cardCvc'
  }
  const values = {
    name: 'WANG XIN',
    line1: 'Yongjiang Lu 78',
    city: 'Hangzhou Shi',
    district: 'Shangcheng Qu',
    zip: '310002',
    cardNumber: '4234123412349562',
    cardExpiry: '0934',
    cardCvc: '123'
  }

  for (const [key, sel] of Object.entries(FILL)) {
    const focused = await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)})
      if (!el || el.offsetParent === null) return { found: false }
      el.scrollIntoView({ block: 'center' })
      el.focus({ preventScroll: true })
      return { found: true, focused: document.activeElement === el }
    })()`)
    if (!focused.found || !focused.focused) {
      console.log(`  ${key}: 聚焦失败`, JSON.stringify(focused))
      continue
    }
    for (const ch of values[key]) {
      await cdp.send('Input.insertText', { text: ch }, sessionId)
      await sleep(25)
    }
    const got = await evalJs(`document.querySelector(${JSON.stringify(sel)}).value`)
    console.log(`  ${key}: ${JSON.stringify(got)} ${got === values[key] ? '✓' : got === values[key].replace(/(..)(..)/, '$1/$2') ? '✓(已格式化)' : '✗'}`)
  }

  // ── 汇总 ──────────────────────────────────────────────────────
  const final = await evalJs(`(() => {
    const g = (s) => document.querySelector(s).value
    return {
      country: g('#billingCountry'), province: g('#billingAdministrativeArea'),
      name: g('#billingName'), line1: g('#billingAddressLine1'), city: g('#billingLocality'),
      district: g('#billingDependentLocality'), zip: g('#billingPostalCode'),
      cardNumber: g('#cardNumber'), cardExpiry: g('#cardExpiry'), cardCvc: g('#cardCvc')
    }
  })()`)
  console.log('\n最终表单:', JSON.stringify(final, null, 2))

  const checks = {
    国家: final.country === 'CN',
    省份: final.province === '浙江省',
    姓名: final.name === values.name,
    街道: final.line1 === values.line1,
    城市: final.city === values.city,
    区: final.district === values.district,
    邮编: final.zip === values.zip,
    卡号: final.cardNumber === values.cardNumber,
    有效期: final.cardExpiry === '09/34',
    CVC: final.cardCvc === values.cardCvc
  }
  console.log('\n逐项校验:')
  let pass = true
  for (const [k, ok] of Object.entries(checks)) {
    console.log(`  ${k}: ${ok ? 'PASS' : 'FAIL'}`)
    if (!ok) pass = false
  }
  console.log(pass ? '\n全部通过 ✓' : '\n存在失败项 ✗')
  process.exitCode = pass ? 0 : 1
} catch (e) {
  console.error('自检失败:', e.message)
  process.exitCode = 1
} finally {
  try { await cdp?.send('Browser.close') } catch {}
  cdp?.close()
  try { proc.kill() } catch {}
  await sleep(800)
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  server.close()
}
