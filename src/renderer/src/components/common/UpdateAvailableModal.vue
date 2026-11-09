<script setup lang="ts">
import { computed } from 'vue'
import { message } from 'ant-design-vue'
import { RocketFilled } from '@ant-design/icons-vue'
import { useUpdateStore } from '@/stores/update'
import { formatDate } from '@/utils/format'
import { handleMarkdownClick, renderMarkdown } from '@/utils/markdown'

const updateStore = useUpdateStore()
const update = computed(() => updateStore.result)
const notesHtml = computed(() => renderMarkdown(update.value?.notes ?? ''))

const packAvailable = computed(() => updateStore.packAvailable)
const downloading = computed(() => updateStore.downloading)
const installing = computed(() => updateStore.installing)
const packReady = computed(() => updateStore.packReady)
const packPhase = computed(() => updateStore.packPhase)
const packProgress = computed(() => updateStore.packProgress)
const packError = computed(() => updateStore.packError)

/** 有热更包时直接在这里下载；没有就退回 Releases 页 */
async function startPackUpdate(): Promise<void> {
  const res = await updateStore.downloadAndInstall()
  if (!res.ok) message.error(res.error || '更新失败')
}

async function relaunchNow(): Promise<void> {
  const res = await updateStore.relaunch()
  if (!res.ok) message.error(res.error || '重启失败')
}

function goUpdate(): void {
  const url = update.value?.releaseUrl
  if (url) void window.api.openExternal(url)
  updateStore.closeModal()
}
</script>

<template>
  <a-modal
    :open="updateStore.modalOpen"
    title="发现新版本"
    :width="500"
    centered
    @cancel="updateStore.closeModal"
  >
    <div class="check-result">
      <RocketFilled class="check-icon" />
      <div class="check-title">有新版本可以更新</div>
      <div class="version-flow">
        <span class="version-chip">v{{ update?.current }}</span>
        <span class="muted">→</span>
        <span class="version-chip new">v{{ update?.latest }}</span>
      </div>
      <div v-if="update?.publishedAt" class="muted release-time">
        发布于 {{ formatDate(update.publishedAt) }}
      </div>
    </div>
    <div v-if="notesHtml" class="release-notes">
      <div class="release-notes-title muted">更新说明</div>
      <div class="release-notes-body markdown" v-html="notesHtml" @click="handleMarkdownClick" />
    </div>
    <div v-if="packAvailable" class="pack-box">
      <div class="muted pack-tip">
        可直接下载热更新包，完成后重启即可生效，无需重新安装。
      </div>
      <a-progress
        v-if="packPhase === 'downloading' || packPhase === 'installing'"
        :percent="packPhase === 'installing' ? 100 : packProgress"
        :status="packPhase === 'installing' ? 'active' : 'normal'"
        size="small"
      />
      <div v-if="packPhase === 'failed'" class="pack-error">{{ packError }}</div>
      <div v-if="packReady" class="pack-ready">
        <a-button type="primary" size="small" @click="relaunchNow">
          重启并更新到 v{{ updateStore.packVersion }}
        </a-button>
        <a-button size="small" @click="updateStore.closeModal">稍后重启</a-button>
      </div>
    </div>
    <template #footer>
      <a-button @click="updateStore.closeModal">稍后再说</a-button>
      <a-button @click="goUpdate">下载完整安装包</a-button>
      <a-button
        v-if="packAvailable && !packReady"
        type="primary"
        :loading="downloading || installing"
        @click="startPackUpdate"
      >
        {{ installing ? '正在安装…' : downloading ? `下载中 ${packProgress}%` : '下载并更新' }}
      </a-button>
    </template>
  </a-modal>
</template>


<style scoped>
.check-result { text-align: center; padding: 8px 0 4px; }
.check-icon { color: var(--kal-primary); font-size: 40px; }
.check-title { margin: 10px 0 6px; font-size: 16px; font-weight: 600; }
.version-flow { display: flex; align-items: center; justify-content: center; gap: 10px; }
.version-chip { padding: 2px 10px; border-radius: 6px; background: var(--kal-block-bg); font-size: 13px; }
.version-chip.new { color: #fff; background: var(--kal-primary); }
.release-time { margin-top: 8px; font-size: 12px; }
.release-notes { margin-top: 16px; padding: 12px; border-radius: 8px; background: var(--kal-block-bg); }
.release-notes-title { margin-bottom: 6px; font-size: 12px; }
.release-notes-body { max-height: 280px; overflow: auto; font-size: 13px; line-height: 1.75; word-break: break-word; }
.markdown :deep(> *:first-child) { margin-top: 0; }
.markdown :deep(> *:last-child) { margin-bottom: 0; }
.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4) { margin: 14px 0 6px; font-size: 14px; font-weight: 600; line-height: 1.5; }
.markdown :deep(h1) { font-size: 16px; }
.markdown :deep(h2) { font-size: 15px; }
.markdown :deep(p) { margin: 0 0 8px; }
.markdown :deep(ul),
.markdown :deep(ol) { margin: 0 0 8px; padding-left: 20px; }
.markdown :deep(li) { margin: 2px 0; }
.markdown :deep(li > p) { margin: 0; }
.markdown :deep(a) { color: var(--kal-primary); }
.markdown :deep(code) { padding: 1px 4px; border-radius: 4px; background: var(--kal-code-bg); }

.pack-box { margin-top: 14px; padding: 12px; border-radius: 8px; background: var(--kal-block-bg); }
.pack-tip { font-size: 12px; line-height: 1.7; }
.pack-error { margin-top: 8px; font-size: 12px; line-height: 1.7; color: #ff4d4f; overflow-wrap: anywhere; }
.pack-ready { display: flex; gap: 8px; margin-top: 10px; }
</style>