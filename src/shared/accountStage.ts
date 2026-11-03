/**
 * 账号的阶段（原「分组」）。
 *
 * 阶段不落盘，完全由账号当前的数据推导出来 —— 订阅档位、积分用量、支付链接、已出售标记
 * 任何一项变化，阶段都会自动跟着变，不需要用户手动维护。
 *
 * 判定顺序（先命中先返回，顺序即优先级）：
 *   1. 已闲置：非 Free 且已用积分超过 100，或 Free 且已用积分大于 0。
 *      排在「已出售」之前：卖掉之后被买家跑起量来的号，说明它已经不在待售状态，
 *      继续留在「已出售」会掩盖真实的销售进度。「已出售」只统计卖掉但还没被用起来的号。
 *      也必须排在「待支付」之前：Free 账号生成过支付链接但已经用掉额度，说明这号已经在用了，
 *      不能继续挂在待支付里。
 *   2. 已出售：有 soldAt 标记且尚未产生用量。
 *   3. 待支付：Free 且生成过支付链接（此时已用积分必为 0）。
 *   4. 已订阅：非 Free 且已用积分不超过 100。
 *   5. 未使用：Free、没有支付链接、且一点积分都没用过。
 *
 * 「积分用量」指 usage.current —— 已用积分的**实际数值**，不是占比。
 * 100 是积分阈值（非 Free 账号超过 100 积分即闲置），不是 100%。
 * Free 账号只要用过积分就算闲置，所以「未使用」是真正没动过的那批。
 */
import type { Account } from './types'

export type AccountStage = 'unused' | 'pendingPayment' | 'subscribed' | 'sold' | 'idle'

/** 非 Free 账号已用积分超过这个数值即算闲置（单位是积分，不是百分比） */
export const IDLE_CREDITS_THRESHOLD = 100

/** 界面 tab 的顺序 */
export const ACCOUNT_STAGES: AccountStage[] = ['unused', 'pendingPayment', 'subscribed', 'sold', 'idle']
export interface AccountStageMeta {
  text: string
  /** 与 antd 的 tag 颜色对齐，卡片标签与 tab 徽标共用 */
  color: string
  /** tab 上的简短说明 */
  hint: string
}

export const ACCOUNT_STAGE_META: Record<AccountStage, AccountStageMeta> = {
  unused: { text: '未使用', color: 'default', hint: 'Free、未生成支付链接且未产生用量' },
  pendingPayment: { text: '待支付', color: 'orange', hint: 'Free 且已生成支付链接，尚未产生用量' },
  subscribed: { text: '已订阅', color: 'green', hint: '非 Free 且已用积分未超 100' },
  sold: { text: '已出售', color: 'purple', hint: '已标记为出售，尚未产生用量' },
  idle: { text: '已闲置', color: 'red', hint: '已用积分超过 100，或 Free 账号已产生用量' }
}

/** 已用积分的实际数值（非百分比）；数据缺失按 0 处理 */
export function usedCreditsOf(account: Account): number {
  const used = account.usage.current
  return typeof used === 'number' && Number.isFinite(used) ? used : 0
}

/** 账号当前所处阶段 */
export function accountStageOf(account: Account): AccountStage {
  const isFree = account.subscription.type === 'Free'
  const used = usedCreditsOf(account)

  /*
   * 闲置排在已出售之前：卖掉之后又被用起来的号，阶段应该跟着用量走，
   * 而不是一直钉在「已出售」里。已出售只剩「卖了但还没产生用量」的号。
   */
  if (isFree) {
    // 用过分就算闲置，哪怕生成过支付链接
    if (used > 0) return 'idle'
    if (account.soldAt) return 'sold'
    return account.paymentLink ? 'pendingPayment' : 'unused'
  }

  if (used > IDLE_CREDITS_THRESHOLD) return 'idle'
  return account.soldAt ? 'sold' : 'subscribed'
}
