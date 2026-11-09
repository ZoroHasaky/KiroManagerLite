// 系统托盘（macOS 菜单栏）：展示当前账号信息，提供刷新 / 切号 / 显示窗口 / 退出
import { Tray, Menu, app, clipboard, nativeImage } from 'electron'
import type { MenuItemConstructorOptions, NativeImage } from 'electron'
import { join } from 'path'
import type { TrayAction, TraySnapshot } from '../shared/types'
import { existsSync } from 'fs'
import { activePackRoot, currentVersion } from './packManager'

let tray: Tray | null = null
let snapshot: TraySnapshot = { total: 0, switchable: 0 }

interface TrayCallbacks {
  onShowWindow: () => void
  onQuit: () => void
  onAction: (action: TrayAction) => void
}

/** 登记一次后长期保留，供设置里动态关闭再启用托盘时复用 */
let callbacks: TrayCallbacks | null = null

// ============ 图标 ============

const iconCache = new Map<string, NativeImage>()

function iconDir(): string {
  if (!app.isPackaged) return join(__dirname, '../../resources/tray')
  // 热更后托盘图标优先用资源包里的，保证与当前代码同版本
  const packRoot = activePackRoot()
  if (packRoot) {
    const inPack = join(packRoot, 'resources', 'tray')
    if (existsSync(inPack)) return inPack
  }
  return join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'tray')
}

/** 菜单项小图标，统一缩放到 16x16 */
function icon(name: string, size = 16): NativeImage {
  const key = `${name}@${size}`
  const cached = iconCache.get(key)
  if (cached) return cached
  try {
    const image = nativeImage.createFromPath(join(iconDir(), `${name}.png`))
    const resized = image.isEmpty() ? image : image.resize({ width: size, height: size })
    iconCache.set(key, resized)
    return resized
  } catch {
    return nativeImage.createEmpty()
  }
}

// ============ 菜单 ============

function disabled(label: string, iconName?: string): MenuItemConstructorOptions {
  return { label, enabled: false, ...(iconName ? { icon: icon(iconName) } : {}) }
}

function buildMenu(): Menu {
  const items: MenuItemConstructorOptions[] = [
    disabled(`Kiro Manager Lite v${currentVersion()}`, 'app'),
    { type: 'separator' },
    disabled(
      snapshot.email ? `已登录：${snapshot.email}` : '当前未登录 Kiro IDE',
      snapshot.email ? 'online' : 'offline'
    ),
    { type: 'separator' }
  ]

  if (snapshot.email) {
    items.push(
      disabled('当前账户', 'account'),
      disabled(`   ${snapshot.email}`),
      disabled(
        `   身份: ${snapshot.idp ?? '未知'} | ${snapshot.subscription ?? '未知'} | ${snapshot.status ?? '未知'}`,
        snapshot.healthy ? 'ok' : 'warning'
      )
    )
    if (snapshot.usageLimit) {
      items.push(
        disabled(`   用量: ${snapshot.usageCurrent ?? 0} / ${snapshot.usageLimit} Credits`, 'usage')
      )
    }
    if (snapshot.daysRemaining !== undefined) {
      items.push(disabled(`   订阅: 剩 ${snapshot.daysRemaining} 天`, 'usage'))
    }
    if (snapshot.tokenLife) {
      items.push(disabled(`   Token: ${snapshot.tokenLife}`, 'refresh'))
    }
  } else {
    items.push(disabled(`共 ${snapshot.total} 个账号，去主窗口切换一个使用`, 'account'))
  }

  items.push(
    { type: 'separator' },
    {
      label: '刷新账户信息',
      icon: icon('refresh'),
      enabled: !!snapshot.email,
      click: () => callbacks?.onAction('refresh')
    },
    {
      label: `切换到下一个账户 (${snapshot.switchable} 个可用)`,
      icon: icon('switch'),
      enabled: snapshot.switchable > 0,
      click: () => callbacks?.onAction('switch-next')
    },
    {
      label: '复制当前邮箱',
      icon: icon('copy'),
      enabled: !!snapshot.email,
      click: () => {
        // writeText 自 Electron 44 起返回 Promise，失败不该冒成未处理的拒绝
        if (snapshot.email) void clipboard.writeText(snapshot.email).catch(() => undefined)
      }
    },
    { type: 'separator' },
    { label: '显示主窗口', icon: icon('window'), click: () => callbacks?.onShowWindow() },
    { label: '退出程序', icon: icon('quit'), click: () => callbacks?.onQuit() }
  )

  return Menu.buildFromTemplate(items)
}

function refreshMenu(): void {
  tray?.setContextMenu(buildMenu())
  tray?.setToolTip(
    snapshot.email ? `Kiro Manager Lite · ${snapshot.email}` : 'Kiro Manager Lite · 未登录'
  )
}

/** 渲染进程推送账号摘要后刷新菜单 */
export function setTraySnapshot(data: TraySnapshot): void {
  snapshot = data
  refreshMenu()
}

/** 仅登记回调，不立即创建托盘（由 setTrayEnabled 决定是否创建） */
export function registerTrayCallbacks(cbs: TrayCallbacks): void {
  callbacks = cbs
}

/** 根据设置动态启用 / 关闭托盘图标 */
export function setTrayEnabled(enabled: boolean): void {
  if (enabled) {
    if (!tray && callbacks) createTray(callbacks)
  } else {
    destroyTray()
  }
}

function createTray(cbs: TrayCallbacks): void {
  if (tray) return

  try {
    const image = icon('app', 18)
    // macOS 菜单栏用模板图标，自动适配深浅色
    if (process.platform === 'darwin') image.setTemplateImage(true)

    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
    refreshMenu()

    tray.on('double-click', () => cbs.onShowWindow())
    // Windows / Linux 左键直接唤起主窗口
    if (process.platform !== 'darwin') tray.on('click', () => cbs.onShowWindow())

    console.log('[Tray] created')
  } catch (e) {
    console.error('[Tray] failed to create:', e)
  }
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
