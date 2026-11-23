// ============================================
// 账户管理 —— 主进程 / 渲染进程共享类型
// ============================================
import { DEFAULT_REGION } from './regions'
import { DEFAULT_BACKUP_CYCLE, DEFAULT_BACKUP_KEEP, type BackupCycle } from './backupSchedule'
import { DEFAULT_PORTAL_LOCALE, type PortalLocale } from './portalLocale'
import type { ModelEffort } from './modelSchema'

export type IdpType = 'BuilderId' | 'Github' | 'Google' | 'Enterprise'

/**
 * 订阅档位。不含 Enterprise —— 那是登录方式（见 IdpType），
 * 一个账号可以「订阅 Power + 用 Enterprise 登录」，两者是正交的。
 */
export type SubscriptionType =
  | 'Free'
  | 'Pro'
  | 'Pro_Plus'
  | 'Pro_Max'
  | 'Power'
  | 'Teams'
  /** 学生号：教育邮箱认证后拿到的档位，接口标题形如 KIRO STUDENT */
  | 'Student'

export type AccountStatus = 'active' | 'expired' | 'error' | 'banned' | 'unknown'

export type AuthMethod = 'IdC' | 'social'

/** 账号凭证 */
export interface AccountCredentials {
  accessToken: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  startUrl?: string
  /** access token 过期时间戳（ms） */
  expiresAt: number
  authMethod?: AuthMethod
  provider?: IdpType
  profileArn?: string
}

/** 奖励额度 */
export interface BonusUsage {
  code: string
  name: string
  current: number
  limit: number
  expiresAt?: string
}

/** 资源（积分）详情 */
export interface ResourceDetail {
  resourceType?: string
  displayName?: string
  displayNamePlural?: string
  currency?: string
  unit?: string
  overageRate?: number
  overageCap?: number
  overageEnabled?: boolean
}

/** 用量 / 积分 */
export interface AccountUsage {
  current: number
  limit: number
  percentUsed: number
  lastUpdated: number
  baseLimit?: number
  baseCurrent?: number
  freeTrialLimit?: number
  freeTrialCurrent?: number
  freeTrialExpiry?: string
  bonuses?: BonusUsage[]
  nextResetDate?: string
  resourceDetail?: ResourceDetail
}

/** 积分变化日志的一条记录（以账号为单位保存） */
export interface UsageHistoryEntry {
  /** 记录时间戳（ms） */
  at: number
  /** 已用积分 */
  current: number
  /** 总额度 */
  limit: number
  /** 使用占比 0-1 */
  percentUsed: number
  /** 与上一条相比的增量，第一条为 0 */
  delta: number
  baseCurrent?: number
  baseLimit?: number
  freeTrialCurrent?: number
  freeTrialLimit?: number
  /** 奖励额度合计 */
  bonusCurrent?: number
  bonusLimit?: number
}

/** 订阅 */
export interface AccountSubscription {
  type: SubscriptionType
  title?: string
  rawType?: string
  /** 下次重置时间戳（ms） */
  expiresAt?: number
  daysRemaining?: number
}

/** 可开通的订阅档位（GetAvailableSubscriptionPlans 的一条） */
export interface SubscriptionPlan {
  /** 内部名，如 KIRO_PRO_PLUS，仅作为列表 key */
  name: string
  /** 下单时要回传的订阅类型，如 Q_DEVELOPER_STANDALONE_PRO_PLUS */
  subscriptionType: string
  /** 展示名，如 KIRO PRO+ */
  title: string
  amount: number
  currency: string
  /** 计费周期文案，如 per month */
  billingInterval: string
  featureHeader: string
  features: string[]
}

/**
 * 点订阅标签后一次问到的结果：只有可开通档位。
 *
 * 账单 / 支付链接不在这里，改由用户选中档位时调 createSubscriptionCheckout 现生成。
 * 原因见 kiroSubscription.getSubscriptionEntry 的注释。
 */
export interface SubscriptionEntry {
  plans: SubscriptionPlan[]
  /** 接口给的免责声明文案 */
  disclaimer: string[]
}

/** 应用内支付：生成的一条中国账单地址（英文形态，字段对应 Stripe 表单） */
export interface PaymentAddress {
  name: string
  zip: string
  city: string
  district: string
  street: string
  provinceZh: string
  provinceEn: string
}

