// 生成热更新资源包
//
// 产物是 kiro-pack-<platform>-<arch>-<version>.tar.gz，外加同名 .sha256。
// 内容与安装包里的运行时文件一一对应：out/（主进程 + preload + 渲染层）、
// resources/（图标与托盘图）、node_modules/（生产依赖）。
//
// 为什么必须带 node_modules：主进程产物把依赖外置了（electron-vite 的
// externalizeDeps），运行时靠 require 从 node_modules 解析。少了它，
// 资源包加载主进程时会在第一个 require 就抛错。
//
// 用法：node scripts/make-pack.mjs [--platform win32] [--arch x64]
// 不传参数时按当前运行平台产出，适合本机调试。
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : fallback
}

const platform = argOf('platform', process.platform)
const arch = argOf('arch', process.arch)
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').split(/\r?\n/)[0].trim()

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`[Pack] VERSION 不是合法版本号：${JSON.stringify(version)}`)
  process.exit(1)
}

/** 产物必须已经构建好，否则打出来的是空包 */
function requireDir(rel) {
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs)) {
    console.error(`[Pack] 缺少 ${rel}，请先执行 electron-vite build`)
    process.exit(1)
  }
  return abs
}

const outDir = requireDir('out')
const resourcesDir = requireDir('resources')

/**
 * 收集要进包的路径。
 *
 * 依赖只取 package.json 的 dependencies：devDependencies 是构建期用的，
 * 装进资源包既浪费体积又可能引入与运行时无关的原生模块。
 * 递归展开传递依赖，按 node_modules 的实际布局（含嵌套目录）收集。
 */
function collectNodeModules() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const wanted = new Set(Object.keys(pkg.dependencies || {}))
  const seen = new Set()
  const result = []
  const queue = [...wanted]

  while (queue.length) {
    const name = queue.shift()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const dir = path.join(root, 'node_modules', name)
    if (!fs.existsSync(dir)) {
      console.warn(`[Pack] 依赖缺失，跳过：${name}`)
      continue
    }
    result.push(dir)
    let meta
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    // 可选依赖可能没装（如平台不匹配的原生模块），存在才继续展开
    for (const dep of Object.keys(meta.dependencies || {})) queue.push(dep)
    for (const dep of Object.keys(meta.optionalDependencies || {})) queue.push(dep)
  }
  return result
}

/** 递归列文件，返回相对包根的路径 */
function walk(dir, base, list = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(abs, base, list)
      continue
    }
    if (!entry.isFile()) continue
    // 符号链接与设备文件不进包：tar 里存下来在目标机器上也未必可用
    list.push(path.relative(base, abs).split(path.sep).join('/'))
  }
  return list
}

/**
 * 搭一个临时目录拼出包内容，再整体打 tar。
 *
 * 不直接对仓库根打包：会把 .git、src、dist 之类全带进去。
 * 只挑运行时需要的那几块，并把 node_modules 收缩到生产依赖。
 */
const stage = path.join(root, 'dist', `.pack-stage-${platform}-${arch}`)
fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })

function copyInto(from, rel) {
  fs.cpSync(from, path.join(stage, rel), { recursive: true, dereference: true })
}

copyInto(outDir, 'out')
copyInto(resourcesDir, 'resources')

for (const dir of collectNodeModules()) {
  const rel = path.relative(path.join(root, 'node_modules'), dir)
  copyInto(dir, path.join('node_modules', rel))
}

// 清单最后写：它要包含其余所有文件的哈希
const files = []
for (const rel of walk(stage, stage)) {
  const abs = path.join(stage, rel)
  const buf = fs.readFileSync(abs)
  files.push({
    path: rel,
    sha256: createHash('sha256').update(buf).digest('hex'),
    size: buf.length
  })
}

const manifest = {
  version,
  builtAt: new Date().toISOString(),
  // 运行环境必须完全一致：资源包里带原生模块，Electron ABI 与平台架构都不能错
  electron: process.env.PACK_ELECTRON_VERSION || readElectronVersion(),
  platform,
  arch,
  files
}

fs.writeFileSync(
  path.join(stage, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
  'utf8'
)

/** 与当前安装包的 Electron 版本一致；CI 里显式传入避免与运行 CI 的本地版本混淆 */
function readElectronVersion() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')
    ).version
  } catch {
    console.warn('[Pack] 无法读取 Electron 版本，使用空值（应用会拒绝安装）')
    return ''
  }
}

const name = `kiro-pack-${platform}-${arch}-${version}.tar.gz`
const outFile = path.join(root, 'dist', name)
fs.mkdirSync(path.join(root, 'dist'), { recursive: true })

/*
 * 用系统 tar。Windows 上要注意两点：
 *  - Git Bash 里的 tar 是 GNU tar，它会把 "E:\..." 当成远程主机（host:path 形式），
 *    所以这里切到 dist 目录、用相对路径调用，避开盘符解析。
 *  - 文件列表用相对路径，tar 才不会写出绝对路径。
 */
execFileSync('tar', ['-czf', name, '-C', path.basename(stage), '.'], {
  cwd: path.join(root, 'dist'),
  stdio: 'inherit'
})

const digest = createHash('sha256').update(fs.readFileSync(outFile)).digest('hex')
fs.writeFileSync(`${outFile}.sha256`, `${digest}  ${name}\n`, 'utf8')

fs.rmSync(stage, { recursive: true, force: true })

const sizeMb = (fs.statSync(outFile).size / 1048576).toFixed(1)
console.log(`[Pack] ${name}（${sizeMb} MB，${files.length} 个文件）`)
console.log(`[Pack] sha256 ${digest}`)
