<script setup lang="ts">
/**
 * 实时价格：Kiro 新号首订价按 UTC 自然月实时折算。
 *
 * 首订券与原月费一起按比例折算，实付整体线性下降（例：Pro+ 剩余 84.87% 时为 $16.97）：
 *   折算价   = round2(原月费 × 当月剩余比例)
 *   首订实付 = round2(max(0, 原月费 − $20 首订券) × 当月剩余比例)
 *   ratio    = 当月剩余秒数 / 全月秒数，按 UTC 自然月计算并 clamp 到 0–1
 *
 * 订阅积分同样线性折算，但新号 500 赠送积分是固定额度，不参与折算：
 *   当月积分 = round(全额积分 × 剩余比例) + 500
 *
 * 原月费高于券的档位只在月末才到 $0，不存在月中的免单点。
 *
 * 页面默认按当前时间实时计算；拖动时间滑块可预览本月内任意节点（每天 10/14/18/22 点），
 * 四张套餐卡片与基准信息一起跟随选中时刻重算。
 *
 * 纯前端本地计算，不依赖主进程与网络：所有数字都来自本机时钟。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  CalendarOutlined,
  ClockCircleOutlined,
  FieldTimeOutlined,
  MoneyCollectOutlined
} from '@ant-design/icons-vue'

/** 美元 → 人民币参考汇率（固定值，与参考实现同一口径，不随行情自动更新） */
const USD_TO_CNY = 6.9726
/** Kiro 新号首订优惠券面额（美元） */
const FIRST_SUB_COUPON_USD = 20
/** 开会员额外赠送的固定积分，不随时间折算 */
const SIGNUP_BONUS_CREDITS = 500

interface KiroPlan {
  key: string
  name: string
  /** 原月费（美元） */
  price: number
  /** 全额 Credits 配额（整月），用于线性折算 */
  credits: number
}

const PLANS: KiroPlan[] = [
  { key: 'pro', name: 'Kiro Pro', price: 20, credits: 1000 },
  { key: 'pro_plus', name: 'Kiro Pro+', price: 40, credits: 2000 },
  { key: 'pro_max', name: 'Kiro Pro Max', price: 100, credits: 5000 },
  { key: 'power', name: 'Kiro Power', price: 200, credits: 10000 }
]

// ============ 计算（纯函数） ============

/** UTC 自然月窗口：本月 1 号 00:00 → 下月 1 号 00:00 */
interface MonthWindow {
  startUtc: number
  endUtc: number
  /** 全月总秒数 */
  totalSec: number
}

