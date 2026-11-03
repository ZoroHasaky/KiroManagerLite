/**
 * 验证拟人化输入：事件序列是否完整、值是否正确、鼠标轨迹是否产生。
 * 复刻 page.ts 的 clickElement + typeText 逻辑。
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a))

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="padding:40px">
<input id="cardNumber" autocomplete="cc-number" style="display:block;margin:20px 0;padding:10px;width:300px">
<input id="cardExpiry" autocomplete="cc-exp" style="display:block;margin:20px 0;padding:10px;width:300px">
<input id="billingName" autocomplete="cc-name" style="display:block;margin:20px 0;padding:10px;width:300px">
<script>
  window.__log = []
  window.__moves = 0
  for (const id of ['cardNumber','cardExpiry','billingName']) {
    const el = document.getElementById(id)
    for (const t of ['pointerdown','mousedown','pointerup','mouseup','click','focus',
                     'keydown','keypress','beforeinput','input','keyup']) {
      el.addEventListener(t, (e) => window.__log.push({
        id, type: t, trusted: e.isTrusted, key: e.key || ''
      }))
    }
  }
  // 卡号格式化：4 位分组
  const num = document.getElementById('cardNumber')
  num.addEventListener('input', () => {
    const d = num.value.replace(/\\D/g,'').slice(0,19)
    num.value = d.replace(/(.{4})/g,'$1 ').trim()
  })
  // 有效期格式化
  const exp = document.getElementById('cardExpiry')
  exp.addEventListener('input', () => {
    const d = exp.value.replace(/\\D/g,'').slice(0,4)
    exp.value = d.length > 2 ? d.slice(0,2)+'/'+d.slice(2) : d
  })
  // 统计鼠标移动
  document.addEventListener('mousemove', () => { window.__moves++ })
</script></body></html>`

const server = createServer((_q, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/`

const local = process.env.LOCALAPPDATA || ''
const exe = join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
const dir = mkdtempSync(join(tmpdir(), 'human-'))

const proc = spawn(exe, [
  '--remote-debugging-port=0', `--user-data-dir=${dir}`,
  '--no-first-run', '--no-default-browser-check', '--test-type',
  '--disable-blink-features=AutomationControlled',
  '--window-size=1000,800', url
], { stdio: 'ignore' })

let ws
try {
  const portFile = join(dir, 'DevToolsActivePort')
  let port = 0
  for (let i = 0; i < 200 && !port; i++) {
    if (existsSync(portFile)) {
      try {
        const n = Number(readFileSync(portFile, 'utf8').split('\n')[0].trim())
        if (Number.isInteger(n) && n > 0) port = n
      } catch {}
    }
    if (!port) await sleep(100)
  }
  let wsUrl = ''
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      wsUrl = v.webSocketDebuggerUrl || ''
    } catch {}
    if (!wsUrl) await sleep(150)
  }

  ws = new WebSocket(wsUrl)
  let id = 1
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
  const send = (method, params = {}, sid) => {
    const myId = id++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(myId); reject(new Error(method + ' 超时')) }, 15000)
      pending.set(myId, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
      ws.send(JSON.stringify({ id: myId, method, params, ...(sid ? { sessionId: sid } : {}) }))
    })
  }

  const { targetInfos } = await send('Target.getTargets')
  const page = targetInfos.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
  const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  const sid = attached.sessionId
  await send('Page.enable', {}, sid)
  await send('Runtime.enable', {}, sid)

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }
  for (let i = 0; i < 40; i++) {
    if (await evalJs(`!!document.querySelector('#cardNumber')`).catch(() => false)) break
    await sleep(150)
  }

  // ── 复刻 page.ts 的逻辑 ──
  const RULES = {
    cardNumber: '#cardNumber',
    cardExpiry: '#cardExpiry',
    billingName: '#billingName'
  }
  const RECT_JS = `((rulesJson) => {
    const rules = JSON.parse(rulesJson)
    const vis = (el) => !!el && el.offsetParent !== null
    for (const r of rules) {
      const el = document.querySelector(r)
      if (!vis(el)) continue
      el.scrollIntoView({ block: 'center' })
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      return { found: true, x: rect.x + rect.width/2, y: rect.y + rect.height/2, value: el.value || '', focused: document.activeElement === el }
    }
    return { found: false, x: 0, y: 0, value: '', focused: false }
  })`
  const VALUE_JS = `((rulesJson) => {
    const rules = JSON.parse(rulesJson)
    const vis = (el) => !!el && el.offsetParent !== null
    for (const r of rules) {
      const el = document.querySelector(r)
      if (vis(el)) return { found: true, value: el.value || '', focused: document.activeElement === el }
    }
    return { found: false, value: '', focused: false }
  })`

  const KEY_STROKES = (() => {
    const map = {}
    for (let i = 0; i < 26; i++) {
      const lower = String.fromCharCode(97 + i)
      const upper = lower.toUpperCase()
      map[lower] = { key: lower, code: 'Key'+upper, vk: 65+i, text: lower }
      map[upper] = { key: upper, code: 'Key'+upper, vk: 65+i, shift: true, text: upper }
    }
    for (let i = 0; i <= 9; i++) map[String(i)] = { key: String(i), code: 'Digit'+i, vk: 48+i, text: String(i) }
    map[' '] = { key: ' ', code: 'Space', vk: 32, text: ' ' }
    map['/'] = { key: '/', code: 'Slash', vk: 191, shift: true, text: '/' }
    map['-'] = { key: '-', code: 'Minus', vk: 189, text: '-' }
    return map
  })()
  const strokeFor = (ch) => KEY_STROKES[ch] || { key: ch, code: '', vk: 0, text: ch }

  let lastPointer = null
  async function moveMouseTo(x, y) {
    const from = lastPointer || { x: Math.max(0, x + randInt(-160,160)), y: Math.max(0, y + randInt(-120,120)) }
    const dist = Math.hypot(x - from.x, y - from.y)
    const steps = Math.max(5, Math.min(28, Math.round(dist/16) + randInt(-2,3)))
    const stepMs = Math.max(6, Math.min(40, (dist / randInt(500,1200)) * 1000 / steps))
    const overshoot = dist > 60 ? Math.min(14, dist*0.06) : 0
    const ux = dist > 0 ? (x-from.x)/dist : 0
    const uy = dist > 0 ? (y-from.y)/dist : 0
    const jitterAmp = Math.min(5, 1 + dist/140)
    const phase = Math.random()*Math.PI*2
    const freq = 1.4 + Math.random()*1.6
    for (let i = 1; i <= steps; i++) {
      const t = i/steps
      const eased = 1 - (1-t)*(1-t)
      const wobble = Math.sin(t*Math.PI*freq + phase) * jitterAmp * (1-t)
      const px = Math.round(from.x + (x + ux*overshoot - from.x)*eased - uy*wobble)
      const py = Math.round(from.y + (y + uy*overshoot - from.y)*eased + ux*wobble)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, buttons: 0 }, sid)
      await sleep(stepMs * (0.6 + Math.random()*0.8))
    }
    if (overshoot > 0) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }, sid)
      await sleep(randInt(20,60))
    }
    lastPointer = { x, y }
  }

  async function clickElement(rules) {
    const rect = await evalJs(`(${RECT_JS})(${JSON.stringify(rules)})`)
    if (!rect.found) return { found: false, focused: false }
    const x = Math.round(rect.x + (Math.random()*6-3))
    const y = Math.round(rect.y + (Math.random()*6-3))
    await moveMouseTo(x, y)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, sid)
    await sleep(randInt(50,120))
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, sid)
    await sleep(randInt(60,150))
    const check = await evalJs(`(${VALUE_JS})(${JSON.stringify(rules)})`)
    return { found: check.found, focused: check.focused }
  }

  async function typeText(text) {
    for (const ch of text) {
      const s = strokeFor(ch)
      const base = { key: s.key, code: s.code, windowsVirtualKeyCode: s.vk, nativeVirtualKeyCode: s.vk, modifiers: s.shift ? 8 : 0 }
      await send('Input.dispatchKeyEvent', {
        type: s.text ? 'keyDown' : 'rawKeyDown', ...base,
        ...(s.text ? { text: s.text, unmodifiedText: s.text } : {})
      }, sid)
      await sleep(randInt(25,70))
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sid)
      await sleep(Math.random() < 0.09 ? randInt(140,320) : randInt(40,110))
    }
  }

  // ── 执行 ──
  const cases = [
    ['cardNumber', '4234123412349562'],
    ['cardExpiry', '0934'],
    ['billingName', 'WANG XIN']
  ]
  for (const [key, value] of cases) {
    const rules = JSON.stringify([RULES[key]])
    const clicked = await clickElement(rules)
    console.log(`${key}: 点击聚焦=${clicked.focused}`)
    if (!clicked.focused) continue
    await typeText(value)
    await sleep(120)
    const got = await evalJs(`document.querySelector(${JSON.stringify(RULES[key])}).value`)
    console.log(`  值=${JSON.stringify(got)}`)
  }

  const log = JSON.parse(await evalJs(`JSON.stringify(window.__log)`))
  const moves = await evalJs(`window.__moves`)

  console.log('\n=== 事件统计 ===')
  for (const id of ['cardNumber', 'cardExpiry', 'billingName']) {
    const evts = log.filter((e) => e.id === id)
    const counts = {}
    for (const e of evts) counts[e.type] = (counts[e.type] || 0) + 1
    console.log(`  ${id}: ${JSON.stringify(counts)}`)
  }
  console.log(`  isTrusted 全为 true: ${log.every((e) => e.trusted)}`)
  console.log(`  鼠标移动事件数: ${moves}`)

  const cardEvts = log.filter((e) => e.id === 'cardNumber')
  const has = (t) => cardEvts.some((e) => e.type === t)
  const checks = {
    鼠标按下: has('mousedown'),
    鼠标抬起: has('mouseup'),
    点击: has('click'),
    指针按下: has('pointerdown'),
    键盘按下: has('keydown'),
    键盘字符: has('keypress'),
    键盘抬起: has('keyup'),
    全部可信: log.every((e) => e.trusted),
    有鼠标轨迹: moves > 5,
    卡号正确: (await evalJs(`document.querySelector('#cardNumber').value`)) === '4234 1234 1234 9562',
    有效期正确: (await evalJs(`document.querySelector('#cardExpiry').value`)) === '09/34',
    姓名正确: (await evalJs(`document.querySelector('#billingName').value`)) === 'WANG XIN'
  }
  console.log('\n=== 校验 ===')
  let pass = true
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${k}: ${v ? 'PASS' : 'FAIL'}`)
    if (!v) pass = false
  }
  console.log(`\n${pass ? '全部通过 ✓' : '存在失败项 ✗'}`)
  process.exitCode = pass ? 0 : 1

  try { await send('Browser.close') } catch {}
} finally {
  try { ws?.close() } catch {}
  try { proc.kill() } catch {}
  await sleep(800)
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  server.close()
}
