// 托盘桥接：把账号汇总同步给主进程菜单，并响应菜单里的动作
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useAccountsStore } from '@/stores/accounts'
import type { TrayAction, TraySnapshot } from '@shared/types'

/** 与本应用一致的到期提醒阈值 */
const EXPIRE_WARN_DAYS = 7

export function useTrayBridge(): void {
  const accountsStore = useAccountsStore()

  const snapshot = computed<TraySnapshot>(() => {
    let active = 0
    let error = 0
    let banned = 0
    let expiring = 0
    for (const account of accountsStore.liveAccounts) {
      if (account.status === 'banned') banned++
      else if (account.status === 'error') error++
      else if (account.status === 'active') active++
      if ((account.subscription.daysRemaining ?? Number.POSITIVE_INFINITY) <= EXPIRE_WARN_DAYS) {
        expiring++
      }
    }
    return { total: accountsStore.liveAccounts.length, active, error, banned, expiring }
  })

  /*
   * 账号列表任何一处变化（批量刷新时每个号一次）都会让 snapshot 重算出一个新对象，
   * 但托盘菜单只关心这几项汇总。内容没变就不发 IPC，免得主进程反复重建菜单。
   * snapshot 每次都是新的扁平对象，不需要 deep。
   */
  let lastSent = ''
  watch(
    snapshot,
    (value) => {
      const text = JSON.stringify(value)
      if (text === lastSent) return
      lastSent = text
      void window.api.syncTray(value)
    },
    { immediate: true }
  )

  /** 托盘里的「刷新全部用量」：与界面上的批量刷新走同一条路径，只是目标取全部可用账号 */
  async function refreshAllUsage(): Promise<void> {
    const ids = accountsStore.liveAccounts
      .filter((account) => account.status !== 'banned')
      .map((account) => account.id)
    if (!ids.length) return void message.info('没有可刷新的账号')
    const res = await accountsStore.runBatch(ids, 'check')
    if (res.failed) {
      message.warning(`用量刷新完成：成功 ${res.success}，失败 ${res.failed}`)
    } else {
      message.success(`已刷新 ${res.success} 个账号的用量`)
    }
  }

  let unsubscribe: (() => void) | null = null

  onMounted(() => {
    unsubscribe = window.api.onTrayAction((action: TrayAction) => {
      if (action === 'refresh-usage') void refreshAllUsage()
    })
  })

  onUnmounted(() => {
    unsubscribe?.()
    unsubscribe = null
  })
}