/** 应用内支付：银行卡信息 */
export interface PaymentCardInfo {
  /** 纯数字卡号（12–19 位） */
  number: string
  /** 有效期 MMYY；填入页面后由 Stripe 自己格式化成 MM/YY */
  expiry: string
  /** 3–4 位安全码 */
  cvc: string
}

/** 应用内支付：打开浏览器并开始自动填充 */
export interface PaymentStartInput {
  accountId: string
  /** Stripe 结算链接 */
  url: string
  /** 账单地址；不传则随机生成 */
  address?: PaymentAddress
  /** 卡信息；不传则只填地址 */
  card?: PaymentCardInfo
}

/**
 * 自动填充的阶段。
 * opening / page-loading 是等待期，filling 表示表单已出现正在填，
 * filled 表示都填好了、等用户确认付款，其余是终态。
 */
export type PaymentPhase =
  | 'opening'
  | 'page-loading'
  | 'filling'
  | 'filled'
  | 'success'
  | 'expired'
  | 'error'
  | 'closed'

/** 主进程推给界面的填充进度 */
export interface PaymentUpdate {
  accountId: string
  phase: PaymentPhase
  detail?: string
}

/**
 * 把账号订阅切换到 Kiro Free 的结果。
 *
 * 除了成功/失败，还要区分「无需变更」的几种情况：
 * 已经是 Free、已安排周期末切换、已设置到期不续费——批量执行时它们都算正常结果，
 * 不该显示成失败让用户去重试。
 */
export interface SwitchToFreeResult {
  success: boolean
  error?: string
  /** 订阅本来就是 Free，未做变更 */
  alreadyFree?: boolean
  /** 已安排周期末切 Free（本次只读发现，未提交） */
  alreadyScheduled?: boolean
  /** 已设置到期不续费，下周期不会扣款，无需切换 */
  wontRenew?: boolean
  /** 本次实际提交了切换 */
  switched?: boolean
  /** 提交后按 Stripe 降级规则，下周期起才变 Free */
  scheduledToFree?: boolean
  /** 周期末变更生效时间戳（秒） */
  transitionAt?: number
  /** 切换前的计划名（读取失败时为价格 ID） */
  previousPlan?: string
  subId?: string
}

/** 账号实体 */
export interface Account {
  id: string
  email: string
  password?: string
  nickname?: string
  note?: string
  idp: IdpType
  /**
   * 旧版的单分组字段。新版写入时镜像为 groupIds 的第一个，供退回旧版本时保住至少一个分组。
   * 读写一律经 shared/itemGroups 的 groupIdsOf / withGroupIds，不要直接用。
   */
  groupId?: string
  /** 所属的全部分组 id；分组被删除后残留的 id 由界面按「未分组」处理 */
  groupIds?: string[]
  /** 放入回收站的时间；存在即表示在回收站里，不参与列表、搜索与自动刷新 */
  trashedAt?: number
  /**
   * 订阅管理弹窗里为该账号生成过的 Stripe 结算链接。
   * 只要生成过就留下，用于判定「待支付」阶段；用户去 Stripe 付完款后由订阅刷新把档位带回来，
   * 阶段自动变成「已订阅」。清空它的入口是「标记为已出售 / 重置阶段」。
   */
  paymentLink?: string
  /** 生成支付链接的时间戳（ms），仅用于展示 */
  paymentLinkAt?: number
  /** 标记为已出售的时间戳（ms）；存在即表示已售出，阶段固定为「已出售」 */
  soldAt?: number
  /**
   * 已提交「切换 Free」的时间戳（ms）。
   *
   * Stripe 的降级是周期末生效，提交后 subscription.type 仍然是原档位，
   * 光看订阅状态分不出「没切过」和「切了但要等生效」——重启后已经切过的账号
   * 会重新出现在切换列表里，还能被重复提交。这里记下提交事实，
   * 配合 downgradeAt（生效时间）判断什么时候可以忽略它。
   */
  downgradedAt?: number
  /** 切换 Free 的生效时间戳（秒，Stripe 的周期末）；没有它说明当时没取到，按已提交长期有效处理 */
  downgradeAt?: number
  /**
   * 提交切换时账号的订阅档位。
   *
   * 用来识别「切完之后又自己重新订阅了付费档」：订阅刷新带回的档位与这里不同，
   * 说明账号已经重新订阅，那条切换记录不该再挡住它。
   */
  downgradeFrom?: SubscriptionType
  userId?: string
  profileArn?: string
  credentials: AccountCredentials
  subscription: AccountSubscription
  usage: AccountUsage
  status: AccountStatus
  lastError?: string
  createdAt: number
  lastUsedAt: number
  lastCheckedAt?: number
}

