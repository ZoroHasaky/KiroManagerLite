import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  app,
  type IpcMainInvokeEvent
} from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { extname, join } from 'path'
import { checkAccountStatus, refreshAccountToken, verifyCredentials } from './accountService'
import { openInAppUrl } from './kiroPortal'
import { openAccountPortal } from './externalPortal'
import { createSubscriptionCheckout, getSubscriptionEntry, listSubscriptionPlans } from './kiroSubscription'
import {
  closePaymentSession,
  startPaymentSession,
  type PaymentStartInput
} from './payment/session'
import { generateBillingAddress, isValidProvince, listProvinces } from './payment/addressGen'
import { switchSubscriptionToFree } from './subscriptionDowngrade'
import { openSubscriptionPortal } from './subscriptionPortal'
import { readLocalKiroCredentials } from './kiroAuth'
import { chatTraceOf, listKiroModels, streamKiroChat } from './kiroChat'
import {
  cancelLogin,
  shutdownLoginServers,
  unregisterProtocol,
  completeSocialLogin,
  pollBuilderIdLogin,
  pollEnterpriseLogin,
  startBuilderIdLogin,
  startEnterpriseLogin,
  startSocialLogin
} from './onlineLogin'
import { isHttpUrl, openUrl } from './browser'
import { setTraySnapshot, setTrayEnabled } from './tray'
import { setUsageApiType } from './kiroApi'
import { setInAppLocale } from './kiroPortal'
import { setProxyConfig } from './net'
import { applyThemeMode } from './appearance'
import { checkForUpdate } from './updater'
import { getIpInfo, testSite } from './networkCheck'
import {
  applyBackup,
  buildBackup,
  clearRendererStorage,
  parseBackup,
  summarizeBackup,
  wipeLocalData
} from './dataBackup'
import {
  backupStatus,
  clearBackupState,
  onBackupSettingsChanged,
  runBackupNow,
  stopBackupScheduler
} from './backupScheduler'
import { clearLogs, exportLogs, getLogDir, log, queryLogs } from './logger'
import {
  activatePack,
  currentVersion,
  discardPack,
  downloadPack,
  installPack,
  packStatus,
  pendingPackVersion,
  rollbackPack
} from './packManager'
import { sendToRenderer } from './utils'
import { buildXlsx, buildZip } from './xlsxWriter'
import { errorMessage } from '../shared/errors'
import {
  deleteAccountData,
  viewAccountData,
  getBackupDir,
  ensureBackupDir,
  getSettings,
  getStorePath,
  flushStore,
  setAccountData,
  setSettings
} from './store'
import {
  appendUsagePoint,
  clearUsageHistory,
  getRecentUsage,
  getUsageHistory,
  pruneUsageHistory
} from './usageHistory'
import { DEFAULT_REGION } from '../shared/regions'
import type {
  Account,
  AccountStoreData,
  AccountUsage,
  AppSettings,
  ChatTestInput,
  IpcResult,
  LogQuery,
  SiteTestId,
  TraySnapshot,
  VerifyCredentialsInput,
  ExportBundle,
  XlsxSheet
} from '../shared/types'

function ok<T>(data?: T): IpcResult<T> {
  return { success: true, data }
}

function fail(error: unknown): IpcResult<never> {
  return { success: false, error: errorMessage(error) }
}

/**
 * 注册 IPC 通道：统一把未捕获异常收敛成 { success: false, error }，
 * 各 handler 只负责返回结果，不必逐个写 try/catch。
 */
function handle(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...(args as never[]))
    } catch (e) {
      return fail(e)
    }
  })
}

