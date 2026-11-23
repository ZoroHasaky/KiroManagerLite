<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAccountsStore, type AccountTaskType } from '@/stores/accounts'

const route = useRoute()
const accountsStore = useAccountsStore()

const title = computed(() => (route.meta.title as string) || '主页')

const accountTaskLabels: Record<AccountTaskType, string> = {
  'import-validation': '批量导入校验中',
  'account-key-refresh': '正在刷新账户密钥',
  'account-usage-refresh': '正在刷新账户用量与积分'
}
const accountTaskLabel = computed(() => accountTaskLabels[accountsStore.task.type])
</script>

<template>
  <header class="app-titlebar">
    <strong>{{ title }}</strong>

    <div
      v-if="accountsStore.task.running"
      style="display: flex; align-items: center; gap: 8px"
    >
      <a-progress
        :percent="Math.round((accountsStore.task.done / Math.max(1, accountsStore.task.total)) * 100)"
        :show-info="false"
        size="small"
        style="width: 140px; margin: 0"
      />
      <span class="muted" style="font-size: 12px; white-space: nowrap">
        {{ accountTaskLabel }} {{ accountsStore.task.done }}/{{ accountsStore.task.total }}
      </span>
    </div>

    <span class="toolbar-spacer" />
  </header>
</template>
