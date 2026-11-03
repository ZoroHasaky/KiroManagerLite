<script setup lang="ts">
/**
 * 批量设置备注：覆盖式改写所选条目的备注，留空即清空。
 *
 * 账号列表与 API Key 列表共用这一份。落盘方式两边不同（一个同步写、一个走 IPC），
 * 所以这里只负责收集输入并 emit，具体怎么存、提示什么由调用方决定。
 */
import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import NotePresetBar from '@/components/common/NotePresetBar.vue'
import { appendNotePreset } from '@shared/notePresets'

const props = defineProps<{
  ids: string[]
  /** 条目名称，用于文案：账号 / Key */
  entity: string
  /** 输入框占位示例 */
  placeholder?: string
  /** 调用方正在保存 */
  saving?: boolean
  /** 预填的备注：只改一个条目（右键「设置备注」）时带上它当前的备注 */
  initial?: string
}>()

const emit = defineEmits<{ submit: [note: string]; close: [] }>()

const note = ref(props.initial ?? '')
const single = computed(() => props.ids.length === 1)

/** 点常用备注：追加到已有文本后面，见 appendNotePreset 的说明 */
function applyPreset(text: string): void {
  note.value = appendNotePreset(note.value, text)
}

function submit(): void {
  if (!props.ids.length) return void message.info(`没有选中的${props.entity}`)
  emit('submit', note.value)
}
</script>

<template>
  <a-modal
    :open="true"
    :title="single ? '设置备注' : '批量设置备注'"
    centered
    width="520px"
    ok-text="保存"
    cancel-text="取消"
    :confirm-loading="props.saving"
    @ok="submit"
    @cancel="emit('close')"
  >
    <p class="muted tip">
      <template v-if="single">留空则清空该{{ props.entity }}的备注。</template>
      <template v-else>
        将覆盖所选 {{ props.ids.length }} 个{{ props.entity }}的备注；留空则清空这些{{
          props.entity
        }}的备注。
      </template>
    </p>
    <NotePresetBar :value="note" @pick="applyPreset" />
    <a-textarea
      v-model:value="note"
      :rows="3"
      :placeholder="props.placeholder ?? '例如：主力号 / 待观察 / 某渠道'"
      allow-clear
      @press-enter="submit"
    />
  </a-modal>
</template>

<style scoped>
.tip {
  margin: 0 0 12px;
  font-size: 12px;
}

.muted {
  color: var(--kal-muted);
}
</style>
