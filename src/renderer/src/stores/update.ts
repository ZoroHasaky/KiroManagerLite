import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { RendererPackStatus, UpdateCheckResult } from '@shared/types'

const CACHE_KEY = 'kal:update-check:v1'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

interface UpdateCache {
  checkedAt: number
  result: UpdateCheckResult
}

function validResult(value: unknown): value is UpdateCheckResult {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.current === 'string'
    && typeof item.latest === 'string'
    && typeof item.hasUpdate === 'boolean'
    && typeof item.releaseUrl === 'string'
    && typeof item.name === 'string'
    && typeof item.notes === 'string'
    && typeof item.publishedAt === 'string'
  )
}

function readCache(currentVersion: string): UpdateCache | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as Partial<UpdateCache> | null
    if (!parsed || typeof parsed.checkedAt !== 'number' || !validResult(parsed.result)) return null
    if (parsed.result.current !== currentVersion) return null
    return { checkedAt: parsed.checkedAt, result: parsed.result }
  } catch {
    return null
  }
}

function writeCache(result: UpdateCheckResult): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ checkedAt: Date.now(), result }))
  } catch {
    // localStorage 不可写时仍保留本次会话内的检查结果。
  }
}


/** 资源包热更的界面阶段 */
export type PackPhase = 'idle' | 'downloading' | 'ready' | 'installing' | 'failed'

export const useUpdateStore = defineStore('update', () => {
  const result = ref<UpdateCheckResult | null>(null)
  const checking = ref(false)
  const modalOpen = ref(false)
  const initialized = ref(false)
  let request: Promise<{ data?: UpdateCheckResult; error?: string }> | null = null

  // ============ 资源包热更新 ============
  /*
   * 状态机：idle → downloading → ready → installing → 重启
   * 任何一步失败都回到 failed 并保留错误原文，用户可重试或改走完整安装包。
   * 下载与安装都在主进程完成，这里只持有界面需要的阶段与进度。
   */
  const packStatus = ref<RendererPackStatus | null>(null)
  const packPhase = ref<PackPhase>('idle')
  const packProgress = ref(0)
  const packError = ref('')
  /** 正在处理的目标版本；失败重试时据此恢复 */
  const packVersion = ref('')
  let offProgress: (() => void) | null = null

  /** 当前平台是否有可用的热更包 */
  const packAvailable = computed(() => {
    const pack = result.value?.pack
    return !!pack?.url && pack.url.length > 0
  })

  /** 已下载解压、等重启生效 */
  const packReady = computed(() => packPhase.value === 'ready')
  const downloading = computed(() => packPhase.value === 'downloading')
  const installing = computed(() => packPhase.value === 'installing')

  function subscribeProgress(): void {
    if (offProgress) return
    offProgress = window.api.onPackProgress((payload) => {
      if (payload.version !== packVersion.value) return
      packProgress.value = payload.percent ?? 0
    })
  }

  async function refreshPackStatus(): Promise<void> {
    const res = await window.api.getPackStatus()
    if (res.success && res.data) {
      packStatus.value = res.data
      // 主进程已装好待生效的版本要接管界面阶段，避免重启后界面显示「未下载」
      if (res.data.pendingVersion && packPhase.value === 'idle') {
        packVersion.value = res.data.pendingVersion
        packPhase.value = 'ready'
      }
    }
  }

  /** 下载并安装当前可用的资源包 */
  async function downloadAndInstall(): Promise<{ ok: boolean; error?: string }> {
    const pack = result.value?.pack
    if (!pack?.url) return { ok: false, error: '这次发布没有提供本平台的热更包' }
    if (packPhase.value === 'downloading' || packPhase.value === 'installing') {
      return { ok: false, error: '正在处理中' }
    }

    packVersion.value = pack.version
    packError.value = ''
    packProgress.value = 0
    packPhase.value = 'downloading'
    subscribeProgress()

    try {
      const downloaded = await window.api.downloadPack(pack.version, {
        url: pack.url,
        sha256: pack.sha256,
        size: pack.size
      })
      if (!downloaded.success) throw new Error(downloaded.error || '下载失败')

      packPhase.value = 'installing'
      const installed = await window.api.installPack(pack.version)
      if (!installed.success) throw new Error(installed.error || '安装失败')

      packPhase.value = 'ready'
      packProgress.value = 100
      await refreshPackStatus()
      return { ok: true }
    } catch (error) {
      packPhase.value = 'failed'
      packError.value = error instanceof Error ? error.message : String(error)
      return { ok: false, error: packError.value }
    }
  }

  /** 放弃已下载的包，回到 idle */
  async function discard(): Promise<void> {
    await window.api.discardPack(packVersion.value || undefined)
    packPhase.value = 'idle'
    packProgress.value = 0
    packError.value = ''
    packVersion.value = ''
    await refreshPackStatus()
  }

  /** 重启让资源包生效 */
  async function relaunch(): Promise<{ ok: boolean; error?: string }> {
    const res = await window.api.relaunchForUpdate()
    if (!res.success) return { ok: false, error: res.error || '重启失败' }
    return { ok: true }
  }

  /** 回退到安装包内置版本 */
  async function rollback(): Promise<{ ok: boolean; error?: string }> {
    const res = await window.api.rollbackPack()
    if (!res.success) return { ok: false, error: res.error || '回退失败' }
    await refreshPackStatus()
    return { ok: true }
  }

  const hasUpdate = computed(() => result.value?.hasUpdate === true)
  const latestVersion = computed(() => result.value?.latest ?? '')

  async function fetchLatest(): Promise<{ data?: UpdateCheckResult; error?: string }> {
    if (request) return request
    checking.value = true
    request = (async () => {
      try {
        const response = await window.api.checkUpdate()
        if (!response.success || !response.data) {
          return { error: response.error || '检查更新失败，请稍后再试' }
        }
        result.value = response.data
        writeCache(response.data)
        return { data: response.data }
      } catch (error) {
        return { error: error instanceof Error ? error.message : '检查更新失败，请稍后再试' }
      } finally {
        checking.value = false
        request = null
      }
    })()
    return request
  }

  async function initialize(currentVersion: string): Promise<void> {
    if (initialized.value || !currentVersion) return
    initialized.value = true
    const cache = readCache(currentVersion)
    if (cache) {
      result.value = cache.result
      if (Date.now() - cache.checkedAt < CACHE_TTL_MS) {
        if (cache.result.hasUpdate) modalOpen.value = true
        return
      }
    }
    const response = await fetchLatest()
    modalOpen.value = response.data?.hasUpdate === true
  }

  async function checkNow(): Promise<{ data?: UpdateCheckResult; error?: string }> {
    const response = await fetchLatest()
    if (response.data) modalOpen.value = response.data.hasUpdate
    return response
  }

  function showModal(): void {
    if (result.value?.hasUpdate) modalOpen.value = true
  }

  function closeModal(): void {
    modalOpen.value = false
  }

  return {
    result,
    checking,
    modalOpen,
    initialized,
    hasUpdate,
    latestVersion,
    initialize,
    checkNow,
    showModal,
    closeModal,
    // 资源包
    packStatus,
    packPhase,
    packProgress,
    packError,
    packVersion,
    packAvailable,
    packReady,
    downloading,
    installing,
    refreshPackStatus,
    downloadAndInstall,
    discard,
    relaunch,
    rollback
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUpdateStore, import.meta.hot))
}