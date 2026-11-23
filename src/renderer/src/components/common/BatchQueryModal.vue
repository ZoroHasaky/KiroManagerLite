<script setup lang="ts">
/**
 * 批量查询：搜索框一次只能查一个关键字，这里一行一个、一次查多个。
 * 每个关键字按搜索字段模糊匹配，命中任意一个就显示（关键字之间是「或」）。
 * 查询结果和上方的搜索、状态、分组等筛选同时生效。
 */
import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import { SnippetsOutlined } from '@ant-design/icons-vue'
import { BATCH_QUERY_LIMIT, parseBatchQuery } from '@/utils/batchQuery'

const props = defineProps<{
  /** 参与匹配的字段，写进说明里，如「邮箱、昵称、备注」 */
  fields: string
  /** 再次打开时带上当前正在查的值，方便在原基础上增删 */
  initial: string[]
  placeholder?: string
}>()

const emit = defineEmits<{ submit: [values: string[]]; close: [] }>()

const text = ref(props.initial.join('\n'))
const parsed = computed(() => parseBatchQuery(text.value))

async function paste(): Promise<void> {
  const res = await window.api.readClipboard()
  if (!res.success) return void message.error(res.error || '读取剪贴板失败')
  const content = (res.data ?? '').trim()
  if (!content) return void message.info('剪贴板是空的')
  // 已有内容时追加到末尾，不覆盖用户已经填好的
  text.value = text.value.trim() ? `${text.value.trimEnd()}\n${content}` : content
}

function submit(): void {
  if (!parsed.value.values.length) return
  if (parsed.value.overflow) {
    message.warning(`超出 ${BATCH_QUERY_LIMIT} 个上限，后面的 ${parsed.value.overflow} 个未参与查询`)
  }
  emit('submit', parsed.value.values)
}
</script>

<template>
  <a-modal :open="true" title="批量查询" centered width="560px" @cancel="emit('close')">
    <p class="muted tip">
      一行一个关键字，在{{ props.fields }}里模糊匹配（包含即可、不区分大小写），
      命中任意一行就会显示。整行就是一个关键字，行内的空格、逗号等都算关键字的一部分。
      一次最多 {{ BATCH_QUERY_LIMIT }} 个，会和上方的搜索、状态、筛选条件一起生效。
    </p>
    <a-textarea
      v-model:value="text"
      class="query-input"
      :rows="10"
      :placeholder="props.placeholder ?? 'a@gmail.com\n备注里的关键字'"
    />
    <p class="muted count">
      已识别 <b>{{ parsed.values.length }}</b> 个关键字（空行已忽略、重复已合并）
      <span v-if="parsed.overflow" class="overflow">，超出上限 {{ parsed.overflow }} 个</span>
    </p>

    <template #footer>
      <div class="query-footer">
        <a-button @click="paste">
          <template #icon><SnippetsOutlined /></template>
          粘贴
        </a-button>
        <span class="spacer" />
        <a-button @click="emit('close')">取消</a-button>
        <a-button type="primary" :disabled="!parsed.values.length" @click="submit">
          查询 {{ parsed.values.length }} 个
        </a-button>
      </div>
    </template>
  </a-modal>
</template>

<style scoped>
.tip {
  margin: 0 0 12px;
  line-height: 1.7;
}

.query-input :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.count {
  margin: 10px 0 0;
}

.overflow {
  color: var(--ant-color-warning, #faad14);
}

.query-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.spacer {
  flex: 1;
}
</style>
