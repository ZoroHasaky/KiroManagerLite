/** 错误信息归一：Error 取 message，其余转字符串，空值用兜底文案 */
export function errorMessage(error: unknown, fallback = ''): string {
  if (error instanceof Error) return error.message || fallback
  if (error === undefined || error === null) return fallback
  return String(error) || fallback
}

/**
 * 判断错误是否为「刷新凭证被服务端拒绝」。
 *
 * refreshToken 是轮换式的，任何一次刷新都会让旧值立即作废。拿作废的值再刷，
 * AWS OIDC 回 `invalid_grant`，Kiro auth service 回 401 `Bad credentials`。
 * 这类错误重试没有意义，只能换用最新凭证或重新登录。
 */
export function isCredentialRejected(message: string): boolean {
  const m = String(message || '').toLowerCase()
  if (m.includes('invalid_grant') || m.includes('bad credentials')) return true
  // 其余 4xx 需要同时带上凭证语义，避免把用量接口的普通 400 也算进来
  if (!m.includes('401') && !m.includes('400')) return false
  return m.includes('credential') || m.includes('unauthorized') || m.includes('token')
}

/**
 * 判断错误是否为「被上游限流」。
 *
 * 429 与 Too many requests 是最明确的信号；Kiro 的极端限流还会直接回 403，
 * 只能从响应体里的措辞认出来。这些文案取自 AWS 的 ThrottlingException 与
 * kiro-agent 转发出来的原文，判定时统一小写。
 */
export function isRateLimited(message: string): boolean {
  const m = String(message || '').toLowerCase()
  if (!m) return false
  if (m.includes('429') || m.includes('too many requests')) return true
  if (m.includes('throttl')) return true
  if (m.includes('rate limit') || m.includes('ratelimit')) return true
  if (m.includes('slow down') || m.includes('slowdown')) return true
  /*
   * 不含 "limit exceeded" / "quota exceeded"：那是额度耗尽（OVERAGE_REQUEST_LIMIT_EXCEEDED
   * 之类），等一会儿不会好，混进限流会让这些号在待刷新池里永远空转。
   */
  return false
}

/**
 * 判断错误是否为「重试也不会变好」的确定性失败，用于批量刷新时跳过。
 *
 * 只认凭证被拒、权限被拒和账号被封这三类：它们要靠重新登录或换账号才能解决，
 * 反复请求纯属浪费额度和时间。
 *
 * 反过来，429（限流）、5xx、超时、fetch failed 这些一律不算：
 * 它们是临时故障，跳过会让账号或 Key 因为一次网络抖动就再也不被刷新，
 * 永远停在异常状态出不来。
 */
export function isPermanentFailure(message: string): boolean {
  const m = String(message || '').toLowerCase()
  if (!m) return false
  /*
   * 限流优先判定为临时，且必须排在 isCredentialRejected 之前。
   * 同一出口 IP 短时间集中刷新大量账号时，Kiro 会回 403 并带上限流语义
   * （ThrottlingException / rate limit / slow down 等）；这类文案里往往也含
   * "token"，先跑 isCredentialRejected 会把它们判成凭证失效，账号于是被永久跳过
   * 自动刷新——恰恰是限流最严重的时候，整批一起停刷，再也看不到额度恢复。
   */
  if (isRateLimited(m)) return false
  // 服务端故障同样是临时的
  if (/\b5\d\d\b/.test(m) || m.includes('timeout') || m.includes('fetch failed')) return false
  if (isCredentialRejected(m)) return true
  if (m.includes('accountsuspended') || m.includes('suspended') || m.includes('banned')) return true
  // 到这里 403 只剩真正的权限问题（bearer token invalid / forbidden），重试无意义
  return m.includes('403') || m.includes('forbidden')
}
