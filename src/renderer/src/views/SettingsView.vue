<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  CloudUploadOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  UploadOutlined
} from '@ant-design/icons-vue'
import {
  BACKUP_CYCLE_OPTIONS,
  BACKUP_KEEP_MAX,
  BACKUP_KEEP_MIN,
  BACKUP_MIN_INTERVAL_MINUTES,
  WEEKDAY_LABELS,
  describeBackupCycle,
  normalizeBackupCycle,
  normalizeBackupKeep,
  type BackupCycle
} from '@shared/backupSchedule'
import { DEFAULT_SETTINGS } from '@shared/types'
import type {
  AccountDisplayMode,
  AppSettings,
  BackupScheduleStatus,
  DataBackupSummary,
  LayoutMode,
  ThemeMode
} from '@shared/types'
import ThemeModeIcon from '@/components/common/ThemeModeIcon.vue'
import LayoutModeIcon from '@/components/common/LayoutModeIcon.vue'
import {
  PORTAL_LOCALE_CUSTOM,
  PORTAL_LOCALE_PRESETS,
  isPresetPortalLocale,
  normalizePortalLocale
} from '@shared/portalLocale'
import { useSettingsStore } from '@/stores/settings'
import { useUpdateStore } from '@/stores/update'
import SettingSwitch from '@/components/common/SettingSwitch.vue'
import PathMenu from '@/components/common/PathMenu.vue'
import { useAccountsStore } from '@/stores/accounts'
import { formatCheckedAt } from '@/utils/format'
import { now } from '@/utils/now'
import { bodyPopupContainer, confirmDanger } from '@/utils/ui'

const settingsStore = useSettingsStore()
const accountsStore = useAccountsStore()
const updateStore = useUpdateStore()

const settings = computed(() => settingsStore.settings)
const proxyDraft = ref(settingsStore.settings.proxyUrl)

/** 各设置卡片共用的表单栅格：左侧固定标签宽度，右侧自适应 */
const FORM_LAYOUT = {
  layout: 'horizontal',
  labelCol: { flex: '0 0 130px' },
  wrapperCol: { flex: '1 1 auto' }
} as const

// ============ 软件更新 ============
/*
 * 热更新只在安装包里可用：开发模式跑的是 dev server，替换资源包没有意义。
 * 资源包覆盖主进程 + preload + 渲染层，所以改主进程代码也能通过它生效，
 * 前提是这一版安装包已经带了 bootstrap 引导层。
 */
const packStatus = computed(() => updateStore.packStatus)
const packPhase = computed(() => updateStore.packPhase)
const packProgress = computed(() => updateStore.packProgress)
const packError = computed(() => updateStore.packError)
const updateChecking = computed(() => updateStore.checking)
const updateResult = computed(() => updateStore.result)
const packAvailable = computed(() => updateStore.packAvailable)

const updateActionText = computed(() => {
  if (packPhase.value === 'downloading') return `正在下载 ${packProgress.value}%`
  if (packPhase.value === 'installing') return '正在解压校验…'
  return '下载并更新'
})

const updateHint = computed(() => {
  if (!updateResult.value) return ''
  if (!updateResult.value.hasUpdate) return `已是最新版本（v${updateResult.value.current}）`
  if (!packAvailable.value) {
    return '这次发布没有提供当前平台的热更包，请打开 Releases 下载完整安装包。'
  }
  return `可热更到 v${updateResult.value.latest}，下载完成后重启即可生效。`
})

async function checkUpdate(): Promise<void> {
  const res = await updateStore.checkNow()
  updateStore.modalOpen = false
  if (res.error) {
    message.error(res.error)
    return
  }
  await updateStore.refreshPackStatus()
  message.success(res.data?.hasUpdate ? `发现新版本 v${res.data.latest}` : '已是最新版本')
}

async function startPackUpdate(): Promise<void> {
  const res = await updateStore.downloadAndInstall()
  if (!res.ok) message.error(res.error || '更新失败')
  else message.success('资源包已就绪，重启后生效')
}

async function relaunchForUpdate(): Promise<void> {
  const res = await updateStore.relaunch()
  if (!res.ok) message.error(res.error || '重启失败')
}

async function discardPackUpdate(): Promise<void> {
  await updateStore.discard()
  message.info('已放弃待安装的资源包')
}


/**
 * 下次执行的时间与倒计时，跟着共享时钟每 5 秒重算。
 *
 * action 区分「检测」与「刷新」：前者只是判断谁该刷，后者才真正发请求。
 * 两类轨道混用同一个词会让用户以为检测也在发请求。
 */
function nextRunText(at: number | null, action: '检测' | '刷新'): string {
  if (!at) return '未开启，不会自动执行'
  const remain = at - now.value
  // 到期后到期时间会被立刻往后推，这里还没推说明本轮正在执行或在等手动任务让路
  if (remain <= 0) return '本轮正在执行…'
  // 小时级的间隔（如闲置号 12 小时）不能只写成「720 分」，读起来没有意义
  const hours = Math.floor(remain / 3_600_000)
  const minutes = Math.floor((remain % 3_600_000) / 60_000)
  const seconds = Math.floor((remain % 60_000) / 1000)
  const countdown = hours
    ? `${hours} 小时 ${minutes} 分后`
    : minutes
      ? `${minutes} 分 ${seconds} 秒后`
      : `${seconds} 秒后`
  return `下次${action} ${formatCheckedAt(at, now.value)}（${countdown}）`
}

