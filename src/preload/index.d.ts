import type {
  Account,
  AccountGroup,
  AccountSnapshot,
  AccountStoreData,
  AccountUsage,
  AppInfo,
  AppSettings,
  AuthMethod,
  BackupScheduleStatus,
  DataBackupSummary,
  BrowserOpenInfo,
  BuilderIdStartInfo,
  ChatTestChunk,
  ChatTestInput,
  ChatTestResult,
  ChatTestResponse,
  ExportBundle,
  IpcResult,
  KiroModelInfo,
  LocalKiroCredentials,
  LoginPollResult,
  OnlineLoginCredentials,
  RefreshTokenResult,
  IpInfo,
  SiteTestId,
  SiteTestResult,
  SocialCallbackPayload,
  LogQuery,
  LogQueryResult,
  PaymentAddress,
  PackAssetInfo,
  PackDownloadProgress,
  PaymentStartInput,
  PaymentUpdate,
  RendererPackStatus,
  SubscriptionEntry,
  SubscriptionPlan,
  SwitchToFreeResult,
  TrayAction,
  TraySnapshot,
  UpdateCheckResult,
  UsageHistoryEntry,
  VerifyCredentialsInput,
  XlsxSheet
} from '../shared/types'

export interface Api {
  md5: (text: string) => string

  loadAccounts: () => Promise<IpcResult<AccountStoreData>>
  saveAccounts: (data: AccountStoreData) => Promise<IpcResult>
  deleteAccounts: (ids: string[]) => Promise<IpcResult<{
    accounts: AccountStoreData
    removed: number
  }>>

  verifyCredentials: (input: VerifyCredentialsInput) => Promise<IpcResult<AccountSnapshot>>
  refreshAccountToken: (account: Account) => Promise<IpcResult<RefreshTokenResult>>
  checkAccountStatus: (
    account: Account
  ) => Promise<IpcResult<AccountSnapshot> & { banned?: boolean }>
  /** 用该账号凭证在系统 Chrome 的无痕窗口打开 Kiro 官网后台 */
  openAccountPortal: (account: Account) => Promise<IpcResult<{ url: string; browser: string }>>
  /** 查订阅入口：已订阅返回 Stripe 账单管理链接，未订阅返回可开通档位 */
  getSubscriptionEntry: (account: Account) => Promise<IpcResult<SubscriptionEntry>>
  /** 为指定档位生成 Stripe 结算链接；rejectSubscribed 为真时已订阅的账号直接报错 */
  createSubscriptionCheckout: (
    account: Account,
    subscriptionType: string,
    rejectSubscribed?: boolean
  ) => Promise<IpcResult<{ url: string }>>
  /** 只查可开通档位（不判断是否已订阅） */
  listSubscriptionPlans: (account: Account) => Promise<IpcResult<SubscriptionPlan[]>>
  /** 取管理门户链接并用系统浏览器的无痕窗口打开；门户里可取消订阅 / 改支付方式 */
  openSubscriptionPortal: (
    account: Account
  ) => Promise<IpcResult<BrowserOpenInfo & { url: string }>>
  /** 用内置浏览器打开链接 */
  openInAppBrowser: (url: string, title?: string) => Promise<IpcResult<{ url: string }>>

  // 应用内支付：拉起外部 Chrome，自动填账单地址与卡信息
  /** 可选的账单省份（中文名） */
  getPaymentProvinces: () => Promise<IpcResult<string[]>>
  /** 生成随机账单地址；province 为空则随机省份 */
  generatePaymentAddress: (province?: string) => Promise<IpcResult<PaymentAddress>>
  /** 打开浏览器并开始自动填充 */
  openPayment: (payload: PaymentStartInput) => Promise<IpcResult<{ browser: string }>>
  /** 关闭当前支付会话 */
  closePayment: () => Promise<IpcResult>
  /** 自动填充进度推送；返回取消订阅函数 */
  onPaymentUpdate: (handler: (payload: PaymentUpdate) => void) => () => void

  /** 把账号订阅切到 Kiro Free（Stripe 门户，纯 HTTP，不启动浏览器） */
  switchSubscriptionToFree: (account: Account) => Promise<IpcResult<SwitchToFreeResult>>

  /** 读取本机已登录的 Kiro 凭证，供添加账号时预填（只读，不修改任何文件） */
  readLocalKiroCredentials: () => Promise<IpcResult<LocalKiroCredentials>>

  getUsageHistory: (accountId: string) => Promise<IpcResult<UsageHistoryEntry[]>>
  /** 最近半小时 / 一小时实际消耗的积分 */
  getRecentUsage: (
    subjectIds: string[]
  ) => Promise<IpcResult<Record<string, { m30: number; m60: number }>>>
  recordUsagePoint: (
    accountId: string,
    usage: AccountUsage
  ) => Promise<IpcResult<{ recorded: boolean }>>
  clearUsageHistory: (accountId: string) => Promise<IpcResult<{ cleared: number }>>

  listKiroModels: (input: {
    accessToken: string
    profileArn?: string
    region?: string
    idp?: string
    authMethod?: AuthMethod
  }) => Promise<IpcResult<KiroModelInfo[]>>
  chatTest: (requestId: string, input: ChatTestInput) => Promise<ChatTestResponse>
  cancelChatTest: (requestId: string) => Promise<IpcResult>
  onChatChunk: (handler: (payload: ChatTestChunk) => void) => () => void

