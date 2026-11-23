<script setup lang="ts">
/**
 * 带范围选择的搜索框：左边选搜什么字段，右边输关键字。
 *
 * 默认是「智能搜索」—— 几个字段一起找，和改造前的搜索框行为一致；
 * 选了具体字段就只在那个字段里找，便于精确定位（比如只按备注筛）。
 * 字段选项由调用方给。
 */
import { computed } from 'vue'
import { SearchOutlined } from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'

export interface SearchScopeOption {
  value: string
  label: string
  /** 选中该范围时输入框的占位文案 */
  placeholder: string
}

const props = defineProps<{
  value: string
  scope: string
  /** 可选范围，第一项作为默认（智能搜索） */
  options: SearchScopeOption[]
}>()

const emit = defineEmits<{ 'update:value': [string]; 'update:scope': [string] }>()

const settingsStore = useSettingsStore()

const placeholder = computed(
  () => props.options.find((item) => item.value === props.scope)?.placeholder ?? '搜索'
)
</script>

<template>
  <!-- size 显式给：a-space-compact 会覆盖组内控件尺寸，见 settings 的 compactSize -->
  <a-space-compact :size="settingsStore.compactSize" class="search-group">
    <a-select
      :value="props.scope"
      :options="props.options"
      class="scope-select"
      @update:value="(v: string) => emit('update:scope', v)"
    />
    <a-input
      :value="props.value"
      allow-clear
      :placeholder="placeholder"
      class="search-input"
      @update:value="(v: string) => emit('update:value', v ?? '')"
    >
      <template #prefix><SearchOutlined /></template>
    </a-input>
  </a-space-compact>
</template>

<style scoped>
/* 整组占据原先搜索框的位置：范围选择定宽，剩下的宽度全给输入框 */
.search-group {
  display: flex;
  flex: 0 1 auto;
  width: 100%;
  max-width: 580px;
  min-width: 0;
}

.scope-select {
  flex: 0 0 auto;
  width: 112px;
}

.search-input {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