const nextKeyRefreshText = computed(() => nextRunText(accountsStore.nextKeyRefreshAt, '检测'))
const nextUsageRefreshText = computed(() => nextRunText(accountsStore.nextUsageRefreshAt, '检测'))
const nextIdleUsageRefreshText = computed(() =>
  nextRunText(accountsStore.nextIdleUsageRefreshAt, '检测')
)
const nextKeyFlushText = computed(() => nextRunText(accountsStore.nextKeyFlushAt, '刷新'))
const nextUsageFlushText = computed(() => nextRunText(accountsStore.nextUsageFlushAt, '刷新'))

watch(
  () => settingsStore.settings.proxyUrl,
  (value) => {
    if (value !== proxyDraft.value) proxyDraft.value = value
  }
)

const themeModeOptions: { value: ThemeMode; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]

const layoutModeOptions: { value: LayoutMode; label: string }[] = [
  { value: 'side', label: '左右布局' },
  { value: 'top', label: '上下布局' }
]

/** 账号列表的展示形态 */
const displayModeOptions: { value: AccountDisplayMode; label: string }[] = [
  { value: 'card', label: '卡片' },
  { value: 'compact', label: '紧凑卡片' },
  { value: 'list', label: '列表' }
]
/** 主题色预设。色值沿用旧版的七个，老用户选过的颜色升级后仍能在这里对上、显示为选中 */
const colorOptions: { value: string; label: string }[] = [
  { value: '#7c3aed', label: '紫罗兰' },
  { value: '#1677ff', label: '天空蓝' },
  { value: '#13c2c2', label: '青碧色' },
  { value: '#52c41a', label: '翡翠绿' },
  { value: '#fa8c16', label: '琥珀橙' },
  { value: '#eb2f96', label: '樱花粉' },
  { value: '#f5222d', label: '朱砂红' }
]


/** 输入框可能给出 null 或越界值，统一夹到 1-100 */
function clampImportConcurrency(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return DEFAULT_SETTINGS.importConcurrency
  return Math.max(1, Math.min(Math.round(num), 100))
}

const closeActionOptions: { value: AppSettings['closeAction']; label: string }[] = [
  { value: 'ask', label: '每次询问' },
  { value: 'minimize', label: '最小化到托盘' },
  { value: 'quit', label: '退出程序' }
]

const portalLocale = computed(
  () => settings.value.portalLocale ?? DEFAULT_SETTINGS.portalLocale
)

/** 预设与主进程共用同一份，末尾追加「自定义」入口 */
const localeSelectOptions = [
  ...PORTAL_LOCALE_PRESETS,
  { value: PORTAL_LOCALE_CUSTOM, label: '自定义…' }
]

/**
 * 是否处于自定义模式。
 * 初值看当前取值是否落在预设里：手输过 zh-Hant-HK 这类值时，重新进设置页要保持自定义态。
 */
const localeCustomMode = ref(!isPresetPortalLocale(portalLocale.value))

/** 自定义输入走本地草稿，回车或点保存才提交，避免每敲一个字母写一次设置 */
const localeDraft = ref(portalLocale.value)

watch(
  () => settingsStore.settings.portalLocale,
  (value) => {
    if (value !== localeDraft.value) localeDraft.value = value
    // 设置被外部改成非预设值（如恢复默认后再手改）时同步切换模式
    if (!isPresetPortalLocale(value)) localeCustomMode.value = true
  }
)

/** 自定义模式下下拉固定停在「自定义」，否则跟随当前预设 */
const localeSelectValue = computed(() =>
  localeCustomMode.value ? PORTAL_LOCALE_CUSTOM : portalLocale.value
)

/** 支持按地区名或语言标签搜索，输入 ru 或「俄」都能筛到 */
function filterLocaleOption(input: string, option: { value: string; label: string }): boolean {
  const keyword = input.trim().toLowerCase()
  if (!keyword) return true
  return (
    option.value.toLowerCase().includes(keyword) || option.label.toLowerCase().includes(keyword)
  )
}

function onLocaleSelect(value: string): void {
  if (value === PORTAL_LOCALE_CUSTOM) {
    // 只切模式、不动已生效的值：等用户填完再提交，避免中途把地区改成空
    localeCustomMode.value = true
    localeDraft.value = portalLocale.value
    return
  }
  localeCustomMode.value = false
  update({ portalLocale: value })
}

/** 提交前规范化：与主进程同一套实现，避免界面显示的和实际生效的不一致 */
function savePortalLocale(): void {
  const normalized = normalizePortalLocale(localeDraft.value)
  localeDraft.value = normalized
  // 填的正好是预设值时收起输入框，回到下拉直选的状态
  if (isPresetPortalLocale(normalized)) localeCustomMode.value = false
  if (normalized !== portalLocale.value) update({ portalLocale: normalized })
}

