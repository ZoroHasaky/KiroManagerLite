/**
 * 取一份 token 还没过期的账号副本。
 *
 * 门户接口（订阅等）靠 cookie 里的 AccessToken 认身份，过期就是
 * 401 UnauthorizedException: Authentication required or access denied。
 * 账号缓存里那份 accessToken 常常已经过期，所以按需续一次；
 * 留 1 分钟余量，避免请求发出途中过期。onRefreshing 在真正续期的前后各调一次，用于切换加载文案。
 */
import { useAccountsStore } from '@/stores/accounts'
import type { Account } from '@shared/types'

export async function freshAccount(
  account: Account,
  onRefreshing?: (refreshing: boolean) => void
): Promise<Account> {
  const store = useAccountsStore()
  const current = store.get(account.id) ?? account
  if (current.credentials.accessToken && (current.credentials.expiresAt ?? 0) - Date.now() > 60_000) {
    return current
  }
  onRefreshing?.(true)
  try {
    const res = await store.refreshToken(account.id)
    if (!res.ok) throw new Error(`刷新密钥失败：${res.error}`)
    return store.get(account.id) ?? current
  } finally {
    onRefreshing?.(false)
  }
}
