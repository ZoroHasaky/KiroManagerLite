/*
 * 启动引导层：唯一留在安装包里、不参与热更新的代码。
 *
 * 为什么需要它：Electron 的入口由 package.json 的 main 字段决定，而这个文件在
 * app.asar 里，运行时改不了。要让主进程、preload、渲染层都能热更，入口必须先落到
 * 一个可写目录之外的中转点——就是这里。它只做一件事：找到当前该跑的版本，require 进去。
 *
 * 这个文件必须保持零依赖、零业务逻辑。它一旦需要热更，方案就退化成必须重装应用。
 */
const { app } = require('electron')
const path = require('path')
const fs = require('fs')

/** 资源包根目录；与 packManager 里的布局保持同一份约定 */
const PACKS_DIR = path.join(app.getPath('userData'), 'packs')
const ACTIVE_FILE = path.join(PACKS_DIR, 'active.json')

/** 安装包内置的版本：任何异常都回退到这里，保证应用永远能启动 */
function builtinEntry() {
  return path.join(__dirname, 'out', 'main', 'index.js')
}

/**
 * 解析当前生效的主进程入口。
 *
 * 开发模式一律走内置产物：`npm run dev` 的入口在 out/main，且不该被用户数据里的
 * 历史资源包劫持。返回 null 表示没有可用的资源包，调用方用内置版本。
 */
function resolvePackEntry() {
  if (!app.isPackaged) return null
  try {
    const raw = fs.readFileSync(ACTIVE_FILE, 'utf8')
    const active = JSON.parse(raw)
    const version = typeof active?.version === 'string' ? active.version.trim() : ''
    // 版本号会拼进路径，必须是纯版本号，不能带斜杠或 .. 之类的东西
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return null
    const dir = path.join(PACKS_DIR, version)
    const entry = path.join(dir, 'out', 'main', 'index.js')
    // 目录和入口都得真实存在，缺一个就当资源包不可用
    if (!fs.existsSync(entry)) return null
    return { version, dir, entry }
  } catch {
    // 文件不存在或内容损坏：静默回退，不打扰用户
    return null
  }
}

/**
 * 摘掉当前生效记录，让下次启动回退到内置版本。
 *
 * 只在主进程入口加载失败时调用：坏包留着的代价是应用再也起不来，
 * 而用户手里至少要有一个人能用的版本。
 */
function dropActive() {
  try {
    fs.rmSync(ACTIVE_FILE, { force: true })
  } catch {
    // 删不掉也不能再抛：这里已经处在异常恢复路径上
  }
}

function start() {
  const pack = resolvePackEntry()

  if (!pack) {
    require(builtinEntry())
    return
  }

  try {
    require(pack.entry)
  } catch (error) {
    /*
     * 资源包里的代码在 require 阶段就抛了（语法错误、缺依赖、原生模块架构不符），
     * 这时窗口还没创建，用户看到的是一片空白。摘掉记录后立刻重启，
     * 下一次启动就走内置版本，用户至少能用上旧版并重新下载。
     */
    dropActive()
    console.error('[Bootstrap] 资源包加载失败，已回退到内置版本：', error)

    // 带上标记，避免用户反复手动启动时再次踩进同一个坏包
    const relaunched = process.argv.includes('--after-pack-failure')
    if (!relaunched) {
      app.relaunch({ args: [...process.argv.slice(1), '--after-pack-failure'] })
    }
    app.exit(1)
    return
  }
}

start()
