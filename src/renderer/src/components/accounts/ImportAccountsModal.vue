<script setup lang="ts">
/**
 * 导入账号：一个弹窗，文件与 JSON 两种方式同时可用。
 *
 * 早先是两个 tab，用户得先想清楚「我这串内容算文件还是算文本」。
 * 实际上两者只是内容来源不同，解析与导入逻辑完全共用，所以合并成一个界面：
 * 上方拖拽 / 选择文件，下方直接粘贴 JSON 或卡密，最后点同一个「开始导入」。
 * 两边都有内容时按「文件在前、文本在后」的顺序依次导入。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  CopyOutlined,
  DeleteOutlined,
  ImportOutlined,
  InboxOutlined,
  LoadingOutlined
} from '@ant-design/icons-vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { copyText } from '@/utils/ui'
import { parseImportContent, type ParsedImport } from '@/utils/transfer'
import { DEFAULT_SETTINGS, type BatchResult } from '@shared/types'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()

const importConcurrency = computed(
  () => settingsStore.settings.importConcurrency || DEFAULT_SETTINGS.importConcurrency
)

const MAX_VISIBLE_MESSAGES = 200

// ============ 文件 ============

interface Entry {
  /** 列表内唯一 key，同名文件也能各自删除 */
  uid: string
  name: string
  size: number
  parsed?: ParsedImport
  /** 读取或解析失败的原因；有值时该文件不参与导入 */
  error?: string
}

const entries = ref<Entry[]>([])
const fileImporting = ref(false)
/** 正在导入第几个文件（1 基），0 表示未开始 */
const currentIndex = ref(0)
const currentName = ref('')

/** 可导入的文件（排除解析失败的） */
const usable = computed(() => entries.value.filter((e) => !e.error && e.parsed))

/** 还在读取中的文件：此时不能开始导入，否则它们会被漏掉 */
const pendingCount = computed(
  () => entries.value.filter((e) => !e.error && !e.parsed).length
)

const fileTotal = computed(() => usable.value.reduce((sum, e) => sum + entryCount(e), 0))

/** 是否存在需要联网校验的凭证条目 */
const hasCredentialItems = computed(
  () =>
    usable.value.some((e) => !e.parsed?.fullData && (e.parsed?.items.length ?? 0) > 0) ||
    (!!parsedText.value && !parsedText.value.fullData && parsedText.value.items.length > 0)
)

function entryCount(entry: Entry): number {
  const parsed = entry.parsed
  if (!parsed) return 0
  return parsed.fullData ? (parsed.fullData.accounts?.length ?? 0) : parsed.items.length
}

