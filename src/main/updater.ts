// 检查更新：读 GitHub Releases 的最新版本号做对比，并找出对应的热更资源包
//
// 资源包与安装包是同一份 Release 的两个资产：前者供已装引导层的新版本热更，
// 后者供老用户/首次安装。这里只负责「查」，下载与安装见 packManager。
import { app } from 'electron'
import { httpRequest } from './net'
import { sleep } from './utils'
import { currentVersion } from './packManager'
import type { PackAssetInfo, UpdateCheckResult } from '../shared/types'

const REPO = 'ZoroHasaky/KiroManagerLite'
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const LATEST_PAGE = `https://github.com/${REPO}/releases/latest`
/** 「前往更新」统一落到 Releases 列表页，方便用户自己挑平台安装包与历史版本 */
const RELEASES_PAGE = `https://github.com/${REPO}/releases`

interface GithubAsset {
  name?: string
  browser_download_url?: string
  size?: number
  digest?: string | null
}

interface GithubRelease {
  tag_name?: string
  name?: string
  body?: string
  published_at?: string
  assets?: GithubAsset[]
}

/**
 * 资源包的资产命名规则，必须与 scripts/make-pack.mjs 保持一致：
 *   kiro-pack-<platform>-<arch>-<version>.tar.gz
 *   kiro-pack-<platform>-<arch>-<version>.tar.gz.sha256
 * 用文件名里的平台架构筛选，而不是靠 Release 里的顺序。
 */
const PACK_ASSET_RE = /^kiro-pack-(.+?)-(.+?)-(.+?)\.tar\.gz$/

/** 去掉 tag 常见前缀，`v1.0.3` / `V1.0.3` / `release-1.0.3` 都归一成 `1.0.3` */
function normalizeVersion(raw: string): string {
  return (raw || '').trim().replace(/^(v|version|release)[-_\s]*/i, '')
}

/**
 * 语义化版本比较，返回 a-b 的符号。
 * 数字段逐位比较；带 -beta 之类预发布标记的一方在数字段相同时视为更旧。
 */
function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string } => {
    const [core, ...rest] = normalizeVersion(v).split('-')
    return {
      nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
      pre: rest.join('-')
    }
  }
  const left = split(a)
  const right = split(b)
  const len = Math.max(left.nums.length, right.nums.length)
  for (let i = 0; i < len; i++) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

class UpdateSourceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** false 表示结果是确定性的，不应再尝试页面兜底。 */
    readonly allowFallback = true
  ) {
    super(message)
    this.name = 'UpdateSourceError'
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
const API_ATTEMPTS = 2
let inFlight: Promise<UpdateCheckResult> | null = null

function resultOf(
  current: string,
  latest: string,
  release?: GithubRelease
): UpdateCheckResult {
  return {
    current,
    latest,
    hasUpdate: compareVersions(latest, current) > 0,
    releaseUrl: RELEASES_PAGE,
    name: release?.name || release?.tag_name || latest,
    notes: (release?.body || '').trim(),
    publishedAt: release?.published_at || ''
  }
}

/**
 * 在 Release 资产里找当前平台架构的资源包。
 *
 * 找不到是常态而不是错误：CI 可能只产出了安装包，或者这次发布没带热更包。
 * 这种情况返回 url 为 null，界面据此禁用「下载更新」并保留跳转 Releases。
 */
function packAssetOf(release: GithubRelease, version: string): PackAssetInfo {
  const target = `${process.platform}-${process.arch}`
  const assets = Array.isArray(release.assets) ? release.assets : []

  const match = assets.find((asset) => {
    const name = asset.name || ''
    const parsed = PACK_ASSET_RE.exec(name)
    if (!parsed) return false
    // 平台与架构必须完全一致：资源包里带原生模块，装错架构会在启动时崩
    return `${parsed[1]}-${parsed[2]}` === target && parsed[3] === version
  })

  if (!match?.browser_download_url) {
    return { version, url: null, sha256: null, size: null, target }
  }

  /*
   * 校验值有两种来源：GitHub 自 2025 起给资产提供 digest（sha256:...），
   * 以及我们额外上传的 .sha256 文本资产（兼容 digest 不可用的情况）。
   * 这里只取 digest——.sha256 文件需要额外一次请求，放在下载流程里按需读取。
   */
  const digest = typeof match.digest === 'string' ? match.digest : ''
  const sha256 = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : null
  const checksumAsset = assets.find((a) => a.name === `${match.name}.sha256`)

  return {
    version,
    url: match.browser_download_url,
    // digest 缺失时退回读 .sha256 附件的能力，由调用方决定要不要拉
    sha256: sha256 ?? (checksumAsset ? '' : null),
    size: typeof match.size === 'number' ? match.size : null,
    target
  }
}

function nestedErrorCode(error: unknown): string {
  let current = error
  const visited = new Set<unknown>()
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current)
    const item = current as { code?: unknown; cause?: unknown }
    if (typeof item.code === 'string' && item.code) return item.code
    current = item.cause
  }
  return ''
}

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRetryableTransport(error: unknown): boolean {
  const text = `${rawErrorMessage(error)} ${nestedErrorCode(error)}`
  return /fetch failed|abort|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|TLS|UND_ERR/i.test(text)
}

