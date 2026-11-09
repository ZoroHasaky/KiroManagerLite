// macOS 应用菜单（顶部菜单栏）：中文化系统默认菜单，并补上页面导航、
// Kiro IDE 开关与「关于」弹窗。
//
// 只在 darwin 生效：Windows / Linux 的窗口菜单保持原有的 autoHideMenuBar 默认行为。
import { app, clipboard, dialog, Menu } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { release, type as osType } from 'os'
import { closeKiroIde, openKiroIde } from './kiroProcess'
import { sendToRenderer } from './utils'
import { currentVersion } from './packManager'

/** 菜单里展示的应用名（打包后的 productName，不跟随 package.json 的包名） */
const APP_NAME = 'Kiro Manager Lite'

interface AppMenuDeps {
  /** 把主窗口带到前台（隐藏到托盘时也能唤回） */
  focusWindow: () => void
  getWindow: () => BrowserWindow | null
}

/** 拿一个可用的父窗口，供原生弹窗挂载；窗口不可用时返回 null 走无主窗弹窗 */
function parentWindow(deps: AppMenuDeps): BrowserWindow | null {
  const win = deps.getWindow()
  return win && !win.isDestroyed() ? win : null
}

/** 统一的原生提示弹窗 */
function alert(deps: AppMenuDeps, message: string, ok = true): void {
  const options = { type: ok ? ('info' as const) : ('warning' as const), buttons: ['确定'], message }
  const parent = parentWindow(deps)
  if (parent) void dialog.showMessageBox(parent, options)
  else void dialog.showMessageBox(options)
}

// ============ 关于弹窗 ============

/** 运行环境明细，与 Kiro IDE 的关于面板同样的字段顺序 */
function aboutDetail(): string {
  const { electron, chrome, node, v8 } = process.versions
  return [
    `版本: ${currentVersion()}`,
    `Electron: ${electron}`,
    `Chromium: ${chrome}`,
    `Node.js: ${node}`,
    `V8: ${v8}`,
    `OS: ${osType()} ${process.arch} ${release()}`
  ].join('\n')
}

/** 「关于 Kiro Manager Lite」：原生弹窗，确定 / 复制两个按钮 */
async function showAbout(deps: AppMenuDeps): Promise<void> {
  const detail = aboutDetail()
  const options = {
    type: 'info' as const,
    title: `关于 ${APP_NAME}`,
    message: APP_NAME,
    detail,
    buttons: ['确定', '复制'],
    defaultId: 1,
    cancelId: 0,
    noLink: true
  }
  const parent = parentWindow(deps)
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  // writeText 自 Electron 44 起返回 Promise；这里不等它，失败也不该影响菜单
  if (response === 1) void clipboard.writeText(`${APP_NAME}\n${detail}`).catch(() => undefined)
}

// ============ 菜单项 ============

/** 跳转到指定路由：先唤起窗口，再复用协议唤起那条 app:navigate 通道 */
function navItem(
  deps: AppMenuDeps,
  label: string,
  route: string,
  accelerator: string
): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: () => {
      deps.focusWindow()
      sendToRenderer(deps.getWindow(), 'app:navigate', route)
    }
  }
}

/** 打开 / 关闭 Kiro IDE，结果用原生弹窗回执 */
function ideItem(deps: AppMenuDeps, label: string, open: boolean): MenuItemConstructorOptions {
  return {
    label,
    click: async () => {
      const res = open ? await openKiroIde() : await closeKiroIde()
      alert(deps, res.message, res.ok)
    }
  }
}

function buildTemplate(deps: AppMenuDeps): MenuItemConstructorOptions[] {
  return [
    {
      label: APP_NAME,
      submenu: [
        { label: `关于 ${APP_NAME}`, click: () => void showAbout(deps) },
        { type: 'separator' },
        navItem(deps, '设置…', 'settings', 'Command+,'),
        { type: 'separator' },
        { label: '服务', role: 'services' },
        { type: 'separator' },
        { label: `隐藏 ${APP_NAME}`, role: 'hide' },
        { label: '隐藏其他', role: 'hideOthers' },
        { label: '全部显示', role: 'unhide' },
        { type: 'separator' },
        { label: `退出 ${APP_NAME}`, role: 'quit' }
      ]
    },
    {
      label: '操作',
      submenu: [
        navItem(deps, '主页', 'home', 'Command+1'),
        navItem(deps, '账户管理', 'accounts', 'Command+2'),
        navItem(deps, '设置', 'settings', 'Command+3'),
        navItem(deps, '关于', 'about', 'Command+4'),
        { type: 'separator' },
        ideItem(deps, '打开主程序', true),
        ideItem(deps, '关闭主程序', false)
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '缩放', role: 'zoom' },
        { label: '关闭窗口', role: 'close' },
        { type: 'separator' },
        { label: '前置全部窗口', role: 'front' }
      ]
    }
  ]
}

/** 安装应用菜单；非 macOS 保持系统默认，不做改动 */
export function setupAppMenu(deps: AppMenuDeps): void {
  if (process.platform !== 'darwin') return
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(deps)))
}
