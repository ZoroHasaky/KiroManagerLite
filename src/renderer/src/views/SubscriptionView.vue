<script setup lang="ts">
/**
 * 订阅管理。
 *
 * 两个 Tab 都是「勾选账号 → 批量执行」的形态，共用同一套列表与批量执行框架：
 *  - 获取链接：给「未使用」阶段的账号批量生成指定档位的 Stripe 结算链接；
 *  - 切换 Free：把非 Free 账号的订阅降到 Kiro Free。
 *
 * 两件事都会改动上游状态，所以都串行执行（并发容易被判为异常活动），
 * 单个账号失败只记在它自己身上，不影响后续。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import dayjs, { type Dayjs } from 'dayjs'
import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  CopyOutlined,
  CrownOutlined,
  DownOutlined,
  DownloadOutlined,
  FileExcelOutlined,
  GlobalOutlined,
  ReloadOutlined,
  StopOutlined,
  ThunderboltOutlined
} from '@ant-design/icons-vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { useSubscriptionLinksStore, type LinkRowState } from '@/stores/subscriptionLinks'
import { useBatchRun, type BatchRow } from '@/utils/batchRun'
import { displayEmail } from '@/utils/display'
import { subscriptionLabel } from '@/utils/format'
import { freshAccount } from '@/utils/freshAccount'
import { toPlain } from '@/utils/ipc'
import { now } from '@/utils/now'
import { copyText } from '@/utils/ui'
import { errorMessage } from '@shared/errors'
import { accountStageOf } from '@shared/accountStage'
import type { Account, SubscriptionPlan, SwitchToFreeResult } from '@shared/types'

const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()
const linksStore = useSubscriptionLinksStore()

type TabKey = 'links' | 'free'
const activeTab = ref<TabKey>('links')

/** 隐私模式下邮箱打码 */
function email(account: Account): string {
  return displayEmail(account.email, settingsStore.settings.privacyMode)
}

// ============ 获取链接 ============

interface LinkRow {
  account: Account
  state: LinkRowState
  url?: string
  error?: string
}

/** 只处理「未使用」阶段的账号：已订阅的生成不了新链接，待支付/已闲置的不该再生成 */
const unusedAccounts = computed(() =>
  accountsStore.liveAccounts.filter((account) => accountStageOf(account) === 'unused')
)

/**
 * 列表里的账号顺序（只存账号，不存结果）。
 *
 * 列表就是「未使用」账号：拿到支付链接后账号阶段变成「待支付」，
 * 它会自动从列表里消失——已经处理完的号不该继续占着待办列表。
 * 结果在 subscriptionLinks store 里按 id 留一份，供下载与切走页面后回来查看。
 */
const linkListRef = ref<HTMLElement | null>(null)

/** 勾选集合：key 为账号 id */
const linkSelected = ref<Set<string>>(new Set())

/**
 * 列表 = 未使用账号 + 本轮正在进行的那一个。
 *
 * 生成成功会让账号阶段从「未使用」变成「待支付」，于是它自然从列表里消失；
 * 但正在跑的那一行必须留着，否则用户看不到「生成中」，执行中的行也会突然消失。
 * 失败的行阶段没变，仍然留在列表里，方便再点一次重试。
 */
const linkRows = computed<LinkRow[]>(() => {
  const rows = new Map<string, Account>()
  for (const account of unusedAccounts.value) rows.set(account.id, account)
  const activeId = linksStore.activeId
  if (activeId && !rows.has(activeId)) {
    const account = accountsStore.get(activeId)
    if (account) rows.set(activeId, account)
  }

  return [...rows.values()].map((account) => {
    const result = linksStore.resultOf(account.id)
    return {
      account,
      state: result?.state ?? 'pending',
      url: result?.url,
      error: result?.error
    }
  })
})

/** 勾选里的失效项：账号已经不在列表里（生成成功溜走 / 被删）时清掉，避免幽灵勾选 */
watch(linkRows, (rows) => {
  const valid = new Set(rows.map((row) => row.account.id))
  const kept = [...linkSelected.value].filter((id) => valid.has(id))
  if (kept.length !== linkSelected.value.size) linkSelected.value = new Set(kept)
})

