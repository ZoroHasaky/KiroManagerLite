// 把根目录 VERSION 文件写进 package.json 的 version。
//
// 为什么需要这一步：应用里所有版本号都来自 app.getVersion()，而它读的是
// 打包时 package.json 的 version。VERSION 只是给人改的单一真源，
// 打包前必须同步过去，否则界面、托盘、更新检查显示的版本会与实际发布的对不上。
//
// 用法：
//   node scripts/sync-version.mjs          # 把 VERSION 同步到 package.json
//   node scripts/sync-version.mjs --check  # 只校验两者一致（CI 用，不一致则退出码 1）
//
// 不写成 npm 的 postinstall 之类的钩子：那会在每次安装依赖时都改文件，
// 让 package.json 无故变脏。只在真正打包前调用。
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')

/** 语义化版本：数字段 + 可选的 -预发布 / +构建元数据，不允许前导零 */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function readVersionFile() {
  const raw = readFileSync(join(root, 'VERSION'), 'utf8')
  // 只取第一行并去掉首尾空白：编辑器常在结尾补换行，不该因此报错
  return raw.split(/\r?\n/)[0].trim()
}

const version = readVersionFile()

if (!SEMVER.test(version)) {
  console.error(`[版本] VERSION 内容不是合法的语义化版本：${JSON.stringify(version)}`)
  console.error('        期望形如 1.2.3，可选后缀 -beta.1')
  process.exit(1)
}

const pkgPath = join(root, 'package.json')
const pkgText = readFileSync(pkgPath, 'utf8')

if (checkOnly) {
  const current = JSON.parse(pkgText).version
  if (current !== version) {
    console.error(`[版本] VERSION(${version}) 与 package.json(${current}) 不一致`)
    process.exit(1)
  }
  console.log(`[版本] 一致：${version}`)
  process.exit(0)
}

// 只替换顶层的 version 字段，保留原文件其余格式（缩进、键顺序、行尾）
const updated = pkgText.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`)
if (updated === pkgText) {
  console.log(`[版本] package.json 已是 ${version}，无需修改`)
} else {
  writeFileSync(pkgPath, updated)
  console.log(`[版本] 已把 package.json 的 version 同步为 ${version}`)
}
