<script setup lang="ts">
/**
 * 支付链接二维码。
 *
 * 用手机扫一下就把它带到手机上继续付款（比如卡在手机银行 App 里验证 3DS）。
 *
 * 二维码在本地生成：支付链接本身就是凭证，不能为了出图把它发给任何在线二维码服务。
 * 生成失败时只提示，不影响上层弹窗——链接仍可复制后自行处理。
 */
import { onMounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { CopyOutlined, DownloadOutlined } from '@ant-design/icons-vue'
import QRCode from 'qrcode'
import { copyText } from '@/utils/ui'
import { errorMessage } from '@shared/errors'

const props = defineProps<{ url: string; title?: string }>()
const emit = defineEmits<{ close: [] }>()

/** 二维码图片的 data URL，由 qrcode 库在本地绘制 */
const dataUrl = ref('')
const generating = ref(false)
const error = ref('')

/**
 * 生成参数。
 *
 * 尺寸按真实数据算过：Stripe 结算链接约 500 字符，二维码会到版本 17（85×85 模块）。
 * 320px 时每模块只剩 3.4px，手机在中距离下容易扫不出来；400px 给到 4.3px，
 * 是「弹窗还能放下」与「扫得动」之间的折中。
 *
 * 边距取 4 个模块（二维码标准要求的最小静区）：太低会让手机的取景框切掉定位角。
 */
const QR_WIDTH = 400
const QR_MARGIN = 4

async function render(): Promise<void> {
  if (!props.url) {
    error.value = '没有可用的支付链接'
    return
  }
  generating.value = true
  error.value = ''
  try {
    dataUrl.value = await QRCode.toDataURL(props.url, {
      width: QR_WIDTH,
      margin: QR_MARGIN,
      // 纠错等级 M：Stripe 链接接近版本 20 的容量边界，L 更省空间但容错差，
      // Q/H 会让版本再涨一截、模块更密。M 是这类长链接的平衡点。
      errorCorrectionLevel: 'M',
      // 深灰而非纯黑：更接近界面配色，对比度仍然足够扫描
      color: { dark: '#141414', light: '#ffffff' }
    })
  } catch (cause) {
    // 链接超出二维码容量（版本 40 也放不下）时会走到这里，提示改用复制链接
    error.value = errorMessage(cause)
    message.error('生成二维码失败，可改用「复制链接」')
  } finally {
    generating.value = false
  }
}

onMounted(render)

// 链接变了（例如上层重新生成了支付链接）就重画，避免显示旧码
watch(() => props.url, render)

/** 另存为 PNG：方便存到相册或发给别人 */
function download(): void {
  if (!dataUrl.value) return
  const link = document.createElement('a')
  link.href = dataUrl.value
  link.download = `payment-qr-${Date.now()}.png`
  link.click()
}
</script>

<template>
  <a-modal
    :open="true"
    :title="props.title ?? '支付链接二维码'"
    centered
    :width="480"
    :footer="null"
    @cancel="emit('close')"
  >
    <div class="qr-body">
      <div class="qr-frame">
        <a-spin v-if="generating" />
        <img v-else-if="dataUrl" :src="dataUrl" class="qr-image" alt="支付链接二维码" />
        <span v-else class="muted">{{ error || '暂无可显示的二维码' }}</span>
      </div>

      <p class="qr-tip muted">用手机扫码即可在手机上继续付款</p>

      <!-- 链接本身也放出来：扫不出来时可以直接照着输，或者复制到别处 -->
      <div class="qr-link mono" :title="props.url">{{ props.url }}</div>

      <div class="qr-actions">
        <a-button :disabled="!props.url" @click="copyText(props.url, '支付链接已复制')">
          <template #icon><CopyOutlined /></template>
          复制链接
        </a-button>
        <a-button type="primary" :disabled="!dataUrl" @click="download">
          <template #icon><DownloadOutlined /></template>
          保存图片
        </a-button>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.qr-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

/* 白底固定：深色主题下二维码若跟随底色反色，很多扫码器认不出 */
.qr-frame {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 400px;
  height: 400px;
  max-width: 100%;
  border: 1px solid var(--kal-border);
  border-radius: 12px;
  background: #ffffff;
}

.qr-image {
  width: 100%;
  height: 100%;
  border-radius: 12px;
}

.qr-tip {
  margin: 0;
  font-size: 12px;
}

/* 链接可能很长：单行省略，完整内容靠 title 与「复制链接」 */
.qr-link {
  width: 100%;
  overflow: hidden;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--kal-code-bg);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qr-actions {
  display: flex;
  gap: 10px;
}
</style>
