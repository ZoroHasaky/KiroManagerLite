/**
 * 极简 CDP 客户端。
 *
 * 只用 Node 内置的全局 WebSocket（Node 22+ / Electron 44 都有），不引 puppeteer
 * 或 ws 之类的依赖：这套代码只需要「发命令 / 收事件」两件事，自己写反而可控，
 * 也能保证每条命令都有超时，页面卡住时不会把主进程拖死。
 *
 * 协议是 CDP 的 flatten 形态：命令和事件都走同一条浏览器级连接，
 * 归属某个页面时消息里带 sessionId。
 */

/** CDP 协议错误（Chrome 侧返回的 error 对象） */
export class CdpError extends Error {
  readonly code?: number
  readonly data?: string

  constructor(message: string, code?: number, data?: string) {
    super(message)
    this.name = 'CdpError'
    this.code = code
    this.data = data
  }
}

interface PendingCommand {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type CdpListener = (params: Record<string, unknown>, sessionId?: string) => void

/** WebSocket 的最小接口，避免把 undici 的类型带进主进程产物 */
interface SocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, handler: (event: unknown) => void): void
}

export class CdpConnection {
  private readonly socket: SocketLike
  private readonly pending = new Map<number, PendingCommand>()
  private readonly listeners = new Map<string, Set<CdpListener>>()
  private readonly closeHandlers = new Set<(reason: string) => void>()
  private nextId = 1
  private closed = false
  private closeReason = ''

  private constructor(socket: SocketLike) {
    this.socket = socket
  }

  static connect(url: string, timeoutMs = 15_000): Promise<CdpConnection> {
    const Ctor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket
    if (!Ctor) return Promise.reject(new Error('当前运行时没有 WebSocket，无法连接 Chrome 调试端口'))

    return new Promise((resolve, reject) => {
      let settled = false
      const socket = new Ctor(url)
      const connection = new CdpConnection(socket)
      // 先挂监听再等 open：早到的事件不能丢
      connection.start()

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          socket.close()
        } catch {
          /* 连接没建立起来，关不掉也无所谓 */
        }
        reject(new Error('连接 Chrome 调试端口超时'))
      }, timeoutMs)

      socket.addEventListener('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(connection)
      })
      socket.addEventListener('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error('连接 Chrome 调试端口失败'))
      })
    })
  }

  private start(): void {
    this.socket.addEventListener('message', (event) => {
      const raw = (event as { data?: unknown }).data
      if (typeof raw === 'string') this.onMessage(raw)
    })
    this.socket.addEventListener('close', () => this.failAll(this.closeReason || '调试连接已关闭'))
    this.socket.addEventListener('error', () => this.failAll('调试连接出错'))
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** 发一条命令；sessionId 为空表示发给浏览器本身（例如 Browser.close / Target.*） */
  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 20_000
  ): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError(this.closeReason || '调试连接已关闭'))

    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)

      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })

      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** 订阅事件，返回取消订阅函数 */
  on(method: string, listener: CdpListener): () => void {
    let set = this.listeners.get(method)
    if (!set) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(listener)
    return () => set?.delete(listener)
  }

  /** 连接断开（或主动 close）时回调一次 */
  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  close(): void {
    this.failAll(this.closeReason || '调试连接已关闭')
    try {
      this.socket.close()
    } catch {
      /* 已经断开 */
    }
  }

  private onMessage(raw: string): void {
    let message: {
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: unknown
      error?: { message?: string; code?: number; data?: string }
      sessionId?: string
    }
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(
          new CdpError(
            message.error.message || `${pending.method} 失败`,
            message.error.code,
            message.error.data
          )
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (!message.method) return
    const set = this.listeners.get(message.method)
    if (!set?.size) return
    for (const listener of set) {
      try {
        listener(message.params ?? {}, message.sessionId)
      } catch {
        /* 单个监听器出错不影响其它监听器 */
      }
    }
  }

  private failAll(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new CdpError(reason))
    }
    this.pending.clear()
    for (const handler of this.closeHandlers) {
      try {
        handler(reason)
      } catch {
        /* 回调异常不影响清理 */
      }
    }
  }
}