const plans = ref<SubscriptionPlan[]>([])
/** 选中档位存在 store 里：切走页面再回来要保留，否则会回落成列表第一项、和预约记录对不上 */
const planType = computed({
  get: () => linksStore.planType,
  set: (value: string) => (linksStore.planType = value)
})
const plansLoading = ref(false)
const plansError = ref('')
/** 查档位时要先给某个账号续期 Token，加载文案据此切换 */
const refreshingToken = ref(false)

/** 只把勾选的账号送进批量执行；没勾选的保持原状不参与 */
const selectedLinkRows = computed(() =>
  linkRows.value.filter((row) => linkSelected.value.has(row.account.id))
)

/** 勾选项里真正会被执行的：已生成成功的行会被跳过，不算进按钮上的数量 */
const runnableIds = computed(() =>
  selectedLinkRows.value.filter((row) => row.state !== 'ok').map((row) => row.account.id)
)

const linkRunning = computed(() => linksStore.running)
const linkStopping = computed(() => linksStore.stopRequested)
const linkStat = computed(() => linksStore.stat)

/** 开始生成：队列与进度都由 store 管，切走页面也不会丢 */
function startLinks(): void {
  if (!planType.value || !runnableIds.value.length) return
  void linksStore.start(runnableIds.value, planType.value)
}

function stopLinks(): void {
  linksStore.stop()
}

