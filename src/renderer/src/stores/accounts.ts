import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, customRef, ref, type Ref } from 'vue'
import { message } from 'ant-design-vue'
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountExportData,
  type AccountGroup,
  type AccountImportItem,
  type AccountSnapshot,
  type AccountStatus,
  type AccountStoreData,
  type BatchResult,
  type IdpType,
  type OnlineLoginCredentials,
  type SubscriptionType,
  type VerifyCredentialsInput
} from '@shared/types'
import { errorMessage, isCredentialRejected } from '@shared/errors'
import { reachedUsageLimit, shouldSkipAccountUsageRefresh } from '@shared/refreshPolicy'
import { accountStageOf, type AccountStage } from '@shared/accountStage'
import { DEFAULT_REGION } from '@shared/regions'
import { runPool } from '@/utils/format'
import { countByGroup, matchesGroupFilter } from '@/utils/groups'
import { runBatchQuery, type BatchQueryResult } from '@/utils/batchQuery'
import { createScopedSearchText } from '@/utils/searchText'
import {
  groupIdsOf,
  isTrashed,
  sameGroupIds,
  validGroupIdsOf,
  withGroupIds
} from '@shared/itemGroups'
import { toPlain } from '@/utils/ipc'
import { isSocialIdp, normalizeIdp } from '@/utils/transfer'
import { useSettingsStore } from './settings'

/** 搜索框左侧的范围选择 */
export type AccountSearchScope = 'all' | 'email' | 'nickname' | 'note'

export interface AccountFilter {
  search: string
  statuses: AccountStatus[]
  subscriptions: SubscriptionType[]
  idps: IdpType[]
  /** 订阅剩余天数下限（含） */
  daysRemainingMin?: number
  /** 订阅剩余天数上限（含），用于「即将到期」快捷筛选 */
  daysRemainingMax?: number
  /** 用量占比下限（0-1），用于「额度告急」快捷筛选 */
  usageMin?: number
  /** 用量占比上限（0-1） */
  usageMax?: number
  /**
   * 导入时间（createdAt）范围，含两端，单位毫秒，精度到秒。
   * 只选日期不碰时间时，界面会补成起点 00:00:00 / 终点 23:59:59。
   */
  createdFrom?: number
  createdTo?: number
  /**
   * 按分组筛选。空数组表示不限；特殊值 __none__ 代表「未分组」，
   * 这样「未分组」能和普通分组一样被勾选，不必再加一个布尔开关。
   *
   * 账号页已改用固定阶段 tab（见 stages），这里保留给旧的筛选调用方与 API Key 页。
   */
  groupIds: string[]
  /**
   * 按阶段筛选（未使用 / 待支付 / 已订阅 / 已出售 / 已闲置）。
   * 空数组表示不限；阶段由账号数据推导，不落盘，见 shared/accountStage。
   */
  stages: AccountStage[]
  /** 搜索范围：all 为智能搜索（邮箱 + 昵称 + 备注一起找），其余只搜对应字段 */
  searchScope: AccountSearchScope
  /**
   * 批量查询的关键字（一行一个，已转小写、去重）；空数组表示没有在批量查询。
   * 按邮箱 / 昵称 / 备注模糊匹配，命中任意一个即显示。
   */
  queries: string[]
}

// 「未分组」哨兵值定义在 utils/groups，账号与 API Key 两边共用；这里转出去兼容既有引用
export { UNGROUPED } from '@/utils/groups'

/** 批量任务的进度状态，全局单例，同一时间只跑一件事 */
export type AccountTaskType =
  | 'import-validation'
  | 'account-key-refresh'
  | 'account-usage-refresh'

interface TaskState {
  running: boolean
  type: AccountTaskType
  label: string
  total: number
  done: number
}

function authMethodOf(idp: IdpType): 'IdC' | 'social' {
  return isSocialIdp(idp) ? 'social' : 'IdC'
}

function emptyUsage(): Account['usage'] {
  return { current: 0, limit: 0, percentUsed: 0, lastUpdated: 0 }
}

/** 账号表变化通知界面的最小间隔（毫秒），见 accounts 的说明 */
const ACCOUNTS_NOTIFY_MS = 120

/**
 * 浅层 ref，写入立即生效、通知节流：
 *  - 读 .value 永远拿到最新写入的值（对所有逻辑代码透明）；
 *  - 距上次通知超过 wait 时立即通知，否则在这段时间末尾补一次，最后一次修改一定会通知到。
 */
function throttledShallowRef<T>(initial: T, wait: number): Ref<T> {
  return customRef<T>((track, trigger) => {
    let value = initial
    let lastNotify = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const notify = (): void => {
      timer = null
      lastNotify = Date.now()
      trigger()
    }
    return {
      get() {
        track()
        return value
      },
      set(next) {
        if (Object.is(next, value)) return
        value = next
        if (timer) return
        const elapsed = Date.now() - lastNotify
        if (elapsed >= wait) notify()
        else timer = setTimeout(notify, wait - elapsed)
      }
    }
  })
}

/** 统计里「即将重置」的天数阈值 */
const EXPIRING_SOON_DAYS = 7
/** 自动刷新密钥的默认时间窗（分钟）；实际取值来自设置，这里只是兜底 */
const DEFAULT_KEY_REFRESH_WINDOW_MINUTES = 30
/** 接口没给 expiresIn 时的兜底有效期（秒） */
const DEFAULT_EXPIRES_IN = 3600

/**
 * 池内条目：入池时记下账号的「刷新标记」快照，出队时据此判断中途是否已被刷过。
 *
 * 手动刷新成功后也会显式出池（见 dequeueRefresh），这里是第二道保险：
 * 覆盖「池外其它途径改了凭证」导致的那条记录过期。
 */
interface RefreshPoolEntry {
  id: string
  /** 密钥池是 token 到期时间，用量池是用量数据的时间戳 */
  stamp: number
}

/**
 * 待刷新池：先进先出。
 *
 * 检测只负责入池，刷新另有一个定时任务从队首取几个去刷——两条时间线解耦，
 * 检测频率再高也不会带来更多请求。
 *
 * 存 id 而不是账号对象：账号数据每次刷新都会整表替换，存快照会读到过期凭证。
 * `queued` 与 `queue` 同步维护，用来保证同一个账号不会重复入池——只靠数组的
 * `includes` 在几千个账号时每次都是 O(n²)。
 */
interface RefreshPool {
  queue: RefreshPoolEntry[]
  queued: Set<string>
}

function createRefreshPool(): RefreshPool {
  return { queue: [], queued: new Set() }
}

/** 取某账号入池时的刷新标记；返回 null 表示它不该进池 */
type PoolStampOf = (id: string) => number | null

/** 出队判断：这个账号（以及入池时的标记）是否仍然需要刷新 */
type PoolStillNeeded = (id: string, stamp: number) => boolean

/**
 * 把待刷账号追加到池尾；已在池里的跳过，不该入池的（账号没了 / 状态变了）直接丢弃。
 *
 * @returns 本次真正新入池的数量
 */
function enqueueRefreshPool(pool: RefreshPool, ids: string[], stampOf: PoolStampOf): number {
  let added = 0
  for (const id of ids) {
    if (pool.queued.has(id)) continue
    const stamp = stampOf(id)
    if (stamp === null) continue
    pool.queue.push({ id, stamp })
    pool.queued.add(id)
    added++
  }
  return added
}

/** 把单个账号从池里摘掉（手动刷新成功后调用）；返回是否真的移除了一条 */
function removeFromRefreshPool(pool: RefreshPool, id: string): boolean {
  if (!pool.queued.delete(id)) return false
  const index = pool.queue.findIndex((entry) => entry.id === id)
  if (index >= 0) pool.queue.splice(index, 1)
  return true
}

/**
 * 从队首取出至多 limit 个账号，取出的同时从池里移除。
 *
 * 用「先进先出」而不是每次重新算一遍该刷谁，是为了让排在后面的账号
 * 一定能轮到——每次重算的话，同一个账号可能因为排序或状态抖动被反复选中或永远选不到。
 *
 * 出队时要再判断一次 stillNeeded：入池到出队之间账号可能已被删除、放进回收站、
 * 封禁，或者已经被人手动刷过。这些都不该占用本次名额——直接丢弃继续往后取，
 * 否则「每次 x 个」会被死号与重复项吃掉。
 */
function drainRefreshPool(
  pool: RefreshPool,
  limit: number,
  stillNeeded: PoolStillNeeded
): string[] {
  // limit 必须有下限：0 或负数会让下面的循环条件永远成立（取不满就一直转）
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1
  const taken: string[] = []
  while (pool.queue.length) {
    if (taken.length >= cap) break
    const entry = pool.queue.shift()!
    pool.queued.delete(entry.id)
    if (stillNeeded(entry.id, entry.stamp)) taken.push(entry.id)
  }
  return taken
}