/** 分组：用户自定义的归类标签，顺序由 order 决定（拖动排序时重写） */
export interface AccountGroup {
  id: string
  name: string
  /** 展示顺序，越小越靠前 */
  order: number
}

/** 持久化载荷 */
export interface AccountStoreData {
  version: number
  accounts: Account[]
  /** 分组定义；老数据没有该字段时按空数组处理 */
  groups?: AccountGroup[]
}

/** 导出文件结构 */
export interface AccountExportData {
  app: 'kiro-account-lite'
  version: string
  exportedAt: number
  accounts: Account[]
  /**
   * 被导出账号所引用的分组定义。
   * 账号里只存 groupId，不带上定义的话恢复到另一台机器就只剩悬空 id，
   * 分组标签会全部消失。老备份没有该字段，按空处理。
   */
  groups?: AccountGroup[]
}

/** 简化导入项（卡密 / OIDC JSON / CSV） */
export interface AccountImportItem {
  email?: string
  password?: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  provider?: string
  nickname?: string
}

export interface BatchResult {
  success: number
  failed: number
  skipped: number
  messages: string[]
}

// ============ IPC 结果 ============

export interface IpcResult<T = undefined> {
  success: boolean
  data?: T
  error?: string
}

/** 校验/查询接口返回的账号快照 */
export interface AccountSnapshot {
  email: string
  userId?: string
  idp?: string
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  profileArn?: string
  subscription: AccountSubscription
  usage: AccountUsage
}

export interface VerifyCredentialsInput {
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: AuthMethod
  provider?: IdpType
  /**
   * 在线登录已经拿到真实 profileArn 时一并带上（Enterprise 尤其重要）。
   * 调用方本就在运行时传了这个字段，这里补上声明，避免校验时又去猜一遍。
   */
  profileArn?: string
}

export interface RefreshTokenResult {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

/** 在线登录拿到的原始凭证 */
export interface OnlineLoginCredentials {
  accessToken: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region: string
  startUrl?: string
  expiresIn: number
  authMethod: AuthMethod
  provider: IdpType
  profileArn?: string
}

export type OnlineLoginMethod = 'Google' | 'Github' | 'BuilderId' | 'Enterprise'

// ============ 系统日志 ============

/** 日志级别，按严重程度升序 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

export interface LogEntry {
  /** 自增序号，同时用作列表 key 与增量拉取的游标 */
  id: number
  at: number
  level: LogLevel
  /** 来源分类，取自日志的 [Xxx] 前缀，如 Net / KiroApi / AutoRefresh */
  category: string
  message: string
}

/** 日志查询条件，全部为可选，未提供即不限制 */
export interface LogQuery {
  keyword?: string
  /** 命中其中任一级别；空数组或不传表示全部 */
  levels?: LogLevel[]
  category?: string
  /** 只看这个时间点之后的日志 */
  since?: number
  /** 最多返回多少条（取最新的） */
  limit?: number
}

export interface LogQueryResult {
  /** 按时间升序返回，便于界面直接追加显示 */
  entries: LogEntry[]
  /** 命中筛选的总条数（可能大于 entries.length） */
  matched: number
  /** 当前保留的日志总条数 */
  total: number
  /** 各级别条数，用于顶部徽章（不受 levels 筛选影响） */
  counts: Record<LogLevel, number>
  /** 出现过的分类，用于下拉选项 */
  categories: string[]
}

/**
 * 托盘菜单动作。
 *
 * 托盘不再承载「当前账号」概念：账号使用相关的能力（切号、写入 IDE）已经移除，
 * 这里只剩让用户从菜单里发起一次全量用量刷新。
 */
export type TrayAction = 'refresh-usage'

