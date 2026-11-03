<script setup lang="ts">
/**
 * 自动化支付弹窗。
 *
 * 用途：账号卡在「待支付」时，不用手动复制链接去浏览器付款——
 * 这里选省份、填卡，点「打开并填充」就会拉起本机 Chrome，
 * 自动把账单地址和卡信息填进 Stripe 结算页。
 *
 * 分工：
 *  - 地址由主进程生成（省市区邮编真实对应），这里只负责展示与「换一条」；
 *  - 真正的填表在外部浏览器里完成，本弹窗只显示进度；
 *  - 付款按钮和 3DS 验证一律留给用户手动确认，不自动点。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import {
  CopyOutlined,
  CreditCardOutlined,
  QrcodeOutlined,
  ReloadOutlined,
  SyncOutlined
} from '@ant-design/icons-vue'
import { maskCardInfo, parseCardInfos } from '@/utils/cardParse'
import { useAccountsStore } from '@/stores/accounts'
import { copyText } from '@/utils/ui'
import { errorMessage } from '@shared/errors'
import { toPlain } from '@/utils/ipc'
import PaymentQrModal from '@/components/accounts/PaymentQrModal.vue'
import type { Account, PaymentAddress, PaymentPhase, PaymentUpdate } from '@shared/types'

const props = defineProps<{ account: Account }>()
const emit = defineEmits<{ close: [] }>()

const accountsStore = useAccountsStore()

const provinces = ref<string[]>([])
/**
 * 省份：每次打开弹窗都重新随机一个。
 * 不记忆上次的选择——连续处理多个账号时，省市区全部换一套更符合分散要求。
 */
const province = ref('')
const address = ref<PaymentAddress | null>(null)
const addressLoading = ref(false)

/** 卡信息粘贴框；解析出多张时按顺序轮换 */
const cardText = ref('')
const cards = computed(() => parseCardInfos(cardText.value))
const cardIndex = ref(0)
const card = computed(() => cards.value[cardIndex.value] ?? null)
const cardPreview = computed(() => (card.value ? maskCardInfo(card.value) : ''))

/** 打开 / 填充进度 */
const phase = ref<PaymentPhase | 'idle'>('idle')
const phaseDetail = ref('')
const opening = ref(false)
const browserName = ref('')

const paymentLink = computed(() => props.account.paymentLink || '')

/** 阶段文案 */
const phaseText = computed(() => {
  switch (phase.value) {
    case 'idle':
      return '等待打开支付窗口'
    case 'opening':
      return '正在启动浏览器…'
    case 'page-loading':
      return '正在等待 Stripe 结算页渲染…'
    case 'filling':
      return '正在自动填写账单地址与卡信息…'
    case 'filled':
      return '已填写完成，请在浏览器里确认并付款'
    case 'success':
      return '支付成功'
    case 'expired':
      return '结算链接已过期'
    case 'closed':
      return '支付窗口已关闭'
    case 'error':
      return '自动填充失败'
    default:
      return ''
  }
})

/**
 * 进行中：只让「启动浏览器」和「正在填表」这两个阶段转圈。
 * 「等待页面」不转圈——它可能持续几十秒，一直转会让人以为卡死了；
 * 此时用户可以自己关掉浏览器重来。
 */
const busy = computed(
  () => opening.value || phase.value === 'opening' || phase.value === 'filling'
)

const canOpen = computed(() => !!paymentLink.value && !busy.value)

/** 是否有一个还开着的支付窗口，决定要不要显示「关闭支付窗口」 */
const sessionActive = computed(
  () =>
    phase.value === 'page-loading' ||
    phase.value === 'filling' ||
    phase.value === 'filled'
)

let unsubscribe: (() => void) | null = null

onMounted(async () => {
  unsubscribe = window.api.onPaymentUpdate((update: PaymentUpdate) => {
    // 只处理本账号的进度：同一时刻只可能有一个会话，但旧会话的收尾消息会晚到
    if (update.accountId !== props.account.id) return
    phase.value = update.phase
    phaseDetail.value = update.detail || ''
    if (update.phase === 'filled') {
      // 已经填好，后面交给用户自己操作；把卡号往后轮换，方便连续处理下一个账号
      if (cards.value.length > 1) cardIndex.value = (cardIndex.value + 1) % cards.value.length
      message.success('已自动填写，请到浏览器里确认并付款')
    } else if (update.phase === 'success') {
      message.success('支付成功，正在刷新账号…')
      // 付完款订阅档位才会由接口带回来，阶段随之从「待支付」变成「已订阅」
      void accountsStore.checkStatus(props.account.id)
    } else if (update.phase === 'expired') {
      message.warning(update.detail || '结算链接已过期，请重新生成')
    } else if (update.phase === 'error') {
      message.error(update.detail || '自动填充失败')
    }
    // page-loading 带 detail 时是「仍在等待」的说明，不再弹提示打扰用户
  })

  const res = await window.api.getPaymentProvinces()
  if (res.success && res.data) provinces.value = res.data

  // 每次打开都重新随机一个省份，地址也跟着重新生成
  if (provinces.value.length) {
    province.value = provinces.value[Math.floor(Math.random() * provinces.value.length)]
  }

  await refreshAddress()
})