export const useAccountsStore = defineStore('accounts', () => {
  const settingsStore = useSettingsStore()

  /*
   * 浅层响应式：账号可能有上千个，深层响应式要给每个账号的每层字段都建代理。
   * 这里的所有写法都是整组替换（map / slice 后赋值），从不就地改某个账号的字段，
   * 所以只追踪 .value 就够了。新增写法时也要保持「替换而不是就地修改」。
   *
   * 另外把「通知界面」节流成最多每 ACCOUNTS_NOTIFY_MS 一次：
   * 批量刷新时每个账号回来都要整表换一次，上千个账号就是上千次整表重新筛选、排序、
   * 重算统计与分组计数，界面会一直卡着。节流后读到的始终是最新数组（这里的代码照常读写），
   * 只是依赖它的计算属性和界面最多每 120ms 跟进一次。第一次修改立即通知，单次操作没有延迟。
   */
  const accounts = throttledShallowRef<Account[]>([], ACCOUNTS_NOTIFY_MS)
  /** 分组定义，始终按 order 升序维护，界面直接按数组顺序渲染 */
  const groups = ref<AccountGroup[]>([])
  const selectedIds = ref<string[]>([])
  /**
   * 是否正在看回收站。打开时列表只显示回收站里的账号（搜索与筛选也只作用于它们），
   * 关闭时回收站里的账号对列表、搜索、筛选计数完全不可见。
   */
  const trashView = ref(false)
  const loading = ref(false)
  const task = ref<TaskState>({
    running: false,
    type: 'import-validation',
    label: '',
    total: 0,
    done: 0
  })
  const filter = ref<AccountFilter>({
    search: '',
    statuses: [],
    subscriptions: [],
    idps: [],
    groupIds: [],
    stages: [],
    searchScope: 'all',
    queries: []
  })

  /*
   * 待刷新池：密钥刷新与用量刷新各一条。
   *
   * 检测只负责入池（判断谁该刷），刷新是另一条定时任务从队首取几个去执行。
   * 闲置账号与常规账号共用一个用量池——它们的差别只在检测间隔（12 小时 vs 5 分钟），
   * 入池频率天然不同，FIFO 就够了，不需要再分一条池子。
   *
   * 不做持久化：重启后池子清空，下一次检测会重新把该刷的号收进来，行为自愈。
   */
  const keyRefreshPool = createRefreshPool()
  const usageRefreshPool = createRefreshPool()

  // ============ 持久化 ============

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  function snapshotForStore(): AccountStoreData {
    return { version: 1, accounts: accounts.value, groups: groups.value }
  }

  function persist(immediate = false): void {
    if (saveTimer) clearTimeout(saveTimer)
    const write = (): void => {
      saveTimer = null
      void window.api.saveAccounts(toPlain(snapshotForStore()))
    }
    if (immediate) write()
    else saveTimer = setTimeout(write, 600)
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      // 订阅档位的历史值由主进程在读取时统一对齐，这里拿到的已是规范值
      const res = await window.api.loadAccounts()
      if (res.success && res.data) {
        accounts.value = res.data.accounts ?? []
        // order 是持久化的排序依据，读回来先归一，界面就能直接按数组顺序渲染
        groups.value = [...(res.data.groups ?? [])].sort((a, b) => a.order - b.order)
      }
    } finally {
      loading.value = false
    }
  }

  // ============ 查询 ============

  /*
   * id 索引按数组身份缓存，不用计算属性：账号表的通知是节流的（见 accounts 的说明），
   * 计算属性在通知到达前会一直给旧值，而 get 被各个操作在修改后立刻调用，必须拿到最新的。
   */
  let idIndex: { list: Account[]; map: Map<string, Account> } | null = null
  const byId = {
    get value(): Map<string, Account> {
      const list = accounts.value
      if (idIndex?.list !== list) idIndex = { list, map: new Map(list.map((a) => [a.id, a])) }
      return idIndex.map
    }
  }

  function get(id: string): Account | undefined {
    return byId.value.get(id)
  }

  /** 最近使用过的一个账号：主页展示用，只是「最近动过的那个号」，与任何外部程序无关 */
  const recentAccount = computed(() => {
    let best: Account | null = null
    for (const account of accounts.value) {
      if (!best || (account.lastUsedAt || 0) > (best.lastUsedAt || 0)) best = account
    }
    return best
  })

  // ============ 分组 ============

  /** id -> 分组，供卡片取名与筛选判断已删除分组 */
  const groupMap = computed(() => new Map(groups.value.map((g) => [g.id, g])))

  /** 各分组下的账号数，外加「未分组」一项，用于面板上的计数（回收站里的不计） */
  const groupCounts = computed(() => countByGroup(accounts.value, groups.value))

  /** 正常列表里的账号（不含回收站） */
  const liveAccounts = computed(() => accounts.value.filter((a) => !isTrashed(a)))
  /** 回收站里的账号数，显示在回收站按钮的角标上 */
  const trashedCount = computed(() => accounts.value.length - liveAccounts.value.length)

  /** 新建分组；同名直接复用已有的那个，避免建出一堆重名分组 */
  function addGroup(name: string): AccountGroup | null {
    const label = name.trim()
    if (!label) return null
    const existing = groups.value.find((g) => g.name === label)
    if (existing) return existing

    const group: AccountGroup = {
      id: crypto.randomUUID(),
      name: label,
      // 追加到末尾
      order: groups.value.length ? Math.max(...groups.value.map((g) => g.order)) + 1 : 0
    }
    groups.value = [...groups.value, group]
    persist()
    return group
  }

  /** 改名；返回错误文案，成功为 null。和别的分组重名时拒绝，否则筛选里会出现两个同名分组 */
  function renameGroup(id: string, name: string): string | null {
    const label = name.trim()
    if (!label) return '分组名称不能为空'
    if (groups.value.some((g) => g.id !== id && g.name === label)) return `分组「${label}」已存在`
    groups.value = groups.value.map((g) => (g.id === id ? { ...g, name: label } : g))
    persist()
    return null
  }

  /** 删除分组：同时把引用它的账号置回未分组，不留悬空 id */
  function removeGroup(id: string): void {
    // 顺手把 order 重排连续，否则删掉中间项后会留下空洞（0、2、3…）
    groups.value = groups.value
      .filter((g) => g.id !== id)
      .map((g, index) => ({ ...g, order: index }))
    // 只摘掉被删的这一个分组，账号的其它分组保持不变
    let touched = false
    const next = accounts.value.map((a) => {
      const ids = groupIdsOf(a)
      if (!ids.includes(id)) return a
      touched = true
      return withGroupIds(a, ids.filter((g) => g !== id))
    })
    if (touched) accounts.value = next
    // 该分组若正被用于筛选，一并摘掉，否则列表会突然空掉
    if (filter.value.groupIds.includes(id)) {
      filter.value.groupIds = filter.value.groupIds.filter((g) => g !== id)
    }
    persist(true)
  }

  /** 按给定顺序重排（拖动排序后调用），order 重新按下标写死 */
  function reorderGroups(orderedIds: string[]): void {
    const byId = new Map(groups.value.map((g) => [g.id, g]))
    const next: AccountGroup[] = []
    orderedIds.forEach((id, index) => {
      const g = byId.get(id)
      if (g) {
        next.push({ ...g, order: index })
        byId.delete(id)
      }
    })
    // 漏掉的（理论上不会有）按原顺序补在后面，避免丢分组
    for (const g of byId.values()) next.push({ ...g, order: next.length })
    groups.value = next
    persist()
  }

  /**
   * 批量设置分组：把所选账号的分组整体替换成 groupIds（可多个），空数组表示移出全部分组。
   * 一次性换数组引用 + 单次 persist，避免逐个写盘。
   */
  function setGroupForAccounts(ids: string[], groupIds: string[]): number {
    const target = new Set(ids.filter(Boolean))
    if (!target.size) return 0
    const wanted = groupIds.filter((id) => groupMap.value.has(id))
    let changed = 0
    const next = accounts.value.map((account) => {
      if (!target.has(account.id)) return account
      if (sameGroupIds(validGroupIdsOf(account, (id) => groupMap.value.has(id)), wanted)) return account
      changed++
      return withGroupIds(account, wanted)
    })
    if (changed) {
      accounts.value = next
      // 立即落盘：反代按分组选号时直接读主进程的数据，防抖 600ms 会让新成员晚一拍才生效
      persist(true)
    }
    return changed
  }

  /** 各搜索范围对应的字段，取值与缓存见 createScopedSearchText */
  const searchTextOf = createScopedSearchText<Account, AccountSearchScope>({
    all: (a) => `${a.email} ${a.nickname ?? ''} ${a.note ?? ''}`,
    email: (a) => a.email,
    nickname: (a) => a.nickname ?? '',
    note: (a) => a.note ?? ''
  })

  /**
   * 批量查询结果：与搜索框同一份搜索文本（邮箱 / 昵称 / 备注），模糊匹配。
   * 只在当前所在的一边（正常列表或回收站）里查，不受其它筛选影响，
   * 这样「未找到」就是真的不在这里，而不是被筛选挡住了。
   */
  const batchQuery = computed<BatchQueryResult | null>(() => {
    const queries = filter.value.queries
    if (!queries.length) return null
    const inTrash = trashView.value
    const side = accounts.value.filter((a) => isTrashed(a) === inTrash)
    // 批量查询固定按「邮箱 + 昵称 + 备注」匹配，不跟搜索框的范围选择走
    return runBatchQuery(side, (a) => searchTextOf(a, 'all'), queries)
  })

  const filtered = computed(() => {
    const {
      search,
      statuses,
      subscriptions,
      idps,
      daysRemainingMin,
      daysRemainingMax,
      usageMin,
      usageMax,
      createdFrom,
      createdTo,
      groupIds,
      stages,
      searchScope
    } = filter.value
    const keyword = search.trim().toLowerCase()
    const groupSet = groupIds.length ? new Set(groupIds) : null
    const stageSet = stages.length ? new Set(stages) : null
    const queryMatched = batchQuery.value?.matched ?? null
    const inTrash = trashView.value
    const groupExists = (id: string): boolean => groupMap.value.has(id)
    return accounts.value.filter((a) => {
      // 回收站与正常列表互不可见：搜索与筛选都只作用于当前所在的那一边
      if (isTrashed(a) !== inTrash) return false
      // 批量查询：命中任意一个关键字（邮箱 / 昵称 / 备注模糊匹配）
      if (queryMatched && !queryMatched.has(a.id)) return false
      // 搜索：智能搜索走邮箱 + 昵称 + 备注，选了具体字段就只搜那一个
      if (keyword && !searchTextOf(a, searchScope).includes(keyword)) return false
      // 多分组：命中所选任一分组即可；分组都已被删除的账号视为未分组
      if (groupSet && !matchesGroupFilter(a, groupSet, groupExists)) return false
      // 阶段：命中任一选中阶段即可；阶段由订阅 / 用量 / 支付链接 / 出售标记实时推导
      if (stageSet && !stageSet.has(accountStageOf(a))) return false
      if (statuses.length && !statuses.includes(a.status)) return false
      if (subscriptions.length && !subscriptions.includes(a.subscription.type)) return false
      if (idps.length && !idps.includes(a.idp)) return false
      // 范围条件一律用 != null 判断「是否已设置」：输入框清空后给过来的是 null，
      // 若按 !== undefined 判断，null 会被当成已设置，比较时又被转成 0，
      // 于是 days > 0 / used > 0 把几乎所有条目都滤掉，列表看起来是空的
      const days = a.subscription.daysRemaining
      if (daysRemainingMax != null && (days ?? Number.POSITIVE_INFINITY) > daysRemainingMax) {
        return false
      }
      if (daysRemainingMin != null && (days ?? Number.NEGATIVE_INFINITY) < daysRemainingMin) {
        return false
      }
      const used = a.usage.percentUsed || 0
      if (usageMin != null && used < usageMin) return false
      if (usageMax != null && used > usageMax) return false
      // 导入时间：两端都含，界面给过来的是精确到秒的时刻
      if (createdFrom != null && a.createdAt < createdFrom) return false
      if (createdTo != null && a.createdAt > createdTo) return false
      return true
    })
  })

  /**
   * 覆盖式设置筛选条件（首页告警跳转、筛选面板重置用）。
   *
   * groupIds 默认沿用当前值：分组是工具栏上独立的一个按钮，有自己的角标和
   * 「清除分组筛选」，用户点筛选面板的重置并不期待分组选择被顺带清掉。
   * 需要连分组一起清的调用方显式传 `groupIds: []`。
   */
  function applyFilter(patch: Partial<AccountFilter>): void {
    filter.value = {
      search: '',
      statuses: [],
      subscriptions: [],
      idps: [],
      groupIds: filter.value.groupIds,
      // 阶段 tab 是独立入口，筛选面板重置不清它
      stages: filter.value.stages,
      // 搜索框清空了，范围跟着回到默认的智能搜索
      searchScope: 'all',
      // 批量查询同样是独立入口（搜索框旁的标签上有 ×），筛选面板重置不清它
      queries: filter.value.queries,
      daysRemainingMin: undefined,
      daysRemainingMax: undefined,
      usageMin: undefined,
      usageMax: undefined,
      createdFrom: undefined,
      createdTo: undefined,
      ...patch
    }
  }

  /**
   * 一次遍历产出各维度计数，界面统计与筛选面板共用。
   * 只统计当前所在的一边（正常列表或回收站），筛选面板上的数字才和列表对得上。
   */
  const stats = computed(() => {
    const inTrash = trashView.value
    const scope = accounts.value.filter((a) => isTrashed(a) === inTrash)
    const byStatus: Record<AccountStatus, number> = {
      active: 0,
      expired: 0,
      error: 0,
      banned: 0,
      unknown: 0
    }
    const bySubscription: Record<SubscriptionType, number> = {
      Free: 0,
      Pro: 0,
      Pro_Plus: 0,
      Pro_Max: 0,
      Power: 0,
      Teams: 0,
      Student: 0
    }
    const byIdp: Record<IdpType, number> = { BuilderId: 0, Github: 0, Google: 0, Enterprise: 0 }
    const byStage: Record<AccountStage, number> = {
      unused: 0,
      pendingPayment: 0,
      subscribed: 0,
      sold: 0,
      idle: 0
    }
    let expiringSoon = 0

    for (const a of scope) {
      // ?? 0 兜底磁盘上可能存在的旧枚举值，避免出现 NaN
      byStatus[a.status] = (byStatus[a.status] ?? 0) + 1
      bySubscription[a.subscription.type] = (bySubscription[a.subscription.type] ?? 0) + 1
      byIdp[a.idp] = (byIdp[a.idp] ?? 0) + 1
      byStage[accountStageOf(a)]++
      if ((a.subscription.daysRemaining ?? 99) <= EXPIRING_SOON_DAYS) expiringSoon++
    }

    return { total: scope.length, byStatus, bySubscription, byIdp, byStage, expiringSoon }
  })

  // ============ 增删改 ============

  /*
   * 查重索引按数组身份缓存：导入几千个账号时每条都要查一次，
   * 逐条扫整表是「导入数 × 账号数」次比较，几万个账号时会卡住好几秒。
   * 判定规则不变：userId 相同，或邮箱 + 登录方式相同即视为已存在。
   */
  let dupIndex: { list: Account[]; userIds: Set<string>; emailIdp: Set<string> } | null = null
  function exists(email?: string, userId?: string, idp?: IdpType): boolean {
    const list = accounts.value
    if (dupIndex?.list !== list) {
      const userIds = new Set<string>()
      const emailIdp = new Set<string>()
      for (const a of list) {
        if (a.userId) userIds.add(a.userId)
        emailIdp.add(`${a.email}\u0000${a.idp}`)
      }
      dupIndex = { list, userIds, emailIdp }
    }
    if (userId && dupIndex.userIds.has(userId)) return true
    return !!email && dupIndex.emailIdp.has(`${email}\u0000${idp}`)
  }

  /** 用校验结果拼出完整账号对象 */
  type BuildInput = VerifyCredentialsInput & {
    password?: string
    nickname?: string
    note?: string
    startUrl?: string
    profileArn?: string
  }

  /**
   * 一批导入所用的 createdAt 基准。
   *
   * 取「现在」与「库里最大 createdAt」的较大值：批内会按条数往上加偏移，
   * 若只用 Date.now()，上一批很大（比如 5000 条，占掉 5 秒的偏移空间）时，
   * 紧接着导入的第二批会落进上一批的区间里，排序就交叠了。
   * 不用展开运算符求最大值——账号上万时 Math.max(...arr) 会爆栈。
   */
  function importBaseTime(): number {
    let max = Date.now()
    for (const account of accounts.value) {
      if ((account.createdAt || 0) > max) max = account.createdAt
    }
    return max
  }

  function buildAccount(snapshot: AccountSnapshot, input: BuildInput): Account {
    const now = Date.now()
    const idp = (input.provider || 'BuilderId') as IdpType
    const profileArn = snapshot.profileArn || input.profileArn
    return {
      id: crypto.randomUUID(),
      email: snapshot.email,
      password: input.password,
      nickname: input.nickname,
      note: input.note,
      idp,
      userId: snapshot.userId,
      profileArn,
      credentials: {
        accessToken: snapshot.accessToken || '',
        refreshToken: snapshot.refreshToken || input.refreshToken,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        region: input.region || DEFAULT_REGION,
        startUrl: input.startUrl,
        expiresAt: now + (snapshot.expiresIn ?? DEFAULT_EXPIRES_IN) * 1000,
        authMethod: authMethodOf(idp),
        provider: idp,
        profileArn
      },
      subscription: snapshot.subscription,
      usage: snapshot.usage,
      status: 'active',
      createdAt: now,
      lastUsedAt: now,
      lastCheckedAt: now
    }
  }

  /** 校验凭证并添加单个账号 */
  async function addByCredentials(
    input: BuildInput
  ): Promise<{ ok: boolean; error?: string; account?: Account }> {
    const res = await window.api.verifyCredentials(input)
    if (!res.success || !res.data) return { ok: false, error: res.error || '校验失败' }

    const idp = (input.provider || 'BuilderId') as IdpType
    if (exists(res.data.email, res.data.userId, idp)) {
      return { ok: false, error: `${res.data.email} 已存在` }
    }

    const account = buildAccount(res.data, input)
    accounts.value = [...accounts.value, account]
    // 入库时记一条基线，之后的变化才有对比对象
    void window.api.recordUsagePoint(account.id, toPlain(account.usage))
    persist()
    return { ok: true, account }
  }

  /** 在线登录成功后拉取账号信息并入库 */
  async function addByOnlineLogin(
    credentials: OnlineLoginCredentials,
    extra?: { nickname?: string; note?: string }
  ): Promise<{ ok: boolean; error?: string; account?: Account }> {
    return addByCredentials({
      refreshToken: credentials.refreshToken,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      region: credentials.region,
      authMethod: credentials.authMethod,
      provider: credentials.provider,
      startUrl: credentials.startUrl,
      profileArn: credentials.profileArn,
      nickname: extra?.nickname
    })
  }

  function updateAccount(id: string, patch: Partial<Account>): void {
    const index = accounts.value.findIndex((a) => a.id === id)
    if (index === -1) return
    // 整体换引用触发一次更新即可，避免先改元素再换数组产生两次写入
    const next = accounts.value.slice()
    next[index] = { ...next[index], ...patch }
    accounts.value = next
    persist()
  }

  /**
   * 记录订阅弹窗为该账号生成过的支付链接（阶段判定「待支付」的依据）。
   * 只保留最近一次：同一账号可能换档位重新生成，旧链接不再有意义。
   */
  function setPaymentLink(id: string, url: string): void {
    updateAccount(id, { paymentLink: url, paymentLinkAt: Date.now() })
  }

  /**
   * 记录「已提交切换 Free」。
   *
   * Stripe 的降级周期末才生效，提交后订阅档位仍是原值，所以必须把这个事实落盘，
   * 否则重启后已切过的账号会重新出现在切换列表里、还能被重复提交。
   *
   * transitionAt 是 Stripe 给的周期末时间戳（秒）。到了那个时刻订阅自己会变 Free，
   * 记录就该失效——见 hasPendingDowngrade。
   */
  function markDowngraded(id: string, transitionAt?: number): void {
    const account = get(id)
    updateAccount(id, {
      downgradedAt: Date.now(),
      downgradeAt: transitionAt && transitionAt > 0 ? transitionAt : undefined,
      // 记下当时的档位，供 hasPendingDowngrade 识别「后来又重新订阅」
      downgradeFrom: account?.subscription.type
    })
  }

  /**
   * 账号是否还有「已提交但尚未生效」的切换 Free。
   *
   * 判据三条，任一不成立就认为记录已失效：
   *  1. 有记录；
   *  2. 没到生效时间（没有生效时间就按长期有效）；
   *  3. 当前档位与提交时一致 —— 档位变了说明账号已经重新订阅付费档，
   *     旧记录不能再挡着它。
   */
  function hasPendingDowngrade(account: Account, now = Date.now()): boolean {
    if (!account.downgradedAt) return false
    // 生效时间按秒存储，这里用 >=：到点那一刻就算已生效，不留悬空记录
    if (account.downgradeAt && account.downgradeAt * 1000 < now) return false
    // 档位变了（重新订阅）：旧记录作废，允许再次切换
    if (account.downgradeFrom && account.downgradeFrom !== account.subscription.type) return false
    return true
  }

  /** 清除切换记录（账号重新订阅后手动恢复用） */
  function clearDowngrade(ids: string[]): number {
    const target = new Set(ids.filter(Boolean))
    if (!target.size) return 0
    let changed = 0
    const next = accounts.value.map((account) => {
      if (!target.has(account.id) || !account.downgradedAt) return account
      changed++
      const { downgradedAt: _at, downgradeAt: _until, downgradeFrom: _from, ...rest } = account
      return rest as Account
    })
    if (changed) {
      accounts.value = next
      persist()
    }
    return changed
  }

  /**
   * 标记 / 取消「已出售」。
   * 标记时清掉支付链接：卖掉的账号不该继续出现在「待支付」里，
   * 取消标记后它会按订阅与用量重新落回其它阶段。
   */
  function setSold(ids: string[], sold: boolean): number {
    const target = new Set(ids.filter(Boolean))
    if (!target.size) return 0
    const now = Date.now()
    let changed = 0
    const next = accounts.value.map((account) => {
      if (!target.has(account.id) || !!account.soldAt === sold) return account
      changed++
      if (sold) return { ...account, soldAt: now, paymentLink: undefined, paymentLinkAt: undefined }
      const { soldAt: _sold, ...rest } = account
      return rest as Account
    })
    if (changed) {
      accounts.value = next
      /*
       * 清掉勾选：阶段是由 soldAt 推导的，标记 / 取消后这些账号都会换一个阶段。
       * 只要当前正停在某个阶段 tab 上，它们就会从列表里消失；留着勾选会让
       * 「已选 N 个」与批量操作指向看不见的账号。与移入回收站的处理一致。
       */
      selectedIds.value = selectedIds.value.filter((id) => !target.has(id))
      persist()
    }
    return changed
  }

  /** 清掉支付链接，让账号回到「未使用 / 已闲置」的自动判定 */
  function clearPaymentLink(ids: string[]): number {
    const target = new Set(ids.filter(Boolean))
    if (!target.size) return 0
    let changed = 0
    const cleared = new Set<string>()
    const next = accounts.value.map((account) => {
      if (!target.has(account.id) || !account.paymentLink) return account
      changed++
      cleared.add(account.id)
      const { paymentLink: _link, paymentLinkAt: _at, ...rest } = account
      return rest as Account
    })
    if (changed) {
      accounts.value = next
      /*
       * 与标记已出售同理：阶段由 paymentLink 推导，清掉后这批账号会离开「待支付」。
       * 正停在该 tab 上时它们会从列表里消失，留着勾选会让批量操作指向看不见的账号；
       * 只清真正改过的那批，没链接的账号本来就不换阶段。
       */
      selectedIds.value = selectedIds.value.filter((id) => !cleared.has(id))
      persist()
    }
    return changed
  }

  /**
   * 批量覆盖备注：选中的账号统一改成同一个 note（空串表示清空）。
   * 一次性换数组引用 + 单次 persist，避免逐个 updateAccount 触发 N 次写盘。
   * @returns 实际改动的账号数
   */
  function setNoteForAccounts(ids: string[], note: string): number {
    const target = new Set(ids.filter(Boolean))
    if (!target.size) return 0
    const value = note.trim() || undefined
    let changed = 0
    const next = accounts.value.map((account) => {
      if (!target.has(account.id) || account.note === value) return account
      changed++
      return { ...account, note: value }
    })
    if (changed) {
      accounts.value = next
      persist()
    }
    return changed
  }

  /** 放入 / 移出回收站，返回实际变化的条数 */
  function setTrashed(ids: string[], trashed: boolean): { changed: number; error?: string } {
    const target = new Set(ids.filter(Boolean))
    if (!target.size) return { changed: 0 }
    const now = Date.now()
    let changed = 0
    const next = accounts.value.map((account) => {
      if (!target.has(account.id) || isTrashed(account) === trashed) return account
      changed++
      if (trashed) return { ...account, trashedAt: now }
      const { trashedAt: _drop, ...rest } = account
      return rest as Account
    })
    if (changed) {
      accounts.value = next
      // 两边视图互不可见，勾选状态跨视图没有意义
      selectedIds.value = selectedIds.value.filter((id) => !target.has(id))
      // 立即落盘：反代按账号选号时直接读主进程的数据
      persist(true)
    }
    return { changed }
  }

  async function removeAccounts(
    ids: string[]
  ): Promise<{ removed: number; error?: string }> {
    const uniqueIds = [...new Set(ids.filter(Boolean))]
    if (!uniqueIds.length) return { removed: 0 }
    // 删除必须以主进程最新快照为准；同时取消尚未发出的旧快照保存，避免删后回写复活。
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    // 删除前记下邮箱写进日志，删完就查不到了；日志里写完整邮箱，不做隐私打码
    const removingSet = new Set(uniqueIds)
    const emails = accounts.value.filter((a) => removingSet.has(a.id)).map((a) => a.email)
    const res = await window.api.deleteAccounts(uniqueIds)
    if (!res.success || !res.data) {
      return { removed: 0, error: res.error || '删除账号失败' }
    }
    accounts.value = res.data.accounts.accounts ?? []
    selectedIds.value = selectedIds.value.filter((id) => !removingSet.has(id))
    if (res.data.removed) {
      console.warn(`[Account] 已删除 ${res.data.removed} 个账号（${emails.join('、')}）`)
    }
    return { removed: res.data.removed }
  }

  // ============ 批量导入 ============

  async function importItems(items: AccountImportItem[]): Promise<BatchResult> {
    const result: BatchResult = { success: 0, failed: 0, skipped: 0, messages: [] }
    const valid = items.filter((i) => i.refreshToken)
    if (valid.length === 0) {
      result.messages.push('没有解析到有效的 refreshToken')
      return result
    }

    task.value = {
      running: true,
      type: 'import-validation',
      label: '批量导入校验中',
      total: valid.length,
      done: 0
    }
    const created: Account[] = []
    // 本批已入队的 email|idp，用 Set 查重避免逐个线性扫描（几千条时是 O(n²)）
    const createdKeys = new Set<string>()
    /** 本批统一的时间基准，各条按输入下标偏移，保证列表顺序与文件顺序一致 */
    const baseTime = importBaseTime()
    const total = valid.length
    // 导入并发独立于批量刷新的并发，单独设置更好控速；上下限由 runPool 兜底
    const limit = settingsStore.settings.importConcurrency || DEFAULT_SETTINGS.importConcurrency

    try {
      await runPool(valid, limit, async (item, index) => {
        /*
         * 登录方式认不出来时的兜底：没有 clientId / clientSecret 的账号不可能是 IdC
         * （IdC 刷新必须带这两个值），只能是社交登录。否则会被当成 BuilderId 送去校验，
         * 直接报「IdC 账号需要同时提供 Client ID 与 Client Secret」而整批失败。
         */
        const idp =
          !item.provider && !item.clientId && !item.clientSecret
            ? 'Google'
            : normalizeIdp(item.provider)
        try {
          const res = await window.api.verifyCredentials({
            refreshToken: item.refreshToken,
            clientId: item.clientId,
            clientSecret: item.clientSecret,
            region: item.region || DEFAULT_REGION,
            authMethod: authMethodOf(idp),
            provider: idp
          })
          if (!res.success || !res.data) {
            result.failed++
            result.messages.push(`#${index + 1} ${item.email || ''} 校验失败：${res.error}`)
            return
          }
          const email = res.data.email || item.email || ''
          const key = `${email}|${idp}`
          if (exists(email, res.data.userId, idp) || createdKeys.has(key)) {
            result.skipped++
            result.messages.push(`#${index + 1} ${email} 已存在，跳过`)
            return
          }
          createdKeys.add(key)
          const account = buildAccount(
            { ...res.data, email },
            {
              refreshToken: item.refreshToken,
              clientId: item.clientId,
              clientSecret: item.clientSecret,
              region: item.region,
              provider: idp,
              password: item.password,
              nickname: item.nickname
            }
          )
          /*
           * createdAt 按输入顺序定序，而不是用 buildAccount 里的「此刻」。
           * 导入是并发的，各账号完成校验的先后与文件顺序无关；不定序的话
           * 同一批在列表里的排列是随机的，看着像乱序。
           * 倒序排列下用 total - index，让文件里靠前的排在列表更上方。
           */
          account.createdAt = baseTime + (total - index)
          created.push(account)
          result.success++
        } catch (e) {
          result.failed++
          result.messages.push(`#${index + 1} 异常：${errorMessage(e)}`)
        } finally {
          task.value.done++
        }
      })
    } finally {
      if (created.length) {
        accounts.value = [...accounts.value, ...created]
        for (const account of created) {
          void window.api.recordUsagePoint(account.id, toPlain(account.usage))
        }
        persist(true)
      }
      // 同上：running 一定要复位，否则会把后续的自动刷新全部挡掉
      task.value.running = false
    }
    return result
  }

  /**
   * 恢复备份里的分组定义，返回「备份 id -> 本机 id」映射。
   *
   * 同名分组复用本机已有的（只改映射，不新建），其余按备份顺序追加到末尾。
   * 只换一次数组引用，写盘交给调用方的 persist，避免一组一次 IO。
   */
  function restoreGroups(incoming?: AccountGroup[]): Map<string, string> {
    const map = new Map<string, string>()
    if (!incoming?.length) return map

    const byName = new Map(groups.value.map((g) => [g.name, g]))
    const usedIds = new Set(groups.value.map((g) => g.id))
    const added: AccountGroup[] = []
    let order = groups.value.length ? Math.max(...groups.value.map((g) => g.order)) + 1 : 0

    for (const raw of [...incoming].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      const name = (raw?.name ?? '').trim()
      if (!name || !raw?.id) continue
      const existing = byName.get(name)
      if (existing) {
        map.set(raw.id, existing.id)
        continue
      }
      // 备份 id 在本机没被占用就沿用，能让同一份备份反复恢复时保持稳定
      const id = usedIds.has(raw.id) ? crypto.randomUUID() : raw.id
      const group: AccountGroup = { id, name, order: order++ }
      usedIds.add(id)
      byName.set(name, group)
      added.push(group)
      map.set(raw.id, id)
    }

    if (added.length) groups.value = [...groups.value, ...added]
    return map
  }

  /** 恢复完整导出文件（保留用量、订阅等快照） */
  function importFullData(data: AccountExportData): BatchResult {
    const result: BatchResult = { success: 0, failed: 0, skipped: 0, messages: [] }
    const created: Account[] = []
    // 与 importItems 一致，用 Set 查重避免逐条线性扫描
    const createdKeys = new Set<string>()
    /*
     * createdAt 一律按「导入这一刻」重排，不沿用备份文件里的原值。
     *
     * 列表默认按 createdAt 倒序，沿用原值会让刚恢复的账号按它们的历史时间
     * 散落在列表各处，用户根本找不到自己刚导进来的是哪些。
     * 批内按下标偏移，倒序下用 total - i 让文件里靠前的排在更上方。
     */
    const baseTime = importBaseTime()
    const list = data.accounts ?? []
    const total = list.length
    /*
     * 先把备份里的分组定义落地，得到「备份里的 id -> 本机的 id」映射。
     * 备份文件的 id 在本机可能不存在（换机恢复），直接沿用会变成悬空 id；
     * 同名分组则复用本机已有的那个，不重复建。
     */
    const groupsBefore = groups.value.length
    const groupIdMap = restoreGroups(data.groups)

    for (const [i, raw] of list.entries()) {
      if (!raw?.credentials?.refreshToken) {
        result.failed++
        continue
      }
      const idp = normalizeIdp(raw.idp)
      const key = `${raw.email}|${idp}`
      if (exists(raw.email, raw.userId, idp) || createdKeys.has(key)) {
        result.skipped++
        continue
      }
      createdKeys.add(key)
      /*
       * 分组 id 先走映射；映射不到时若本机正好有这个分组（同机恢复、或老备份
       * 没带 groups 字段）就沿用，否则当未分组处理，不留悬空引用。
       */
      // 老备份只有单个 groupId、新备份是 groupIds，groupIdsOf 两种都认
      const mappedGroupIds = groupIdsOf(raw)
        .map((id) => groupIdMap.get(id) ?? (groupMap.value.has(id) ? id : undefined))
        .filter((id): id is string => !!id)
      // 导入的账号一律进正常列表，不保留备份里的回收站标记
      const { trashedAt: _dropTrash, ...restRaw } = withGroupIds(raw, mappedGroupIds)
      created.push({
        ...restRaw,
        id: raw.id || crypto.randomUUID(),
        idp,
        usage: raw.usage ?? emptyUsage(),
        subscription: raw.subscription ?? { type: 'Free' },
        status: raw.status ?? 'unknown',
        createdAt: baseTime + (total - i),
        lastUsedAt: raw.lastUsedAt ?? baseTime
      })
      result.success++
    }

    if (created.length) accounts.value = [...accounts.value, ...created]
    // 只新增了分组（账号全跳过）也要落盘，否则新分组下次启动就丢了
    if (created.length || groups.value.length !== groupsBefore) persist(true)
    if (result.skipped) result.messages.push(`跳过 ${result.skipped} 个已存在的账号`)
    console.info(
      `[Account] 导入备份完成：新增 ${result.success}，跳过 ${result.skipped}，失败 ${result.failed}`
    )
    return result
  }

  // ============ 刷新 Token ============

  function applySnapshot(id: string, snapshot: AccountSnapshot): void {
    const account = get(id)
    if (!account) return
    // 积分变化日志由主进程去重：没变化的刷新不会落记录
    void window.api.recordUsagePoint(id, toPlain(snapshot.usage))
    updateAccount(id, {
      email: snapshot.email || account.email,
      userId: snapshot.userId ?? account.userId,
      // 记住主进程实测生效的 profileArn，下轮一次命中（Enterprise 免去重问 profile）
      profileArn: snapshot.profileArn || account.profileArn,
      subscription: snapshot.subscription,
      usage: snapshot.usage,
      status: 'active',
      lastError: undefined,
      lastCheckedAt: Date.now(),
      credentials: snapshot.accessToken
        ? {
            ...account.credentials,
            accessToken: snapshot.accessToken,
            refreshToken: snapshot.refreshToken || account.credentials.refreshToken,
            expiresAt: Date.now() + (snapshot.expiresIn ?? DEFAULT_EXPIRES_IN) * 1000
          }
        : account.credentials
    })
  }

  async function refreshToken(id: string): Promise<{ ok: boolean; error?: string }> {
    const account = get(id)
    if (!account) return { ok: false, error: '账号不存在' }

    const res = await window.api.refreshAccountToken(toPlain(account))
    if (!res.success || !res.data) {
      // 凭证被拒和网络异常要区分状态，但错误文案一律保留接口原始返回，便于排查
      const raw = res.error || 'Token 刷新失败'
      updateAccount(id, {
        status: isCredentialRejected(raw) ? 'expired' : 'error',
        lastError: raw,
        lastCheckedAt: Date.now()
      })
      return { ok: false, error: raw }
    }

    // 请求期间凭证可能已被其它入口更新过，这里重新取一次，
    // 否则展开的是 await 之前的旧 credentials，会把新值覆盖回去
    const latest = get(id) ?? account
    updateAccount(id, {
      credentials: {
        ...latest.credentials,
        accessToken: res.data.accessToken,
        refreshToken: res.data.refreshToken,
        expiresAt: Date.now() + res.data.expiresIn * 1000
      },
      status: 'active',
      lastError: undefined
    })
    // 刚刷过就别让它继续排在池子里等第二次
    removeFromRefreshPool(keyRefreshPool, id)
    return { ok: true }
  }

  async function checkStatus(id: string): Promise<{ ok: boolean; error?: string }> {
    const account = get(id)
    if (!account) return { ok: false, error: '账号不存在' }

    const res = await window.api.checkAccountStatus(toPlain(account))
    if (!res.success || !res.data) {
      const raw = res.error || '用量刷新失败'
      const credentialGone = !res.banned && isCredentialRejected(raw)
      updateAccount(id, {
        status: res.banned ? 'banned' : credentialGone ? 'expired' : 'error',
        lastError: raw,
        lastCheckedAt: Date.now()
      })
      return { ok: false, error: raw }
    }
    applySnapshot(id, res.data)
    // 刚刷过就别让它继续排在池子里等第二次
    removeFromRefreshPool(usageRefreshPool, id)
    return { ok: true }
  }

  /**
   * 批量刷新密钥或用量。ids 决定入队顺序（并发执行，完成顺序不保证），
   * 调用方按界面排序传入即可让靠前的账号先开始。
   * onProgress 用于实时反馈进度，不传则静默执行。
   */
  async function runBatch(
    ids: string[],
    kind: 'refresh' | 'check',
    onProgress?: (done: number, total: number) => void
  ): Promise<BatchResult> {
    const result: BatchResult = { success: 0, failed: 0, skipped: 0, messages: [] }
    if (ids.length === 0) return result

    task.value = {
      running: true,
      type: kind === 'refresh' ? 'account-key-refresh' : 'account-usage-refresh',
      label: kind === 'refresh' ? '批量刷新密钥' : '批量刷新用量',
      total: ids.length,
      done: 0
    }

    const concurrency = settingsStore.settings.concurrency

    // running 必须在 finally 里复位：池子里任何一个任务抛异常都会让整个 runPool reject，
    // 一旦这里漏掉复位，task.running 会永久为 true，之后所有自动刷新都会被静默跳过
    try {
      await runPool(
        ids,
        concurrency,
        async (id) => {
          // 单个账号的异常必须就地兜住：抛出去会中断所在的并发通道，
          // 该通道排队中的账号会被整批丢掉，表现为「一批里有些账号没刷新」
          try {
            const res = kind === 'refresh' ? await refreshToken(id) : await checkStatus(id)
            if (res.ok) result.success++
            else {
              result.failed++
              result.messages.push(`${get(id)?.email ?? id}：${res.error}`)
            }
          } catch (e) {
            result.failed++
            result.messages.push(`${get(id)?.email ?? id}：${errorMessage(e)}`)
          } finally {
            task.value.done++
            onProgress?.(task.value.done, ids.length)
          }
        },
        // 上游按突发流量限流，通道同帧起跑时一批里总有几个吃 403
        { staggerMs: 400 }
      )
    } finally {
      task.value.running = false
      persist(true)
      console.info(
        `[Account] ${task.value.label}结束：共 ${ids.length}，成功 ${result.success}，失败 ${result.failed}`
      )
    }
    return result
  }

  // ============ 自动刷新调度 ============

  // 调度方式：只记「下一轮的绝对到期时间」，再用一个秒级 tick 检查是否越过。
  //
  // 不要给每条任务开一个 setInterval(间隔分钟数)，实测不按时执行，原因有两个：
  // 1) 窗口最小化到托盘后页面转入后台，Chromium 会节流甚至冻结长间隔定时器，
  //    回调迟迟不来，界面上的倒计时也就一直停在 0 秒；
  // 2) 系统睡眠、进程被挂起期间错过的轮次，setInterval 不会补跑，直接丢掉。
  // 用到期时间 + 秒级 tick，无论被节流或挂起多久，恢复后的第一个 tick 就会补上。
  const AUTO_TICK_MS = 1_000

  let tickTimer: ReturnType<typeof setInterval> | null = null
  /** 自动任务自己的串行锁，两轮同时到期时排队跑，避免互相丢轮 */
  let autoRunning = false

  /** 下一条检测 / 刷新轨道的时间戳，未启用时为 null，供界面展示 */
  const nextKeyRefreshAt = ref<number | null>(null)
  const nextUsageRefreshAt = ref<number | null>(null)
  /**
   * 已闲置账号单独一条轨道。
   *
   * 闲置号的积分不会再涨，没必要跟着常规间隔一起发请求；账号一多（几百上千个闲置号）
   * 这轮请求纯属浪费。分开计时后它按 idleUsageRefreshInterval（默认 12 小时）跑，
   * 与常规用量刷新互不影响。
   *
   * 注意这里只是「检测间隔」：检测只把它们放进用量池，实际刷新由 nextUsageFlushAt 控制。
   */
  const nextIdleUsageRefreshAt = ref<number | null>(null)
  /**
   * 两条池子刷新轨道的下一次执行时间。
   *
   * 和上面三个检测时间相互独立：检测决定「谁该刷」，这里决定「什么时候真去刷」。
   * 拆开之后，检测间隔调得再密也不会增加上游请求量。
   *
   * 两条轨道也彼此独立：密钥池的节奏由 keyFlushInterval 控制（token 过期影响使用），
   * 用量池由 usageFlushInterval 控制（只是界面数字），可以各调各的。
   */
  const nextKeyFlushAt = ref<number | null>(null)
  const nextUsageFlushAt = ref<number | null>(null)

  // 已生效的间隔（分钟）。设置对象是整体替换的，换主题、折叠侧边栏这类无关改动
  // 也会触发外部的 watch，靠这些值判断间隔是否真的变了，避免倒计时被无故清零
  let appliedKeyInterval = 0
  let appliedUsageInterval = 0
  let appliedIdleInterval = 0
  let appliedKeyFlushInterval = 0
  let appliedUsageFlushInterval = 0

  /**
   * 上次真正跑完一轮的时间，落 localStorage 跨启动保留。
   * 冷启动时据此判断是否已经欠了一轮，欠了就立刻补跑，不必再等一个完整间隔。
   */
  const LAST_RUN_STORAGE = {
    key: 'kal:auto-key-refresh-at',
    usage: 'kal:auto-usage-refresh-at',
    idleUsage: 'kal:auto-idle-usage-refresh-at',
    keyFlush: 'kal:auto-key-flush-at',
    usageFlush: 'kal:auto-usage-flush-at'
  } as const

  type AutoKind = keyof typeof LAST_RUN_STORAGE

  function readLastRun(kind: AutoKind): number {
    const raw = Number(localStorage.getItem(LAST_RUN_STORAGE[kind]))
    // 缺记录（首次启动）或数据被改坏时返回 0，一律按「欠一轮」处理
    return Number.isFinite(raw) && raw > 0 ? raw : 0
  }

  function markRan(kind: AutoKind): void {
    try {
      localStorage.setItem(LAST_RUN_STORAGE[kind], String(Date.now()))
    } catch {
      // 隐私模式下 localStorage 可能不可写，退化成「每次启动都补跑一轮」
    }
  }

  const keyIntervalMs = (): number => Math.max(1, settingsStore.settings.keyRefreshInterval) * 60_000
  const usageIntervalMs = (): number =>
    Math.max(1, settingsStore.settings.usageRefreshInterval) * 60_000
  /** 闲置账号的间隔按小时配置，换算成毫秒 */
  const idleUsageIntervalMs = (): number =>
    Math.max(1, settingsStore.settings.idleUsageRefreshInterval) * 3_600_000

  /**
   * 每次从池子里取多少个去刷新。非法值（负数、NaN、空串）回落到默认。
   *
   * 同一出口 IP 短时间集中请求会被上游限流回 403，把这个数量摊小能明显降低触发概率。
   */
  function flushSizeOf(value: unknown, fallback: number): number {
    const raw = Number(value)
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
  }
  const keyFlushSize = (): number =>
    flushSizeOf(settingsStore.settings.keyFlushSize, DEFAULT_SETTINGS.keyFlushSize)
  const usageFlushSize = (): number =>
    flushSizeOf(settingsStore.settings.usageFlushSize, DEFAULT_SETTINGS.usageFlushSize)

  /** 池子刷新间隔，换算成毫秒；非法值回落到默认 */
  const flushIntervalMs = (value: unknown, fallback: number): number =>
    Math.max(1, Number(value) || fallback) * 60_000
  const keyFlushIntervalMs = (): number =>
    flushIntervalMs(settingsStore.settings.keyFlushInterval, DEFAULT_SETTINGS.keyFlushInterval)
  const usageFlushIntervalMs = (): number =>
    flushIntervalMs(settingsStore.settings.usageFlushInterval, DEFAULT_SETTINGS.usageFlushInterval)

  /**
   * 检测「即将过期的密钥」，把它们放进待刷新池。
   *
   * 只入池、不发请求：真正发请求由密钥池刷新任务按 keyFlushInterval / keyFlushSize
   * 控制。两条时间线解耦后，检测频率调高也不会带来更多上游请求。
   *
   * refreshToken 是轮换式的，刷一次旧值立即作废，所以刷得越勤、轮换失败与限流的
   * 面就越大，而 token 本身有 1 小时寿命，没必要每轮都换。
   */
  function scanExpiringKeys(): void {
    const windowMinutes = Math.max(
      1,
      settingsStore.settings.keyRefreshWindowMinutes || DEFAULT_KEY_REFRESH_WINDOW_MINUTES
    )
    const windowMs = windowMinutes * 60_000
    /*
     * 可选的用量阈值拦截。默认关闭，因为停刷密钥是有代价的：
     * accessToken 过期后要重新换一次，refreshToken 长期不轮换也可能被判失效。
     * 打开后只对「额度已用完、短期不会再动」的账号生效，能省下大量无谓轮换。
     */
    const capEnabled = settingsStore.settings.skipKeyRefreshAtUsageLimit
    const maxPercent = settingsStore.settings.usageRefreshMaxPercent
    const useCap = capEnabled && Number.isFinite(maxPercent) && maxPercent > 0

    const expiring = accounts.value.filter(
      (a) => a.status !== 'banned' && a.credentials.expiresAt - Date.now() < windowMs
    )
    const soon = expiring
      .filter((a) => !useCap || !reachedUsageLimit(a, maxPercent))
      .map((a) => a.id)
    const capped = expiring.length - soon.length

    /*
     * 入池标记是「入池那一刻的 token 到期时间」；出队时比对账号当前的到期时间，
     * 变了说明中途被刷过，token 已经新鲜，直接丢弃不再刷一次。
     */
    const added = enqueueRefreshPool(keyRefreshPool, soon, (id) => {
      const account = get(id)
      if (!account || !isRefreshableId(id)) return null
      return account.credentials.expiresAt
    })

    const pending = keyRefreshPool.queue.length
    if (!added && !pending) {
      // 池子也空：要么本就没有即将过期的账号，要么候选全被用量阈值排除
      console.info(
        capped
          ? `[AutoRefresh] 本轮没有需要加入密钥池的账号：${capped} 个用量已达 ${maxPercent}%，已跳过`
          : '[AutoRefresh] 本轮没有即将过期的账号，密钥池为空'
      )
      return
    }
    console.info(
      `[AutoRefresh] 密钥池检测完成：新入池 ${added} 个，池内待刷 ${pending} 个` +
        (capped ? `（${capped} 个已达用量阈值，未入池）` : '')
    )
  }

  /**
   * 覆盖本轮该刷的账号，界面上保持静默，只往控制台记录，避免定时弹通知打扰。
   *
   * 跳过封禁与凭证失效的账号：自动刷新是每隔一段时间就跑一轮的，
   * 把必然 401 / 403 的账号一直带着刷，只会白耗时间并在日志里堆无效告警。
   * 临时故障（网络、限流、5xx）不在跳过范围内，下一轮照常重试。
   *
   * 只入池、不发请求：真正刷新由池子刷新任务按固定节奏执行。
   *
   * @param scope 'regular' 扫非闲置账号，'idle' 扫已闲置账号。
   *   两条轨道各有各的检测间隔（见 idleUsageIntervalMs）；入池后共用同一个池，
   *   因为它们的入池频率天然不同，FIFO 就够了。
   */
  function scanUsage(scope: 'regular' | 'idle'): void {
    // 回收站里的账号是冷藏的，不参与自动刷新用量
    const live = liveAccounts.value
    const byStage = live.filter((a) =>
      scope === 'idle' ? accountStageOf(a) === 'idle' : accountStageOf(a) !== 'idle'
    )
    const runnable = byStage.filter((a) => !shouldSkipAccountUsageRefresh(a))
    /*
     * 用量已经超过设置阈值的账号不再自动刷新：额度见底后刷多少次都不会变多，
     * 纯属浪费请求。手动刷新不受这条限制，用户想查随时能查。
     */
    const maxPercent = settingsStore.settings.usageRefreshMaxPercent
    const notCapped = runnable.filter((a) => !reachedUsageLimit(a, maxPercent))
    const capped = runnable.length - notCapped.length
    const ids = notCapped.map((a) => a.id)
    const skipped = byStage.length - ids.length
    const label = scope === 'idle' ? '已闲置账号' : '常规账号'
    // 全部被跳过时也要留下日志：账号多的时候「这轮为什么没扫到」得能查得到
    if (!ids.length) {
      console.info(
        `[AutoRefresh] ${label}本轮无可入池账号：共 ${byStage.length} 个，` +
          `其中 ${capped} 个用量已达 ${maxPercent}%，其余为封禁或凭证失效`
      )
      return
    }
    /*
     * 入池标记是「用量数据的时间戳」；出队时比对，变了说明中途被刷成功过，
     * 用量已经是最新的，直接丢弃不再重复请求一次。
     *
     * 用 usage.lastUpdated 而不是 lastCheckedAt：后者在刷新失败时也会更新，
     * 拿它当标记会让「手动刷失败」的账号被误判成已刷过而不再重试。lastUpdated
     * 只在解析成功响应时写入，失败时保持原值，语义正好。
     */
    const added = enqueueRefreshPool(usageRefreshPool, ids, (id) => {
      const account = get(id)
      if (!account || !isRefreshableId(id)) return null
      return account.usage.lastUpdated ?? 0
    })
    const pending = usageRefreshPool.queue.length
    console.info(
      `[AutoRefresh] ${label}用量池检测完成：新入池 ${added} 个，池内待刷 ${pending} 个` +
        (skipped ? `（${skipped} 个封禁、凭证失效或已达阈值，未入池）` : '')
    )
  }

  /**
   * 从密钥池取一批去刷新。
   *
   * 密钥池与用量池各有一条独立的刷新轨道（各自的间隔与每次数量），不再交替：
   * token 过期会直接影响账号能否使用，值得比用量刷得更勤。
   *
   * 空池不弹提示：这是几分钟就可能跑一次的自动任务，弹了就是刷屏。
   */
  async function flushKeyPool(): Promise<void> {
    if (!keyRefreshPool.queue.length) return
    // 先把池里的号全部取出（含被剔除的），再看真正该刷的有几个
    const ids = drainRefreshPool(keyRefreshPool, keyFlushSize(), stillNeededKey)
    if (!ids.length) return
    const startedAt = Date.now()
    console.info(
      `[AutoRefresh] 刷新密钥池：取 ${ids.length} 个，池内还剩 ${keyRefreshPool.queue.length} 个`
    )
    const res = await runBatch(ids, 'refresh')
    console.info(
      `[AutoRefresh] 密钥池刷新结束：成功 ${res.success}，失败 ${res.failed}，` +
        `耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`
    )
    if (res.failed) console.warn('[AutoRefresh] 密钥池刷新失败明细：', res.messages)
  }

  /** 从用量池取一批去刷新，同上 */
  async function flushUsagePool(): Promise<void> {
    if (!usageRefreshPool.queue.length) return
    const ids = drainRefreshPool(usageRefreshPool, usageFlushSize(), stillNeededUsage)
    if (!ids.length) return
    const startedAt = Date.now()
    console.info(
      `[AutoRefresh] 刷新用量池：取 ${ids.length} 个，池内还剩 ${usageRefreshPool.queue.length} 个`
    )
    const res = await runBatch(ids, 'check')
    console.info(
      `[AutoRefresh] 用量池刷新结束：成功 ${res.success}，失败 ${res.failed}，` +
        `耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`
    )
    if (res.failed) console.warn('[AutoRefresh] 用量池刷新失败明细：', res.messages)
  }

  /** 密钥池出队判断：账号还能刷、且入池后 token 没被换过 */
  function stillNeededKey(id: string, stamp: number): boolean {
    const account = get(id)
    if (!account || !isRefreshableId(id)) return false
    // 到期时间变了 = 入池后被刷过，token 已经新鲜，不再重复刷
    return account.credentials.expiresAt === stamp
  }

  /** 用量池出队判断：账号还能刷、且入池后用量没被刷过 */
  function stillNeededUsage(id: string, stamp: number): boolean {
    const account = get(id)
    if (!account || !isRefreshableId(id)) return false
    return (account.usage.lastUpdated ?? 0) === stamp
  }

  /** 每秒检查各条轨道是否到期；到期就跑，跑完从当前时间重新计时 */
  async function autoTick(): Promise<void> {
    if (autoRunning) return
    const at = Date.now()
    const keyDue = nextKeyRefreshAt.value !== null && at >= nextKeyRefreshAt.value
    const usageDue = nextUsageRefreshAt.value !== null && at >= nextUsageRefreshAt.value
    const idleDue =
      nextIdleUsageRefreshAt.value !== null && at >= nextIdleUsageRefreshAt.value
    const keyFlushDue = nextKeyFlushAt.value !== null && at >= nextKeyFlushAt.value
    const usageFlushDue = nextUsageFlushAt.value !== null && at >= nextUsageFlushAt.value
    if (!keyDue && !usageDue && !idleDue && !keyFlushDue && !usageFlushDue) return
    // 手动批量操作正占用着全局任务状态：本轮不丢，等它结束后的下一个 tick 立刻补跑
    if (task.value.running) return

    autoRunning = true
    try {
      /*
       * 到期时间先往后推一轮再执行：中途抛异常也不会卡在「一直到期」的状态里每秒重试。
       *
       * 检测与刷新是两条独立时间线：检测只入池，刷新才发请求。
       * 检测在入池前不需要知道池子有多长，所以直接按固定间隔排下一轮即可。
       */
      if (keyDue) {
        nextKeyRefreshAt.value = at + keyIntervalMs()
        scanExpiringKeys()
        markRan('key')
      }
      if (usageDue) {
        nextUsageRefreshAt.value = at + usageIntervalMs()
        scanUsage('regular')
        markRan('usage')
      }
      if (idleDue) {
        nextIdleUsageRefreshAt.value = at + idleUsageIntervalMs()
        scanUsage('idle')
        markRan('idleUsage')
      }
      /*
       * 两条刷新区间彼此独立，同一次 tick 里都到期时按「密钥 → 用量」串行执行。
       * autoRunning 锁保证不会真正并发，只是背靠背。
       */
      if (keyFlushDue) {
        nextKeyFlushAt.value = at + keyFlushIntervalMs()
        await flushKeyPool()
        markRan('keyFlush')
      }
      if (usageFlushDue) {
        nextUsageFlushAt.value = at + usageFlushIntervalMs()
        await flushUsagePool()
        markRan('usageFlush')
      }
    } catch (e) {
      console.error('[AutoRefresh] 本轮自动刷新异常：', e)
    } finally {
      autoRunning = false
    }
  }

  /**
   * 该账号是否还能参与刷新：已删除、进了回收站、被封禁的都不该占池子名额。
   * 不排除 expired——密钥刷新本身就是为了把过期凭证换新，排除它等于永不修复。
   */
  function isRefreshableId(id: string): boolean {
    const account = get(id)
    return !!account && !isTrashed(account) && account.status !== 'banned'
  }

  function ensureTick(): void {
    if (tickTimer) return
    tickTimer = setInterval(() => void autoTick(), AUTO_TICK_MS)
  }

  function stopTick(): void {
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
  }

  /**
   * 手动批量刷新完调用：让检测轨道从现在重新计时，避免刚看完就又被检一遍。
   *
   * 手动刷新不进池、也不影响池子刷新的节奏——池子里原有的内容照常按自己的
   * 时间点继续推进。
   */
  function scheduleKeyRefresh(): void {
    appliedKeyInterval = settingsStore.settings.keyRefreshInterval
    if (!settingsStore.settings.autoRefresh) {
      nextKeyRefreshAt.value = null
      return
    }
    markRan('key')
    nextKeyRefreshAt.value = Date.now() + keyIntervalMs()
    ensureTick()
  }

  /** 用量检测轨道重新计时，同上 */
  function scheduleUsageRefresh(): void {
    appliedUsageInterval = settingsStore.settings.usageRefreshInterval
    appliedIdleInterval = settingsStore.settings.idleUsageRefreshInterval
    if (!settingsStore.settings.autoRefreshUsage) {
      nextUsageRefreshAt.value = null
      nextIdleUsageRefreshAt.value = null
      return
    }
    markRan('usage')
    markRan('idleUsage')
    nextUsageRefreshAt.value = Date.now() + usageIntervalMs()
    nextIdleUsageRefreshAt.value = Date.now() + idleUsageIntervalMs()
    ensureTick()
  }

  /**
   * 按「上次跑完的时间 + 间隔」对齐下一轮，而不是从现在起算。
   *
   * 冷启动、长时间休眠、或把间隔从长调短之后，如果已经越过应刷时间，
   * 这里算出的时间点就落在过去，下一个 tick（1 秒内）立刻补跑一轮，
   * 不必再干等一个完整间隔。
   */
  function alignNextRun(kind: AutoKind): number {
    const intervalOf: Record<AutoKind, () => number> = {
      key: keyIntervalMs,
      usage: usageIntervalMs,
      idleUsage: idleUsageIntervalMs,
      keyFlush: keyFlushIntervalMs,
      usageFlush: usageFlushIntervalMs
    }
    const due = readLastRun(kind) + intervalOf[kind]()
    // 已经欠一轮：统一归到当下，界面显示「本轮正在执行…」而不是一个久远的时间
    return due <= Date.now() ? Date.now() : due
  }

  function alignKeyRefresh(): void {
    appliedKeyInterval = settingsStore.settings.keyRefreshInterval
    if (!settingsStore.settings.autoRefresh) {
      nextKeyRefreshAt.value = null
      return
    }
    nextKeyRefreshAt.value = alignNextRun('key')
    ensureTick()
  }

  function alignUsageRefresh(): void {
    appliedUsageInterval = settingsStore.settings.usageRefreshInterval
    appliedIdleInterval = settingsStore.settings.idleUsageRefreshInterval
    if (!settingsStore.settings.autoRefreshUsage) {
      nextUsageRefreshAt.value = null
      nextIdleUsageRefreshAt.value = null
      return
    }
    nextUsageRefreshAt.value = alignNextRun('usage')
    nextIdleUsageRefreshAt.value = alignNextRun('idleUsage')
    ensureTick()
  }

  /**
   * 两条刷新区间的对齐，各自受对应的检测开关门控。
   *
   * 某个检测开关关掉时它的池子不会再有新号进来，但池里可能还有积压，
   * 所以刷新轨道跟着开关走：关掉检测就不再刷新那个池。
   */
  function alignKeyFlush(): void {
    appliedKeyFlushInterval = settingsStore.settings.keyFlushInterval
    if (!settingsStore.settings.autoRefresh) {
      nextKeyFlushAt.value = null
      return
    }
    nextKeyFlushAt.value = alignNextRun('keyFlush')
    ensureTick()
  }

  function alignUsageFlush(): void {
    appliedUsageFlushInterval = settingsStore.settings.usageFlushInterval
    if (!settingsStore.settings.autoRefreshUsage) {
      nextUsageFlushAt.value = null
      return
    }
    nextUsageFlushAt.value = alignNextRun('usageFlush')
    ensureTick()
  }

  /**
   * 按当前设置对齐各条轨道：开关刚打开或间隔真的改了才重新计时，
   * 其余设置改动（主题、侧边栏、隐私模式……）不影响已经在跑的倒计时。
   *
   * 计时基准是「上次跑完的时间」，所以冷启动时若距上次刷新已超过间隔，
   * 会立刻补跑一轮而不是干等一个完整间隔。
   */
  function startAutoRefresh(): void {
    const {
      autoRefresh,
      autoRefreshUsage,
      keyRefreshInterval,
      usageRefreshInterval,
      idleUsageRefreshInterval,
      keyFlushInterval,
      usageFlushInterval
    } = settingsStore.settings
    // 用 align 而不是 schedule：冷启动或改短间隔后若已欠一轮，会立刻补跑
    if (!autoRefresh) nextKeyRefreshAt.value = null
    else if (nextKeyRefreshAt.value === null || appliedKeyInterval !== keyRefreshInterval) {
      alignKeyRefresh()
    }
    if (!autoRefreshUsage) {
      nextUsageRefreshAt.value = null
      nextIdleUsageRefreshAt.value = null
    } else if (
      nextUsageRefreshAt.value === null ||
      appliedUsageInterval !== usageRefreshInterval ||
      appliedIdleInterval !== idleUsageRefreshInterval
    ) {
      alignUsageRefresh()
    }
    // 两条池子刷新轨道各自跟着自己的检测开关与间隔
    if (!autoRefresh) nextKeyFlushAt.value = null
    else if (nextKeyFlushAt.value === null || appliedKeyFlushInterval !== keyFlushInterval) {
      alignKeyFlush()
    }
    if (!autoRefreshUsage) nextUsageFlushAt.value = null
    else if (
      nextUsageFlushAt.value === null ||
      appliedUsageFlushInterval !== usageFlushInterval
    ) {
      alignUsageFlush()
    }

    if (
      nextKeyRefreshAt.value === null &&
      nextUsageRefreshAt.value === null &&
      nextIdleUsageRefreshAt.value === null &&
      nextKeyFlushAt.value === null &&
      nextUsageFlushAt.value === null
    ) {
      stopTick()
    } else {
      ensureTick()
    }
  }

  function stopAutoRefresh(): void {
    stopTick()
    nextKeyRefreshAt.value = null
    nextUsageRefreshAt.value = null
    nextIdleUsageRefreshAt.value = null
    nextKeyFlushAt.value = null
    nextUsageFlushAt.value = null
  }

  return {
    // 状态
    accounts,
    liveAccounts,
    trashedCount,
    trashView,
    recentAccount,
    selectedIds,
    loading,
    task,
    filter,
    // 查询
    filtered,
    batchQuery,
    stats,
    get,
    applyFilter,
    // 增删改
    load,
    addByCredentials,
    addByOnlineLogin,
    updateAccount,
    setNoteForAccounts,
    setPaymentLink,
    markDowngraded,
    hasPendingDowngrade,
    clearDowngrade,
    setSold,
    clearPaymentLink,
    // 分组
    groups,
    groupMap,
    groupCounts,
    addGroup,
    renameGroup,
    removeGroup,
    reorderGroups,
    setGroupForAccounts,
    setTrashed,
    removeAccounts,
    importItems,
    importFullData,
    // 刷新
    refreshToken,
    checkStatus,
    runBatch,
    nextKeyRefreshAt,
    nextUsageRefreshAt,
    nextIdleUsageRefreshAt,
    nextKeyFlushAt,
    nextUsageFlushAt,
    scheduleKeyRefresh,
    scheduleUsageRefresh,
    startAutoRefresh,
    stopAutoRefresh
  }
})

// setup 风格的 store 默认不参与 HMR，改完 store 后运行中的实例会缺少新增方法
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAccountsStore, import.meta.hot))
}
