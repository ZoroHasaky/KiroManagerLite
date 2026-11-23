// 本地持久化（electron-store，账号数据加密存放）
import Store from 'electron-store'
import { app } from 'electron'
import * as path from 'path'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import {
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_SETTINGS,
  type AccountStoreData,
  type AppSettings,
  type SubscriptionType
} from '../shared/types'
import { normalizeSubscriptionType } from '../shared/subscription'
import { normalizeNotePresets } from '../shared/notePresets'

/** 旧版「一键接入客户端」写过的配置文件快照，仅用于升级时还原 */
export interface LegacyClientBackupFile {
  path: string
  /** 写入前文件是否存在；false 表示还原时应删除该文件 */
  existed: boolean
  content: string
}

export interface LegacyClientBackup {
  savedAt: number
  files: LegacyClientBackupFile[]
}

/** 旧版写入 KIRO_API_KEY 的记录，仅用于升级时移除 */
export interface LegacyCliEnvBackup {
  writtenAt: number
  files: { path: string; created: boolean }[]
  previousWindowsValue: string | null
}

interface Schema {
  accountData: AccountStoreData
  settings: AppSettings
  /*
   * 以下键是旧版本（≤1.2.5）写下的，本版本不再产生新的，只在启动时读一次做外部配置还原。
   * 键名必须与旧版完全一致，否则读不到已落盘的数据、用户机器上的痕迹就还原不了。
   * 类型用 unknown / 宽松形状：由旧版本写出，不能假定内部结构一定正确，用到的地方逐个校验。
   */
  keyData?: unknown
  shellApproveBackup?: unknown
  machineIdBackup?: unknown
  kiroCliEnvBackup?: LegacyCliEnvBackup | null
  proxyClientBackups?: Record<string, LegacyClientBackup>
  proxyClientPaths?: Record<string, string>
  /**
   * 上次退出时的窗口位置与尺寸。
   *
   * 单独一个键而不是放进 settings：settings 是渲染进程整份提交的，
   * 窗口尺寸只有主进程知道，混在一起容易被界面那次整体覆盖冲掉。
   */
  windowBounds: WindowBounds | null
}

/** 窗口的位置与尺寸，以及最大化状态（最大化时用普通尺寸还原） */
export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

const EMPTY_DATA: AccountStoreData = { version: 1, accounts: [] }

const STORE_NAME = 'kiro-account-lite'

/** 升级到 electron-store 12 前的主库副本文件名（不含扩展名），清除全部数据时一并删除 */
export const PRE_UPGRADE_STORE_COPY = `${STORE_NAME}.pre-v1038`

/**
 * 升级到 electron-store 12 之前留一份原文件副本。
 *
 * 新版底层（conf 16）能读旧版（conf 8 / conf 10）写的加密文件，升级没问题；
 * 但它写回时换了密钥派生的 salt，旧版读不回去。用户若把应用退回旧版本，
 * 旧版会在启动时解密失败。副本只做一次（有了就不再覆盖），
 * 退回旧版本时把它改回原名即可继续使用。
 */
function backupBeforeStoreFormatChange(): void {
  try {
    const dir = app.getPath('userData')
    const source = path.join(dir, `${STORE_NAME}.json`)
    const target = path.join(dir, `${PRE_UPGRADE_STORE_COPY}.json`)
    if (existsSync(source) && !existsSync(target)) copyFileSync(source, target)
  } catch {
    // 备份失败不影响启动：正常读写用的是原文件，这份副本只在退回旧版本时才需要
  }
}

backupBeforeStoreFormatChange()

/*
 * 不要加 conf 的 cache 选项：开了之后 store.store 返回的是被冻结的对象，
 * 下面 write() 里的 snapshot[key] = … 会直接抛错。
 * 这个文件本身就是为了省掉重复解密与解析，缓存由下面的 snapshot 负责。
 */
const store = new Store<Schema>({
  name: STORE_NAME,
  encryptionKey: 'kiro-account-lite-local-key',
  defaults: {
    accountData: EMPTY_DATA,
    settings: DEFAULT_SETTINGS,
    windowBounds: null
  }
})