onBeforeUnmount(() => {
  unsubscribe?.()
})

/** 换一条地址：按当前选中的省份重新随机 */
async function refreshAddress(): Promise<void> {
  addressLoading.value = true
  try {
    const res = await window.api.generatePaymentAddress(province.value || undefined)
    if (res.success && res.data) address.value = res.data
    else message.error(res.error || '生成账单地址失败')
  } catch (e) {
    message.error(errorMessage(e))
  } finally {
    addressLoading.value = false
  }
}

/** 省份切换：立刻换一条该省的地址。选择只在本次弹窗内有效，关掉即弃 */
function onProvinceChange(): void {
  void refreshAddress()
}

/** 卡号轮换：粘贴了多张卡时手动切换当前这张 */
function nextCard(): void {
  if (cards.value.length <= 1) return
  cardIndex.value = (cardIndex.value + 1) % cards.value.length
}

/** 打开浏览器并开始自动填充 */
async function openAndFill(): Promise<void> {
  if (!paymentLink.value) {
    message.error('该账号还没有支付链接，请先在订阅管理里生成')
    return
  }
  if (!address.value) {
    message.error('账单地址还没生成好，请稍等或点「换一条」')
    return
  }

  opening.value = true
  phase.value = 'opening'
  phaseDetail.value = ''
  try {
    const res = await window.api.openPayment(
      toPlain({
        accountId: props.account.id,
        url: paymentLink.value,
        address: address.value,
        card: card.value ?? undefined
      })
    )
    if (!res.success || !res.data) {
      phase.value = 'error'
      phaseDetail.value = res.error || '打开支付窗口失败'
      message.error(phaseDetail.value)
      return
    }
    browserName.value = res.data.browser
  } catch (e) {
    phase.value = 'error'
    phaseDetail.value = errorMessage(e)
    message.error(phaseDetail.value)
  } finally {
    opening.value = false
  }
}

/** 主动关掉支付窗口。关弹窗不会顺手关浏览器——用户可能正在里面付款 */
async function closePayment(): Promise<void> {
  await window.api.closePayment()
  phase.value = 'closed'
  phaseDetail.value = '已关闭支付窗口'
}

function onCancel(): void {
  emit('close')
}

/** 点邮箱复制，方便和浏览器里登录的账号核对 */
function copyEmail(): void {
  copyText(props.account.email, '邮箱已复制')
}

/** 复制支付链接：想自己拿去别处打开时用 */
function copyPaymentLink(): void {
  if (!paymentLink.value) return
  copyText(paymentLink.value, '支付链接已复制')
}

/** 二维码弹窗：把同一个支付链接画成二维码，方便用手机扫着付 */
const qrOpen = ref(false)

function showQr(): void {
  if (!paymentLink.value) return
  qrOpen.value = true
}
</script>

