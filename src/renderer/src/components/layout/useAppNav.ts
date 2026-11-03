/**
 * 导航菜单的数据与行为，左侧导航栏与顶部导航栏共用：菜单项、当前选中、跳转、明暗切换。
 */
import { computed, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  HomeOutlined,
  TeamOutlined,
  KeyOutlined,
  CreditCardOutlined,
  MoneyCollectOutlined,
  CloudServerOutlined,
  ToolOutlined,
  FileTextOutlined,
  SettingOutlined,
  InfoCircleOutlined
} from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import { useKeysStore } from '@/stores/keys'

export interface NavItem {
  key: string
  label: string
  icon: Component
}

export function useAppNav() {
  const route = useRoute()
  const router = useRouter()
  const settingsStore = useSettingsStore()
  const keysStore = useKeysStore()

  const selectedKeys = computed(() => [route.name as string])

  function navigate(info: { key: string | number }): void {
    void router.push({ name: String(info.key) })
  }

  /** logo 点击回主页 */
  function goHome(): void {
    if (route.name !== 'home') void router.push({ name: 'home' })
  }

  const items = computed<NavItem[]>(() => {
    return [
      { key: 'home', label: '主页', icon: HomeOutlined },
      // 账户管理不跟数量：账号成千上万时数字一直在变，侧栏宽度跟着抖，也没人靠它判断什么
      { key: 'accounts', label: '账户管理', icon: TeamOutlined },
      {
        key: 'keys',
        label: keysStore.count ? `API Key 管理（${keysStore.count}个）` : 'API Key 管理',
        icon: KeyOutlined
      },
      { key: 'subscription', label: '订阅管理', icon: CreditCardOutlined },
      { key: 'pricing', label: '实时价格', icon: MoneyCollectOutlined },
      { key: 'proxy', label: '本地反代', icon: CloudServerOutlined },
      { key: 'tools', label: '常用工具', icon: ToolOutlined },
      { key: 'logs', label: '系统日志', icon: FileTextOutlined },
      { key: 'settings', label: '设置', icon: SettingOutlined },
      { key: 'about', label: '关于', icon: InfoCircleOutlined }
    ]
  })

  /*
   * 快捷明暗切换：按当前实际明暗翻到另一边，固定成浅色 / 深色。
   * 「自动」下点一次也会变成固定值，想回到跟随系统去设置页选「自动」。
   */
  const darkModeLabel = computed(() => (settingsStore.isDark ? '浅色模式' : '深色模式'))

  function toggleDark(): void {
    void settingsStore.update({ themeMode: settingsStore.isDark ? 'light' : 'dark' })
  }

  return { items, selectedKeys, navigate, goHome, darkModeLabel, toggleDark }
}