/** 设置缺失时回落到默认的「最小化到托盘」，避免下拉显示空白 */
const closeAction = computed(
  () => settings.value.closeAction ?? DEFAULT_SETTINGS.closeAction
)

function update(patch: Parameters<typeof settingsStore.update>[0]): void {
  void settingsStore.update(patch)
}

/** 数字类设置：清空或填了非法值时回落默认值 */
type NumericSettingKey =
  | 'keyRefreshInterval'
  | 'usageRefreshInterval'
  | 'idleUsageRefreshInterval'
  | 'usageRefreshMaxPercent'
  | 'keyRefreshWindowMinutes'
  | 'keyFlushInterval'
  | 'keyFlushSize'
  | 'usageFlushInterval'
  | 'usageFlushSize'

function updateNumber(key: NumericSettingKey, value: unknown): void {
  update({ [key]: Number(value) || DEFAULT_SETTINGS[key] })
}

async function saveProxy(): Promise<void> {
  await settingsStore.update({ proxyUrl: proxyDraft.value.trim() })
  message.success('代理地址已保存')
}

function openPath(target: 'store' | 'backup'): void {
  void window.api.showPath(target)
}

/** 备份范围说明，和主进程 dataBackup 里实际打包的内容一致 */
const BACKUP_SCOPE = '账号与账号的积分变化记录'

// ============ 备份计划 ============

const cycle = computed(() => normalizeBackupCycle(settings.value.backupCycle))
const cycleOptions = BACKUP_CYCLE_OPTIONS
const weekdayOptions = WEEKDAY_LABELS.map((label, value) => ({ value, label }))
const monthDayOptions = Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: `${i + 1} 号` }))

/** 每种周期需要填哪几项，和图示一致：选了类型后右侧只出现相关的输入框 */
const cycleFields = computed(() => {
  const t = cycle.value.type
  return {
    n: t === 'nDays' || t === 'nHours' || t === 'nMinutes',
    weekday: t === 'week',
    day: t === 'month',
    hour: t === 'day' || t === 'nDays' || t === 'week' || t === 'month',
    minute: t !== 'nMinutes'
  }
})

const nUnit = computed(() => ({ nDays: '天', nHours: '小时', nMinutes: '分钟' })[cycle.value.type as 'nDays'] ?? '')
const nMin = computed(() => (cycle.value.type === 'nMinutes' ? BACKUP_MIN_INTERVAL_MINUTES : 1))

function updateCycle(patch: Partial<BackupCycle>): void {
  update({ backupCycle: normalizeBackupCycle({ ...cycle.value, ...patch }) })
}

/** 换周期类型时把 N 夹进新类型的范围：从 N 小时的 2 换到 N 分钟，2 分钟低于下限 */
function changeCycleType(type: BackupCycle['type']): void {
  updateCycle({ type, n: type === 'nMinutes' ? Math.max(cycle.value.n, 30) : cycle.value.n })
}

const backupState = ref<BackupScheduleStatus | null>(null)
const backingUp = ref(false)
let offBackupStatus: (() => void) | null = null

onMounted(async () => {
  offBackupStatus = window.api.onBackupStatus((status) => (backupState.value = status))
  const res = await window.api.getBackupStatus()
  if (res.success && res.data) backupState.value = res.data
  // 进页面就同步一次资源包状态：上次装了但没重启的包要显示成「待重启」
  await updateStore.refreshPackStatus()
})
onUnmounted(() => offBackupStatus?.())

// 开关、周期一改，主进程会重排并推送新状态；这里再主动拉一次，避免推送比保存先到
watch(
  () => [settings.value.backupEnabled, JSON.stringify(settings.value.backupCycle)],
  async () => {
    const res = await window.api.getBackupStatus()
    if (res.success && res.data) backupState.value = res.data
  }
)

const backupNextText = computed(() => {
  const next = backupState.value?.nextAt
  if (!settings.value.backupEnabled || !next) return '未开启'
  return formatCheckedAt(next, now.value)
})

const backupLastText = computed(() => {
  const s = backupState.value
  if (!s?.lastAt) return '还没有备份过'
  return `${formatCheckedAt(s.lastAt, now.value)}${s.lastError ? '（失败）' : ''}`
})

async function backupNow(): Promise<void> {
  backingUp.value = true
  try {
    const res = await window.api.runBackupNow()
    if (!res.success) return void message.error(res.error || '备份失败')
    backupState.value = res.data ?? backupState.value
    if (res.data?.lastError) message.error(`备份失败：${res.data.lastError}`)
    else message.success('已备份到备份目录')
  } finally {
    backingUp.value = false
  }
}

const exporting = ref(false)
const importing = ref(false)
const resetting = ref(false)

