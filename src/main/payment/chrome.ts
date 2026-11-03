/**
 * 用系统安装的 Chrome（或 Edge）打开支付页，并通过 CDP 驱动它。
 *
 * 为什么不用内置 BrowserWindow：支付页要跑在用户真实的浏览器里，
 * 指纹、扩展、证书链都是原生 Chrome 的，和内置 Chromium 是两套东西。
 * 这里参考 AWSRegister 的做法——自己拉起进程、读调试端口、手写 CDP，
 * 不引入 puppeteer / playwright（它们会额外带一份 Chromium 和一大坨依赖）。
 *
 * 代理：沿用系统代理设置，出口由用户在本机代理里控制。
 * 不额外传 --proxy-server，也不禁用系统代理——Chromium 默认就会读系统配置。
 *
 * 缓存：每次都用全新的临时 profile（cookie / 登录态互不可见），但磁盘缓存
 * 指向应用数据目录下的固定位置。Stripe 的静态资源带 `max-age=31536000`，
 * 全新 profile 意味着每次都从零下载那几个 MB 的 JS——实测表单出现要 5–30 秒；
 * 复用缓存后稳定在 1–2 秒。缓存只存 HTTP 响应，不含 cookie 与本地存储。
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CdpConnection, CdpError } from './cdp'
import { sleep } from '../utils'

/** 候选浏览器：Chrome 优先，Edge 作为 Chromium 内核的兜底 */
interface BrowserCandidate {
  name: string
  path: string
}

function windowsCandidates(): BrowserCandidate[] {
  const local = process.env.LOCALAPPDATA || ''
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  return [
    { name: 'Google Chrome', path: join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Google Chrome', path: join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Google Chrome', path: join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Microsoft Edge', path: join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Microsoft Edge', path: join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') }
  ]
}

function macCandidates(): BrowserCandidate[] {
  return [
    { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' }
  ]
}

function linuxCandidates(): BrowserCandidate[] {
  return [
    { name: 'Google Chrome', path: '/usr/bin/google-chrome' },
    { name: 'Google Chrome', path: '/usr/bin/google-chrome-stable' },
    { name: 'Chromium', path: '/usr/bin/chromium' },
    { name: 'Chromium', path: '/usr/bin/chromium-browser' },
    { name: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' }
  ]
}

/**
 * 从注册表兜底找 Chrome：装在非标准路径时（绿色版、自定义目录）上面几个固定路径都会落空。
 * 只读 HKCU 的 App Paths，不动系统其它位置。
 */
function fromWindowsRegistry(): string | null {
  if (process.platform !== 'win32') return null
  for (const exe of ['chrome.exe', 'msedge.exe']) {
    try {
      const out = spawnSync(
        'reg',
        ['query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'],
        { encoding: 'utf8', timeout: 3000, windowsHide: true }
      )
      const match = String(out.stdout || '').match(/REG_SZ\s+(.+?)\s*$/m)
      const path = match ? match[1].trim().replace(/^"|"$/g, '') : ''
      if (path && existsSync(path)) return path
    } catch {
      /* 注册表项不存在 */
    }
  }
  return null
}

/** 找出可用的 Chromium 内核浏览器；一个都没有时返回 null */
export function resolveBrowserPath(configured?: string): BrowserCandidate | null {
  const explicit = (configured || '').trim().replace(/^"|"$/g, '')
  if (explicit && existsSync(explicit)) return { name: '自定义浏览器', path: explicit }

  const list =
    process.platform === 'win32'
      ? windowsCandidates()
      : process.platform === 'darwin'
        ? macCandidates()
        : linuxCandidates()

  for (const candidate of list) {
    if (existsSync(candidate.path)) return candidate
  }
  const registry = fromWindowsRegistry()
  return registry ? { name: 'Chromium 内核浏览器', path: registry } : null
}

export interface LaunchOptions {
  /** 浏览器可执行文件；不传则自动探测 */
  exePath?: string
  /** 首屏打开的地址 */
  url?: string
  width?: number
  height?: number
  /**
   * 跨会话复用的磁盘缓存目录。
   * 传了就用它，并自动创建；不传则完全不用磁盘缓存（等价于纯冷启动）。
   * 生产调用方传 app.getPath('userData') 下的子目录。
   */
  cacheDir?: string
  /**
   * 用无痕窗口打开。
   *
   * 临时 profile 关窗即删，本身已经不落痕迹；再加 --incognito 是为了让用户一眼
   * 看出「这个窗口不碰自己的浏览记录」，并且缓存、下载都只留在内存里。
   * 无痕模式有自己的内存缓存，`--disk-cache-dir` 对它不生效。
   */
  incognito?: boolean
  /**
   * Chromium 界面语言（BCP 47），对应 `--lang`。
   * 只影响 navigator.language 与页面内按浏览器语言的自适应，
   * Accept-Language 请求头另外由 CDP 设置。
   */
  lang?: string
}

/** 一个正在运行的浏览器实例 */
export interface BrowserInstance {
  /** 浏览器名（Chrome / Edge / ...），用于界面提示 */
  name: string
  cdp: CdpConnection
  /** 页面 target 的会话 id */
  sessionId: string
  targetId: string
  /** 用户是否自己关掉了窗口 */
  closedByUser: boolean
  /** 浏览器进程是否已经退出（不一定等于用户关窗，见下方 exit 监听） */
  processExited: boolean
  close(): Promise<void>
  /**
   * 同步杀掉浏览器进程。
   * 退出路径专用：will-quit 里等不了异步清理，而 Chrome 是 detached: false 的子进程，
   * 父进程退出并不会连带把它收掉，不在这里杀就会留下一个孤儿窗口。
   */
  killSync(): void
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: 8000,
        windowsHide: true,
        stdio: 'ignore'
      })
      return
    } catch {
      /* 退回普通 kill */
    }
  }
  try {
    process.kill(pid)
  } catch {
    /* 进程已退出 */
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 等 DevToolsActivePort 生成并读出端口。
 * 传 --remote-debugging-port=0 让系统分配端口，避免和用户已开的调试实例撞车。
 */
async function waitForPort(userDataDir: string, timeoutMs: number): Promise<number> {
  const file = join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        const first = readFileSync(file, 'utf8').split('\n')[0].trim()
        const port = Number(first)
        if (Number.isInteger(port) && port > 0) return port
      } catch {
        /* 文件正在写入，下一轮再读 */
      }
    }
    await sleep(100)
  }
  throw new Error('浏览器启动超时：没有生成调试端口（DevToolsActivePort）')
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  return (await res.json()) as T
}

