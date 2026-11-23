// 系统托盘（macOS 菜单栏）：展示账号汇总，提供刷新用量 / 显示窗口 / 退出
import { Tray, Menu, app, nativeImage } from 'electron'
import type { MenuItemConstructorOptions, NativeImage } from 'electron'
import { join } from 'path'
import type { TrayAction, TraySnapshot } from '../shared/types'
import { existsSync } from 'fs'
import { activePackRoot, currentVersion } from './packManager'

let tray: Tray | null = null
let snapshot: TraySnapshot = { total: 0, active: 0, error: 0, banned: 0, expiring: 0 }

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
    disabled(`共 ${snapshot.total} 个账号`, 'account'),
    disabled(`   正常 ${snapshot.active} · 异常 ${snapshot.error} · 封禁 ${snapshot.banned}`),
    disabled(`   ${snapshot.expiring} 个账号 7 天内到期`, snapshot.expiring ? 'warning' : 'ok'),
    { type: 'separator' },
    {
      label: '刷新全部用量',
      icon: icon('refresh'),
      enabled: snapshot.total > 0,
      click: () => callbacks?.onAction('refresh-usage')
    },
    { type: 'separator' },
    { label: '显示主窗口', icon: icon('window'), click: () => callbacks?.onShowWindow() },
    { label: '退出程序', icon: icon('quit'), click: () => callbacks?.onQuit() }
  ]

  return Menu.buildFromTemplate(items)
}

function refreshMenu(): void {
  tray?.setContextMenu(buildMenu())
  tray?.setToolTip(`Kiro Manager Lite · ${snapshot.total} 个账号`)
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