/** 导出数据：保存后主进程会在文件管理器里选中该文件 */
async function exportAll(): Promise<void> {
  exporting.value = true
  try {
    const res = await window.api.exportAllData()
    if (!res.success) return void message.error(res.error || '导出失败')
    if (res.data?.saved) message.success('已导出数据')
  } finally {
    exporting.value = false
  }
}

/** Modal.confirm 渲染在 body 下，组件的 scoped 样式管不到，段落间距只能内联 */
const CONFIRM_LINE = 'margin: 0 0 6px'

function formatBackupTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { hour12: false })
}

/** 先选文件、看摘要，确认后再整体替换；替换完成后应用会自行重启 */
async function importAll(): Promise<void> {
  importing.value = true
  let summary: DataBackupSummary | null | undefined
  try {
    const res = await window.api.pickImportData()
    if (!res.success) return void message.error(res.error || '读取备份失败')
    summary = res.data
  } finally {
    importing.value = false
  }
  if (!summary) return
  const parts: string[] = []
  if (summary.accounts !== null) parts.push(`${summary.accounts} 个账号`)
  if (summary.usageHistory) parts.push('积分变化记录')
  const lines = [
    `导出时间：${summary.exportedAt ? formatBackupTime(summary.exportedAt) : '未知'}${summary.appVersion ? `（v${summary.appVersion}）` : ''}`,
    `包含：${parts.join('、') || '无可导入的内容'}`,
    '文件里带了的部分会替换本机对应的数据，没带的部分和设置等其他数据保持不变；完成后应用自动重启。'
  ]
  if (summary.newerSchema) {
    lines.push('该文件来自更新版本的应用，本版本认识的部分会照常导入，其余部分会被忽略。')
  }
  confirmDanger({
    title: '导入数据',
    content: h('div', lines.map((line) => h('p', { style: CONFIRM_LINE }, line))),
    okText: '导入并重启',
    okButtonProps: { type: 'primary', danger: true },
    onOk: async () => {
      const res = await window.api.applyImportData()
      // 成功时应用已经重启，走不到这里；能拿到结果就是失败了
      if (!res.success) message.error(res.error || '导入失败')
    }
  })
}

/*
 * 旧版本写进用户机器上的外部配置由主进程在启动时自动还原，
 * 确认框里不逐条列出，只说清楚会删掉什么。
 */
function resetAll(): void {
  confirmDanger({
    title: '初始化',
    content: h('div', [
      h('p', { style: CONFIRM_LINE }, '删除全部账号、设置、日志、历史记录和备份目录里的所有备份，和初次安装时一样。'),
      h('p', { style: CONFIRM_LINE }, '该操作不可撤销，完成后应用自动重启。')
    ]),
    okText: '确认初始化',
    okButtonProps: { type: 'primary', danger: true },
    onOk: async () => {
      resetting.value = true
      const res = await window.api.resetAllData()
      resetting.value = false
      if (!res.success) message.error(res.error || '初始化失败')
    }
  })
}
</script>