/*
 * 内存快照：electron-store（conf）的每次 get 都会同步读文件、用 pbkdf2 派生密钥、
 * 解密、再整份 JSON.parse；这份文件装着全部账号，直接读会让主线程（界面与 IPC）
 * 每次卡上几毫秒。主进程是这个文件唯一的写入方，
 * 所以只在首次读取时解密一次，之后读写都走内存快照，写入照常同步落盘。
 *
 * read 返回深拷贝：调用方拿到的始终是独立对象（语义与 store.get 一致），
 * 就地修改不会悄悄改掉快照，必须经 write 才生效。
 * write 存进快照的是 JSON 往返后的值，与下次从磁盘读回来的内容完全一致。
 */
let snapshot: Schema | null = null

function read<K extends keyof Schema>(key: K): Schema[K] {
  snapshot ??= store.store
  return structuredClone(snapshot[key])
}

/**
 * 不拷贝，直接返回快照里的对象，只给只读调用方用。
 * 账号数据约 2MB，深拷贝一次在主线程上要 1ms 多；
 * 走这条路省掉这次拷贝。返回值不能修改，要改的调用方用 read（经 write 才生效）。
 */
function peek<K extends keyof Schema>(key: K): Readonly<Schema[K]> {
  snapshot ??= store.store
  return snapshot[key]
}

/**
 * 写入合并：快照立即更新（之后的读取马上看到新值），落盘攒一小段时间再一次写完。
 *
 * 为什么要合并：conf 的每次 set 都要把整个文件读回来、pbkdf2 派生密钥、解密、JSON.parse，
 * 改完再派生一次密钥、加密、整份写盘。这个文件装着全部账号，上千个账号时一次就是上百毫秒的主线程阻塞；
 * 批量刷新、批量测活时每秒可能写几十次，界面与 IPC 会被卡住。
 * 合并后同一段时间内的多次修改只落一次盘，内容和逐次写完全一致（写的就是最新快照）。
 *
 * 只延迟 STORE_FLUSH_MS：正常退出、导入后重启、清除数据前都会立即 flushStore，
 * 只有进程被强杀时可能丢最后这一小段的修改。
 */
const STORE_FLUSH_MS = 300
const dirtyKeys = new Set<keyof Schema>()
let storeFlushTimer: NodeJS.Timeout | null = null

/** 把待写的键一次写进磁盘；退出、重启、导出前调用 */
export function flushStore(): void {
  if (storeFlushTimer) {
    clearTimeout(storeFlushTimer)
    storeFlushTimer = null
  }
  if (!snapshot || !dirtyKeys.size) return
  const patch: Partial<Schema> = {}
  for (const key of dirtyKeys) (patch as Record<string, unknown>)[key] = snapshot[key]
  dirtyKeys.clear()
  // 对象形式的 set 一次写完全部键：只读一次文件、只加密写一次
  ;(store.set as (patch: Partial<Schema>) => void)(patch)
}

function write<K extends keyof Schema>(key: K, value: Schema[K]): void {
  snapshot ??= store.store
  // 快照里存 JSON 往返后的值，与之后从磁盘读回的内容完全一致，也和调用方的对象断开引用
  snapshot[key] = JSON.parse(JSON.stringify(value)) as Schema[K]
  dirtyKeys.add(key)
  if (storeFlushTimer) return
  storeFlushTimer = setTimeout(flushStore, STORE_FLUSH_MS)
}

// 兜底：任何退出路径（含 app.exit）在进程结束前都把没写的写掉
process.on('exit', flushStore)

// ============ 初始化 ============

/** 主库回到出厂默认值 */
export function resetStoreData(): void {
  // 清空前丢掉待写的修改，否则它会在清空之后把旧数据又写回去
  if (storeFlushTimer) clearTimeout(storeFlushTimer)
  storeFlushTimer = null
  dirtyKeys.clear()
  store.clear()
  snapshot = null
}

// ============ 旧版本遗留数据（升级清理用）============

/**
 * 旧版本留在主库里的「本应用改过用户机器上哪些东西」的记录。
 *
 * 本版本已经不再提供对应的功能，但如果这些记录非空，说明用户机器上还留着
 * 旧版本写入的痕迹（IDE 端点、桌面 agent 配置、KIRO_API_KEY），启动时要还原。
 */
