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
 * 价格随时间单调下降，所以「目标价 → 时间点」有唯一解：
 *   ratio* = 目标价 / (原月费 − 券)，时刻 = 月末 − 全月秒数 × ratio*
 * 原月费高于券的档位只在月末才到 $0，不存在月中的免单点。
 *
 * 纯前端本地计算，不依赖主进程与网络：所有数字都来自本机时钟。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  CalendarOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  MoneyCollectOutlined,
  SearchOutlined,
  ThunderboltOutlined
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

/** 当月折算价 */
function proratedUsd(price: number, ratio: number): number {
  return round2(price * ratio)
}

/** 新号首订实付：原月费减首订券后整体按剩余比例折算 */
function firstSubPayUsd(price: number, ratio: number): number {
  return round2(Math.max(0, price - FIRST_SUB_COUPON_USD) * ratio)
}

/**
 * 反向求解：本月内首订实付恰好等于 targetUsd 的时刻。
 * 目标价高于月初实付（原月费 − 券）或为负时无解。
 */
function solveTimeForTarget(
  price: number,
  targetUsd: number,
  win: MonthWindow
): { atUtcMs: number; ratio: number } | null {
  if (!Number.isFinite(targetUsd)) return null
  const maxPay = firstSubPayUsd(price, 1)
  if (targetUsd < 0 || targetUsd > maxPay) return null
  const ratio = Math.min(1, Math.max(0, targetUsd / (price - FIRST_SUB_COUPON_USD)))
  return { atUtcMs: win.endUtc - win.totalSec * ratio * 1000, ratio }
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

const win = computed(() => getMonthWindow(now.value))
const remainSec = computed(() => Math.max(0, (win.value.endUtc - now.value) / 1000))
/** 当月剩余比例：月初为 1，月末趋近 0 */
const ratio = computed(() =>
  Math.min(1, Math.max(0, remainSec.value / win.value.totalSec))
)
const remain = computed(() => breakdown(remainSec.value))
const elapsedPct = computed(() => ((1 - ratio.value) * 100).toFixed(1))

const monthLabel = computed(() => {
  const d = new Date(win.value.startUtc)
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月（全月 ${Math.round(win.value.totalSec / 86400)} 天）`
})

/** 套餐卡片的实时数据 */
const planCards = computed(() =>
  PLANS.map((plan) => {
    const prorated = proratedUsd(plan.price, ratio.value)
    const pay = firstSubPayUsd(plan.price, ratio.value)
    const alwaysFree = plan.price <= FIRST_SUB_COUPON_USD
    /* 实付线性下降，月末归零：每天降 (原月费 − 券) / 全月天数 */
    const dailyDropUsd =
      (Math.max(0, plan.price - FIRST_SUB_COUPON_USD) * 86400) / win.value.totalSec
    /* 积分线性折算，新号赠送的 500 分是定额，加在折算结果之上 */
    const creditsProrated = Math.round(plan.credits * ratio.value)
    const creditsNow = creditsProrated + SIGNUP_BONUS_CREDITS
    return {
      ...plan,
      prorated,
      pay,
      isFreeNow: pay === 0,
      alwaysFree,
      dailyDropUsd,
      creditsProrated,
      creditsNow
    }
  })
)

// ============ 反向查询 ============

const targetPlanKey = ref('pro_max')
const targetInput = ref<number | null>(null)
const targetCurrency = ref<'usd' | 'cny'>('usd')

const targetPlan = computed(() => PLANS.find((p) => p.key === targetPlanKey.value) ?? null)

const planOptions = PLANS.map((p) => ({
  value: p.key,
  label: `${p.name} · ${fmtUsd(p.price)}/月 · ${fmtInt(p.credits)} credits`
}))

const reverseResult = computed(() => {
  const plan = targetPlan.value
  const raw = targetInput.value
  if (!plan || raw === null || !Number.isFinite(raw)) return null

  // 原月费不高于首订券：整月任意时刻都是 $0，没有唯一时间点
  if (plan.price <= FIRST_SUB_COUPON_USD) {
    return raw === 0
      ? ({ kind: 'alwaysFree' } as const)
      : ({ kind: 'unreachable', maxPay: 0 } as const)
  }

  const targetUsd = targetCurrency.value === 'usd' ? raw : raw / USD_TO_CNY
  const solved = solveTimeForTarget(plan.price, targetUsd, win.value)
  if (!solved) {
    return { kind: 'unreachable', maxPay: firstSubPayUsd(plan.price, 1) } as const
  }
  const deltaMs = solved.atUtcMs - now.value
  return {
    kind: 'solved',
    targetUsd: round2(targetUsd),
    atUtcMs: solved.atUtcMs,
    ratio: solved.ratio,
    deltaMs,
    // 60 秒容差内视为正处在该价格点
    isNow: Math.abs(deltaMs) < 60_000,
    countdown: breakdown(Math.abs(deltaMs) / 1000)
  } as const
})

function useFreePoint(): void {
  targetInput.value = 0
}
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
            Kiro 新号首订价格与积分，按 UTC 自然月线性折算（含人民币换算与反向查询）
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
          <span class="basis-label">本地时间</span>
          <span class="basis-value">{{ fmtLocal(now) }}</span>
        </div>
        <div class="basis-item">
          <span class="basis-label">UTC</span>
          <span class="basis-value">{{ fmtUtc(now) }}</span>
        </div>
        <div class="basis-item">
          <span class="basis-label">当前自然月</span>
          <span class="basis-value">{{ monthLabel }}</span>
        </div>
        <div class="basis-item">
          <span class="basis-label">当月剩余</span>
          <span class="basis-value accent">
            {{ remain.d }} 天 {{ remain.h }} 小时 {{ remain.m }} 分
            <span class="muted">（剩余 {{ elapsedPct }}%）</span>
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
          <a-tag :bordered="false">{{ fmtInt(plan.creditsNow) }} credits</a-tag>
        </div>

        <div class="plan-rows">
          <div class="plan-row">
            <span class="muted">原月费</span>
            <span class="num">{{ fmtUsd(plan.price) }} · {{ fmtCny(plan.price) }}</span>
          </div>
          <div class="plan-row">
            <span class="muted">当月折算价</span>
            <span class="num">{{ fmtUsd(plan.prorated) }} · {{ fmtCny(plan.prorated) }}</span>
          </div>
          <div class="plan-row">
            <span class="muted">当月折算积分</span>
            <span class="num">{{ fmtInt(plan.creditsProrated) }} / {{ fmtInt(plan.credits) }}</span>
          </div>
          <div class="plan-row">
            <span class="muted">新号赠送积分</span>
            <span class="num">+{{ fmtInt(SIGNUP_BONUS_CREDITS) }}（不折算）</span>
          </div>
          <div class="plan-row">
            <span class="muted">当月合计积分</span>
            <span class="num accent-num">{{ fmtInt(plan.creditsNow) }}</span>
          </div>
        </div>

        <div class="pay-box" :class="{ free: plan.isFreeNow }">
          <span class="pay-label">新号首订实付</span>
          <span class="pay-value">{{ fmtUsd(plan.pay) }}</span>
          <span class="pay-cny">≈ {{ fmtCny(plan.pay) }}</span>
        </div>

        <div class="plan-foot">
          <p v-if="plan.isFreeNow" class="zero-now">
            <ThunderboltOutlined />
            ★ 当前已享 0 元免单
          </p>
          <p v-else class="zero-in">
            <ClockCircleOutlined />
            每天下降 {{ fmtUsd(plan.dailyDropUsd) }} · ≈ {{ fmtCny(plan.dailyDropUsd) }}
          </p>
          <p class="zero-at">
            <span class="muted">{{ plan.alwaysFree ? '整月任意时刻首订均免单' : '月末归零：' }}</span>
            <span v-if="!plan.alwaysFree" class="num">{{ fmtLocal(win.endUtc) }}</span>
          </p>
        </div>
      </a-card>
    </div>

    <!-- 反向查询 -->
    <a-card class="reverse-card" :bordered="false">
      <div class="card-head">
        <SearchOutlined class="card-head-icon" />
        <div>
          <div class="card-title">反向查询：目标价 → 时间点</div>
          <div class="card-sub">
            计算本月内首订实付恰好等于目标价的时间点（价格随时间只降不升，解唯一）
          </div>
        </div>
      </div>

      <div class="query-row">
        <div class="field">
          <label class="field-label">套餐</label>
          <a-select v-model:value="targetPlanKey" :options="planOptions" class="field-control" />
        </div>

        <a-radio-group v-model:value="targetCurrency" button-style="solid" class="currency">
          <a-radio-button value="usd">$</a-radio-button>
          <a-radio-button value="cny">¥</a-radio-button>
        </a-radio-group>

        <div class="field">
          <label class="field-label">
            目标实付价（{{ targetCurrency === 'usd' ? '美元' : '人民币' }}）
          </label>
          <div class="field-inline">
            <a-input-number
              v-model:value="targetInput"
              :min="0"
              :step="0.01"
              :precision="2"
              class="field-control"
              :placeholder="targetCurrency === 'usd' ? '如 10.00' : '如 69.73'"
            />
            <a-button class="free-btn" @click="useFreePoint">$0（月末）</a-button>
          </div>
        </div>
      </div>

      <!-- 有解：给出时间点与倒计时 -->
      <div v-if="reverseResult?.kind === 'solved'" class="result-box">
        <p v-if="reverseResult.isNow" class="result-now">当前正处于该价格点附近。</p>
        <p v-else-if="reverseResult.deltaMs > 0" class="result-lead">
          还有 {{ reverseResult.countdown.d }} 天 {{ reverseResult.countdown.h }} 小时
          {{ reverseResult.countdown.m }} 分 {{ reverseResult.countdown.s }} 秒到达该价格
        </p>
        <p v-else class="result-lead muted">
          该价格出现在 {{ reverseResult.countdown.d }} 天
          {{ reverseResult.countdown.h }} 小时 {{ reverseResult.countdown.m }} 分前（当前实付已低于目标价）
        </p>

        <div class="result-grid">
          <div>
            <span class="basis-label">时间点（本地）</span>
            <span class="basis-value">{{ fmtLocal(reverseResult.atUtcMs) }}</span>
          </div>
          <div>
            <span class="basis-label">UTC</span>
            <span class="basis-value">{{ fmtUtc(reverseResult.atUtcMs) }}</span>
          </div>
          <div>
            <span class="basis-label">该时刻实付</span>
            <span class="basis-value">
              {{ fmtUsd(reverseResult.targetUsd) }} · {{ fmtCny(reverseResult.targetUsd) }}
            </span>
          </div>
          <div>
            <span class="basis-label">对应当月剩余比例</span>
            <span class="basis-value">{{ (reverseResult.ratio * 100).toFixed(2) }}%</span>
          </div>
        </div>
      </div>

      <!-- 整月免单：原月费不高于首订券 -->
      <a-alert
        v-else-if="reverseResult?.kind === 'alwaysFree'"
        type="success"
        show-icon
        :message="`${targetPlan?.name} 整月任意时刻首订均为 $0`"
        description="该档位原月费不高于首订券面额，折算价始终被券覆盖，不存在唯一的价格时间点。"
      />

      <!-- 无解：目标价高于月初实付 -->
      <a-alert
        v-else-if="reverseResult?.kind === 'unreachable'"
        type="warning"
        show-icon
        :message="'目标价不可达'"
        :description="
          reverseResult.maxPay === 0
            ? `${targetPlan?.name} 整月任意时刻首订均为 $0（券始终覆盖折算价），无法达到更高的实付价格。`
            : `月初首订实付最高为 ${fmtUsd(reverseResult.maxPay)}（≈ ${fmtCny(reverseResult.maxPay)}），此后只降不升。请输入 0 ~ ${fmtUsd(reverseResult.maxPay)} 之间的目标价。`
        "
      />

      <p v-else class="result-hint">
        输入目标价后，这里会显示首订实付恰好等于该价的本地 / UTC 时间点、倒计时与对应的当月剩余比例。
      </p>

      <p class="result-note">
        <ExclamationCircleOutlined />
        价格与时间点均为本地按时钟推算，实际扣款以 Stripe 结算页为准。
      </p>
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
.reverse-card,
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

.plan-foot {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
}

.plan-foot p {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  margin: 0;
}

.zero-now {
  font-weight: 600;
  color: #52c41a;
}

.zero-in {
  color: var(--kal-muted);
}

.zero-at {
  color: var(--kal-muted);
}

/* 反向查询 */
.query-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: end;
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.field-label {
  font-size: 12px;
  color: var(--kal-muted);
}

.field-control {
  width: 100%;
}

.field-inline {
  display: flex;
  gap: 8px;
}

.free-btn {
  flex: 0 0 auto;
}

.result-box {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--kal-block-bg);
}

.result-now {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: #52c41a;
}

.result-lead {
  margin: 0 0 10px;
  font-size: 13px;
}

.result-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}

.result-grid > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.result-hint,
.result-note {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--kal-muted);
}

.result-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--kal-border);
}

@media (max-width: 860px) {
  .query-row {
    grid-template-columns: 1fr;
  }
}
</style>