<template>
  <div>
    <a-card size="small" title="外观" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="主题风格">
          <div class="choice-group" role="radiogroup" aria-label="主题风格">
            <button
              v-for="opt in themeModeOptions"
              :key="opt.value"
              type="button"
              role="radio"
              class="choice-card"
              :class="{ selected: settings.themeMode === opt.value }"
              :aria-checked="settings.themeMode === opt.value"
              @click="update({ themeMode: opt.value })"
            >
              <ThemeModeIcon :mode="opt.value" />
              <span class="choice-label">{{ opt.label }}</span>
            </button>
          </div>
          <div class="choice-hint">选择界面主题风格，「自动」跟随系统的浅色 / 深色切换</div>
        </a-form-item>
        <a-form-item label="主题色">
          <div class="choice-group" role="radiogroup" aria-label="主题色">
            <button
              v-for="opt in colorOptions"
              :key="opt.value"
              type="button"
              role="radio"
              class="choice-card"
              :class="{ selected: settings.primaryColor === opt.value }"
              :aria-checked="settings.primaryColor === opt.value"
              @click="update({ primaryColor: opt.value })"
            >
              <span class="swatch" :style="{ background: opt.value }" />
              <span class="choice-label">{{ opt.label }}</span>
            </button>
          </div>
          <div class="choice-hint">选择界面的强调色，用于按钮、链接与选中态</div>
        </a-form-item>
        <a-form-item label="布局风格">
          <div class="choice-group" role="radiogroup" aria-label="布局风格">
            <button
              v-for="opt in layoutModeOptions"
              :key="opt.value"
              type="button"
              role="radio"
              class="choice-card"
              :class="{ selected: settings.layoutMode === opt.value }"
              :aria-checked="settings.layoutMode === opt.value"
              @click="update({ layoutMode: opt.value })"
            >
              <LayoutModeIcon :mode="opt.value" />
              <span class="choice-label">{{ opt.label }}</span>
            </button>
          </div>
          <div class="choice-hint">左右布局把导航放在左侧，上下布局把导航放到窗口顶部，内容区更宽</div>
        </a-form-item>
        <a-form-item label="控件尺寸">
          <a-radio-group
            :value="settings.componentSize"
            @change="(e: any) => update({ componentSize: e.target.value })"
          >
            <a-radio value="default">默认尺寸</a-radio>
            <a-radio value="large">大尺寸</a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item label="账号展示形态">
          <div class="choice-group" role="radiogroup" aria-label="账号展示形态">
            <button
              v-for="opt in displayModeOptions"
              :key="opt.value"
              type="button"
              role="radio"
              class="choice-card"
              :class="{ selected: settings.accountDisplayMode === opt.value }"
              :aria-checked="settings.accountDisplayMode === opt.value"
              @click="update({ accountDisplayMode: opt.value })"
            >
              <span class="choice-label">{{ opt.label }}</span>
            </button>
          </div>
          <div class="choice-hint">账号管理页的展示形态：卡片信息最全，列表一屏能看更多</div>
        </a-form-item>
        <a-form-item label="隐私打码" class="field-inline">
          <SettingSwitch field="privacyMode" />
          <span class="muted">列表与详情中隐藏邮箱与备注</span>
        </a-form-item>
        <a-form-item label="积分两位小数">
          <SettingSwitch field="usagePrecision" />
        </a-form-item>
      </a-form>
    </a-card>

    <a-card size="small" title="密钥刷新" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="自动刷新密钥" class="field-inline">
          <SettingSwitch field="autoRefresh" />
          <span class="muted">
            自动检测即将过期的账号并刷新 token，避免无谓轮换 Refresh Token
          </span>
        </a-form-item>
        <a-form-item label="密钥过期提前量" class="field-inline">
          <a-input-number
            :value="settings.keyRefreshWindowMinutes"
            :min="1"
            :max="180"
            :step="5"
            addon-after="分钟"
            style="width: 180px"
            :disabled="!settings.autoRefresh"
            @change="(v: unknown) => updateNumber('keyRefreshWindowMinutes', v)"
          />
          <span class="muted">
            剩余有效期小于这个值的账号才算「即将过期」，提前量越小进池的账号越少
          </span>
        </a-form-item>
        <a-form-item label="密钥检测间隔" class="field-inline">
          <a-input-number
            :value="settings.keyRefreshInterval"
            :min="1"
            :max="600"
            :step="5"
            addon-after="分钟"
            style="width: 180px"
            :disabled="!settings.autoRefresh"
            @change="(v: unknown) => updateNumber('keyRefreshInterval', v)"
          />
          <span class="muted">
            多久检测一次哪些账号即将过期；检测只负责把它们放进密钥池，不发请求
            <span class="next-refresh">{{ nextKeyRefreshText }}</span>
          </span>
        </a-form-item>
        <a-form-item label="密钥池刷新间隔" class="field-inline">
          <a-input-number
            :value="settings.keyFlushInterval"
            :min="1"
            :max="120"
            :step="1"
            addon-after="分钟"
            style="width: 180px"
            :disabled="!settings.autoRefresh"
            @change="(v: unknown) => updateNumber('keyFlushInterval', v)"
          />
          <span class="muted">
            每隔这么久从密钥池里取一批真正去刷新
            <span class="next-refresh">{{ nextKeyFlushText }}</span>
          </span>
        </a-form-item>
        <a-form-item label="密钥池每次数量" class="field-inline">
          <a-input-number
            :value="settings.keyFlushSize"
            :min="1"
            :max="200"
            :step="5"
            addon-after="个"
            style="width: 180px"
            :disabled="!settings.autoRefresh"
            @change="(v: unknown) => updateNumber('keyFlushSize', v)"
          />
          <span class="muted">
            每次从密钥池取多少个账号。同一出口 IP 短时间内请求太多会被上游限流（返回 403），
            调小可显著降低触发概率，代价是池子排得更久
          </span>
        </a-form-item>
        <a-form-item label="用量达阈值后停刷密钥" class="field-inline">
          <SettingSwitch field="skipKeyRefreshAtUsageLimit" />
          <span class="muted">
            用「用量刷新」里的百分比一起拦截密钥刷新。停刷后 token 会过期，
            再次使用该账号需要重新登录
          </span>
        </a-form-item>
      </a-form>
      <ul class="tips">
        <li>
          检测与刷新是两条独立的时间线：「密钥检测间隔」只决定多久检查一次谁该刷，
          即将过期的账号会被放进密钥池，本身不发请求。
        </li>
        <li>
          「密钥池刷新间隔」与「密钥池每次数量」决定真正发出多少请求。
          把请求按固定节奏摊开，是规避上游限流的主要手段。
        </li>
        <li>手动刷新单个账号时，如果它在池子里会被一并移除，不会被池子再刷一遍。</li>
      </ul>
    </a-card>

    <a-card size="small" title="用量刷新" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="自动刷新用量" class="field-inline">
          <SettingSwitch field="autoRefreshUsage" />
          <span class="muted">
            自动检测并拉取账号的积分用量与订阅信息
          </span>
        </a-form-item>
        <a-form-item label="用量检测间隔" class="field-inline">
          <a-input-number
            :value="settings.usageRefreshInterval"
            :min="1"
            :max="600"
            :step="5"
            addon-after="分钟"
            style="width: 180px"
            :disabled="!settings.autoRefreshUsage"
            @change="(v: unknown) => updateNumber('usageRefreshInterval', v)"
          />
          <span class="muted">
            多久检测一次哪些账号该更新用量；检测只负责把它们放进用量池，不发请求
            <span class="next-refresh">{{ nextUsageRefreshText }}</span>
          </span>
        </a-form-item>
        <a-form-item label="已闲置账号检测间隔" class="field-inline">
          <a-input-number
            :value="settings.idleUsageRefreshInterval"
            :min="1"
            :max="168"
            :step="1"
            addon-after="小时"
            style="width: 180px"
            :disabled="!settings.autoRefreshUsage"
            @change="(v: unknown) => updateNumber('idleUsageRefreshInterval', v)"
          />
          <span class="muted">
            已闲置账号不会再产生新消耗，单独按这个间隔检测即可
            <span class="next-refresh">{{ nextIdleUsageRefreshText }}</span>
          </span>
        </a-form-item>
        <a-form-item label="用量池刷新间隔" class="field-inline">
          <a-input-number
            :value="settings.usageFlushInterval"
            :min="1"
            :max="120"
            :step="1"
            addon-after="分钟"
            style="width: 180px"
            :disabled="!settings.autoRefreshUsage"
            @change="(v: unknown) => updateNumber('usageFlushInterval', v)"
          />
          <span class="muted">
            每隔这么久从用量池里取一批真正去拉取
            <span class="next-refresh">{{ nextUsageFlushText }}</span>
          </span>
        </a-form-item>
        <a-form-item label="用量池每次数量" class="field-inline">
          <a-input-number
            :value="settings.usageFlushSize"
            :min="1"
            :max="200"
            :step="5"
            addon-after="个"
            style="width: 180px"
            :disabled="!settings.autoRefreshUsage"
            @change="(v: unknown) => updateNumber('usageFlushSize', v)"
          />
          <span class="muted">
            每次从用量池取多少个账号。用量刷新只影响界面数字，可以比密钥池放得更慢
          </span>
        </a-form-item>
        <a-form-item label="用量达阈值后停刷" class="field-inline">
          <a-input-number
            :value="settings.usageRefreshMaxPercent"
            :min="0"
            :max="100"
            :step="5"
            addon-after="%"
            style="width: 180px"
            :disabled="!settings.autoRefreshUsage"
            @change="(v: unknown) => updateNumber('usageRefreshMaxPercent', v)"
          />
          <span class="muted">
            用量达到该百分比后不再自动刷新，0 表示不限制；重置时间过后会自动放行一次
          </span>
        </a-form-item>
        <a-form-item label="批量并发" class="field-inline">
          <a-input-number
            :value="settings.concurrency"
            :min="1"
            :max="20"
            style="width: 180px"
            @change="(v: unknown) => update({ concurrency: Number(v) || 5 })"
          />
          <span class="muted">
            一个批次内部同时发出几个请求。与「每次数量」相乘才是瞬时请求量，
            并发过高容易被限流
          </span>
        </a-form-item>
        <a-form-item label="删除前确认">
          <SettingSwitch field="confirmBeforeDelete" />
        </a-form-item>
      </a-form>
      <ul class="tips">
        <li>
          「用量检测间隔」只决定多久检查一次谁该刷；真正的请求由「用量池刷新间隔」
          与「用量池每次数量」控制。
        </li>
        <li>
          已闲置账号（用过分或超过闲置阈值）按更长的间隔单独检测，与常规账号共用同一个用量池。
        </li>
        <li>手动批量刷新需要先勾选账号，勾多少刷多少，不受「每次数量」限制，也不入池。</li>
        <li>各条检测与刷新轨道独立计时，撞在一起时按顺序串行执行，不会丢轮。</li>
        <li>手动批量操作进行中时定时任务会等待，操作结束后立即补跑到期的那一轮。</li>
        <li>窗口最小化到托盘、电脑睡眠唤醒后错过的轮次都会自动补跑，不需要重开窗口。</li>
      </ul>
    </a-card>

    <a-card size="small" title="数据管理" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="数据目录">
          <PathMenu
            v-if="settingsStore.appInfo?.dataDir"
            :path="settingsStore.appInfo.dataDir"
            @reveal="openPath('store')"
          />
          <span v-else class="muted">-</span>
        </a-form-item>
        <a-form-item label="导入导出">
          <a-space wrap>
            <a-button :loading="exporting" @click="exportAll">
              <template #icon><DownloadOutlined /></template>
              导出数据
            </a-button>
            <a-button :loading="importing" @click="importAll">
              <template #icon><UploadOutlined /></template>
              导入数据
            </a-button>
            <a-button danger :loading="resetting" @click="resetAll">
              <template #icon><ReloadOutlined /></template>
              初始化
            </a-button>
          </a-space>
        </a-form-item>

      </a-form>
      <ul class="tips">
        <li>导出内容：{{ BACKUP_SCOPE }}。设置项、日志等不在其中。</li>
        <li>导出为明文 .json 文件，包含账号凭证，请妥善保管，不要发给他人。</li>
        <li>导入只接受本应用导出的 .json 文件，替换本机对应的账号与积分变化记录，其余数据保持不变；完成后应用自动重启。备份目录里的文件也可以直接导入。</li>
        <li>
          初始化会先还原旧版本留在本机的 IDE 端点等外部配置，再清掉全部数据、日志、历史记录和备份目录，
          和初次安装时一样，完成后应用自动重启。
        </li>
      </ul>
    </a-card>

    <a-card size="small" title="备份计划">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="备份计划" class="field-inline">
          <SettingSwitch field="backupEnabled" />
          <span class="muted">开启后按下面的周期静默备份，内容与「导出数据」完全一致</span>
        </a-form-item>
        <a-form-item label="执行周期">
          <div class="cycle-row">
            <a-select
              :value="cycle.type"
              :options="cycleOptions"
              :disabled="!settings.backupEnabled"
              :get-popup-container="bodyPopupContainer"
              style="width: 120px"
              @change="(v: unknown) => changeCycleType(v as BackupCycle['type'])"
            />
            <a-input-number
              v-if="cycleFields.n"
              :value="cycle.n"
              :min="nMin"
              :precision="0"
              :addon-after="nUnit"
              :disabled="!settings.backupEnabled"
              style="width: 150px"
              @change="(v: unknown) => updateCycle({ n: Number(v) || nMin })"
            />
            <a-select
              v-if="cycleFields.weekday"
              :value="cycle.weekday"
              :options="weekdayOptions"
              :disabled="!settings.backupEnabled"
              :get-popup-container="bodyPopupContainer"
              style="width: 100px"
              @change="(v: unknown) => updateCycle({ weekday: Number(v) })"
            />
            <a-select
              v-if="cycleFields.day"
              :value="cycle.day"
              :options="monthDayOptions"
              :disabled="!settings.backupEnabled"
              :get-popup-container="bodyPopupContainer"
              style="width: 100px"
              @change="(v: unknown) => updateCycle({ day: Number(v) })"
            />
            <a-input-number
              v-if="cycleFields.hour"
              :value="cycle.hour"
              :min="0"
              :max="23"
              :precision="0"
              addon-after="时"
              :disabled="!settings.backupEnabled"
              style="width: 130px"
              @change="(v: unknown) => updateCycle({ hour: Number(v) || 0 })"
            />
            <a-input-number
              v-if="cycleFields.minute"
              :value="cycle.minute"
              :min="0"
              :max="59"
              :precision="0"
              addon-after="分"
              :disabled="!settings.backupEnabled"
              style="width: 130px"
              @change="(v: unknown) => updateCycle({ minute: Number(v) || 0 })"
            />
          </div>
          <div class="choice-hint">
            {{ describeBackupCycle(cycle) }}
            <template v-if="settings.backupEnabled">· 下次执行 {{ backupNextText }}</template>
          </div>
        </a-form-item>
        <a-form-item label="保留份数" class="field-inline">
          <a-input-number
            :value="settings.backupKeep"
            :min="BACKUP_KEEP_MIN"
            :max="BACKUP_KEEP_MAX"
            :precision="0"
            addon-before="最新"
            addon-after="份"
            :disabled="!settings.backupEnabled"
            style="width: 180px"
            @change="(v: unknown) => update({ backupKeep: normalizeBackupKeep(v) })"
          />
          <span class="muted">超出的旧备份在下次备份后自动删除</span>
        </a-form-item>
        <a-form-item label="备份目录">
          <PathMenu
            v-if="settingsStore.appInfo?.backupDir"
            :path="settingsStore.appInfo.backupDir"
            @reveal="openPath('backup')"
          />
          <div class="choice-hint">
            上次备份：{{ backupLastText }} · 现有 {{ backupState?.count ?? 0 }} 份
            <span v-if="backupState?.lastError" class="restart-hint">（{{ backupState.lastError }}）</span>
          </div>
        </a-form-item>
        <a-form-item label=" " :colon="false">
          <a-space wrap>
            <a-button :loading="backingUp" @click="backupNow">
              <template #icon><CloudUploadOutlined /></template>
              立即备份
            </a-button>
            <a-button @click="openPath('backup')">
              <template #icon><FolderOpenOutlined /></template>
              打开备份目录
            </a-button>
          </a-space>
        </a-form-item>
      </a-form>
      <ul class="tips">
        <li>备份文件与「导出数据」完全一致（明文 .json），同样包含凭证，请妥善保管。</li>
        <li>应用没开或电脑睡眠时错过的备份，下次启动或唤醒后补一次，不按错过的次数重复补。</li>
      </ul>
    </a-card>

    <a-card size="small" title="软件更新" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="当前版本">
          <span class="update-version">
            v{{ packStatus?.activeVersion || packStatus?.baseVersion || settingsStore.appInfo?.version || '-' }}
          </span>
          <span v-if="packStatus?.runningFromPack" class="muted update-note">
            来自资源包，安装包内置版本 v{{ packStatus.baseVersion }}
          </span>
          <span v-else-if="packStatus?.activeVersion" class="muted update-note">
            来自资源包，安装包内置版本 v{{ packStatus.baseVersion }}
          </span>
        </a-form-item>

        <a-form-item label="热更新">
          <a-space wrap>
            <a-button :loading="updateChecking" @click="checkUpdate">检查更新</a-button>
            <a-button
              v-if="updateResult?.hasUpdate && packAvailable"
              type="primary"
              :loading="packPhase === 'downloading' || packPhase === 'installing'"
              :disabled="packPhase === 'ready'"
              @click="startPackUpdate"
            >
              {{ updateActionText }}
            </a-button>
            <a-button
              v-if="packPhase === 'ready'"
              type="primary"
              @click="relaunchForUpdate"
            >
              重启并更新到 v{{ updateStore.packVersion }}
            </a-button>
            <a-button v-if="packPhase === 'ready'" @click="discardPackUpdate">放弃</a-button>
            <a-button
              v-if="packStatus?.activeVersion"
              @click="updateStore.rollback()"
            >
              回退到内置版本
            </a-button>
          </a-space>
          <div v-if="updateHint" class="update-hint muted">{{ updateHint }}</div>
          <a-progress
            v-if="packPhase === 'downloading' || packPhase === 'installing'"
            :percent="packPhase === 'installing' ? 100 : packProgress"
            :status="packPhase === 'installing' ? 'active' : 'normal'"
            size="small"
            class="update-progress"
          />
          <div v-if="packPhase === 'failed'" class="update-error">{{ packError }}</div>
        </a-form-item>
      </a-form>
      <ul class="tips">
        <li>热更新会整份替换主进程、界面与随包资源，下载完成后点「重启并更新」即可生效，不必重新安装。</li>
        <li>资源包按平台与架构分发，装错平台会被拒绝；下载后会逐文件校验，校验不通过不会启用。</li>
        <li>极少数情况下新版本无法启动，应用会自动回退到安装包内置版本；也可以在这里手动回退。</li>
        <li>开发模式（npm run dev）不支持热更新。</li>
      </ul>
    </a-card>

  </div>