  startBuilderIdLogin: (
    region?: string,
    privateMode?: boolean
  ) => Promise<IpcResult<BuilderIdStartInfo>>
  pollBuilderIdLogin: () => Promise<IpcResult<LoginPollResult>>
  startSocialLogin: (
    provider: 'Google' | 'Github',
    privateMode?: boolean
  ) => Promise<IpcResult<BrowserOpenInfo & { loginUrl: string }>>
  completeSocialLogin: (
    code: string,
    state: string
  ) => Promise<IpcResult<OnlineLoginCredentials>>
  startEnterpriseLogin: (
    startUrl: string,
    region?: string,
    privateMode?: boolean
  ) => Promise<IpcResult<BrowserOpenInfo & { authorizeUrl: string; expiresIn: number }>>
  pollEnterpriseLogin: () => Promise<IpcResult<LoginPollResult>>
  cancelLogin: () => Promise<IpcResult>
  onSocialCallback: (handler: (payload: SocialCallbackPayload) => void) => () => void

  exportToFile: (
    content: string,
    filename: string
  ) => Promise<IpcResult<{ saved: boolean; path?: string }>>
  /** 导出为 Excel 工作簿；主进程负责生成二进制并弹保存对话框 */
  exportToXlsx: (
    sheet: XlsxSheet,
    filename: string
  ) => Promise<IpcResult<{ saved: boolean; path?: string }>>
  /** 打包导出：把多个文件装进一个 zip 落盘 */
  exportToZip: (
    bundle: ExportBundle,
    filename: string
  ) => Promise<IpcResult<{ saved: boolean; path?: string; count?: number }>>
  writeClipboard: (text: string) => void
  readClipboard: () => Promise<IpcResult<string>>

  getSettings: () => Promise<IpcResult<AppSettings>>
  saveSettings: (patch: Partial<AppSettings>) => Promise<IpcResult<AppSettings>>
  getAppInfo: () => Promise<IpcResult<AppInfo>>
  checkUpdate: () => Promise<IpcResult<UpdateCheckResult>>

  /** 资源包热更新状态 */
  getPackStatus: () => Promise<IpcResult<RendererPackStatus>>
  /** 下载指定版本的资源包；进度通过 onPackProgress 事件推送 */
  downloadPack: (
    version: string,
    asset: Pick<PackAssetInfo, 'url' | 'sha256' | 'size'>
  ) => Promise<IpcResult<{ file: string }>>
  installPack: (version: string) => Promise<IpcResult<{ version: string }>>
  discardPack: (version?: string) => Promise<IpcResult<RendererPackStatus>>
  /** 重启应用，让已安装的资源包生效 */
  relaunchForUpdate: () => Promise<IpcResult<{ relaunched: boolean; version: string }>>
  /** 回退到安装包内置版本（重启后生效） */
  rollbackPack: () => Promise<IpcResult<RendererPackStatus>>
  onPackProgress: (
    handler: (payload: PackDownloadProgress & { version: string }) => void
  ) => () => void

  /** 当前出口 IP，走应用代理设置 */
  getIpInfo: () => Promise<IpcResult<IpInfo>>
  /** 测试单个网站的连通性与延迟 */
  testSite: (id: SiteTestId) => Promise<IpcResult<SiteTestResult>>

  openExternal: (url: string, privateMode?: boolean) => Promise<IpcResult<BrowserOpenInfo>>
  showPath: (target: 'store' | 'backup' | 'logs') => Promise<IpcResult>
  /** 导出全部数据为 .json；用户取消时 saved 为 false */
  exportAllData: () => Promise<IpcResult<{ saved: boolean; path?: string }>>
  /** 选择 .json 并返回摘要；用户取消时 data 为 null */
  pickImportData: () => Promise<IpcResult<DataBackupSummary | null>>
  /** 用刚选的备份替换全部数据，成功后应用立即重启（这个调用通常等不到返回） */
  applyImportData: () => Promise<IpcResult>
  /** 清除全部数据，成功后应用立即重启 */
  resetAllData: () => Promise<IpcResult>
  /** 备份计划状态：上次 / 下次执行时间、备份目录里的份数 */
  getBackupStatus: () => Promise<IpcResult<BackupScheduleStatus>>
  /** 立即执行一次备份（和计划到点时完全一样） */
  runBackupNow: () => Promise<IpcResult<BackupScheduleStatus>>
  onBackupStatus: (handler: (status: BackupScheduleStatus) => void) => () => void

  queryLogs: (query: LogQuery) => Promise<IpcResult<LogQueryResult>>
  clearLogs: () => Promise<IpcResult>
  exportLogs: (query: LogQuery) => Promise<IpcResult<{ content: string }>>
  onLogAppended: (handler: (total: number) => void) => () => void

  syncTray: (snapshot: TraySnapshot) => Promise<IpcResult>
  onTrayAction: (handler: (action: TrayAction) => void) => () => void
  onAppNavigate: (handler: (target: string) => void) => () => void

  quitApp: () => Promise<IpcResult>
  onConfirmQuit: (handler: () => void) => () => void
  onConfirmClose: (handler: () => void) => () => void
  closeWindowChoice: (choice: 'minimize' | 'quit' | 'cancel') => Promise<IpcResult>
}

declare global {
  interface Window {
    api: Api
  }
}