export interface LegacyExternalState {
  /** 是否需要执行清理 */
  pending: boolean
  /** 旧版写入 KIRO_API_KEY 的记录；没有则为 null */
  cliEnv: LegacyCliEnvBackup | null
  /** 旧版写过的桌面 agent 配置快照 */
  clientBackups: { target: string; backup: LegacyClientBackup }[]
  /**
   * 旧版接管 IDE 端点前记录的原始值（krs / cps 两个键）。
   * 有就按它精确还原，比一律清成空数组更接近用户原本的配置。
   */
  originalEndpoints?: { krs?: unknown; cps?: unknown }
}

export function readLegacyExternalState(): LegacyExternalState {
  const raw = store.store
  const keyData = raw.keyData as { enabled?: unknown; originalEndpoints?: unknown } | undefined
  const backups = raw.proxyClientBackups ?? {}
  const clientBackups: { target: string; backup: LegacyClientBackup }[] = []
  for (const [target, backup] of Object.entries(backups)) {
    if (backup && Array.isArray(backup.files)) clientBackups.push({ target, backup })
  }
  const cliEnv = raw.kiroCliEnvBackup ?? null
  const original = keyData?.originalEndpoints as
    | { krs?: unknown; cps?: unknown }
    | undefined
  const gatewayTakeover = keyData?.enabled === true || original !== undefined
  return {
    // 只要有一类痕迹存在就值得跑一次；跑完清空记录，之后不再命中
    pending: gatewayTakeover || clientBackups.length > 0 || !!cliEnv,
    cliEnv: cliEnv && Array.isArray(cliEnv.files) ? cliEnv : null,
    clientBackups,
    originalEndpoints: original
  }
}

/** 清理完成后把这些键从主库里彻底删掉，避免每次启动重复判断 */
export function clearLegacyExternalState(): void {
  // 先把待写的改动落盘：下面要直接操作底层 store，快照会被丢弃
  flushStore()
  const keys = [
    'keyData',
    'shellApproveBackup',
    'machineIdBackup',
    'kiroCliEnvBackup',
    'proxyClientBackups',
    'proxyClientPaths'
  ] as const
  for (const key of keys) {
    if (store.has(key)) store.delete(key)
  }
  // 直接改过底层 store，快照要作废，否则后续读到的还是旧内容
  snapshot = null
  dirtyKeys.clear()
}

// ============ 账号数据 ============

/** 当前有效的订阅档位，用于识别磁盘上遗留的废弃值 */
const VALID_SUBSCRIPTION_TYPES = new Set<string>([
  'Free',
  'Pro',
  'Pro_Plus',
  'Pro_Max',
  'Power',
  'Teams',
  'Student'
] satisfies SubscriptionType[])

/**
 * 按 title 重新对齐订阅档位，就地改写并落盘。
 *
 * subscription.type 是从 title 派生出来的持久化值。磁盘上可能有 Power 账号存着
 * 'Enterprise'，而 Enterprise 不是订阅档位（它是登录方式）。判定逻辑只作用于新算出的值，
 * 不重新对齐的话已存的值不会变，筛选面板里的 Power 会一直是 0，除非把每个账号的用量都重新刷一遍。
 *
 * 放在这个唯一读取入口上做，比放在渲染进程的 store.load() 里可靠：后者只在 load
 * 时跑一次，热重载或 store 状态被保留时根本不会执行。
 * 幂等；title 缺失时无判据，只把已废弃的档位归到 Free，其余保持原值。
 */
/**
 * 已对齐过的账号表（按对象身份记）。快照里的账号表只在写入时整体换新，
 * 同一个对象对齐一次就够了；不记的话每次读取都要整表再扫一遍。
 */
const alignedTables = new WeakSet<AccountStoreData>()

function alignSubscriptionTypes(data: AccountStoreData): AccountStoreData {
  if (alignedTables.has(data)) return data
  alignedTables.add(data)
  let changed = false
  for (const account of data.accounts) {
    const sub = account.subscription
    if (!sub) continue
    if (!sub.title) {
      if (VALID_SUBSCRIPTION_TYPES.has(sub.type)) continue
      sub.type = 'Free'
      changed = true
      continue
    }
    const next = normalizeSubscriptionType(sub.title)
    if (next === sub.type) continue
    sub.type = next
    changed = true
  }
  // 对齐一次就写回，避免每次读取都重算
  if (changed) write('accountData', data)
  return data
}

/** 账号数据的独立副本：调用方可以修改，改完经 setAccountData 落盘 */
export function getAccountData(): AccountStoreData {
  const data = read('accountData') as AccountStoreData | undefined
  if (!data || !Array.isArray(data.accounts)) return EMPTY_DATA
  return alignSubscriptionTypes(data)
}