</template>

<style scoped>
/*
 * 主题风格 / 主题色的选项卡：图标或色块在上、名称在下。
 * 选中项描边与文字换成主题色，右上角一个实心圆点；未选中的悬停时描边提亮。
 */
.update-version {
  margin-right: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.update-note,
.update-hint {
  font-size: 12px;
}

.update-hint {
  margin-top: 6px;
}

.update-progress {
  max-width: 420px;
  margin-top: 8px;
}

.update-error {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.7;
  color: #ff4d4f;
  overflow-wrap: anywhere;
}

.choice-group {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.choice-card {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 76px;
  height: 72px;
  padding: 0;
  /* --kal-border 只有 8% 不透明度，做卡片轮廓太淡，按正文色调一档 */
  border: 1.5px solid color-mix(in srgb, currentColor 16%, transparent);
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.choice-card:hover {
  border-color: color-mix(in srgb, var(--kal-primary) 50%, transparent);
}

.choice-card:focus-visible {
  outline: 2px solid var(--kal-primary);
  outline-offset: 2px;
}

.choice-card.selected {
  border-color: var(--kal-primary);
  color: var(--kal-primary);
}

.choice-card.selected::after {
  content: '';
  position: absolute;
  top: 6px;
  right: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--kal-primary);
}

.choice-label {
  font-size: 13px;
  line-height: 1;
}

.choice-card.selected .choice-label {
  font-weight: 600;
}

.swatch {
  width: 30px;
  height: 18px;
  border-radius: 5px;
}

/* 执行周期：类型下拉 + 按类型出现的几个输入框，一行排开、放不下再换行 */
.cycle-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}


.choice-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--kal-muted);
}

/*
 * 控件与右侧说明文字默认按基线对齐，说明文字会偏下。
 * 用 flex 居中，让两者垂直对齐。
 */
.field-inline :deep(.ant-form-item-control-input-content) {
  display: flex;
  align-items: center;
}

/* 说明文字与控件间距统一，且可换行、不挤压前面的控件 */
.field-inline :deep(.ant-form-item-control-input-content) > .muted,
.field-inline :deep(.ant-form-item-control-input-content) > .restart-hint {
  min-width: 0;
  margin-left: 10px;
}

/* 需要重启才完全生效的设置，用红色把代价说在前面 */
.restart-hint {
  color: #ff4d4f;
  font-size: 12px;
  line-height: 1.6;
}

/* 下次刷新时间单独占一行，跟在说明文字下方 */
.next-refresh {
  display: block;
  margin-top: 2px;
  font-size: 12px;
}

/* 卡片底部的补充说明 */
.tips {
  margin: 0;
  padding: 10px 12px 10px 26px;
  border-radius: 8px;
  background: var(--kal-block-bg);
  color: var(--kal-muted);
  font-size: 12px;
  line-height: 1.9;
}
</style>
