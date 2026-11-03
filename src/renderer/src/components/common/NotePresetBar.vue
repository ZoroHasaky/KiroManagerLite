<script setup lang="ts">
/**
 * 常用备注条：设置备注弹窗里、输入框上方那一排短语。
 *
 * 点一条就把它填进输入框；右边「存为常用」收下输入框当前内容，方便边写边攒。
 * 常用备注存在设置里（settings.notePresets），账号与 API Key 共用同一份，
 * 所以这个组件直接读设置 store，调用方只需要把输入框的当前值传进来。
 */
import { computed } from 'vue'
import { message } from 'ant-design-vue'
import { PlusOutlined } from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import {
  NOTE_PRESET_MAX_COUNT,
  NOTE_PRESET_MAX_LENGTH,
  normalizeNotePresets,
  pickPresetCandidate
} from '@shared/notePresets'

const props = defineProps<{
  /** 输入框里当前的文本：决定「存为常用」存什么，也用来判断是否已经存在 */
  value: string
}>()

const emit = defineEmits<{ pick: [text: string] }>()

const settingsStore = useSettingsStore()

const presets = computed(() => normalizeNotePresets(settingsStore.settings.notePresets))

/** 待存的文本：只取最后一行，和落盘时同一套规整，判断重复才准 */
const draft = computed(() => pickPresetCandidate(props.value))

async function save(): Promise<void> {
  if (!draft.value) return void message.info('输入框还是空的，先写点内容再存为常用')
  if (draft.value.length > NOTE_PRESET_MAX_LENGTH) {
    return void message.warning(`常用备注最多 ${NOTE_PRESET_MAX_LENGTH} 个字，再精简一下`)
  }
  if (presets.value.includes(draft.value)) return void message.info('这条已经在常用备注里了')
  if (presets.value.length >= NOTE_PRESET_MAX_COUNT) {
    return void message.warning(`常用备注最多 ${NOTE_PRESET_MAX_COUNT} 条，先删掉几条再添加`)
  }
  await settingsStore.update({ notePresets: [...presets.value, draft.value] })
  // 多行备注只会存最后一行，说清楚存了哪条，免得用户以为整段都进去了
  message.success(`已存为常用备注：${draft.value}`)
}

async function remove(text: string): Promise<void> {
  await settingsStore.update({ notePresets: presets.value.filter((item) => item !== text) })
}
</script>

<template>
  <div class="preset-bar">
    <span class="preset-label">常用备注</span>
    <div class="preset-list">
      <!--
        点击事件挂在外层 span 而不是 a-tag 上：a-tag 一旦带 onClick 就会自动套上
        Wave（antd 的点击涟漪），在这里表现为一个扩散到输入框上的浅色方框。
        删除用的 × 由 a-tag 自己处理，它会 stopPropagation，不会顺带填充。
      -->
      <span
        v-for="text in presets"
        :key="text"
        class="preset-item"
        :title="`点击填入：${text}`"
        @click="emit('pick', text)"
      >
        <a-tag :bordered="false" closable class="preset-tag" @close="remove(text)">
          {{ text }}
        </a-tag>
      </span>
      <a-button
        type="dashed"
        size="small"
        class="preset-add"
        title="把输入框最后一行存为常用备注"
        @click="save"
      >
        <template #icon><PlusOutlined /></template>
        存为常用
      </a-button>
      <!-- 一条都没有时，「存为常用」是唯一入口，给一句说明免得看不出这是干什么的 -->
      <span v-if="!presets.length" class="preset-empty">把输入框的内容存成常用，下次点一下就填进来</span>
    </div>
  </div>
</template>

<style scoped>
.preset-bar {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 12px;
}

.preset-label {
  flex: 0 0 auto;
  padding-top: 3px;
  color: var(--kal-muted);
  font-size: 12px;
  line-height: 20px;
}

/* 常用条数多了只在条内滚动，不把弹窗越撑越高 */
.preset-list {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 68px;
  min-width: 0;
  overflow-y: auto;
}

.preset-item {
  max-width: 100%;
  cursor: pointer;
}

/* a-tag 默认 nowrap：一条长短语会顶出弹窗，允许在条内折行 */
.preset-tag {
  max-width: 100%;
  margin: 0;
  white-space: normal;
  word-break: break-word;
  user-select: none;
}

.preset-add {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
}

.preset-empty {
  color: var(--kal-muted);
  font-size: 12px;
  line-height: 24px;
}
</style>
