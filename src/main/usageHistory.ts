// 积分变化日志：以账号为单位记录每次用量刷新后的积分快照
//
// 单独一个 store 文件，不和账号数据混在一起：历史会随时间不断变长，
// 账号数据每次改动都要整体写盘，混在一起会让每次保存都拖着几万条记录跑。
//
// 表整体读写都很贵（几千账号 × 上千条记录），所以这里在内存里缓存整张表，
// 写入合并成一次防抖落盘：批量刷新上千个账号时不会再触发上千次全表序列化。
import Store from 'electron-store'
import type { AccountUsage, UsageHistoryEntry } from '../shared/types'

/** 每个账号最多保留的记录数，超出丢弃最早的 */
const MAX_ENTRIES_PER_ACCOUNT = 2000
/** 积分变化小于这个值当作没变（接口返回的浮点尾差） */
const EPSILON = 1e-6
/** 追加记录后的落盘延迟，把批量刷新期间的写入合并成一次 */
const FLUSH_DELAY_MS = 1000

type HistoryMap = Record<string, UsageHistoryEntry[]>

interface Schema {
  /** accountId -> 按时间升序的记录 */
  history: HistoryMap
}

const store = new Store<Schema>({
  name: 'kiro-usage-history',
  defaults: { history: {} }
})

/** 整张表的内存副本，读写都走它 */
let cache: HistoryMap | null = null
let flushTimer: NodeJS.Timeout | null = null

function history(): HistoryMap {
  if (!cache) cache = (store.get('history') as HistoryMap) ?? {}
  return cache
}

/** 立即落盘，并取消待执行的延迟落盘（应用退出前也要调一次） */
export function flushUsageHistory(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (cache) store.set('history', cache)
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flushUsageHistory, FLUSH_DELAY_MS)
  // 不因为这个定时器阻止进程退出
  flushTimer.unref?.()
}

/** 一次遍历汇总全部赠送额度；没有赠送额度时两个字段都留空 */
function sumBonuses(usage: AccountUsage): { current?: number; limit?: number } {
  const bonuses = usage.bonuses
  if (!bonuses?.length) return {}
  let current = 0
  let limit = 0
  for (const bonus of bonuses) {
    current += bonus.current || 0
    limit += bonus.limit || 0
  }
  return { current, limit }
}

export function getUsageHistory(accountId: string): UsageHistoryEntry[] {
  return history()[accountId] ?? []
}

/** 最近消耗统计的两个窗口：半小时与一小时 */
export interface RecentUsage {
  m30: number
  m60: number
}

const HALF_HOUR_MS = 30 * 60_000
const HOUR_MS = 60 * 60_000

/**
 * 一批账号 / Key 最近半小时、一小时实际消耗的积分，供列表排序用。
 *
 * 取窗口内各条记录的 delta 之和：delta 是相邻两次快照之间的增量，正好就是这段时间的消耗。
 * 只累加正数：额度重置时已用量会归零，delta 是负的，那不是「消耗」。
 * 数据只到最近一次刷新为止，刷新间隔越短越准。
 *
 * 一次 IPC 批量算完：列表排序要所有条目的值，逐条取会是上千次往返。
 * 从末尾往前扫，遇到窗口外的记录就停，每个条目只看最近几条。
 */
export function getRecentUsage(subjectIds: string[], at: number = Date.now()): Record<string, RecentUsage> {
  const all = history()
  const result: Record<string, RecentUsage> = {}
  for (const id of subjectIds) {
    const entries = all[id]
    if (!entries?.length) continue
    let m30 = 0
    let m60 = 0
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      const age = at - entry.at
      if (age > HOUR_MS) break
      const delta = entry.delta > 0 ? entry.delta : 0
      m60 += delta
      if (age <= HALF_HOUR_MS) m30 += delta
    }
    result[id] = { m30: Number(m30.toFixed(6)), m60: Number(m60.toFixed(6)) }
  }
  return result
}

/**
 * 记录一次积分快照。
 *
 * 只有积分或额度真的变了才落一条，否则每分钟一次的自动刷新会把日志灌满。
 * 返回是否写入了新记录。
 */
export function appendUsagePoint(accountId: string, usage: AccountUsage): boolean {
  if (!accountId || !usage) return false

  const all = history()
  const entries = all[accountId] ?? []
  const last = entries.at(-1)

  const current = usage.current || 0
  const limit = usage.limit || 0
  if (last && Math.abs(last.current - current) < EPSILON && last.limit === limit) return false

  const bonus = sumBonuses(usage)
  entries.push({
    at: usage.lastUpdated || Date.now(),
    current,
    limit,
    percentUsed: usage.percentUsed || 0,
    delta: last ? Number((current - last.current).toFixed(6)) : 0,
    baseCurrent: usage.baseCurrent,
    baseLimit: usage.baseLimit,
    freeTrialCurrent: usage.freeTrialCurrent,
    freeTrialLimit: usage.freeTrialLimit,
    bonusCurrent: bonus.current,
    bonusLimit: bonus.limit
  })

  // 超量时截掉最早的部分
  all[accountId] =
    entries.length > MAX_ENTRIES_PER_ACCOUNT ? entries.slice(-MAX_ENTRIES_PER_ACCOUNT) : entries
  scheduleFlush()
  return true
}

export function clearUsageHistory(accountId: string): number {
  const all = history()
  const count = all[accountId]?.length ?? 0
  if (!count) return 0
  delete all[accountId]
  flushUsageHistory()
  return count
}

/**
 * 删除已经不存在的账号留下的历史。
 *
 * key: 前缀是旧版本 API Key 页留下的命名空间，功能已移除，
 * 这里连它们一起清掉，用户升级后那份数据不会永远躺在磁盘上。
 */
export function pruneUsageHistory(keepAccountIds: string[]): number {
  const keep = new Set(keepAccountIds)
  const all = history()
  let removed = 0
  for (const id of Object.keys(all)) {
    if (id.startsWith('key:') || keep.has(id)) continue
    delete all[id]
    removed++
  }
  if (removed) flushUsageHistory()
  return removed
}