/**
 * 账号数据的只读视图（不拷贝），给健康检查、IPC 下发这类只读不写的场景。
 * 订阅档位同样会对齐：对齐是在快照上就地改写并落盘，和走 getAccountData 结果一致。
 */
export function viewAccountData(): Readonly<AccountStoreData> {
  const data = peek('accountData') as AccountStoreData | undefined
  if (!data || !Array.isArray(data.accounts)) return EMPTY_DATA
  return alignSubscriptionTypes(data)
}

export async function setAccountData(data: AccountStoreData): Promise<void> {
  write('accountData', data)
}

/** 从主进程最新快照删除账号，避免渲染进程用旧整表覆盖刚写入的新凭证 */
export async function deleteAccountData(
  ids: string[]
): Promise<{ accounts: AccountStoreData; removed: number }> {
  const remove = new Set(ids.filter(Boolean))
  const current = getAccountData()
  if (!remove.size) return { accounts: current, removed: 0 }

  const remaining = current.accounts.filter((account) => !remove.has(account.id))
  const removed = current.accounts.length - remaining.length
  if (!removed) return { accounts: current, removed: 0 }

  const accounts: AccountStoreData = { ...current, accounts: remaining }
  await setAccountData(accounts)
  return { accounts, removed }
}

export function getSettings(): AppSettings {
  const raw = (read('settings') ?? {}) as Partial<AppSettings> & { darkMode?: unknown }
  const { darkMode, ...rest } = raw
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...rest }
  /*
   * 已存设置里可能只有 darkMode 开关而没有 themeMode，此时按 darkMode 换算，明暗保持不变；
   * 不能直接落到默认的「自动」，否则开着浅色的人会在系统深色时突然变黑。
   * 旧键在下一次保存时自然被丢掉（rest 里已经没有它）。
   */
  if (rest.themeMode === undefined && typeof darkMode === 'boolean') {
    merged.themeMode = darkMode ? 'dark' : 'light'
  }
  // 存值不是十六进制色值（如 system）时回到默认紫
  if (!/^#[0-9a-f]{6}$/i.test(merged.primaryColor)) merged.primaryColor = DEFAULT_PRIMARY_COLOR
  // 手改过的配置里可能有空串或重复项，界面拿到的必须是干净的一份
  merged.notePresets = normalizeNotePresets(merged.notePresets)
  return merged
}

export function setSettings(settings: Partial<AppSettings>): AppSettings {
  const merged = { ...getSettings(), ...settings }
  // 渲染进程可能一次提交整份数组（比如删除常用备注），这里同样兜一次
  merged.notePresets = normalizeNotePresets(merged.notePresets)
  write('settings', merged)
  return merged
}

export function getStorePath(): string {
  return store.path
}

// ============ 窗口状态 ============

/** 上次保存的窗口位置与尺寸；没有存过或数据不可信时返回 null */
export function getWindowBounds(): WindowBounds | null {
  const raw = read('windowBounds') as WindowBounds | null | undefined
  if (!raw) return null
  const width = Number(raw.width)
  const height = Number(raw.height)
  // 尺寸必须是有限正数：手改过的配置或早期版本写坏的值不能直接拿去建窗口
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null
  return {
    x: Number.isFinite(Number(raw.x)) ? Math.round(Number(raw.x)) : undefined,
    y: Number.isFinite(Number(raw.y)) ? Math.round(Number(raw.y)) : undefined,
    width: Math.round(width),
    height: Math.round(height),
    maximized: raw.maximized === true
  }
}

export function setWindowBounds(bounds: WindowBounds): void {
  write('windowBounds', bounds)
}

// ============ 备份目录 ============

/** 自动备份（备份计划）的 .kml 存放位置；清除全部数据时整个目录一起删 */
export function getBackupDir(): string {
  return path.join(app.getPath('userData'), 'backups')
}

/**
 * 确保备份目录存在。启动时就建好：设置页上能看到这个路径、能点「打开备份目录」，
 * 不能等第一次备份才出现（目录不存在时打开会静默失败，看起来像按钮坏了）。
 */
export function ensureBackupDir(): string {
  const dir = getBackupDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    console.warn('[Store] 创建备份目录失败:', error)
  }
  return dir
}
