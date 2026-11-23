// Kiro 凭证的 ARN 规则与「读取本地登录」支持
//
// 本文件不再向 Kiro IDE 的凭证目录（~/.aws/sso/cache）写任何东西：
// 账号的刷新只更新本应用自己的数据，IDE 那边由使用者自行管理。
//
// 保留的读取入口只服务一个场景：添加账号时把本机 IDE 已登录的凭证读出来做初始化，
// 属于「少手填几个字段」的便利，不改变 IDE 的状态。
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { KIRO_START_URL, serviceRegion } from './kiroEndpoints'
import { pushUnique } from './utils'
import { DEFAULT_REGION } from '../shared/regions'
import type { AuthMethod, IdpType, LocalKiroCredentials } from '../shared/types'

const KIRO_SSO_CACHE_DIR = path.join(os.homedir(), '.aws', 'sso', 'cache')
const KIRO_AUTH_TOKEN_FILE = 'kiro-auth-token.json'
const KIRO_AUTH_TOKEN_PATH = path.join(KIRO_SSO_CACHE_DIR, KIRO_AUTH_TOKEN_FILE)

/**
 * Kiro 源码里给 BuilderId 硬编码的占位符 ARN。
 *
 * 两个用途，别混：IDE 内部逻辑依赖 token 文件里存在该字段；
 * 而 runtime 接口（getUsageLimits / ListAvailableModels）也把 profileArn 当必填，
 * BuilderId 账号必须原样带上它才回 200，不带就是
 * 403 "User is not authorized to make this call."。
 */
export const KIRO_BUILDER_ID_PLACEHOLDER_ARN =
  'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
// Github / Google 社交登录共用的固定 profileArn
export const KIRO_SOCIAL_PROFILE_ARN =
  'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'

const ENTERPRISE_FALLBACK = { accountId: '610548660232', profileId: 'VNECVYCYYAWN' }

function enterpriseFallbackArn(region?: string): string {
  const { accountId, profileId } = ENTERPRISE_FALLBACK
  return `arn:aws:codewhisperer:${serviceRegion(region)}:${accountId}:profile/${profileId}`
}

/** 社交登录（Github / Google）没有 profile 概念，后端认一个固定 ARN */
export function isSocialLogin(input: { authMethod?: string; provider?: string }): boolean {
  return (
    input.authMethod === 'social' || input.provider === 'Github' || input.provider === 'Google'
  )
}

function isPlaceholderArn(arn?: string | null): boolean {
  return arn === KIRO_BUILDER_ID_PLACEHOLDER_ARN
}

/** 调接口时该用哪个 profileArn：取候选里第一个有值的项 */
export function resolveProfileArn(input: {
  profileArn?: string
  authMethod?: string
  provider?: string
  region?: string
}): string {
  return (
    profileArnCandidates(input).find((arn): arn is string => !!arn) ??
    KIRO_BUILDER_ID_PLACEHOLDER_ARN
  )
}

/**
 * 按优先级给出「调接口时可以依次尝试」的 profileArn 候选。
 *
 * profileArn 给错是 403 "User is not authorized" 的常见原因：
 * Enterprise 账号必须用它自己 profile 的 ARN，而 BuilderId 没有 profile 概念，
 * 带上任何真实 ARN 都可能被拒，只能带占位符。所以这里给出多个候选，
 * 由调用方逐个实测。
 */
export function profileArnCandidates(input: {
  profileArn?: string
  authMethod?: string
  provider?: string
  region?: string
}): (string | undefined)[] {
  const out: (string | undefined)[] = []
  if (input.profileArn && !isPlaceholderArn(input.profileArn)) pushUnique(out, input.profileArn)

  // 社交账号后端固定一个 profile，且该字段必填，没有「不带」这个选项
  if (isSocialLogin(input)) {
    pushUnique(out, KIRO_SOCIAL_PROFILE_ARN)
    return out
  }

  // Enterprise 用兜底 ARN，BuilderId / 其它 IdC 按 IDE 原生行为写占位符；都不行就干脆不带
  pushUnique(
    out,
    input.provider === 'Enterprise'
      ? enterpriseFallbackArn(input.region)
      : KIRO_BUILDER_ID_PLACEHOLDER_ARN
  )
  pushUnique(out, undefined)
  return out
}