/** 把设置里与主进程相关的部分同步下去 */
export function applyRuntimeSettings(settings: AppSettings): void {
  applyThemeMode(settings.themeMode)
  setUsageApiType(settings.usageApiType)
  setProxyConfig(settings.proxyEnabled, settings.proxyUrl)
  setInAppLocale(settings.portalLocale)
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  // ============ 数据持久化 ============
  // 返回值经 IPC 序列化后渲染进程拿到的就是副本，这里不必再深拷贝一次
  handle('accounts:load', () => ok(viewAccountData()))

  handle('accounts:save', async (_e, data: AccountStoreData) => {
    await setAccountData(data)
    // 账号被删掉后它的积分日志就没人看了，顺手清掉
    pruneUsageHistory((data.accounts ?? []).map((a) => a.id))
    return ok()
  })

  handle('accounts:delete', async (_e, ids: string[]) => {
    const result = await deleteAccountData(Array.isArray(ids) ? ids : [])
    if (result.removed) {
      pruneUsageHistory(result.accounts.accounts.map((account) => account.id))
    }
    return ok(result)
  })

  // ============ 积分变化日志 ============
  handle('usage:history', (_e, accountId: string) => ok(getUsageHistory(accountId)))
  // 列表按「最近半小时 / 一小时消耗」排序时批量取值；API Key 的 id 要带 key: 前缀
  handle('usage:recent', (_e, subjectIds: string[]) =>
    ok(getRecentUsage(Array.isArray(subjectIds) ? subjectIds : []))
  )

  handle('usage:record', (_e, accountId: string, usage: AccountUsage) =>
    ok({ recorded: appendUsagePoint(accountId, usage) })
  )

  handle('usage:clear-history', (_e, accountId: string) =>
    ok({ cleared: clearUsageHistory(accountId) })
  )

  // ============ 账号操作 ============
  handle('accounts:verify', async (_e, input: VerifyCredentialsInput) =>
    ok(await verifyCredentials(input))
  )

  handle('accounts:refresh-token', async (_e, account: Account) =>
    ok(await refreshAccountToken(account))
  )

  handle('accounts:open-portal', async (_e, account: Account) =>
    ok(await openAccountPortal(account))
  )

  // ============ 订阅 ============
  handle('accounts:subscription-entry', async (_e, account: Account) =>
    ok(await getSubscriptionEntry(account))
  )

  handle(
    'accounts:subscription-checkout',
    async (_e, account: Account, subscriptionType: string, rejectSubscribed?: boolean) =>
      ok(await createSubscriptionCheckout(account, subscriptionType, !!rejectSubscribed))
  )

  handle('accounts:subscription-plans', async (_e, account: Account) =>
    ok(await listSubscriptionPlans(account))
  )

  /** 取该账号的 Stripe 管理门户链接，并用系统浏览器的无痕窗口打开 */
  handle('accounts:open-subscription-portal', async (_e, account: Account) =>
    ok(await openSubscriptionPortal(account))
  )

  /** 用内置浏览器打开链接（Stripe 账单 / 结算页） */
  handle('app:open-in-app-browser', (_e, url: string, title?: string) =>
    ok(openInAppUrl(url, title || 'Kiro'))
  )

  // ============ 应用内支付（外部 Chrome + CDP 自动填表） ============
  /** 省份列表，供支付弹窗的下拉选择 */
  handle('payment:provinces', () => ok(listProvinces()))

  /** 生成一条随机账单地址；传省份则在该省内随机 */
  handle('payment:generate-address', (_e, province?: string) =>
    ok(generateBillingAddress(province && isValidProvince(province) ? province : undefined))
  )

  /** 打开外部浏览器并开始自动填充；返回用的哪个浏览器 */
  handle('payment:open', async (_e, payload: PaymentStartInput) =>
    ok(await startPaymentSession(payload, getWindow))
  )

  /** 关闭当前支付会话 */
  handle('payment:close', async () => {
    await closePaymentSession(getWindow)
    return ok()
  })

  // ============ 订阅降级 ============
  /** 把账号订阅切到 Kiro Free（Stripe 门户，纯 HTTP） */
  handle('subscription:switch-to-free', async (_e, account: Account) =>
    ok(await switchSubscriptionToFree(account))
  )

  // 封禁需要额外回传 banned 标记，单独注册以保留该字段
  ipcMain.handle('accounts:check-status', async (_e, account: Account) => {
    try {
      const snapshot = await checkAccountStatus(account)
      return ok(snapshot)
    } catch (e) {
      const banned = (e as { isBanned?: boolean }).isBanned === true
      return { ...fail(e), banned }
    }
  })

  // ============ 账号测活（真实对话）============

  handle('kiro:list-models', async (_e, input: Parameters<typeof listKiroModels>[0]) =>
    ok(await listKiroModels(input))
  )

  // 一个请求一个 AbortController，避免 requestId 相同时相互取消
  const accountChatAborters = new Map<string, AbortController>()

  handle('kiro:chat-test', async (event, requestId: string, input: ChatTestInput) => {
    const controller = new AbortController()
    accountChatAborters.set(requestId, controller)
    try {
      const result = await streamKiroChat(
        input,
        {
          onDelta: (delta) => {
            // 渲染进程可能已经关闭弹窗，发送前确认还活着
            if (!event.sender.isDestroyed()) {
              event.sender.send('kiro:chat-chunk', { requestId, delta })
            }
          }
        },
        controller.signal
      )
      return ok(result)
    } catch (error) {
      // 失败也把官方原始返回带回去：空响应、异常帧、403 这些最需要看原文的恰恰是失败的情况
      return { ...fail(error), raw: chatTraceOf(error) }
    } finally {
      if (accountChatAborters.get(requestId) === controller) accountChatAborters.delete(requestId)
    }
  })

  handle('kiro:chat-cancel', (_e, requestId: string) => {
    accountChatAborters.get(requestId)?.abort(new Error('用户取消'))
    return ok()
  })

  // ============ 在线登录 ============
  handle('login:start-builder-id', async (_e, region?: string, privateMode?: boolean) =>
    ok(await startBuilderIdLogin(region || DEFAULT_REGION, privateMode))
  )

  handle('login:poll-builder-id', async () => ok(await pollBuilderIdLogin()))

  handle('login:start-social', async (_e, provider: 'Google' | 'Github', privateMode?: boolean) =>
    ok(await startSocialLogin(provider, privateMode))
  )

  handle('login:complete-social', async (_e, code: string, state: string) =>
    ok(await completeSocialLogin(code, state))
  )

  handle(
    'login:start-enterprise',
    async (_e, startUrl: string, region?: string, privateMode?: boolean) =>
      ok(await startEnterpriseLogin(startUrl, region || DEFAULT_REGION, privateMode))
  )

  handle('login:poll-enterprise', async () => ok(await pollEnterpriseLogin()))

  handle('login:cancel', () => {
    cancelLogin()
    return ok()
  })

  // ============ 文件导入导出 ============
  /** 保存对话框的类型筛选：与文件名扩展名一致的那一项排在最前 */
  function exportFilters(filename: string): { name: string; extensions: string[] }[] {
    const known = [
      { name: 'JSON', extensions: ['json'] },
      { name: '日志', extensions: ['log'] },
      { name: '文本', extensions: ['txt'] },
      { name: 'CSV', extensions: ['csv'] },
      { name: 'Excel 工作簿', extensions: ['xlsx'] }
    ]
    const ext = filename.split('.').pop()?.toLowerCase() ?? ''
    const matched = known.filter((f) => f.extensions.includes(ext))
    const rest = known.filter((f) => !f.extensions.includes(ext))
    return [...matched, ...rest, { name: '全部文件', extensions: ['*'] }]
  }

  /**
   * 落盘后一律在文件管理器里定位该文件。
   *
   * 导出的多是凭证类文件，用户下一步基本都要去拿它，省掉自己翻目录这一步。
   * 用 showItemInFolder 而不是 openPath：后者会直接用默认程序打开文件内容，
   * 凭证文件被自动弹开并不是我们想要的效果。
   */
  function revealExported(filePath: string): void {
    // 定位失败不该让导出本身算失败，文件已经写成功了
    try {
      shell.showItemInFolder(filePath)
    } catch {
      /* ignore */
    }
  }

  handle('file:export', async (_e, content: string, filename: string) => {
    const result = await dialog.showSaveDialog(getWindow()!, {
      title: filename.endsWith('.log') ? '导出日志' : '导出账号数据',
      defaultPath: filename,
      // 匹配文件名扩展名的类型必须排在首位，否则 macOS 会按第一项再追加一次扩展名
      filters: exportFilters(filename)
    })
    if (result.canceled || !result.filePath) return ok({ saved: false })
    await writeFile(result.filePath, content, 'utf-8')
    revealExported(result.filePath)
    return ok({ saved: true, path: result.filePath })
  })

  // 打包导出：把多个文件塞进一个 zip 再落盘
  handle('file:export-zip', async (_e, bundle: ExportBundle, filename: string) => {
    const entries = bundle.files ?? []
    if (!entries.length) throw new Error('没有可打包的内容')

    const result = await dialog.showSaveDialog(getWindow()!, {
      title: '导出压缩包',
      defaultPath: filename,
      filters: [
        { name: '压缩包', extensions: ['zip'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return ok({ saved: false })
    await writeFile(result.filePath, buildZip(entries))
    revealExported(result.filePath)
    return ok({ saved: true, path: result.filePath, count: entries.length })
  })

  // xlsx 是二进制 zip，走不了上面的 utf-8 通道；渲染层只传结构化数据，落盘前在主进程组装
  handle('file:export-xlsx', async (_e, sheet: XlsxSheet, filename: string) => {
    const result = await dialog.showSaveDialog(getWindow()!, {
      title: '导出表格',
      defaultPath: filename,
      filters: exportFilters(filename)
    })
    if (result.canceled || !result.filePath) return ok({ saved: false })
    await writeFile(result.filePath, buildXlsx(sheet))
    revealExported(result.filePath)
    return ok({ saved: true, path: result.filePath })
  })

  // ============ 设置 ============
  handle('settings:get', () => {
    const settings = getSettings()
    applyRuntimeSettings(settings)
    return ok(settings)
  })

  handle('settings:save', (_e, patch: Partial<AppSettings>) => {
    const merged = setSettings(patch)
    applyRuntimeSettings(merged)
    // 托盘开关变化时动态启用 / 关闭托盘图标
    if (patch.trayEnabled !== undefined) setTrayEnabled(patch.trayEnabled)
    // 备份计划的开关或周期变了就重新排程；只改保留份数不用（下次备份时按新值清理）
    if (patch.backupEnabled !== undefined || patch.backupCycle !== undefined) onBackupSettingsChanged()
    return ok(merged)
  })

  // ============ 应用 ============
  handle('app:info', () =>
    ok({
      version: currentVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      storePath: getStorePath(),
      dataDir: app.getPath('userData'),
      backupDir: getBackupDir()
    })
  )

  // 检查更新：对比 GitHub 最新 Release 的版本号，只给结论不做下载
  handle('app:check-update', async () => ok(await checkForUpdate()))

  // ============ 资源包热更新 ============
  /*
   * 下载与安装分成两步而不是一步到位：下载失败的代价只是一次重试，
   * 安装则会改动 userData 里的版本目录与 active.json，两者失败面完全不同。
   * 全部由用户在设置页手动触发，不做后台静默下载。
   */
  handle('update:pack-status', async () => ok(packStatus()))

  handle('update:pack-download', async (_e, version: unknown, asset: unknown) => {
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
      return fail('资源包版本号无效')
    }
    const info = asset as { url?: unknown; sha256?: unknown; size?: unknown } | undefined
    if (typeof info?.url !== 'string' || !/^https:\/\//i.test(info.url)) {
      return fail('资源包下载地址无效')
    }
    const file = await downloadPack(
      version,
      {
        url: info.url,
        sha256: typeof info.sha256 === 'string' && info.sha256 ? info.sha256 : undefined,
        size: typeof info.size === 'number' ? info.size : undefined
      },
      (progress) => sendToRenderer(getWindow(), 'update:pack-progress', { version, ...progress })
    )
    return ok(file)
  })

  handle('update:pack-install', async (_e, version: unknown) => {
    if (typeof version !== 'string' || !version) return fail('资源包版本号无效')
    const result = await installPack(version)
    return ok(result)
  })

  handle('update:pack-discard', async (_e, version: unknown) => {
    await discardPack(typeof version === 'string' && version ? version : undefined)
    return ok(packStatus())
  })

  /*
   * 重启并让已装好的资源包生效。
   *
   * 与 data:import 的重启不同，这里不需要手动停反代 / 交还协议：资源包只换代码，
   * 账号数据没变，正常退出流程该做的事照做即可。用 flushStore 确保窗口尺寸、
   * 设置这些刚写的东西落盘，然后 relaunch。
   */
  handle('update:relaunch', async () => {
    const pending = pendingPackVersion()
    if (pending) activatePack(pending)
    flushStore()
    if (!app.isPackaged) {
      // 开发模式下 relaunch 只会连到已停止的 dev server，与 data:import 的处理一致
      return ok({ relaunched: false, version: currentVersion() })
    }
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 300)
    return ok({ relaunched: true, version: pending ?? currentVersion() })
  })

  handle('update:pack-rollback', async () => {
    rollbackPack()
    return ok(packStatus())
  })

  // ============ 常用工具：网络检测 ============
  handle('tools:ip-info', async () => ok(await getIpInfo()))
  handle('tools:site-test', async (_e, id: SiteTestId) => ok(await testSite(id)))

  handle('app:open-external', async (_e, url: string, privateMode?: boolean) => {
    // 只放行 http(s)，避免被诱导打开本地程序或自定义协议
    if (!isHttpUrl(url)) return fail(new Error('仅支持 http/https 链接'))
    return ok(await openUrl(url, privateMode))
  })

  handle('tray:sync', (_e, data: TraySnapshot) => {
    setTraySnapshot(data)
    return ok()
  })

  /*
   * 剪贴板写入只能在主进程做：Electron 44 起 clipboard 模块不再暴露给渲染进程。
   * 写入本身是异步的（44 起 writeText 返回 Promise），要 await 后再回结果。
   */
  handle('clipboard:write', async (_e, text: string) => {
    await clipboard.writeText(typeof text === 'string' ? text : String(text ?? ''))
    return ok()
  })
  // 读剪贴板同理只能在主进程做（批量查询的「粘贴」按钮）
  handle('clipboard:read', async () => ok(await clipboard.readText()))

  handle('app:show-path', (_e, target: 'store' | 'backup' | 'logs') => {
    const paths = { store: app.getPath('userData'), backup: ensureBackupDir(), logs: getLogDir() }
    shell.openPath(paths[target] ?? paths.store)
    return ok()
  })

  // ============ 数据管理：整库导出 / 导入 / 清除 ============

  handle('backup:status', async () => ok(await backupStatus()))
  handle('backup:run', async () => ok(await runBackupNow()))

  /**
   * 导入、清除之后重启应用：各模块的内存缓存、定时器、已启动的网关与反代都还是旧数据，
   * 逐个通知它们重载容易漏，重启最可靠。
   *
   * 不走正常退出流程（will-quit 里会把内存里的旧用量、旧日志刷回磁盘，盖掉刚写入的数据），
   * 所以这里先手动做完退出时必须做的事：还原 Kiro IDE 端点、停反代、交还 kiro:// 协议，
   * 然后由调用方写数据，最后 app.exit 立即退出、不再给任何定时器运行的机会。
   */
  function stopServicesForRelaunch(): void {
    // 先停备份计划：导入 / 清除写数据的中途要是正好到点，会把半新半旧的数据打成一份备份
    stopBackupScheduler()
    cancelLogin()
    shutdownLoginServers()
    unregisterProtocol()
  }

  /*
   * 开发模式不能自己重启：界面跑在 electron-vite 的 dev server（localhost:5173）上，
   * 旧进程一退出它就跟着停了，relaunch 出来的新进程只能加载到一片白屏。
   * 所以开发时只退出，提示重新 npm run dev；打包后界面是本地文件，照常重启。
   */
  function relaunchNow(): void {
    if (!app.isPackaged) {
      dialog.showMessageBoxSync({
        type: 'info',
        title: 'Kiro Manager Lite',
        message: '数据已处理完成',
        detail: '开发模式下无法自动重启（dev server 会随应用一起退出），请重新运行 npm run dev。'
      })
      flushStore()
      app.exit(0)
      return
    }
    // app.exit 不走 will-quit：导入写进主库的数据要在这里立即落盘
    flushStore()
    app.relaunch()
    app.exit(0)
  }

  /** 导出数据为 .json，保存后在文件管理器里定位它 */
  handle('data:export', async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
    const result = await dialog.showSaveDialog(getWindow()!, {
      title: '导出数据',
      defaultPath: join(app.getPath('downloads'), `kiro-manager-lite-${stamp}.json`),
      filters: [{ name: 'Kiro Manager Lite 数据', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return ok({ saved: false })
    // Windows 上用户改名时可能把后缀删了，补回来，否则导入时选不到
    const file = extname(result.filePath).toLowerCase() === '.json' ? result.filePath : `${result.filePath}.json`
    await writeFile(file, buildBackup(), 'utf8')
    revealExported(file)
    log('info', `[Backup] 已导出数据：${file}`)
    return ok({ saved: true, path: file })
  })

  /**
   * 选一份导出的 .json 并解析，返回摘要给界面确认；真正导入要再调 data:import-apply。
   * 解析结果暂存在主进程，渲染层传不进任意内容。
   */
  let pendingImport: ReturnType<typeof parseBackup> | null = null
  handle('data:import-pick', async () => {
    const result = await dialog.showOpenDialog(getWindow()!, {
      title: '导入数据',
      properties: ['openFile'],
      filters: [{ name: 'Kiro Manager Lite 数据', extensions: ['json'] }]
    })
    const file = result.filePaths[0]
    if (result.canceled || !file) return ok(null)
    // 对话框的过滤在部分平台可以被「所有文件」绕过，这里再卡一次后缀
    if (extname(file).toLowerCase() !== '.json') return fail(new Error('只支持导入 .json 数据文件'))
    pendingImport = parseBackup(await readFile(file, 'utf8'))
    return ok({ file, ...summarizeBackup(pendingImport) })
  })

  /** 把暂存文件里带了的部分写进本机（没带的保持现状），然后重启 */
  handle('data:import-apply', () => {
    if (!pendingImport) return fail(new Error('请先选择要导入的备份文件'))
    const file = pendingImport
    pendingImport = null
    log('info', '[Backup] 导入数据，应用将重启')
    stopServicesForRelaunch()
    applyBackup(file)
    relaunchNow()
    return ok()
  })

  /**
   * 清除全部数据，回到刚安装时的状态，然后重启。
   *
   * 先把本应用改过的外部配置还原：本地备份一删，就再也找不到改写前的原样了——
   * Kiro IDE 会一直指向已经不存在的本地网关，权限规则和桌面 agent 的配置也会残留。
   * 外部还原失败不中断清除（文件被用户删了、应用卸载了），只记日志。
   */
  handle('data:reset', async () => {
    log('info', '[Backup] 清除全部数据，应用将重启')
    await clearLogs()
    await clearRendererStorage().catch(() => undefined)
    stopServicesForRelaunch()
    wipeLocalData()
    clearBackupState()
    relaunchNow()
    return ok()
  })

  // ============ 系统日志 ============
  handle('log:query', (_e, query: LogQuery) => ok(queryLogs(query)))

  handle('log:clear', async () => {
    await clearLogs()
    return ok()
  })

  /** 导出当前筛选结果的纯文本，由渲染层再决定存文件还是复制 */
  handle('log:export', (_e, query: LogQuery) => ok({ content: exportLogs(query) }))

  // 渲染进程确认退出后真正退出。before-quit 会先置位退出标记，
  // 所以窗口 close 监听里的「最小化到托盘」不会把这次退出拦下来
  handle('app:quit', () => {
    app.quit()
    return ok()
  })
}