function getMonthWindow(utcMs: number): MonthWindow {
  const d = new Date(utcMs)
  const startUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  const endUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  return { startUtc, endUtc, totalSec: (endUtc - startUtc) / 1000 }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** 新号首订实付：原月费减首订券后整体按剩余比例折算 */
function firstSubPayUsd(price: number, ratio: number): number {
  return round2(Math.max(0, price - FIRST_SUB_COUPON_USD) * ratio)
}

// ============ 格式化 ============

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`
}

function fmtCny(usd: number): string {
  return `¥${(usd * USD_TO_CNY).toFixed(2)}`
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function fmtLocal(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function fmtUtc(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
}

/** 秒数拆成天/时/分/秒，负数按 0 处理 */
function breakdown(sec: number): { d: number; h: number; m: number; s: number } {
  const t = Math.max(0, Math.floor(sec))
  return {
    d: Math.floor(t / 86400),
    h: Math.floor((t % 86400) / 3600),
    m: Math.floor((t % 3600) / 60),
    s: t % 60
  }
}

// ============ 页面状态 ============

/** 每秒跳动的时钟，驱动全部价格与倒计时重算 */
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

/** 只在本月变化时才改值，避免每秒重算月份窗口与滑块节点 */
const monthStartUtc = computed(() => {
  const d = new Date(now.value)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
})
const win = computed(() => getMonthWindow(monthStartUtc.value))

/** 本地日期的零点，跨天时才变，用作节点列表的起点 */
const dayAnchor = computed(() => {
  const d = new Date(now.value)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
})

/** 每天的 4 个时间节点（本地时间） */
const NODE_HOURS = [10, 14, 18, 22]

interface TimeNode {
  /** 该节点的绝对时刻 */
  ms: number
}

/**
 * 从今天起到本计费月结束，逐日铺 4 个时间节点。
 * 起点用本地日期，终点用 UTC 月末，避免跨时区时越过了本该结束的月份。
 * 列表在一次访问内保持稳定，拖动时下标不会漂移。
 */
const timeNodes = computed<TimeNode[]>(() => {
  const w = win.value
  const anchor = new Date(dayAnchor.value)
  const list: TimeNode[] = []
  // 最多 31 天，留一点余量防时区/月末边界把循环卡住
  for (let i = 0; i < 33; i++) {
    const dayStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + i)
    if (dayStart.getTime() > w.endUtc) break
    for (const hour of NODE_HOURS) {
      const ms = new Date(
        dayStart.getFullYear(),
        dayStart.getMonth(),
        dayStart.getDate(),
        hour
      ).getTime()
      if (ms > w.endUtc) continue
      list.push({ ms })
    }
  }
  // 月末最后一刻之后没有任何节点时，留一个当前时刻，保证滑块始终可用
  if (!list.length) list.push({ ms: Math.min(now.value, w.endUtc) })
  return list
})

/** 实时模式：按当前时间每秒重算；预览模式：锁定滑块选中的节点 */
const followNow = ref(true)
const pickedIndex = ref(0)

const effectiveMs = computed(() =>
  followNow.value ? now.value : (timeNodes.value[pickedIndex.value]?.ms ?? now.value)
)

/** 滑块位置：实时模式下停在离当前时间最近的节点上 */
const sliderIndex = computed(() => {
  if (!followNow.value) return Math.min(pickedIndex.value, timeNodes.value.length - 1)
  let best = 0
  let bestDiff = Number.POSITIVE_INFINITY
  timeNodes.value.forEach((node, i) => {
    const diff = Math.abs(node.ms - now.value)
    if (diff < bestDiff) {
      bestDiff = diff
      best = i
    }
  })
  return best
})

const sliderMax = computed(() => Math.max(0, timeNodes.value.length - 1))

/** 刻度只标每天的第一个节点；天数多时隔几天标一次，避免标签重叠 */
const sliderMarks = computed(() => {
  const marks: Record<number, { style: Record<string, string>; label: string }> = {}
  const nodes = timeNodes.value
  if (!nodes.length) return marks
  const dayCount = Math.ceil(nodes.length / NODE_HOURS.length)
  const stride = dayCount <= 8 ? 1 : Math.ceil(dayCount / 6)
  nodes.forEach((node, i) => {
    if (i % NODE_HOURS.length !== 0) return
    if ((i / NODE_HOURS.length) % stride !== 0) return
    const d = new Date(node.ms)
    marks[i] = {
      style: { whiteSpace: 'nowrap', fontSize: '11px' },
      label: `${d.getMonth() + 1}-${d.getDate()}`
    }
  })
  return marks
})

function tipFormatter(value: number | undefined): string {
  const node = value === undefined ? undefined : timeNodes.value[value]
  if (!node) return ''
  const d = new Date(node.ms)
  return `${d.getMonth() + 1}-${d.getDate()} ${pad2(d.getHours())}:00`
}

function onSlide(value: number | [number, number]): void {
  if (Array.isArray(value)) return
  pickedIndex.value = value
  followNow.value = false
}

function resetToNow(): void {
  followNow.value = true
}

const remainSec = computed(() => Math.max(0, (win.value.endUtc - effectiveMs.value) / 1000))
/** 当月剩余比例：月初为 1，月末趋近 0 */
const ratio = computed(() =>
  Math.min(1, Math.max(0, remainSec.value / win.value.totalSec))
)
const remain = computed(() => breakdown(remainSec.value))
const remainPct = computed(() => (ratio.value * 100).toFixed(1))

const monthLabel = computed(() => {
  const d = new Date(win.value.startUtc)
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月（全月 ${Math.round(win.value.totalSec / 86400)} 天）`
})