/**
 * 剥掉 BuilderId 占位符 ARN，只保留真实可用的 ARN。
 *
 * 仅供控制面（CreateApiKey / ListApiKeys）挑候选使用。
 *
 * 切勿用在用量接口上：getUsageLimits 把 profileArn 当必填，
 * BuilderId 恰恰要带这个占位符才回 200，剥掉就是
 * 403 "User is not authorized to make this call."。
 */
export function arnForApiCall(arn?: string): string | undefined {
  return arn && !isPlaceholderArn(arn) ? arn : undefined
}

interface KiroAuthTokenFile {
  accessToken: string
  refreshToken: string
  expiresAt: string
  authMethod?: string
  provider?: string
  region?: string
  clientIdHash?: string
  profileArn?: string
}

function computeClientIdHash(startUrl?: string): string {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify({ startUrl: startUrl || KIRO_START_URL }))
    .digest('hex')
}

/** 列出 sso cache 目录下的文件，目录不存在时给空列表 */
function listCacheFiles(): Promise<string[]> {
  return fs.readdir(KIRO_SSO_CACHE_DIR).catch(() => [] as string[])
}

async function readKiroAuthToken(): Promise<KiroAuthTokenFile | null> {
  try {
    const raw = await fs.readFile(KIRO_AUTH_TOKEN_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as KiroAuthTokenFile
    if (!parsed.accessToken || !parsed.refreshToken) return null
    return parsed
  } catch {
    return null
  }
}

interface ClientRegistration {
  clientId?: string
  clientSecret?: string
}

async function readCacheJson(fileName: string): Promise<ClientRegistration | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(KIRO_SSO_CACHE_DIR, fileName), 'utf-8'))
  } catch {
    return null
  }
}

/** 找出 IdC 的客户端注册（clientId / clientSecret）：先按 hash 命中，再扫描兜底 */
async function findClientRegistration(clientIdHash?: string): Promise<ClientRegistration | null> {
  const primary = await readCacheJson(`${clientIdHash || computeClientIdHash()}.json`)
  if (primary?.clientId && primary.clientSecret) return primary

  for (const file of await listCacheFiles()) {
    if (!file.endsWith('.json') || file === KIRO_AUTH_TOKEN_FILE) continue
    const data = await readCacheJson(file)
    if (data?.clientId && data.clientSecret) return data
  }
  return null
}

/**
 * 读取本地 Kiro 已登录的完整凭证（含 IdC 客户端注册），供「添加账号」时预填表单。
 * 只读，不修改任何文件。
 */
export async function readLocalKiroCredentials(): Promise<
  LocalKiroCredentials | { error: string }
> {
  const token = await readKiroAuthToken()
  if (!token) {
    return { error: '找不到 kiro-auth-token.json 或缺少 refreshToken，请先在 Kiro 中登录' }
  }

  const isSocial = token.authMethod === 'social'
  let clientId = ''
  let clientSecret = ''

  if (!isSocial) {
    const reg = await findClientRegistration(token.clientIdHash)
    if (!reg?.clientId || !reg.clientSecret) {
      return { error: '找不到客户端注册文件，请确认已在 Kiro 中完成登录' }
    }
    clientId = reg.clientId
    clientSecret = reg.clientSecret
  }

  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    clientId,
    clientSecret,
    region: token.region || DEFAULT_REGION,
    authMethod: isSocial ? 'social' : 'IdC',
    provider: (token.provider as IdpType) || 'BuilderId'
  }
}
