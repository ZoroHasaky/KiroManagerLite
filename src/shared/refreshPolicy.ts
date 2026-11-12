// 用量 / 积分刷新的跳过策略：主进程与渲染进程共用的单一真源
//
// 手动全量刷新、自动定时刷新分散在四个调用点（主进程 keyService、
// 渲染层 KeysView / AccountsView / accounts store），如果各写一遍判定，
// 迟早会漂移成「手动跳过了、自动还在刷」这类不一致。这里统一收口。
//
// 判定原则：只跳过「重试也不会变好」的确定性失败，临时故障一律继续刷。
// 详见 isPermanentFailure 的说明。
import { isPermanentFailure } from './errors'
import type { Account, KeyEntry } from './types'

/** API Key 的异常原因：管理面同步错误与对话测活错误取并集 */
export function keyIssueOf(entry: Pick<KeyEntry, 'lastError' | 'lastChatError'>): string | undefined {
  return entry.lastError || entry.lastChatError
}

/**
 * 该 API Key 是否应跳过用量 / 积分刷新。
 *
 * 只跳确定性失败（凭证被拒、403、账号封禁），这些要换 Key 才能解决。
 * 从没查过的 Key 没有 issue，自然不会被跳过。
 */
export function shouldSkipKeyUsageRefresh(
  entry: Pick<KeyEntry, 'lastError' | 'lastChatError'>
): boolean {
  const issue = keyIssueOf(entry)
  return !!issue && isPermanentFailure(issue)
}

/**
 * 该账号是否应跳过用量 / 积分刷新。
 *
 * banned 是服务端明确的封禁，expired 表示 refreshToken 已被拒，
 * 两者都要重新登录才能恢复。status 为 error 时再看错误内容：
 * 网络、限流、5xx 这类临时故障必须继续刷，否则一次抖动就永久停刷。
 */
export function shouldSkipAccountUsageRefresh(
  account: Pick<Account, 'status' | 'lastError'>
): boolean {
  if (account.status === 'banned' || account.status === 'expired') return true
  return account.status === 'error' && isPermanentFailure(account.lastError || '')
}

/**
 * 该账号的用量是否已经达到「不再自动刷新」的阈值。
 *
 * 与 shouldSkipAccountUsageRefresh 的区别：那个跳的是「刷了也必然失败」的账号，
 * 这个是主动停掉「刷了也没意义」的账号——额度已经见底，刷新只会白耗请求。
 *
 * 阈值 <= 0 表示不限制。额度重置之前一律停刷，但过了 nextResetDate 必须放行，
 * 否则账号被停刷后就永远看不到「额度已重置」，会一直卡在跳过状态里。
 */
export function reachedUsageLimit(
  account: Pick<Account, 'usage'>,
  maxPercent: number,
  now = Date.now()
): boolean {
  if (!Number.isFinite(maxPercent) || maxPercent <= 0) return false

  const limit = account.usage?.limit ?? 0
  // 没有额度信息时不拦：limit 为 0 时百分比无从谈起，继续刷才能拿到真实额度
  if (limit <= 0) return false

  if ((account.usage.percentUsed || 0) * 100 < maxPercent) return false

  /*
   * 到阈值了，接下来要判断「是不是已经过了重置时间、该放行一次」。
   *
   * nextResetDate 是可选字段：早期数据或某些接口响应里没有它。这种情况下不能
   * 一律停刷——账号会永远卡在跳过状态，连额度重置了都不知道。退化成按最后
   * 更新时间算：超过 24 小时没刷过就放行一次，既能止住大部分无谓请求，
   * 又保证账号最多一天能自愈一次。
   */
  const resetAt = account.usage?.nextResetDate ? Date.parse(account.usage.nextResetDate) : NaN
  if (Number.isFinite(resetAt)) return now < resetAt

  const lastUpdated = account.usage?.lastUpdated ?? 0
  const STALE_MS = 24 * 60 * 60 * 1000
  if (!Number.isFinite(lastUpdated) || lastUpdated <= 0) return false
  return now - lastUpdated < STALE_MS
}