/** 套餐卡片的实时数据 */
const planCards = computed(() =>
  PLANS.map((plan) => {
    const pay = firstSubPayUsd(plan.price, ratio.value)
    /* 积分线性折算，新号赠送的 500 分是定额，加在折算结果之上 */
    const creditsNow = Math.round(plan.credits * ratio.value) + SIGNUP_BONUS_CREDITS
    /* 积分性价比：每付 1 美元能拿到多少积分；实付为 0 时没有意义 */
    const creditsPerUsd = pay > 0 ? creditsNow / pay : null
    return {
      ...plan,
      pay,
      isFreeNow: pay === 0,
      creditsNow,
      creditsPerUsd
    }
  })
)

</script>

<template>
  <div class="pricing-page">
    <!-- 页头 -->
    <a-card class="hero-card" :bordered="false">
      <div class="hero">
        <div class="hero-icon"><MoneyCollectOutlined /></div>
        <div class="hero-text">
          <h2 class="hero-title">实时价格</h2>
          <p class="hero-desc">
            Kiro 新号首订价格与积分，按 UTC 自然月线性折算（拖动滑块可预览本月任意时间节点）
          </p>
        </div>
      </div>
    </a-card>

    <!-- 计费基准 -->
    <a-card class="basis-card" :bordered="false">
      <div class="card-head">
        <CalendarOutlined class="card-head-icon" />
        <div>
          <div class="card-title">计费基准（UTC 自然月）</div>
          <div class="card-sub">
            首订实付 =（原月费 − ${{ FIRST_SUB_COUPON_USD }} 首订券）× 当月剩余比例，随时间线性下降
          </div>
        </div>
      </div>

      <div class="basis-grid">
        <div class="basis-item">
          <span class="basis-label">{{ followNow ? '本地时间（当前）' : '本地时间（预览）' }}</span>
          <span class="basis-value">{{ fmtLocal(effectiveMs) }}</span>
        </div>
        <div class="basis-item">
          <span class="basis-label">UTC</span>
          <span class="basis-value">{{ fmtUtc(effectiveMs) }}</span>
        </div>
        <div class="basis-item">
          <span class="basis-label">当前自然月</span>
          <span class="basis-value">{{ monthLabel }}</span>
        </div>
        <div class="basis-item">
          <span class="basis-label">当月剩余</span>
          <span class="basis-value accent">
            {{ remain.d }} 天 {{ remain.h }} 小时 {{ remain.m }} 分
            <span class="muted">（剩余 {{ remainPct }}%）</span>
          </span>
        </div>
      </div>

      <a-progress
        :percent="Number((1 - ratio) * 100)"
        :show-info="false"
        :stroke-color="'var(--kal-primary)'"
        class="basis-progress"
      />

      <p class="formula">
        核心公式：首订实付 = max(0, 原月费 − ${{ FIRST_SUB_COUPON_USD }} 首订券) × 当月剩余比例
        · 汇率：$1 = ¥{{ USD_TO_CNY }}
        · 当月积分 = 全额积分 × 剩余比例 + {{ SIGNUP_BONUS_CREDITS }} 新号赠送（赠送部分不折算）
      </p>
    </a-card>

    <!-- 套餐实时价格 -->
    <div class="plan-grid">
      <a-card
        v-for="plan in planCards"
        :key="plan.key"
        class="plan-card"
        :class="{ 'is-free': plan.isFreeNow }"
        :bordered="false"
      >
        <div class="plan-head">
          <span class="plan-name">{{ plan.name }}</span>
        </div>

        <div class="pay-box" :class="{ free: plan.isFreeNow }">
          <span class="pay-label">新号首订实付</span>
          <span class="pay-value">{{ fmtUsd(plan.pay) }}</span>
          <span class="pay-cny">≈ {{ fmtCny(plan.pay) }}</span>
        </div>

        <div class="plan-rows">
          <div class="plan-row">
            <span class="muted">可获得积分</span>
            <span class="num accent-num">{{ fmtInt(plan.creditsNow) }}</span>
          </div>
          <div class="plan-row">
            <span class="muted">积分性价比</span>
            <span class="num">
              <template v-if="plan.creditsPerUsd !== null">
                {{ fmtInt(Math.round(plan.creditsPerUsd)) }} 积分/美元
              </template>
              <span v-else class="muted">—</span>
            </span>
          </div>
        </div>
      </a-card>
    </div>

    <!-- 时间滑块 -->
    <a-card class="timeline-card" :bordered="false">
      <div class="card-head">
        <FieldTimeOutlined class="card-head-icon" />
        <div>
          <div class="card-title">时间滑块</div>
          <div class="card-sub">
            每天 10 点、14 点、18 点、22 点 4 个节点，拖动可预览该时刻的套餐数据
          </div>
        </div>
      </div>

      <div class="timeline-status">
        <span class="timeline-badge" :class="{ 'is-live': followNow }">
          <ClockCircleOutlined />
          {{ followNow ? '当前时间（实时跟进）' : '预览时间' }}
        </span>
        <span class="timeline-time">{{ fmtLocal(effectiveMs) }}</span>
        <a-button size="small" class="now-btn" @click="resetToNow">当前时间</a-button>
      </div>

      <a-slider
        :value="sliderIndex"
        :max="sliderMax"
        :step="1"
        :marks="sliderMarks"
        :tip-formatter="tipFormatter"
        @change="onSlide"
      />
    </a-card>
  </div>