/** 渲染进程推送给托盘的账号汇总 */
export interface TraySnapshot {
  total: number
  /** 正常账号数 */
  active: number
  /** 状态异常账号数 */
  error: number
  /** 已封禁账号数 */
  banned: number
  /** 7 天内到期的账号数 */
  expiring: number
}

/** 外部浏览器打开结果 */
export interface BrowserOpenInfo {
  /** 是否真的用无痕/隐私窗口打开 */
  privateMode: boolean
  /** 实际使用的浏览器 */
  browser?: string
}

/**
 * 本机已登录的 Kiro 凭证，供「添加账号」时预填表单。
 * 只读：读取后由用户确认，走正常的添加账号流程。
 */
export interface LocalKiroCredentials {
  accessToken: string
  refreshToken: string
  clientId: string
  clientSecret: string
  region: string
  authMethod: AuthMethod
  provider: IdpType
}

export interface BuilderIdStartInfo extends BrowserOpenInfo {
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

export interface LoginPollResult {
  completed: boolean
  credentials?: OnlineLoginCredentials
  slowDown?: boolean
}

export interface SocialCallbackPayload {
  code?: string
  state?: string
  error?: string
}

/** Kiro 官方可用模型 */
export interface KiroModelInfo {
  modelId: string
  modelName?: string
  description?: string
  /** 消耗额度倍率（上游 rateMultiplier）；auto 等模型可能不返回 */
  rate?: number
  /**
   * 推理档位选项，从上游的 additionalModelRequestFieldsSchema 解析而来。
   * 只有部分模型有（Claude 系与 GPT 系），字段路径与枚举各不相同，详见 shared/modelSchema。
   */
  effort?: ModelEffort
  /**
   * 上游 tokenLimits.maxInputTokens：该模型的上下文窗口。
   * 各模型差别很大（实测 164K ~ 1M），写客户端配置时必须按模型取，不能统一写死。
   */
  maxInputTokens?: number
  /** 上游 tokenLimits.maxOutputTokens：单次输出上限（64K / 128K 两档） */
  maxOutputTokens?: number
  /** 上游 supportedInputTypes，如 ['TEXT', 'IMAGE']；/v1/models 据此给出 modalities */
  inputTypes?: string[]
  /** 上游 rateUnit，目前都是 'Credit' */
  rateUnit?: string
  /** 上游 promptCaching.supportsPromptCaching */
  promptCaching?: boolean
}

/** 账号测活：发起一次真实的流式对话 */
export interface ChatTestInput {
  accountId: string
  accessToken: string
  modelId: string
  message: string
  profileArn?: string
  region?: string
  idp?: string
  /** social / IdC：决定 profileArn 兜底策略 */
  authMethod?: AuthMethod
  /**
   * 模型的额外请求字段（推理档位等），由界面按该模型的 schema 拼好。
   * 放在请求体根级；给了不支持的模型或非法值上游会 400，所以只在模型确实有这项时才传。
   */
  additionalModelRequestFields?: Record<string, unknown>
}

/** 官方响应流里的一帧：事件类型 + 原样的负载 */
export interface ChatRawFrame {
  /** :event-type；异常帧是 :exception-type */
  type: string
  /** 负载（JSON 能解析就是对象，否则是原文字符串） */
  payload: unknown
}

/**
 * 测活时向官方发的一次请求及其原样返回，供界面「查看完整响应」展示。
 * 不含请求头与 token；响应头去掉了 set-cookie 与 authorization。
 */
export interface ChatRawAttempt {
  /** 请求地址 */
  url: string
  /** 这次带的 profileArn；null 表示没带。API Key 测活不涉及这一项，省略 */
  profileArn?: string | null
  /** HTTP 状态；连接都没建立（网络错误、超时）时没有 */
  status?: number
  headers: Record<string, string>
  /** 事件帧，按到达顺序；非 2xx 时为空 */
  frames: ChatRawFrame[]
  /** 非 2xx 时的响应体原文 */
  body?: string
  /** success：出了正文；error：失败；cancelled：用户中止 */
  outcome: 'success' | 'error' | 'cancelled'
  /** 失败原因（我们的判断或上游原文） */
  error?: string
  durationMs: number
  /** 帧太多或体积太大时只留了前面一部分 */
  truncated: boolean
}

/**
 * 一次测活的全部尝试：账号测活会依次换 profileArn 候选、换端点，每一次都留底，
 * 最后一条就是给出结论的那次。
 */
export interface ChatRawTrace {
  attempts: ChatRawAttempt[]
}

/** 测活接口的返回：失败时 data 为空，原始返回放在 raw 里 */
export type ChatTestResponse = IpcResult<ChatTestResult> & { raw?: ChatRawTrace }

export interface ChatTestResult {
  endpoint: string
  text: string
  /** 官方原始返回（全部尝试） */
  raw?: ChatRawTrace
  /** 首字延迟（毫秒） */
  firstByteMs: number
  totalMs: number
  /** 后端在流里回报的模型。实测 Kiro 对 auto 不回具体模型（不回或原样回 "auto"），只有点名模型时才回那个模型 */
  modelId?: string
  /** 思考内容字数，推理型模型才有 */
  thinkingChars?: number
}

/** 测活过程中推送给界面的流式片段 */
export interface ChatTestChunk {
  requestId: string
  delta: string
}

/** 备份计划的状态，设置页展示用 */
export interface BackupScheduleStatus {
  /** 上次自动备份的时间；从没备份过为 null */
  lastAt: number | null
  /** 上次自动备份失败的原因；成功后清空 */
  lastError: string | null
  /** 下次执行时间；计划没开为 null */
  nextAt: number | null
  /** 备份目录里现有的份数 */
  count: number
}

/** 导入整库备份（.kml）前给用户确认的摘要 */
export interface DataBackupSummary {
  /** 数据文件路径 */
  file: string
  /** 导出时间；旧文件或手改过缺这一项时为 0 */
  exportedAt: number
  /** 导出时的应用版本 */
  appVersion: string
  /** 文件来自更新版本的应用：已知的部分照常导入，新增的部分会被忽略 */
  newerSchema: boolean
  /** 各部分的数量；文件里没带这一部分时为 null（导入时保持本机现状） */
  accounts: number | null
  /** 带了账号用量记录 */
  usageHistory: boolean
}

/** 应用与运行时信息 */
export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  /** 加密主库文件（electron-store，名字固定带 .json 后缀，内容是密文） */
  storePath: string
  /** 应用数据目录：主库、历史记录、日志、备份都在这下面 */
  dataDir: string
  backupDir: string
}

