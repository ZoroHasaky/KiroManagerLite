<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  CheckCircleFilled,
  CheckOutlined,
  CloseCircleFilled,
  InfoCircleFilled,
  SyncOutlined,
  ThunderboltFilled
} from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import { useUpdateStore } from '@/stores/update'
import kiroLogo from '@/assets/kiro-logo.png'

const settingsStore = useSettingsStore()
const updateStore = useUpdateStore()
const info = computed(() => settingsStore.appInfo)

// ============ 检查更新 ============
const checking = computed(() => updateStore.checking)
const checkResult = computed(() => updateStore.result)
const checkOpen = ref(false)
const checkError = ref('')

/** 手动检查先打开状态弹窗，再在弹窗中呈现最终结果。 */
async function checkUpdate(): Promise<void> {
  if (checking.value) return
  checkError.value = ''
  checkOpen.value = true
  const response = await updateStore.checkNow()
  if (response.error) {
    checkError.value = response.error
    return
  }
  // 发现新版本时关闭状态弹窗，由全局 UpdateAvailableModal 接管更新详情。
  if (response.data?.hasUpdate) checkOpen.value = false
  else if (!response.data) checkError.value = '没有收到有效的版本检查结果，请稍后重试'
}

/** 关于页展示的功能清单，按应用的模块顺序排列，与 README 的功能特性保持一致 */
const features = [
  { name: '多账号管理', desc: 'Google / GitHub / Builder ID / Enterprise SSO 在线登录、OIDC 凭证、读取本机登录态，支持搜索、多维筛选、分组与批量操作' },
  { name: '账号阶段', desc: '未使用 / 待支付 / 已订阅 / 已出售 / 已闲置五个阶段自动推导，不用手工维护分组' },
  { name: '刷新与检测', desc: '密钥与用量各自定时检测并分批刷新，两个待刷新池独立控制间隔与每批数量，避免触发上游限流' },
  { name: '流式测活', desc: '真实对话测活，模型可搜索、二级可选推理档位，可查看官方完整原始返回' },
  { name: '订阅与官网', desc: '订阅状态、可开通档位与 Stripe 账单页，可批量生成订阅链接；内置私密浏览器免登录进 Kiro 官网后台' },
  { name: '订阅管理', desc: '一次性预约与可停止的批量生成支付链接，二维码本地生成，切换 Free 走 Stripe 门户' },
  { name: '用量与历史', desc: '记录每次刷新的积分变化，趋势曲线、明细表与 Excel 导出' },
  { name: '导入导出', desc: '卡密、JSON、CSV、TXT 互通，可批量导入多个文件、分割导出为压缩包' },
  { name: '常用工具', desc: '出口 IP 与网站连通性检测，走应用自身的代理设置' },
  { name: '系统日志', desc: '主进程与界面日志同一时间线，按级别、分类、关键字与时间筛选并可导出' },
  { name: '隐私打码', desc: '一键遮住邮箱与备注，截图录屏更安心' },
  { name: '个性化设置', desc: '主题风格与主题色、左右 / 上下布局、控件尺寸、HTTP 代理、内置浏览器地区、定时备份与初始化' },
  { name: '桌面端体验', desc: '系统托盘常驻、关闭行为可配、自定义协议唤起、单实例锁' }
]
</script>