/** 页面 target：排除 devtools 自身和后台页面 */
async function findPageTarget(cdp: CdpConnection): Promise<{ targetId: string } | null> {
  const res = await cdp.send<{
    targetInfos: Array<{ targetId: string; type: string; url: string }>
  }>('Target.getTargets')
  const page = res.targetInfos.find(
    (t) => t.type === 'page' && !t.url.startsWith('devtools://')
  )
  return page ? { targetId: page.targetId } : null
}

/**
 * 拉起浏览器并连上它的调试端口。
 *
 * 关键参数：
 *  - `--remote-debugging-port=0` 让系统分配端口；
 *  - `--user-data-dir=<临时目录>` 强制独立实例（否则会转发给已运行的主实例，
 *    调试端口就不会生效），退出后整个目录删掉，不留任何登录态；
 *  - 不传任何代理参数：跟随系统代理，出口交给本机代理控制；
 *  - `--test-type` + `--disable-blink-features=AutomationControlled`：
 *    前者压掉「不受支持的命令行标记」提示条（它会改变页面能读到的窗口几何差值），
 *    后者把 navigator.webdriver 置为 false。两者缺一不可，详见下方参数注释。
 */
export async function launchBrowser(options: LaunchOptions = {}): Promise<BrowserInstance> {
  const browser = resolveBrowserPath(options.exePath)
  if (!browser) {
    throw new Error('没有找到 Chrome 或 Edge，请先安装 Chrome 后再试')
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'kiro-pay-'))

  /*
   * 磁盘缓存单独指定，不放在临时 profile 里。
   *
   * 临时 profile 用完即删，缓存也就跟着没了，于是每次开支付窗口都要重新下载
   * Stripe 那几个 MB 的静态 JS（响应头是 max-age=31536000）。实测冷缓存下
   * 表单出现要 5–30 秒，热缓存稳定在 1–2 秒。
   *
   * 只共享 HTTP 缓存：cookie、localStorage、IndexedDB 仍在各自的临时 profile 里，
   * 不同账号之间不会串登录态。
   */
  let cacheDir = ''
  if (options.cacheDir) {
    try {
      mkdirSync(options.cacheDir, { recursive: true })
      cacheDir = options.cacheDir
    } catch {
      /* 目录建不出来就退回纯冷启动，不影响主流程 */
    }
  }

  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    ...(cacheDir ? [`--disk-cache-dir=${cacheDir}`, '--disk-cache-size=268435456'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    ...(options.incognito ? ['--incognito'] : []),
    ...(options.lang ? [`--lang=${options.lang}`] : []),
    /*
     * --test-type 有两个作用：
     *  1. 压掉 Chrome 顶部那行「您使用的是不受支持的命令行标记」提示条。
     *     这条提示虽然是浏览器 UI（不在页面 DOM 里、脚本读不到），但它会占掉
     *     浏览器顶部约 56px，使 outerHeight - innerHeight 明显偏离正常窗口，
     *     而几何差值恰恰是页面能读到的指纹。
     *  2. 它本身不改变任何页面可见属性，只影响 Chrome 的提示行为。
     * --disable-blink-features=AutomationControlled 用来把 navigator.webdriver
     * 置为 false；实测不加它这个值会变成 true，是页面能直接读到的强自动化信号。
     */
    '--test-type',
    '--disable-blink-features=AutomationControlled',
    /*
     * 这里刻意不再传 --disable-background-networking。
     *
     * 该参数会关掉 Chrome 的后台网络服务，连带禁掉 DNS 预取和 TCP/TLS 预连接，
     * 而支付窗口是全新 profile、没有连接复用，Stripe 的 CDN 每次都要从零建连。
     * 实测加载 js.stripe.com：带上它 4 次里出现 4.1s / 30.5s 的尖峰，
     * 去掉后稳定在 2.0–2.6s。它省的那点后台流量对一次性支付窗口毫无意义。
     *
     * --disable-component-update / --disable-sync 等保留：它们不影响页面加载，
     * 只是避免这个临时实例去同步书签、下载组件。
     */
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-client-side-phishing-detection',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    `--window-size=${options.width ?? 1280},${options.height ?? 900}`,
    options.url || 'about:blank'
  ]

  const proc: ChildProcess = spawn(browser.path, args, {
    stdio: 'ignore',
    windowsHide: false,
    detached: false
  })
  const pid = proc.pid ?? 0

  const instance: BrowserInstance = {
    name: browser.name,
    cdp: null as unknown as CdpConnection,
    sessionId: '',
    targetId: '',
    closedByUser: false,
    processExited: false,
    close: async () => undefined,
    killSync: () => {
      if (pid) killTree(pid)
    }
  }

  const cleanupDir = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true })
        return
      } catch {
        // Windows 上 Chrome 还占着文件句柄时删不掉，等一会儿重试
        await sleep(300)
      }
    }
  }

  try {
    const port = await waitForPort(userDataDir, 20_000)

    // 端口写出来后监听可能还没就绪，轮询 /json/version
    let wsUrl = ''
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
          `http://127.0.0.1:${port}/json/version`
        )
        if (version.webSocketDebuggerUrl) {
          wsUrl = version.webSocketDebuggerUrl
          break
        }
      } catch {
        /* 还没起来 */
      }
      await sleep(150)
    }
    if (!wsUrl) throw new Error('浏览器调试端点未就绪')

    const cdp = await CdpConnection.connect(wsUrl)
    instance.cdp = cdp

    let target = await findPageTarget(cdp)
    for (let i = 0; i < 20 && !target; i++) {
      await sleep(150)
      target = await findPageTarget(cdp)
    }
    if (!target) throw new Error('没有找到可控制的浏览器页面')

    const attached = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true
    })
    instance.targetId = target.targetId
    instance.sessionId = attached.sessionId

    proc.once('exit', () => {
      /*
       * 只记录「进程已经没了」这一事实，不直接当成「用户关了窗口」：
       * Chrome 在某些环境下会把启动器进程转交出去，原进程退出并不代表浏览器关闭。
       * 真正的关闭由调试连接断开（cdp.isClosed）与 Target.targetDestroyed 判定。
       */
      instance.processExited = true
    })
    cdp.on('Target.targetDestroyed', (params, sessionId) => {
      if (!sessionId && params.targetId === target.targetId) instance.closedByUser = true
    })

    instance.close = async (): Promise<void> => {
      try {
        if (!cdp.isClosed) await cdp.send('Browser.close', {}, undefined, 3000)
      } catch {
        /* 进程可能已经退出 */
      }
      cdp.close()
      if (pid) killTree(pid)
      for (let i = 0; i < 10 && pid && isAlive(pid); i++) await sleep(150)
      await cleanupDir()
    }

    return instance
  } catch (error) {
    // 启动失败要把进程和临时目录都收掉，否则会留一堆僵尸 Chrome
    try {
      instance.cdp?.close()
    } catch {
      /* 连接还没建立 */
    }
    if (pid) killTree(pid)
    await cleanupDir()
    throw error
  }
}

/** 关闭浏览器，吞掉所有异常（退出路径上不该因为清理失败中断） */
export async function closeBrowserQuietly(instance: BrowserInstance | null): Promise<void> {
  if (!instance) return
  try {
    await instance.close()
  } catch {
    /* 已经关掉了 */
  }
}

/** CDP 错误是否是「连接已断」这一类，调用方据此判断窗口被用户关掉了 */
export function isDisconnectedError(error: unknown): boolean {
  if (error instanceof CdpError) {
    return /调试连接已关闭|调试连接出错|Target closed|not attached/i.test(error.message)
  }
  return false
}