function entryKind(entry: Entry): string {
  if (entry.error) return '无法解析'
  return entry.parsed?.fullData ? '完整备份' : '凭证条目'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * a-upload 的钩子：必须同步返回 false 才能稳定阻止它自己发起上传
 * （返回 Promise 会被当成 transformFile 的结果处理）。读文件在后台异步进行。
 * 多选时该钩子会对每个文件各调用一次，加入顺序即为后续导入顺序。
 */
function beforeUpload(file: File): boolean {
  void addFile(file)
  return false
}

async function addFile(file: File): Promise<void> {
  // 同名同大小视为重复选择，避免同一个文件被导入两次
  if (entries.value.some((e) => e.name === file.name && e.size === file.size)) {
    message.info(`${file.name} 已在列表中`)
    return
  }

  const entry: Entry = {
    uid: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    size: file.size
  }
  entries.value = [...entries.value, entry]

  try {
    // 去掉 BOM：带 BOM 的 JSON 会让 JSON.parse 直接抛错
    const text = (await file.text()).replace(/^\ufeff/, '')
    if (!text.trim()) throw new Error('文件内容为空')
    const parsed = parseImportContent(text)
    const count = parsed.fullData ? (parsed.fullData.accounts?.length ?? 0) : parsed.items.length
    if (count === 0) throw new Error('没有解析出有效凭证，请检查格式')
    update(entry.uid, { parsed })
  } catch (e) {
    update(entry.uid, { error: e instanceof Error ? e.message : String(e) })
  }
}

function update(uid: string, patch: Partial<Entry>): void {
  entries.value = entries.value.map((e) => (e.uid === uid ? { ...e, ...patch } : e))
}

function remove(uid: string): void {
  entries.value = entries.value.filter((e) => e.uid !== uid)
}

function clearFiles(): void {
  entries.value = []
}

// ============ JSON / 文本 ============

const text = ref('')

const placeholder = `把 JSON 或卡密粘贴到这里，也可以直接拖文件到上方：

1) 卡密：邮箱----密码----RefreshToken----ClientId----ClientSecret----登录方式
2) 精简 JSON 数组：[{ "email": "a@b.c", "refreshToken": "...", "provider": "BuilderId" }]
3) 本应用导出的完整 JSON（含用量、订阅快照）
4) CSV（带表头）/ TXT（邮箱,RefreshToken,昵称,登录方式）`

/**
 * 解析结果只算一次：预览与提交共用同一个 computed 缓存。
 * 粘贴几千行时，每次按键重新全量解析两遍的开销很可观。
 */
const parsedText = computed(() => (text.value.trim() ? parseImportContent(text.value) : null))

const textPreview = computed(() => {
  const data = parsedText.value
  if (!data) return null
  if (data.fullData) {
    return { kind: '完整备份', count: data.fullData.accounts?.length ?? 0 }
  }
  return { kind: '凭证条目', count: data.items.length }
})

const textCount = computed(() => textPreview.value?.count ?? 0)

/** 总数：文件条目 + 文本条目，用于按钮文案与空状态判断 */
const totalCount = computed(() => fileTotal.value + textCount.value)

const hasAnything = computed(() => usable.value.length > 0 || !!parsedText.value)

const importing = computed(() => fileImporting.value)

/** 只展示本次导入自身的校验进度，不显示后台批量刷新之类的其它任务 */
const validationProgress = computed(() => {
  const task = accountsStore.task
  if (!importing.value || !task.running || task.type !== 'import-validation') return null
  return `校验进度 ${task.done}/${task.total}`
})

// ============ 结果 ============

const result = ref<BatchResult | null>(null)
const resultMessages = computed(
  () => result.value?.messages.slice(0, MAX_VISIBLE_MESSAGES) ?? []
)
const resultHiddenCount = computed(() =>
  Math.max(0, (result.value?.messages.length ?? 0) - MAX_VISIBLE_MESSAGES)
)

/** 复制完整日志：界面只渲染前 200 条，但排查问题需要全部内容 */
function copyLog(): void {
  const lines = result.value?.messages ?? []
  if (!lines.length) return
  copyText(lines.join('\n'), `已复制 ${lines.length} 条日志`)
}

// ============ 提交 ============

/**
 * 按「文件 → 文本」的顺序导入。
 * 两者共用同一套解析结果与导入 action，只是来源不同，所以合并成一次提交，
 * 用户不必先想清楚这段内容该走哪条路。
 */
async function submit(): Promise<void> {
  if (pendingCount.value) return void message.warning('还有文件正在读取，请稍候')
  if (!hasAnything.value) return void message.warning('请先添加文件或粘贴内容')

  fileImporting.value = true
  const merged: BatchResult = { success: 0, failed: 0, skipped: 0, messages: [] }

  const absorb = (single: BatchResult, label: string): void => {
    merged.success += single.success
    merged.failed += single.failed
    merged.skipped += single.skipped
    merged.messages.push(
      `【${label}】成功 ${single.success}，跳过 ${single.skipped}，失败 ${single.failed}`,
      ...single.messages.map((line) => `  ${line}`)
    )
  }

  try {
    // 文件：按列表顺序逐个导入
    const list = usable.value
    for (let i = 0; i < list.length; i++) {
      const entry = list[i]
      currentIndex.value = i + 1
      currentName.value = entry.name

      const parsed = entry.parsed as ParsedImport
      if (parsed.fullData) {
        // 完整备份含用量与订阅快照，直接本地恢复，不逐个联网校验。
        // 恢复是同步的，先让出一帧把进度文案渲染出来，否则连续多个备份会看起来卡住。
        await nextTick()
        absorb(accountsStore.importFullData(parsed.fullData), entry.name)
      } else {
        absorb(await accountsStore.importItems(parsed.items), entry.name)
      }
    }

    // 文本：最后处理，失败也不影响已经导入的文件
    const data = parsedText.value
    if (data) {
      currentName.value = '粘贴的内容'
      currentIndex.value = list.length + 1
      await nextTick()
      if (data.fullData) {
        absorb(accountsStore.importFullData(data.fullData), '粘贴的内容')
      } else if (data.items.length) {
        absorb(await accountsStore.importItems(data.items), '粘贴的内容')
      }
    }

    result.value = merged
    const summary = `成功 ${merged.success}，跳过 ${merged.skipped}，失败 ${merged.failed}`
    if (merged.success) message.success(`导入完成：${summary}`)
    else message.warning(`没有成功导入的账号（${summary}）`)
    // 全部顺利才自动关闭；有失败时留下弹窗给用户看日志
    if (merged.success && !merged.failed) close()
  } finally {
    fileImporting.value = false
    currentIndex.value = 0
    currentName.value = ''
  }
}

function close(): void {
  emit('update:open', false)
}

/** 每次打开都清空上一次的内容与结果 */
watch(
  () => props.open,
  (open) => {
    if (!open) return
    entries.value = []
    text.value = ''
    result.value = null
    currentIndex.value = 0
    currentName.value = ''
  }
)
</script>

<template>
  <a-modal
    :open="props.open"
    width="720px"
    centered
    :footer="null"
    :mask-closable="!importing"
    :closable="!importing"
    @cancel="close"
  >
    <template #title>
      <span class="modal-title">
        <ImportOutlined />
        导入账号
        <a-tag v-if="totalCount" color="blue" style="margin: 0">
          共 {{ totalCount }} 条
        </a-tag>
      </span>
    </template>

    <div class="import-body">
      <!-- 文件：拖拽或点击选择 -->
      <a-upload-dragger
        class="tool-dragger"
        :multiple="true"
        :show-upload-list="false"
        accept=".json,.txt,.csv"
        :disabled="importing"
        :before-upload="beforeUpload"
      >
        <div class="drop-inner">
          <p class="drop-icon"><InboxOutlined /></p>
          <p class="drop-title">点击选择，或把文件拖到这里</p>
          <p class="drop-hint">可一次选择多个文件，按列表顺序依次导入</p>
        </div>
      </a-upload-dragger>

      <div v-if="entries.length" class="file-list">
        <div v-for="(entry, index) in entries" :key="entry.uid" class="file-row">
          <span class="file-index">{{ index + 1 }}</span>
          <div class="file-body">
            <div class="file-name">{{ entry.name }}</div>
            <div class="file-meta muted">
              <template v-if="entry.error">
                <span class="file-error">{{ entry.error }}</span>
              </template>
              <template v-else-if="entry.parsed">
                {{ entryKind(entry) }} · {{ entryCount(entry) }} 条 · {{ formatSize(entry.size) }}
              </template>
              <template v-else>
                <LoadingOutlined /> 正在读取…
              </template>
            </div>
          </div>
          <a-tag v-if="entry.error" color="red" style="margin: 0">跳过</a-tag>
          <a-button
            type="text"
            size="small"
            danger
            :disabled="importing"
            @click="remove(entry.uid)"
          >
            <template #icon><DeleteOutlined /></template>
          </a-button>
        </div>
        <a-button
          type="link"
          size="small"
          class="clear-files"
          :disabled="importing"
          @click="clearFiles"
        >
          清空文件列表
        </a-button>
      </div>

      <!-- 文本：直接粘贴 -->
      <div class="section-head">
        <span class="section-title">或直接粘贴 JSON / 卡密</span>
        <span v-if="textPreview" class="muted preview">
          识别为 {{ textPreview.kind }} · {{ textPreview.count }} 条
        </span>
      </div>

      <a-textarea
        v-model:value="text"
        :rows="8"
        :placeholder="placeholder"
        :disabled="importing"
      />

      <div v-if="hasCredentialItems" class="hint-line muted">
        凭证条目会在导入时联网校验并拉取用量，并发 {{ importConcurrency }}（可在设置里调整）
      </div>

      <a-alert
        v-if="importing"
        type="info"
        show-icon
        class="progress-alert"
        :message="`正在导入：${currentName}`"
        :description="validationProgress || undefined"
      />

      <template v-if="resultMessages.length">
        <a-divider style="margin: 14px 0 10px" />
        <div class="log-head">
          <span class="section-title">导入日志</span>
          <!-- 复制的是全部日志，不只是界面上截断显示的那 200 条 -->
          <a-button type="text" size="small" @click="copyLog">
            <template #icon><CopyOutlined /></template>
            复制全部
          </a-button>
        </div>
        <div class="token-box mono">
          <div v-for="(line, i) in resultMessages" :key="i">{{ line }}</div>
          <div v-if="resultHiddenCount" class="muted">
            … 另有 {{ resultHiddenCount }} 条未显示（避免一次渲染过多内容）
          </div>
        </div>
      </template>
    </div>

    <div class="modal-actions">
      <a-button :disabled="importing" @click="close">关闭</a-button>
      <a-button
        type="primary"
        :loading="importing || pendingCount > 0"
        :disabled="!hasAnything || pendingCount > 0"
        @click="submit"
      >
        <template #icon><ImportOutlined /></template>
        开始导入{{ totalCount ? `（${totalCount} 条）` : '' }}
      </a-button>
    </div>
  </a-modal>
</template>

<style scoped>
.modal-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.import-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/*
 * 拖拽区加高。ant 的 .ant-upload-wrapper 是 span 且没设 display，
 * dragger 的 height prop 只是往它上面写 inline height，对 inline 元素无效，
 * 所以高度只能由这里的 min-height 撑出来。
 */
.tool-dragger {
  display: block;
}

.tool-dragger :deep(.ant-upload-drag) {
  min-height: 150px;
}

/*
 * 垂直居中交给自己的包裹层：ant 内部是 table + table-cell 布局，
 * 一旦把 .ant-upload-btn 改成 flex，slot 里的元素会变成 flex item 横向排开。
 */
.drop-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 120px;
}