function friendlyNetworkError(error: unknown): Error {
  const code = nestedErrorCode(error)
  const raw = rawErrorMessage(error)
  if (/abort|timeout|timed out|UND_ERR_CONNECT_TIMEOUT/i.test(`${raw} ${code}`)) {
    return new Error('连接 GitHub 超时，请检查网络或代理设置后重试')
  }
  if (isRetryableTransport(error)) {
    return new Error(`无法连接 GitHub，请检查网络或代理设置${code ? `（${code}）` : ''}`)
  }
  return new Error(raw || '检查更新失败，请稍后重试')
}

async function checkViaApi(current: string): Promise<UpdateCheckResult> {
  const res = await httpRequest(LATEST_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub API 拒绝没有 UA 的请求
      'User-Agent': `kiro-manager-lite/${current}`
    },
    timeoutMs: 10_000
  })

  if (!res.ok) {
    if (res.status === 404) {
      throw new UpdateSourceError('仓库还没有发布任何版本', false, false)
    }
    if (res.status === 403) {
      throw new UpdateSourceError('GitHub 接口访问频率受限', false)
    }
    throw new UpdateSourceError(
      `GitHub 接口返回 ${res.status}`,
      RETRYABLE_STATUS.has(res.status)
    )
  }

  const release = await res.json<GithubRelease>()
  const latest = normalizeVersion(release.tag_name || '')
  if (!latest) throw new UpdateSourceError('未能解析 GitHub API 返回的版本号', false)
  const result = resultOf(current, latest, release)
  return { ...result, pack: packAssetOf(release, latest) }
}

/**
 * API 不可用时访问 Releases 的 /latest 跳转地址。
 * GitHub 会把它重定向到 /releases/tag/vX.Y.Z，从最终 URL 即可得到版本号，
 * 不需要脆弱地解析整页 HTML，也不消耗 GitHub API 额度。
 */
async function checkViaReleasePage(current: string): Promise<UpdateCheckResult> {
  const res = await httpRequest(LATEST_PAGE, {
    headers: {
      Accept: 'text/html',
      'User-Agent': `kiro-manager-lite/${current}`
    },
    timeoutMs: 12_000
  })
  if (!res.ok) {
    if (res.status === 404) throw new Error('仓库还没有发布任何版本')
    throw new Error(`GitHub Releases 页面返回 ${res.status}`)
  }

  let tag = ''
  try {
    const match = new URL(res.url).pathname.match(/\/releases\/tag\/([^/]+)/)
    tag = match ? decodeURIComponent(match[1]) : ''
  } catch {
    // URL 异常统一落到下面的可读错误。
  }
  const latest = normalizeVersion(tag)
  if (!latest) throw new Error('未能从 GitHub Releases 页面识别最新版本')
  return resultOf(current, latest, { tag_name: tag })
}

async function runCheck(): Promise<UpdateCheckResult> {
  // 用当前实际运行的版本比较：热更之后 app.getVersion() 仍是安装包版本，
  // 拿它比较会永远认为「有新版本」，从而反复提示已装过的包
  const current = currentVersion()
  let apiError: unknown

  for (let attempt = 1; attempt <= API_ATTEMPTS; attempt++) {
    try {
      return await checkViaApi(current)
    } catch (error) {
      apiError = error
      if (error instanceof UpdateSourceError && !error.allowFallback) throw error
      const retryable = error instanceof UpdateSourceError
        ? error.retryable
        : isRetryableTransport(error)
      console.warn(
        `[Updater] GitHub API 第 ${attempt}/${API_ATTEMPTS} 次失败：` +
          `${rawErrorMessage(error)}${nestedErrorCode(error) ? ` (${nestedErrorCode(error)})` : ''}`
      )
      if (!retryable || attempt === API_ATTEMPTS) break
      await sleep(600)
    }
  }

  try {
    console.warn('[Updater] 切换到 GitHub Releases 页面兜底检查')
    return await checkViaReleasePage(current)
  } catch (fallbackError) {
    console.warn(
      `[Updater] Releases 页面兜底失败：${rawErrorMessage(fallbackError)}` +
        `${nestedErrorCode(fallbackError) ? ` (${nestedErrorCode(fallbackError)})` : ''}`
    )
    // 两条链路都失败时优先呈现最终网络原因；若页面返回了明确业务错误则原样保留。
    if (isRetryableTransport(fallbackError)) throw friendlyNetworkError(fallbackError)
    if (fallbackError instanceof Error) throw fallbackError
    throw friendlyNetworkError(apiError)
  }
}

/**
 * 拉取 GitHub 最新 Release 并与当前版本比较。
 * 主进程单飞：冷启动、多窗口和手动点击同时触发时只执行一组远端请求。
 */
export function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!inFlight) {
    inFlight = runCheck().finally(() => {
      inFlight = null
    })
  }
  return inFlight
}