/** 正在处理的那一行滚进视野（行元素带 data-row-index） */
watch(
  () => linksStore.activeId,
  (id) => {
    if (!id) return
    const index = linkRows.value.findIndex((row) => row.account.id === id)
    if (index < 0) return
    void nextTick(() => {
      const target = linkListRef.value?.querySelector<HTMLElement>(
        `[data-row-index="${Math.min(index + 2, linkRows.value.length - 1)}"]`
      )
      // block: 'nearest' 只滚动列表容器自身，不会带动整个页面
      target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }
)

/**
 * 已生成的链接（下载与计数用）。
 *
 * 不能从 linkRows 取：拿到链接的账号已经离开列表了。这里直接读 store 里的结果，
 * 邮箱从账号数据补回来。走 resultOf 而不是 results，链接被清掉的那些不会被导出。
 */
const generatedRows = computed(() => {
  const rows: { id: string; email: string; url: string }[] = []
  for (const id of linksStore.results.keys()) {
    const result = linksStore.resultOf(id)
    if (result?.state !== 'ok' || !result.url) continue
    rows.push({ id, email: accountsStore.get(id)?.email ?? id, url: result.url })
  }
  return rows
})
const noDownload = computed(() => !generatedRows.value.length || linkRunning.value)
const planTitle = computed(
  () => plans.value.find((plan) => plan.subscriptionType === planType.value)?.title ?? ''
)

function priceText(plan: SubscriptionPlan): string {
  if (plan.amount <= 0) return '免费'
  return `${plan.currency === 'USD' ? '$' : ''}${plan.amount}${plan.currency === 'USD' ? '' : ` ${plan.currency}`}`
}

/**
 * 查可开通档位：用任意一个有凭证的账号问一次即可。
 * 档位列表对所有账号是同一份（同一商户），不必每个账号各查一遍。
 */
async function loadPlans(): Promise<void> {
  plansError.value = ''
  const probe = accountsStore.liveAccounts[0]
  if (!probe) {
    plansError.value = '还没有任何账号'
    return
  }
  plansLoading.value = true
  try {
    const account = await freshAccount(probe, (v) => (refreshingToken.value = v))
    const res = await window.api.listSubscriptionPlans(toPlain(account))
    if (!res.success || !res.data) {
      plansError.value = res.error || '查询订阅档位失败'
      return
    }
    // 免费档没有结算链接，不列出来
    const previous = planType.value
    plans.value = res.data.filter((plan) => plan.amount > 0)
    /*
     * 已经选过的档位还在列表里就保持不动，只在「没选过」或「原档位下线了」时才回落到第一项。
     *
     * 不能无条件取第一项：重新进页面会重跑一次 loadPlans，而预约里记的是预约当时选的那个档位。
     * 无条件回落会让下拉显示成另一个档位、预约条却写着原来那个，
     * 用户照着下拉点「获取链接」就会按错档位生成一批链接。
     */
    const stillAvailable = plans.value.some((plan) => plan.subscriptionType === previous)
    if (!stillAvailable) planType.value = plans.value[0]?.subscriptionType ?? ''
    if (!plans.value.length) plansError.value = '接口没有返回可开通的订阅档位'
    // 档位真的变了（原档位下线）等同于用户换档，旧链接与预约都要作废
    if (previous && planType.value !== previous) linksStore.reset()
  } catch (cause) {
    plansError.value = errorMessage(cause)
  } finally {
    plansLoading.value = false
  }
}

onMounted(loadPlans)

/**
 * 换档位后已生成的链接对不上，全部回到待生成。
 * 预约绑定的是旧档位，同样作废，否则到点会按旧档位悄悄生成。
 */
function onPlanChange(): void {
  linksStore.reset()
}

function toggleLink(id: string): void {
  // 运行中不改勾选：队列已按开始时的勾选拍好快照，此时改只会让界面与实际不一致
  if (linkRunning.value) return
  const next = new Set(linkSelected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  linkSelected.value = next
}

function selectAllLinks(checked: boolean): void {
  if (linkRunning.value) return
  linkSelected.value = checked ? new Set(linkRows.value.map((row) => row.account.id)) : new Set()
}

const allLinksSelected = computed(
  () => linkRows.value.length > 0 && linkSelected.value.size === linkRows.value.length
)

// ============ 预约执行 ============

/**
 * 预约时间选择器的值。
 * 预填「10 分钟后」：默认值让按钮直接可用，用户只需要在这一基础上改日期或时刻；
 * 选完也不清空，方便微调。
 */
const scheduleAt = ref<Dayjs | null>(dayjs().add(10, 'minute').second(0))
const booked = computed(() => linksStore.schedule)

/** 不能约到过去：日期选择器只放行今天及以后，具体时刻再在提交时校验 */
function disabledDate(current: Dayjs): boolean {
  return current.endOf('day').valueOf() < Date.now()
}

/** 预约信息条上的时间：与选择器同一个格式，分钟精度足够 */
function formatScheduleAt(at: number): string {
  return dayjs(at).format('YYYY-MM-DD HH:mm')
}

function submitSchedule(): void {
  const at = scheduleAt.value
  if (!at) return void message.info('请先选择预约时间')
  const error = linksStore.scheduleAt(at.valueOf(), runnableIds.value, planType.value)
  if (error) return void message.warning(error)
  message.success(
    `已预约 ${formatScheduleAt(at.valueOf())} 执行，共 ${runnableIds.value.length} 个账号`
  )
}

function cancelSchedule(): void {
  linksStore.cancelSchedule()
  message.success('已取消预约')
}

/** 预约倒计时：用共享的 5 秒时钟驱动，不额外开定时器 */
const bookedCountdown = computed(() => {
  const at = booked.value?.at
  if (!at) return ''
  const remain = at - now.value
  if (remain <= 0) return '即将开始…'
  const totalMinutes = Math.ceil(remain / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours) return minutes ? `${hours} 小时 ${minutes} 分钟后` : `${hours} 小时后`
  return `${Math.max(1, minutes)} 分钟后`
})

const bookedPlanTitle = computed(() => {
  const type = booked.value?.planType
  return plans.value.find((plan) => plan.subscriptionType === type)?.title ?? type ?? ''
})

async function openUrl(row: LinkRow): Promise<void> {
  if (!row.url) return
  const res = await window.api.openInAppBrowser(row.url, `订阅 ${planTitle.value} - ${row.account.email}`)
  if (!res.success) message.error(res.error || '打开链接失败')
}

/** 下载已生成的链接：txt 为「邮箱----链接」，xlsx 两列且链接可点 */
async function download(kind: 'txt' | 'xlsx'): Promise<void> {
  const rows = generatedRows.value
  if (!rows.length) return

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const plan = planTitle.value.replace(/[^\w+]+/g, '_') || 'plan'
  const filename = `subscription-${plan}-${rows.length}个-${stamp}.${kind}`

  const res =
    kind === 'txt'
      ? await window.api.exportToFile(
          `${rows.map((row) => `${row.email}----${row.url}`).join('\n')}\n`,
          filename
        )
      : await window.api.exportToXlsx(
          {
            name: '订阅链接',
            columns: [
              { title: '邮箱', width: 36 },
              { title: '订阅链接', width: 180, format: 'link' }
            ],
            rows: rows.map((row) => [row.email, row.url])
          },
          filename
        )

  if (!res.success) return void message.error(res.error || '下载失败')
  if (res.data?.saved) message.success(`已导出 ${rows.length} 个订阅链接`)
}

// ============ 切换 Free ============

interface FreeRow extends BatchRow {
  account: Account
  /** 结果里的「无需变更」说明，成功后展示 */
  note?: string
  /** 成功后先保留结果，到这个时刻再从列表移除 */
  removeAt?: number
}

/**
 * 需要切换 Free 的账号：订阅不是 Free，且没有「已提交、尚未生效」的切换记录。
 *
 * 后半条是关键。Stripe 的降级周期末才生效，提交之后 subscription.type 仍是原档位，
 * 只看订阅状态的话，重启程序后已经切过的账号会重新冒出来、还能被再提交一次。
 * 记录落在 Account.downgradedAt（见 stores/accounts 的 markDowngraded）。
 */
const paidAccounts = computed(() =>
  accountsStore.liveAccounts.filter(
    (account) =>
      account.subscription.type !== 'Free' && !accountsStore.hasPendingDowngrade(account)
  )
)

const freeRows = ref<FreeRow[]>([])
const freeListRef = ref<HTMLElement | null>(null)
const freeSelected = ref<Set<string>>(new Set())

/**
 * 与「获取链接」不同：这个列表**跟着状态收缩**。
 *
 * 「切换 Free」只对还没处理过的账号有意义，处理完就该从列表里消失；
 * 继续留着会让用户以为还有一批待处理，也容易对同一个号重复发起切换。
 * 代价是正在跑的批次行会中途消失，所以 useBatchRun 内部持有队列快照
 * （见 utils/batchRun），执行本身不受列表变化影响。
 */
watch(
  [paidAccounts, () => accountsStore.liveAccounts],
  ([eligible, live]) => {
    const liveById = new Map(live.map((account) => [account.id, account]))

    const next: FreeRow[] = []
    for (const row of freeRows.value) {
      const fresh = liveById.get(row.account.id)
      if (!fresh) continue
      // 刚处理完的行还处在结果展示期，等它自己的定时器移除，别在这里提前抹掉
      const showingResult = row.removeAt !== undefined && Date.now() < row.removeAt
      if (showingResult) {
        row.account = fresh
        next.push(row)
        continue
      }
      // 已经变成 Free、或已提交切换但还没生效的，都不该再留在待切换列表里
      if (fresh.subscription.type === 'Free') continue
      if (accountsStore.hasPendingDowngrade(fresh)) continue
      row.account = fresh
      next.push(row)
    }

    const existing = new Set(next.map((row) => row.account.id))
    for (const account of eligible) {
      if (existing.has(account.id)) continue
      next.push({ account, state: 'pending' })
    }

    const order = new Map<string, number>()
    eligible.forEach((account, index) => order.set(account.id, index))
    next.forEach((row, index) => {
      if (!order.has(row.account.id)) order.set(row.account.id, eligible.length + index)
    })
    next.sort((a, b) => (order.get(a.account.id) ?? 0) - (order.get(b.account.id) ?? 0))

    freeRows.value = next
    const valid = new Set(next.map((row) => row.account.id))
    freeSelected.value = new Set([...freeSelected.value].filter((id) => valid.has(id)))
  },
  { immediate: true }
)

const selectedFreeRows = computed(() =>
  freeRows.value.filter((row) => freeSelected.value.has(row.account.id))
)

const freeBatch = useBatchRun({
  rows: selectedFreeRows,
  listRef: freeListRef,
  messageKey: 'subscription-free-abort',
  async runOne(row) {
    const res = await window.api.switchSubscriptionToFree(toPlain(await freshAccount(row.account)))
    if (!res.success || !res.data) {
      row.state = 'fail'
      row.error = res.error || '切换失败'
      return
    }
    const result: SwitchToFreeResult = res.data
    if (!result.success) {
      row.state = 'fail'
      row.error = result.error || '切换失败'
      return
    }

    row.state = 'ok'
    // 「无需变更」的几种情况也按成功处理，但说明原因，避免用户以为没生效
    if (result.alreadyFree) row.note = '本来就是 Free'
    else if (result.alreadyScheduled) row.note = '已安排周期末切换'
    else if (result.wontRenew) row.note = '已设置到期不续费'
    else if (result.switched) row.note = '已提交，周期末生效'

    /*
     * 把「已提交」这个事实落盘。
     *
     * 三种「无需变更」的情况也要记：它们同样意味着这个号不需要再出现在待切换列表里
     * （本来就是 Free 的下一轮刷新就不会进来了，但已安排 / 不续费的订阅档位仍是原值，
     * 不记的话重启后又会冒出来）。transitionAt 只对「已安排」和「已提交」有效，
     * 到期后记录自动失效。
     */
    accountsStore.markDowngraded(row.account.id, result.transitionAt)

    /*
     * 已经切走的行要离开列表，但立刻消失会让人看不到结果。
     * 留 4 秒让「已提交，周期末生效」这类说明能被读到，再由下面的定时器移除。
     */
    row.removeAt = Date.now() + 4000
    window.setTimeout(() => {
      const remain = freeRows.value.filter((item) => item.account.id !== row.account.id)
      if (remain.length === freeRows.value.length) return
      freeRows.value = remain
      const nextSelected = new Set(freeSelected.value)
      nextSelected.delete(row.account.id)
      freeSelected.value = nextSelected
    }, 4200)

    // 切换成功后刷新该账号，让档位与阶段跟着变
    void accountsStore.checkStatus(row.account.id)
  }
})

/** 同 link 那套写法：解构出 ref 才能在模板里自动解包 */
const {
  running: freeRunning,
  aborted: freeAborted,
  stat: freeStat,
  start: startFreeBatch,
  abort: abortFreeBatch
} = freeBatch

function toggleFree(id: string): void {
  const next = new Set(freeSelected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  freeSelected.value = next
}

function selectAllFree(checked: boolean): void {
  freeSelected.value = checked ? new Set(freeRows.value.map((row) => row.account.id)) : new Set()
}

const allFreeSelected = computed(
  () => freeRows.value.length > 0 && freeSelected.value.size === freeRows.value.length
)

/** 切换 Free 会改上游状态，先确认一次 */
function startFreeSwitch(): void {
  if (!selectedFreeRows.value.length) return
  const count = selectedFreeRows.value.length
  if (!window.confirm(`确认把选中的 ${count} 个账号切换到 Kiro Free？\n\n切换后当前周期仍按原计划计费，下个周期起生效。`)) {
    return
  }
  void startFreeBatch()
}
</script>

<template>
  <div class="subscription-page">
    <a-tabs v-model:active-key="activeTab" class="page-tabs">
      <!-- ============ 获取链接 ============ -->
      <a-tab-pane key="links" tab="获取链接">
        <div class="toolbar">
          <span class="toolbar-label">订阅套餐</span>
          <a-select
            v-model:value="planType"
            class="plan-select"
            :loading="plansLoading"
            :disabled="plansLoading || linkRunning"
            :placeholder="plansLoading ? '正在加载套餐…' : '选择套餐'"
            @change="onPlanChange"
          >
            <a-select-option
              v-for="plan in plans"
              :key="plan.subscriptionType"
              :value="plan.subscriptionType"
            >
              {{ plan.title }}<span class="muted">（{{ priceText(plan) }} / {{ plan.billingInterval }}）</span>
            </a-select-option>
          </a-select>

          <a-button :loading="plansLoading" :disabled="linkRunning" @click="loadPlans">
            <template #icon><ReloadOutlined /></template>
            刷新套餐
          </a-button>

          <span class="spacer" />

          <a-space-compact :size="settingsStore.compactSize">
            <a-button :disabled="noDownload" @click="download('txt')">
              <template #icon><DownloadOutlined /></template>
              下载 txt（{{ generatedRows.length }}）
            </a-button>
            <a-dropdown :disabled="noDownload" placement="bottomRight">
              <a-button :disabled="noDownload" aria-label="选择下载格式">
                <template #icon><DownOutlined /></template>
              </a-button>
              <template #overlay>
                <a-menu @click="download('xlsx')">
                  <a-menu-item key="xlsx">
                    <FileExcelOutlined />
                    下载 xlsx（{{ generatedRows.length }}）
                  </a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
          </a-space-compact>
        </div>

        <a-alert
          v-if="plansError"
          type="error"
          show-icon
          class="page-alert"
          :message="plansError"
          description="套餐列表来自 Kiro 门户，需要至少一个凭证有效的账号才能查询。"
        />
        <a-alert
          v-else
          type="info"
          show-icon
          class="page-alert"
          message="为勾选的「未使用」账号生成所选档位的 Stripe 订阅链接，按列表顺序逐个生成，单个失败不影响后续。已有订阅的账号会判为失败。也可以预约一个时间点，到点自动执行一次（离开本页仍会执行，退出应用则失效）。"
        />

        <!-- 预约信息条：已约好之后替代底部的「预约执行」按钮，随时可取消 -->
        <a-alert v-if="booked" type="success" show-icon class="page-alert booked-bar">
          <template #message>
            <span class="booked-text">
              已预约 {{ formatScheduleAt(booked.at) }} 为 {{ booked.ids.length }} 个账号生成「{{
                bookedPlanTitle
              }}」链接
              <span class="muted">（{{ bookedCountdown }}）</span>
            </span>
            <a-button type="link" size="small" class="booked-cancel" @click="cancelSchedule">
              取消预约
            </a-button>
          </template>
        </a-alert>

        <div class="list-head">
          <a-checkbox
            :checked="allLinksSelected"
            :indeterminate="linkSelected.size > 0 && !allLinksSelected"
            :disabled="linkRunning"
            @change="selectAllLinks(($event.target as HTMLInputElement).checked)"
          >
            全选
          </a-checkbox>
          <span class="count-text">
            共 {{ linkRows.length }} 个未使用账号
            <template v-if="linkSelected.size">· 已选 {{ linkSelected.size }}</template>
          </span>
          <span class="spacer" />
          <span v-if="linkRunning" class="count-text">
            正在生成 {{ linkStat.ok + linkStat.fail + 1 }}/{{ linkStat.total }}
          </span>
          <a-tag v-if="linkStat.ok" color="green" :bordered="false">
            成功 {{ linkStat.ok }}
          </a-tag>
          <a-tag v-if="linkStat.fail" color="red" :bordered="false">
            失败 {{ linkStat.fail }}
          </a-tag>
        </div>

        <div ref="linkListRef" class="row-list">
          <div
            v-for="(row, index) in linkRows"
            :key="row.account.id"
            :data-row-index="index"
            class="row clickable"
            :class="[row.state, { 'is-selected': linkSelected.has(row.account.id) }]"
            @click="toggleLink(row.account.id)"
          >
            <!-- 复选框自己会派发 change，再冒泡到整行就会连着切两次，这里拦下 -->
            <a-checkbox
              :checked="linkSelected.has(row.account.id)"
              :disabled="linkRunning"
              @click.stop
              @change="toggleLink(row.account.id)"
            />
            <div class="row-main">
              <div class="row-email">
                {{ email(row.account) }}
                <a-tag :bordered="false" class="tier-tag">
                  {{ subscriptionLabel(row.account.subscription) }}
                </a-tag>
              </div>
              <a
                v-if="row.url"
                class="row-url mono"
                :href="row.url"
                :title="row.url"
                @click.prevent.stop="openUrl(row)"
              >
                {{ row.url }}
              </a>
            </div>
            <div class="row-state">
              <template v-if="row.state === 'pending'">
                <span class="muted">等待生成</span>
              </template>
              <template v-else-if="row.state === 'running'">
                <a-spin size="small" />
                <span class="running-text">生成中</span>
              </template>
              <template v-else-if="row.state === 'ok'">
                <CheckCircleFilled class="ok-icon" />
                <span class="ok-text">已生成</span>
                <a-tooltip title="用内置浏览器打开">
                  <a-button type="text" size="small" class="row-icon" @click.stop="openUrl(row)">
                    <template #icon><GlobalOutlined /></template>
                  </a-button>
                </a-tooltip>
                <a-tooltip title="复制订阅链接">
                  <a-button
                    type="text"
                    size="small"
                    class="row-icon"
                    @click.stop="copyText(row.url!, '已复制订阅链接')"
                  >
                    <template #icon><CopyOutlined /></template>
                  </a-button>
                </a-tooltip>
              </template>
              <template v-else>
                <CloseCircleFilled class="fail-icon" />
                <span class="fail-text" :title="row.error">{{ row.error }}</span>
              </template>
            </div>
          </div>

          <div v-if="!linkRows.length" class="empty muted">
            没有「未使用」阶段的账号
          </div>
        </div>

        <div class="footer">
          <span class="spacer" />
          <a-button v-if="linkRunning" danger :loading="linkStopping" @click="stopLinks">
            <template v-if="!linkStopping" #icon><StopOutlined /></template>
            {{ linkStopping ? '正在停止' : '停止' }}
          </a-button>
          <template v-else>
            <!--
              预约控件与「已预约」信息条互斥：信息条里已经有时间、数量和取消入口，
              再摆一个日期选择器只会让人搞不清改哪一边生效。
            -->
            <template v-if="!booked">
              <!-- 预约：选一个具体日期时刻，到点自动跑一次；预约只存内存，退出应用后失效 -->
              <a-date-picker
                v-model:value="scheduleAt"
                class="schedule-picker"
                show-time
                format="YYYY-MM-DD HH:mm"
                :disabled-date="disabledDate"
                placeholder="预约执行时间"
              />
              <a-button
                :disabled="!planType || !runnableIds.length"
                @click="submitSchedule"
              >
                <template #icon><ClockCircleOutlined /></template>
                预约执行（{{ runnableIds.length }}）
              </a-button>
            </template>
            <a-button
              type="primary"
              :disabled="!planType || !runnableIds.length"
              @click="startLinks"
            >
              <template #icon><CrownOutlined /></template>
              获取链接（{{ runnableIds.length }}）
            </a-button>
          </template>
        </div>
      </a-tab-pane>

      <!-- ============ 切换 Free ============ -->
      <a-tab-pane key="free" tab="切换 Free">
        <a-alert
          type="warning"
          show-icon
          class="page-alert"
          message="把勾选账号的订阅切换到 Kiro Free。按 Stripe 规则，当前周期仍按原计划计费，下个周期起生效；已经是 Free、已安排切换或已设置不续费的账号会自动跳过。"
        />

        <div class="list-head">
          <a-checkbox
            :checked="allFreeSelected"
            :indeterminate="freeSelected.size > 0 && !allFreeSelected"
            @change="selectAllFree(($event.target as HTMLInputElement).checked)"
          >
            全选
          </a-checkbox>
          <span class="count-text">
            共 {{ freeRows.length }} 个非 Free 账号
            <template v-if="freeSelected.size">· 已选 {{ freeSelected.size }}</template>
          </span>
          <span class="spacer" />
          <span v-if="freeRunning" class="count-text">
            正在处理 {{ freeStat.ok + freeStat.fail + 1 }}/{{ freeStat.total }}
          </span>
          <a-tag v-if="freeStat.ok" color="green" :bordered="false">
            成功 {{ freeStat.ok }}
          </a-tag>
          <a-tag v-if="freeStat.fail" color="red" :bordered="false">
            失败 {{ freeStat.fail }}
          </a-tag>
        </div>

        <div ref="freeListRef" class="row-list">
          <div
            v-for="(row, index) in freeRows"
            :key="row.account.id"
            :data-row-index="index"
            class="row clickable"
            :class="[row.state, { 'is-selected': freeSelected.has(row.account.id) }]"
            @click="toggleFree(row.account.id)"
          >
            <!-- 复选框自己会派发 change，再冒泡到整行就会连着切两次，这里拦下 -->
            <a-checkbox
              :checked="freeSelected.has(row.account.id)"
              :disabled="freeRunning"
              @click.stop
              @change="toggleFree(row.account.id)"
            />
            <div class="row-main">
              <div class="row-email">
                {{ email(row.account) }}
                <a-tag :bordered="false" class="tier-tag">
                  {{ subscriptionLabel(row.account.subscription) }}
                </a-tag>
              </div>
            </div>
            <div class="row-state">
              <template v-if="row.state === 'pending'">
                <span class="muted">等待切换</span>
              </template>
              <template v-else-if="row.state === 'running'">
                <a-spin size="small" />
                <span class="running-text">处理中</span>
              </template>
              <template v-else-if="row.state === 'ok'">
                <CheckCircleFilled class="ok-icon" />
                <span class="ok-text">{{ row.note || '已切换' }}</span>
              </template>
              <template v-else>
                <CloseCircleFilled class="fail-icon" />
                <span class="fail-text" :title="row.error">{{ row.error }}</span>
              </template>
            </div>
          </div>

          <div v-if="!freeRows.length" class="empty muted">
            没有非 Free 的账号
          </div>
        </div>

        <div class="footer">
          <span class="spacer" />
          <a-button v-if="freeRunning" danger :loading="freeAborted" @click="abortFreeBatch">
            <template v-if="!freeAborted" #icon><StopOutlined /></template>
            {{ freeAborted ? '正在中止' : '中止' }}
          </a-button>
          <a-button
            v-else
            danger
            :disabled="!selectedFreeRows.length"
            @click="startFreeSwitch"
          >
            <template #icon><ThunderboltOutlined /></template>
            切换 Free（{{ selectedFreeRows.length }}）
          </a-button>
        </div>
      </a-tab-pane>
    </a-tabs>
  </div>
</template>

<style scoped>
.subscription-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* Tab 内容区撑满，列表自己滚动 */
.page-tabs {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

.page-tabs :deep(.ant-tabs-content-holder) {
  display: flex;
  min-height: 0;
}

.page-tabs :deep(.ant-tabs-content) {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

.page-tabs :deep(.ant-tabs-tabpane) {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.toolbar-label {
  flex: 0 0 auto;
  font-size: 13px;
}

.plan-select {
  width: 300px;
  max-width: 100%;
}

.page-alert {
  margin-bottom: 12px;
}

.list-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.count-text {
  color: var(--kal-muted);
  font-size: 12px;
}

.spacer {
  flex: 1 1 auto;
}

/* 列表占满剩余高度，超出自己滚动 */
.row-list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow: auto;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: var(--kal-block-bg);
  transition: border-color 0.2s, background 0.2s;
}

/* 整行可点：只靠 16px 的复选框勾几十个太折磨，与账号页的交互保持一致 */
.row.clickable {
  cursor: pointer;
}

.row.clickable:hover {
  background: var(--kal-code-bg);
}

/* 选中态与账号卡片同色系，比 hover 更实一点 */
.row.is-selected {
  border-color: var(--kal-primary);
  background: rgba(124, 58, 237, 0.08);
}

.row.running {
  border-color: var(--kal-primary);
}

.row.ok {
  border-color: #52c41a33;
}

.row.fail {
  border-color: #ff4d4f33;
}

.row-main {
  flex: 1 1 auto;
  min-width: 0;
}

.row-email {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  font-size: 13px;
  white-space: nowrap;
}

.tier-tag {
  flex: 0 0 auto;
  margin: 0;
  font-size: 11px;
}

/* 链接可点：默认灰色，悬停变主题色 */
.row-url {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  color: var(--kal-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.row-url:hover {
  color: var(--kal-primary);
}

.row-icon {
  transition: color 0.15s, background 0.15s;
}

.row-icon:hover,
.row-icon:focus-visible {
  color: var(--kal-primary) !important;
  background: color-mix(in srgb, var(--kal-primary) 12%, transparent) !important;
}

.row-state {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  max-width: 46%;
  font-size: 12px;
}

.running-text {
  color: var(--kal-primary);
}

.ok-icon,
.ok-text {
  color: #52c41a;
}

.fail-icon {
  flex: 0 0 auto;
  color: #ff4d4f;
}

.fail-text {
  overflow: hidden;
  color: #ff4d4f;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  padding: 32px 0;
  text-align: center;
  font-size: 13px;
}

.footer {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
}

/* 预约时间选择器：和按钮同高，别在底部撑出第二行 */
.schedule-picker {
  width: 220px;
}

/* 预约信息条：文案与「取消预约」同一行，窄屏时取消按钮折到右边 */
.booked-bar :deep(.ant-alert-message) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.booked-text {
  flex: 1 1 auto;
  min-width: 0;
}

.booked-cancel {
  flex: 0 0 auto;
  padding: 0 4px;
  height: auto;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.muted {
  color: var(--kal-muted);
}
</style>