// ============================================
// 表格导出（xlsx）
// ============================================

/** 单元格取值：数字走数值格式，字符串走文本，null 留空 */
export type XlsxCellValue = string | number | null

/** 一列的表头与格式；格式按列统一应用，和界面表格的列一一对应 */
export interface XlsxColumn {
  title: string
  /** 列宽（Excel 字符宽度），不填由 Excel 默认 */
  width?: number
  /**
   * 数值呈现方式：
   * - number 普通数值，配合 decimals 控制小数位
   * - percent 百分比，值传 0-1 的小数
   * - datetime 日期时间，值传毫秒时间戳
   * - link 超链接，值传 http(s) 地址，单元格显示地址本身、点击可打开
   * - 不填按常规格式（文本原样、数字通用）
   */
  format?: 'number' | 'percent' | 'datetime' | 'link'
  /** number / percent 的小数位数，默认 2 */
  decimals?: number
}

/** 导出用的单个工作表数据 */
export interface XlsxSheet {
  /** 工作表名称（Excel 限制 31 字符且不能含 : \ / ? * [ ]） */
  name: string
  columns: XlsxColumn[]
  /** 数据行，顺序与 columns 对应 */
  rows: XlsxCellValue[][]
}

/** 打包导出：把多个文本文件装进一个 zip */
export interface ExportBundle {
  files: { name: string; content: string }[]
}

// ============ 网络检测 ============

/** 当前出口 IP 信息；请求走应用的代理设置，反映的是 Kiro 请求实际的出口 */
export interface IpInfo {
  ip: string
  country?: string
  countryCode?: string
  region?: string
  city?: string
  /** 运营商 / 机房，如 AS13335 Cloudflare */
  org?: string
  timezone?: string
  /** 数据来源，便于用户判断可信度 */
  source: string
}