<template>
  <div>
    <!-- 头部：品牌标识 + 版本 + 检查更新 -->
    <section class="hero">
      <span class="hero-blob hero-blob-a" />
      <span class="hero-blob hero-blob-b" />
      <div class="hero-main">
        <img class="hero-logo" :src="kiroLogo" alt="Kiro Manager Lite" />
        <h2 class="hero-title">Kiro Manager Lite</h2>
        <p class="hero-version muted">版本 {{ info?.version || '-' }}</p>
        <a-space :size="12" wrap class="hero-actions">
          <a-button :loading="checking" @click="checkUpdate">
            <template #icon><SyncOutlined /></template>
            检查更新
          </a-button>
        </a-space>
      </div>
    </section>

    <a-card size="small" title="版本信息" style="margin-bottom: 16px">
      <a-descriptions :column="2" size="small">
        <a-descriptions-item label="应用版本">{{ info?.version || '-' }}</a-descriptions-item>
        <a-descriptions-item label="平台">{{ info?.platform || '-' }}</a-descriptions-item>
        <a-descriptions-item label="Electron">{{ info?.electron || '-' }}</a-descriptions-item>
        <a-descriptions-item label="Chromium">{{ info?.chrome || '-' }}</a-descriptions-item>
        <a-descriptions-item label="Node">{{ info?.node || '-' }}</a-descriptions-item>
        <a-descriptions-item label="技术栈">Vue 3 · Vite · Pinia · Ant Design Vue · Electron</a-descriptions-item>
      </a-descriptions>
    </a-card>

    <a-card size="small" class="intro-card" style="margin-bottom: 16px">
      <template #title>
        <span class="card-title">
          <InfoCircleFilled class="card-title-icon" />
          关于本应用
        </span>
      </template>
      <p class="intro-text">
        多账号集中管理 · 阶段自动推导 · 密钥与用量分批刷新 · 订阅开通与账单管理 · 支付链接与二维码 · 流式测活 · 导入导出 · 内置私密浏览器 · 托盘常驻
      </p>
      <p class="intro-text">
        本应用使用 Electron + Vue 3 + TypeScript 开发，支持 Windows、macOS 和 Linux 平台。
        所有账号数据均加密保存在本机，不会上传到任何服务器。
      </p>
    </a-card>

    <a-card size="small" class="feature-card" style="margin-bottom: 24px">
      <template #title>
        <span class="card-title">
          <ThunderboltFilled class="card-title-icon" />
          主要功能
        </span>
      </template>
      <ul class="feature-list">
        <li v-for="item in features" :key="item.name" class="feature-item">
          <CheckOutlined class="feature-check" />
          <span class="feature-name">{{ item.name }}</span>
          <span class="feature-sep">：</span>
          <span class="feature-desc muted">{{ item.desc }}</span>
        </li>
      </ul>
    </a-card>

    <!-- 手动检查状态：点击后立即打开，加载、失败、已是最新版都在同一弹窗内呈现。 -->
    <a-modal
      v-if="checkOpen"
      v-model:open="checkOpen"
      title="检查更新"
      :width="420"
      centered
      :closable="!checking"
      :mask-closable="!checking"
      :keyboard="!checking"
    >
      <div class="check-result" aria-live="polite">
        <template v-if="checking">
          <a-spin size="large" class="check-spinner" />
          <div class="check-title">正在检查更新</div>
          <div class="check-detail muted">正在获取最新版本信息，请稍候…</div>
        </template>
        <template v-else-if="checkError">
          <CloseCircleFilled class="check-icon error" />
          <div class="check-title">检查更新失败</div>
          <div class="check-error">{{ checkError }}</div>
          <div class="check-detail muted">可以稍后重试。</div>
        </template>
        <template v-else>
          <CheckCircleFilled class="check-icon ok" />
          <div class="check-title">已是最新版本</div>
          <div class="check-detail muted">
            当前版本 v{{ checkResult?.current || info?.version || '-' }}
          </div>
        </template>
      </div>
      <template #footer>
        <span v-if="checking" class="check-footer-loading muted">正在检查，请勿关闭…</span>
        <template v-else-if="checkError">
          <a-button @click="checkOpen = false">关闭</a-button>
          <a-button @click="checkUpdate">
            <template #icon><SyncOutlined /></template>
            重新检查
          </a-button>
        </template>
        <a-button v-else type="primary" @click="checkOpen = false">好的</a-button>
      </template>
    </a-modal>
  </div>
</template>

<style scoped>
/* ============ 关于本应用 / 主要功能 ============ */
.card-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.card-title-icon {
  color: var(--kal-primary);
}

.intro-card :deep(.ant-card-body),
.feature-card :deep(.ant-card-body) {
  padding: 16px;
}

.intro-text {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.9;
}

.intro-text:last-child {
  margin-bottom: 0;
}

.feature-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.feature-item {
  display: flex;
  align-items: baseline;
  gap: 2px;
  padding: 4px 0;
  font-size: 13px;
  line-height: 1.8;
}

.feature-check {
  flex: 0 0 auto;
  margin-right: 6px;
  color: var(--kal-primary);
  font-size: 12px;
}

.feature-name {
  flex: 0 0 auto;
  font-weight: 600;
  color: var(--kal-primary);
}

.feature-sep {
  flex: 0 0 auto;
  color: var(--kal-muted);
}

/* 说明文字占据剩余宽度，长句在窄窗口下正常换行 */
.feature-desc {
  flex: 1 1 auto;
  min-width: 0;
}

/* ============ 头部横幅 ============ */
.hero {
  position: relative;
  overflow: hidden;
  margin-bottom: 16px;
  padding: 40px 24px 36px;
  border: 1px solid var(--kal-border);
  border-radius: 12px;
  background: var(--kal-card-bg);
  text-align: center;
}

.hero-blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(40px);
  background: radial-gradient(circle, var(--kal-primary), transparent 70%);
  opacity: 0.18;
  pointer-events: none;
}

.hero-blob-a {
  top: -60px;
  right: -30px;
  width: 180px;
  height: 180px;
}

.hero-blob-b {
  bottom: -60px;
  left: -20px;
  width: 150px;
  height: 150px;
}

.hero-main {
  position: relative;
}

/* 品牌标识：logo 单独居中，应用名放在下方 */
.hero-logo {
  display: block;
  width: 72px;
  height: 72px;
  margin: 0 auto;
  border-radius: 18px;
  object-fit: cover;
}

.hero-title {
  margin: 18px 0 8px;
  font-size: 22px;
  font-weight: 700;
  color: var(--kal-primary);
}

.hero-version {
  margin: 0 0 24px;
  font-size: 13px;
}

/* ============ 检查更新弹窗 ============ */
.check-result {
  text-align: center;
  padding: 8px 0 4px;
}

.check-icon {
  font-size: 40px;
}

.check-icon.ok {
  color: #52c41a;
}

.check-icon.error {
  color: #ff4d4f;
}

.check-spinner {
  display: inline-flex;
  margin: 2px 0 4px;
}

.check-detail {
  max-width: 340px;
  margin: 0 auto;
  font-size: 12.5px;
  line-height: 1.7;
}

.check-error {
  max-width: 350px;
  margin: 0 auto 6px;
  color: #ff4d4f;
  font-size: 12.5px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.check-footer-loading {
  display: inline-block;
  padding: 5px 0;
  font-size: 12px;
}

.check-title {
  margin: 10px 0 6px;
  font-size: 16px;
  font-weight: 600;
}
</style>