</template>

<style scoped>
.pricing-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.hero-card,
.basis-card,
.timeline-card,
.plan-card {
  border: 1px solid var(--kal-border);
  background: var(--kal-card-bg);
}

.hero {
  display: flex;
  align-items: center;
  gap: 14px;
}

.hero-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 46px;
  height: 46px;
  border-radius: 13px;
  font-size: 22px;
  color: #fff;
  background: linear-gradient(135deg, var(--kal-primary), #a78bfa);
}

.hero-title {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
}

.hero-desc {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--kal-muted);
}

.card-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 14px;
}

.card-head-icon {
  margin-top: 2px;
  font-size: 15px;
  color: var(--kal-primary);
}

.card-title {
  font-size: 15px;
  font-weight: 600;
}

.card-sub {
  margin-top: 3px;
  font-size: 12px;
  color: var(--kal-muted);
}

/* 计费基准 */
.basis-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px;
}

.basis-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--kal-block-bg);
}

.basis-label {
  font-size: 11px;
  color: var(--kal-muted);
}

.basis-value {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.basis-value.accent {
  color: var(--kal-primary);
}

.basis-progress {
  margin: 14px 0 8px;
}

.formula {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--kal-muted);
}

/* 套餐卡片 */
.plan-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
}

.plan-card.is-free {
  border-color: rgba(82, 196, 26, 0.45);
}

.plan-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.plan-name {
  font-size: 15px;
  font-weight: 600;
}

.plan-rows {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
}

.plan-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.num {
  font-variant-numeric: tabular-nums;
}

.accent-num {
  color: var(--kal-primary);
  font-weight: 600;
}

.pay-box {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--kal-block-bg);
}

.pay-box.free {
  background: rgba(82, 196, 26, 0.1);
}

.pay-label {
  font-size: 11px;
  color: var(--kal-muted);
}

.pay-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
}

.pay-box.free .pay-value,
.pay-box.free .pay-cny {
  color: #52c41a;
}

.pay-cny {
  font-size: 12px;
  color: var(--kal-muted);
  font-variant-numeric: tabular-nums;
}

/* 时间滑块 */
.timeline-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin: 2px 0 18px;
}

.timeline-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--kal-muted);
  background: var(--kal-block-bg);
}

.timeline-badge.is-live {
  color: var(--kal-primary);
}

.timeline-time {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.now-btn {
  margin-left: auto;
}

/* 滑块下方的日期刻度不参与点击热区，避免误触 */
.timeline-card :deep(.ant-slider-mark-text) {
  pointer-events: none;
  color: var(--kal-muted);
}

.timeline-card :deep(.ant-slider) {
  margin-bottom: 30px;
}

@media (max-width: 860px) {
  .timeline-status {
    gap: 8px;
  }
}
</style>