/** 网站连通性测试目标；具体地址由主进程决定，渲染层只传标识 */
export type SiteTestId = 'github' | 'google' | 'youtube' | 'kiro' | 'amazon'

export interface SiteTestResult {
  id: SiteTestId
  url: string
  /** 收到任何 HTTP 响应都算连通（403 / 429 也说明网络是通的） */
  ok: boolean
  status?: number
  /** 从发起请求到收到响应头的耗时 */
  latencyMs?: number
  error?: string
}

/** GitHub Release 检查更新结果 */
export interface UpdateCheckResult {
  /** 当前运行版本，如 1.0.3 */
  current: string
  /** 远端最新版本，已去掉 tag 前缀 v */
  latest: string
  /** 远端版本高于当前版本 */
  hasUpdate: boolean
  /** Release 页面地址，用于「前往更新」 */
  releaseUrl: string
  /** Release 名称，缺失时回退成 tag */
  name: string
  /** Release 正文（更新说明），可能为空 */
  notes: string
  /** 发布时间 ISO 字符串，可能为空 */
  publishedAt: string
  /**
   * 当前平台的热更资源包。
   * 只有走 GitHub API 检查时才会带上；页面兜底链路解析不到资产，缺省。
   */
  pack?: PackAssetInfo
}

/**
 * 远端资源包资产描述，由检查更新接口返回。
 *
 * url 为 null 表示这次发布没有提供当前平台架构的热更包，
 * 界面应退回「打开 Releases 下载完整安装包」。
 */
export interface PackAssetInfo {
  version: string
  url: string | null
  /** 期望的 sha256；为 null 表示上游没提供，只能跳过校验 */
  sha256: string | null
  size: number | null
  /** 平台-架构标识，如 win32-x64 */
  target: string
}

/**
 * 资源包（热更新）状态。
 *
 * 区分三个版本：base 是安装包自带的，active 是当前正在跑的，pending 是
 * 已解压、等重启生效的。三者相同时说明没有热更介入。
 */
export interface RendererPackStatus {
  /** 当前是否运行在安装包内（开发模式为 false，不支持热更） */
  packed: boolean
  /** 当前生效的资源包版本，没有则 null */
  activeVersion: string | null
  /** 安装包内置版本 */
  baseVersion: string
  /** 已下载解压、等重启生效的版本，没有则 null */
  pendingVersion: string | null
  /** 当前运行是否真的来自资源包（而非安装包内置代码） */
  runningFromPack: boolean
}

/** 资源包下载进度 */
export interface PackDownloadProgress {
  received: number
  total: number
  percent: number
}

/**
 * 账号列表的展示形态。
 * card：完整卡片（用量 + 额度明细）；
 * compact：卡片去掉额度明细那一块，一屏能多放几行；
 * list：一排一个的横向长条，信息压到一行里。
 */
export type AccountDisplayMode = 'card' | 'compact' | 'list'

/**
 * 账号导出格式，取值与 renderer/utils/transfer 的 ExportFormat 一致。
 * 放在 shared 里是为了把「上次选的格式」持久化进设置。
 */
export type AccountExportFormat = 'json' | 'oidc' | 'kami' | 'csv' | 'txt' | 'clipboard'

/** 主题风格：auto 跟随系统明暗，light / dark 固定 */
export type ThemeMode = 'auto' | 'light' | 'dark'

/** 布局风格：side 左侧导航栏，top 顶部导航栏 */
export type LayoutMode = 'side' | 'top'

/** 默认主题色：紫罗兰 */
export const DEFAULT_PRIMARY_COLOR = '#7c3aed'