.drop-icon {
  margin: 0 0 8px;
  font-size: 40px;
  line-height: 1;
  color: var(--kal-primary);
}

.drop-title {
  margin: 0 0 4px;
  font-size: 14px;
}

.drop-hint {
  margin: 0;
  color: var(--kal-muted);
  font-size: 12px;
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 200px;
  overflow-y: auto;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--kal-block-bg);
}

.clear-files {
  align-self: flex-start;
  padding: 0;
}

.file-index {
  flex: 0 0 auto;
  width: 20px;
  text-align: center;
  color: var(--kal-muted);
  font-size: 12px;
}

.file-body {
  flex: 1 1 auto;
  min-width: 0;
}

.file-name {
  font-size: 13px;
  word-break: break-all;
}

.file-meta {
  margin-top: 1px;
  font-size: 12px;
}

.file-error {
  color: #cf1322;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
}

.section-title {
  font-size: 13px;
  font-weight: 500;
}

.preview {
  font-size: 12px;
}

.hint-line {
  font-size: 12px;
}

.progress-alert {
  margin: 0;
}

.log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.token-box {
  max-height: 160px;
  overflow: auto;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--kal-code-bg);
  font-size: 12px;
  line-height: 1.7;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.muted {
  color: var(--kal-muted);
}
</style>