<template>
  <a-modal
    :open="true"
    centered
    width="560px"
    :footer="null"
    :mask-closable="false"
    @cancel="onCancel"
  >
    <template #title>
      <span class="modal-title">
        <CreditCardOutlined />
        自动化支付
      </span>
    </template>

    <div class="pay-body">
      <!-- 账号邮箱单独一行，比标题小一号；点击复制，方便对照浏览器里登录的账号 -->
      <a-tooltip :title="`点击复制 ${props.account.email}`">
        <span class="account-email" @click="copyEmail">{{ props.account.email }}</span>
      </a-tooltip>

      <p class="tip muted">
        打开 Stripe 结算页并自动填写账单信息。
        浏览器使用系统安装的 Chrome（跟随系统代理），付款与 3DS 验证请手动完成。
      </p>

      <!-- 支付链接缺失：直接告诉用户去哪儿生成，而不是让按钮点了没反应 -->
      <a-alert
        v-if="!paymentLink"
        type="warning"
        show-icon
        message="该账号还没有支付链接"
        description="请先在账号卡片的订阅标签里生成结算链接，再回到这里付款。"
      />

      <template v-else>
        <!-- 省份 -->
        <div class="field-row">
          <span class="field-label">账单省份</span>
          <a-select
            v-model:value="province"
            class="field-control"
            :options="[{ value: '', label: '随机' }, ...provinces.map((p) => ({ value: p, label: p }))]"
            @change="onProvinceChange"
          />
        </div>

        <!-- 地址预览：和实际填进页面的是同一份数据，所见即所填 -->
        <div class="field-row align-start">
          <span class="field-label">账单地址</span>
          <div class="field-control address-box">
            <div class="address-head">
              <span class="muted">自动生成，可直接用于 Stripe 表单</span>
              <a-button size="small" type="link" :loading="addressLoading" @click="refreshAddress">
                <template #icon><ReloadOutlined /></template>
                换一条
              </a-button>
            </div>
            <pre v-if="address" class="address-text">{{ address.name }}
{{ address.zip }}
{{ address.city }}
{{ address.district }}
{{ address.street }}
{{ address.provinceZh }}</pre>
            <span v-else class="muted">正在生成…</span>
          </div>
        </div>

        <!-- 卡信息 -->
        <div class="field-row align-start">
          <span class="field-label">卡信息</span>
          <div class="field-control">
            <a-textarea
              v-model:value="cardText"
              :rows="3"
              placeholder="粘贴卡信息，每行一项：&#10;4234 1234 1234 9562&#10;09/34（或 0934）&#10;123"
              allow-clear
            />
            <div class="card-foot">
              <span v-if="cardPreview" class="card-preview">{{ cardPreview }}</span>
              <span v-else class="muted">未识别到完整卡信息，只填地址</span>
              <a-button
                v-if="cards.length > 1"
                size="small"
                type="link"
                @click="nextCard"
              >
                第 {{ cardIndex + 1 }}/{{ cards.length }} 张 · 切换
              </a-button>
            </div>
          </div>
        </div>

        <!-- 进度 -->
        <div class="phase-box" :class="`phase-${phase}`">
          <SyncOutlined v-if="busy" spin />
          <span class="phase-text">{{ phaseText }}</span>
          <span v-if="browserName" class="phase-browser muted">（{{ browserName }}）</span>
          <p v-if="phaseDetail" class="phase-detail">{{ phaseDetail }}</p>
        </div>
      </template>
    </div>

    <div class="modal-actions">
      <a-button v-if="paymentLink" @click="copyPaymentLink">
        <template #icon><CopyOutlined /></template>
        复制链接
      </a-button>
      <a-button v-if="paymentLink" @click="showQr">
        <template #icon><QrcodeOutlined /></template>
        显示二维码
      </a-button>
      <a-button
        v-if="sessionActive"
        danger
        @click="closePayment"
      >
        关闭支付窗口
      </a-button>
      <a-button
        type="primary"
        :disabled="!canOpen"
        :loading="busy"
        @click="openAndFill"
      >
        打开并填充
      </a-button>
    </div>

    <!-- 二维码叠在本弹窗之上；关闭二维码不影响支付窗口与填充进度 -->
    <PaymentQrModal
      v-if="qrOpen"
      :url="paymentLink"
      :title="`支付链接二维码 - ${props.account.email}`"
      @close="qrOpen = false"
    />
  </a-modal>
</template>

<style scoped>
.modal-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.pay-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 邮箱：比标题小一号，点击复制 */
.account-email {
  align-self: flex-start;
  max-width: 100%;
  overflow: hidden;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.15s;
}

.account-email:hover {
  color: var(--kal-primary);
}

.tip {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
}

/* 左侧固定标签宽度，右侧控件占满，多个字段才能对齐成一条竖线 */
.field-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.field-row.align-start {
  align-items: flex-start;
}

.field-label {
  flex: 0 0 auto;
  width: 64px;
  font-size: 13px;
  color: var(--kal-muted);
}

.field-control {
  flex: 1 1 auto;
  min-width: 0;
}

.address-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--kal-border);
  border-radius: 8px;
  background: var(--kal-card-bg);
}

.address-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.address-text {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
  font-size: 12px;
}

.card-preview {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

/* 进度条：不同阶段用不同底色，扫一眼就知道走到哪一步 */
.phase-box {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--kal-border);
  border-radius: 8px;
  font-size: 13px;
  background: var(--kal-card-bg);
}

.phase-filled,
.phase-success {
  border-color: #52c41a;
  color: #389e0d;
}

.phase-error,
.phase-expired {
  border-color: #ff4d4f;
  color: #cf1322;
}

.phase-detail {
  flex: 1 0 100%;
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--kal-muted);
  word-break: break-word;
}

.phase-browser {
  font-size: 12px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
</style>