export interface AppSettings {
  /** 主题色，十六进制色值 */
  primaryColor: string
  /**
   * 主题风格。已存设置里只有 darkMode 字段而没有它时，
   * 主进程读设置时按 darkMode 换算成 light / dark（见 store.getSettings），保持原有明暗。
   */
  themeMode: ThemeMode
  /** 布局风格：左右（导航在左侧）或上下（导航在顶部） */
  layoutMode: LayoutMode
  /**
   * 全局控件尺寸。
   * large 是本应用的默认观感（按钮、输入框都偏大，信息密度低但好点）；
   * default 是 Ant Design 原生尺寸，一屏能放下更多内容。
   */
  componentSize: 'default' | 'large'
  /** 账号列表的展示形态，见 AccountDisplayMode */
  accountDisplayMode: AccountDisplayMode
  /**
   * 导出账号时上次选择的格式，下次打开导出弹窗默认选中它。
   * 取值不在当前支持列表里时回落到第一项。
   */
  accountExportFormat: AccountExportFormat
  /** 侧栏折叠 */
  sidebarCollapsed: boolean
  /** 隐私打码：列表与详情中隐藏邮箱、昵称等隐私信息 */
  privacyMode: boolean
  /** 显示两位小数积分 */
  usagePrecision: boolean
  /** 在线登录默认用无痕窗口打开 */
  loginPrivateMode: boolean
  /** 记住上次填写的 Enterprise SSO 地址与区域 */
  enterpriseStartUrl: string
  enterpriseRegion: string
  /** 自动刷新 token */
  autoRefresh: boolean
  /** 自动刷新积分用量：按下面的检查间隔与批量并发，定期拉取账号的用量与订阅 */
  autoRefreshUsage: boolean
  /** 密钥刷新间隔（分钟） */
  keyRefreshInterval: number
  /** 用量刷新间隔（分钟） */
  usageRefreshInterval: number
  /**
   * 已闲置账号的用量刷新间隔（小时）。
   *
   * 「已闲置」是阶段推导出来的（见 shared/accountStage）：用过分或用量超阈值的号。
   * 这些号不会再产生新的消耗，却要跟着每轮用量刷新一起发请求，账号一多就是纯浪费。
   * 这里让它们按更长的间隔单独刷，其余账号仍按 usageRefreshInterval 走。
   */
  idleUsageRefreshInterval: number
  /**
   * 用量达到这个百分比后就不再自动刷新用量（0 表示不限制）。
   *
   * 快用完额度的号刷新频率再高也没有意义——额度不会自己变多，
   * 而每轮刷新都要发一次真实请求。设成 95 就只保留「快见底但还没见底」
   * 的那一小段继续跟踪，见底后停手。
   *
   * 到重置时间后会自动放行一次刷新，否则账号会被永久跳过。
   */
  usageRefreshMaxPercent: number
  /**
   * 密钥刷新只处理「这么多分钟内即将过期」的账号。
   *
   * refreshToken 是轮换式的，刷得越勤、旧值被作废的机会越多，取消订阅时越容易踩到
   * invalid_grant；而 accessToken 本身寿命 1 小时，提前量太大也没有意义。
   * 提前量越小、每轮要刷的账号越少，批量刷新时的瞬时压力也越小。
   */
  keyRefreshWindowMinutes: number
  /**
   * 密钥刷新也套用「用量达阈值后停刷」的百分比。
   *
   * 与用量刷新不同，停刷密钥有副作用：accessToken 一小时就过期，过期后要用这个账号
   * 就得拿 refreshToken 重新换一次，refreshToken 长期不轮换还可能被服务端判失效。
   * 所以默认关闭，只给「额度已用完、短期不会再动」的账号建议打开。
   */
  skipKeyRefreshAtUsageLimit: boolean
  /**
   * 密钥池的刷新间隔（分钟）：每隔这么久从密钥待刷新池里取一批真正去刷。
   *
   * 「检测」与「刷新」是两条独立的时间线：keyRefreshInterval 只负责判断谁的 token
   * 快过期并把它放进池子，真正发请求由这个间隔控制。密钥与用量各有各的节奏，
   * 因为两者的代价不同——token 过期会直接影响使用，用量只是界面上的数字。
   *
   * 同一出口 IP 短时间集中请求会被 Kiro 限流回 403，把请求按固定节奏摊开是
   * 最直接的规避手段。调小能更快排空池子，但触发限流的概率也会上升。
   */
  keyFlushInterval: number
  /** 每次从密钥池里取多少个账号去刷新；取太多等于回到一次性刷一大批 */
  keyFlushSize: number
  /**
   * 用量池的刷新间隔（分钟）：每隔这么久从用量待刷新池里取一批真正去刷。
   *
   * 用量刷新只影响界面上的数字，不像 token 过期那样有使用后果，
   * 所以默认比密钥池放得更慢。
   */
  usageFlushInterval: number
  /** 每次从用量池里取多少个账号去刷新 */
  usageFlushSize: number
  /**
   * 批量并发：一个批次内部同时发出几个请求。
   *
   * 与「每次刷新数量」是两个维度：后者决定这一轮取多少个账号，
   * 前者决定这些账号里同时跑几个。两者相乘才是瞬时请求量的上界。
   */
  concurrency: number
  /** 用量接口类型 */
  usageApiType: 'rest' | 'cbor'
  /**
   * 批量导入时同时校验的账号数量。导入几千条时靠这个并发池分批处理，
   * 避免一次性发起全部请求把内存和接口打满。
   */
  importConcurrency: number
  /** 网络代理 */
  proxyEnabled: boolean
  proxyUrl: string
  /** 删除前二次确认 */
  confirmBeforeDelete: boolean
  /** 备份计划开关：开启后按 backupCycle 静默导出全部数据（和手动导出的 .kml 完全一致） */
  backupEnabled: boolean
  /** 备份计划的执行周期，见 shared/backupSchedule */
  backupCycle: BackupCycle
  /** 备份目录里只保留最新的几份，更早的自动删除 */
  backupKeep: number
  /** 启用系统托盘 */
  trayEnabled: boolean
  /** 点击窗口关闭按钮时的行为：每次询问 / 最小化到托盘 / 直接退出 */
  closeAction: 'ask' | 'minimize' | 'quit'
  /**
   * 访问 Kiro 网页端时使用的地区（应用内网页与「前往官网」拉起的外部 Chrome 共用）。
   *
   * 同时决定 Accept-Language 请求头与浏览器界面区域，
   * 后者影响页面里 navigator.language 读到的值——门户按前端语言判断时只有它管用。
   */
  portalLocale: PortalLocale
  /**
   * 常用备注：设置备注弹窗里输入框上方的一排短语，点一下填进输入框。
   * 读设置时统一过一遍 normalizeNotePresets。
   */
  notePresets: string[]
}

