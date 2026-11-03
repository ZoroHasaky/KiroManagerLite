import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { errorMessage } from '@shared/errors'
import { toPlain } from '@/utils/ipc'
import { freshAccount } from '@/utils/freshAccount'
import { useAccountsStore } from './accounts'

/**
 * 「获取链接」的批量执行与预约调度。
 *
 * 为什么放在 store 而不是页面里：订阅页没有 KeepAlive，切路由就卸载。
 * 循环留在组件里的话，卸载后任务还在跑，但结果与进度随组件一起消失，
 * 用户切回来只能看到一张空列表。放进 store 后执行与结果都跟页面生命周期无关，
 * 预约到点即使人不在订阅页也能照常生成。
 *
 * 串行执行：与 utils/batchRun 同样的理由——批量并发请求上游容易被判为异常活动。
 */

export type LinkRowState = 'pending' | 'running' | 'ok' | 'fail'

export interface LinkResult {
  state: LinkRowState
  url?: string
  /** 失败原因，展示在行内 */
  error?: string
}

/** 一次预约：到点用这些账号跑这个套餐，跑完即结束 */
export interface LinkSchedule {
  at: number
  ids: string[]
  planType: string
}

/** 停止提示的 message key，避免与别的批量任务的提示互相覆盖 */
const STOP_MESSAGE_KEY = 'subscription-links-stop'

/**
 * 调度用秒级 tick 比对绝对时间戳，不给预约开一个长 setTimeout。
 * 窗口最小化到托盘后页面转入后台，Chromium 会节流长定时器；
 * 系统睡眠期间错过的时刻长定时器也不会补跑。到期时间 + 秒级 tick
 * 无论被延迟多久，恢复后的第一个 tick 就能补上（同 accounts 的自动刷新调度）。
 */
const SCHEDULE_TICK_MS = 1_000