export const DEFAULT_SETTINGS: AppSettings = {
  primaryColor: DEFAULT_PRIMARY_COLOR,
  themeMode: 'auto',
  layoutMode: 'side',
  // 保持既有观感：老用户升级上来不会突然变小
  componentSize: 'large',
  accountDisplayMode: 'card',
  accountExportFormat: 'json',
  sidebarCollapsed: false,
  privacyMode: false,
  usagePrecision: false,
  loginPrivateMode: false,
  enterpriseStartUrl: '',
  enterpriseRegion: DEFAULT_REGION,
  autoRefresh: true,
  autoRefreshUsage: true,
  keyRefreshInterval: 5,
  // 默认 30 分钟：与 1.2.x 行为一致，老用户升级不会突然改变刷新节奏
  keyRefreshWindowMinutes: 30,
  // 默认关闭：停刷密钥会让 token 过期，账号下次使用要重新登录
  skipKeyRefreshAtUsageLimit: false,
  usageRefreshInterval: 5,
  // 已闲置账号默认 12 小时刷一次：它们不再产生新消耗，没必要跟着短间隔空跑
  idleUsageRefreshInterval: 12,
  // 0 = 关闭：默认不按用量百分比拦截，保持与旧版本一致的行为
  usageRefreshMaxPercent: 0,
  // 密钥池：token 过期会直接影响使用，默认更积极（每 5 分钟取 20 个）
  keyFlushInterval: 5,
  keyFlushSize: 20,
  // 用量池：只影响界面数字，放慢一些（每 10 分钟取 20 个）
  usageFlushInterval: 10,
  usageFlushSize: 20,
  concurrency: 5,
  usageApiType: 'rest',
  importConcurrency: 50,
  proxyEnabled: false,
  proxyUrl: '',
  confirmBeforeDelete: true,
  // 默认开启：每 30 分钟静默备份一次，只留最新 3 份
  backupEnabled: true,
  backupCycle: { ...DEFAULT_BACKUP_CYCLE },
  backupKeep: DEFAULT_BACKUP_KEEP,
  trayEnabled: true,
  closeAction: 'minimize',
  portalLocale: DEFAULT_PORTAL_LOCALE,
  // 空数组打底：常用备注完全由用户自己攒，不给任何预设
  notePresets: []
}