export const useSubscriptionLinksStore = defineStore('subscriptionLinks', () => {
  const accountsStore = useAccountsStore()

  /** 账号 id -> 结果。页面卸载重进后仍能展示上次生成的结果 */
  const results = reactive(new Map<string, LinkResult>())

  const running = ref(false)
  /** 用户已点停止：当前请求返回后不再取下一个账号 */
  const stopRequested = ref(false)
  /** 本轮队列快照；统计与进度都基于它，不受执行中改勾选影响 */
  const runIds = ref<string[]>([])
  /** 当前正在处理的账号，供页面把该行滚进视野 */
  const activeId = ref<string | null>(null)

  const schedule = ref<LinkSchedule | null>(null)

  /**
   * 当前选中的档位（subscriptionType）。
   *
   * 放在 store 而不是页面里：订阅页没有 KeepAlive，切走再回来组件会重建，
   * 页面级 ref 随之清零、loadPlans 回落到列表第一项。而预约记的是预约当时的档位，
   * 两边不一致时用户照着下拉点「获取链接」就会按错的档位生成一批链接。
   */
  const planType = ref('')

  let tickTimer: ReturnType<typeof setInterval> | null = null

  function stats() {
    let ok = 0
    let fail = 0
    let pending = 0
    for (const id of runIds.value) {
      // 走 stateOf 而不是直接读 results：作废的 ok 结果不该计入成功
      const state = stateOf(id)
      if (state === 'ok') ok++
      else if (state === 'fail') fail++
      else if (state === 'pending') pending++
    }
    return { total: runIds.value.length, ok, fail, pending }
  }

  /** 本轮统计；不随勾选变化，运行中数字不会乱跳 */
  const stat = computed(stats)

  /**
   * 一条账号的结果。
   *
   * ok 但账号身上已经没有 paymentLink 时按「没有结果」处理：链接被清掉了
   * （标记出售、重置阶段等），账号会退回「未使用」重新出现在待生成列表里。
   * 这时还认那条旧结果，界面会显示成「已生成」，执行时也会被当成成功跳过。
   */
  function resultOf(id: string): LinkResult | undefined {
    const result = results.get(id)
    if (result?.state !== 'ok') return result
    return accountsStore.get(id)?.paymentLink ? result : undefined
  }

  /** 一条账号的结果状态；没有记录（或记录已作废）就是还没生成过 */
  function stateOf(id: string): LinkRowState {
    return resultOf(id)?.state ?? 'pending'
  }

  function reportOutcome(scheduled: boolean): void {
    const { ok, fail } = stats()
    if (stopRequested.value) {
      message.warning({
        content: `已停止：成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ''}`,
        key: STOP_MESSAGE_KEY,
        duration: 3
      })
      return
    }
    // 手动任务正常跑完时行内已经有成功/失败统计，不再多弹一条；预约任务人可能不在本页，必须提示
    if (!scheduled || (!ok && !fail)) return
    const text = `预约任务完成：成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ''}`
    if (fail) message.warning(text)
    else message.success(text)
  }

  /**
   * 按顺序为这些账号生成结算链接。
   *
   * 已生成成功的行跳过：重跑只补失败和没跑到的，不会把已有链接重新生成一遍。
   *
   * @param ids 目标账号；内部去重
   * @param planType 档位的 subscriptionType
   * @param options.scheduled 由预约触发：结束时额外弹一次结果，因为用户多半不在本页
   */
  async function start(
    ids: string[],
    planType: string,
    options: { scheduled?: boolean } = {}
  ): Promise<void> {
    if (running.value) return
    const queue = [...new Set(ids.filter(Boolean))]
    if (!queue.length || !planType) return

    running.value = true
    stopRequested.value = false
    runIds.value = queue
    /*
     * 一次只留一个待执行任务：预约触发的那一路在 onTick 里已经先清空，
     * 手动开跑则把还没到点的预约顶掉——同一批账号刚被处理过，
     * 到点再跑一遍只会重复一次「全部跳过」，不如直接告诉用户。
     */
    if (schedule.value) {
      cancelSchedule()
      if (!options.scheduled) message.info('已手动开始生成，原预约已取消')
    }

    try {
      for (const id of queue) {
        // 停止点：手上这个请求已经返回，不再取下一个
        if (stopRequested.value) break
        if (stateOf(id) === 'ok') continue

        const account = accountsStore.get(id)
        if (!account) {
          results.set(id, { state: 'fail', error: '账号已被删除' })
          continue
        }

        activeId.value = id
        results.set(id, { state: 'running' })
        try {
          // 门户接口靠 cookie 里的 AccessToken 认身份，过期就会 401，先按需续期
          const fresh = await freshAccount(account)
          const res = await window.api.createSubscriptionCheckout(
            toPlain(fresh),
            planType,
            true
          )
          if (res.success && res.data?.url) {
            results.set(id, { state: 'ok', url: res.data.url })
            // 回写支付链接：账号页的「待支付」阶段据此判定
            accountsStore.setPaymentLink(id, res.data.url)
          } else {
            results.set(id, { state: 'fail', error: res.error || '生成订阅链接失败' })
          }
        } catch (cause) {
          results.set(id, { state: 'fail', error: errorMessage(cause) })
        }
      }
    } finally {
      running.value = false
      activeId.value = null
      message.destroy(STOP_MESSAGE_KEY)
    }

    // 预约任务触发时用户多半已经切到别的页面，结束后必须有提示；
    // 手动任务在停止后也要说清楚停在哪一步
    reportOutcome(!!options.scheduled)
  }

  /** 手动停止：不打断在途请求，等它返回后跳出循环 */
  function stop(): void {
    if (!running.value || stopRequested.value) return
    stopRequested.value = true
    message.loading({
      content: '正在停止，等待当前账号的请求返回…',
      key: STOP_MESSAGE_KEY,
      duration: 0
    })
  }

  // ============ 预约调度 ============

  function ensureTick(): void {
    if (tickTimer) return
    tickTimer = setInterval(() => onTick(), SCHEDULE_TICK_MS)
  }

  function stopTick(): void {
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
  }

  function onTick(): void {
    const job = schedule.value
    if (!job) {
      stopTick()
      return
    }
    if (Date.now() < job.at) return
    // 到点时手上还有任务：本轮不丢，等它结束，下个 tick 再跑
    if (running.value) return

    schedule.value = null
    stopTick()
    void start(job.ids, job.planType, { scheduled: true })
  }

  /**
   * 预约一个时间点执行一次。返回错误文案，成功返回 null。
   *
   * 只存在内存：应用退出后预约消失，需要重新约。最小化到托盘不受影响。
   */
  function scheduleAt(at: number, ids: string[], planType: string): string | null {
    if (running.value) return '正在生成链接，请先停止或等待完成'
    if (!planType) return '请先选择订阅套餐'
    const targets = [...new Set(ids.filter(Boolean))]
    if (!targets.length) return '请先勾选要生成链接的账号'
    if (!Number.isFinite(at)) return '请选择预约时间'
    if (at <= Date.now()) return '预约时间必须晚于当前时间'

    schedule.value = { at, ids: targets, planType }
    ensureTick()
    return null
  }

  function cancelSchedule(): void {
    schedule.value = null
    stopTick()
  }

  /**
   * 换套餐等场景：已生成的结果作废，回到待生成；预约一并取消。
   *
   * 这里直接清空结果：列表只展示还没拿到链接的账号，已经生成的行早已不在列表里，
   * 留着旧档位的结果会让「下载」导出上一档的链接。正在跑时不动，避免写一半被清掉。
   */
  function reset(): void {
    if (running.value) return
    results.clear()
    runIds.value = []
    cancelSchedule()
  }

  return {
    results,
    running,
    stopRequested,
    runIds,
    activeId,
    schedule,
    planType,
    stat,
    resultOf,
    stateOf,
    start,
    stop,
    scheduleAt,
    cancelSchedule,
    reset
  }
})

// setup 风格的 store 默认不参与 HMR，改完 store 后运行中的实例会缺少新增方法
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSubscriptionLinksStore, import.meta.hot))
}
