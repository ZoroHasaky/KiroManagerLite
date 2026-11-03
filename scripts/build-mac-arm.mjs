// macOS arm64（Apple Silicon）打包。
//
// 与 build-mac.mjs 的区别：那个脚本打 arm64 + x64 两个架构，还要额外产 pkg；
// 这个只出 Apple Silicon 一份，产物是 dmg + zip（zip 供自动更新用）。
//
// 只能在 macOS 上运行：electron-builder 在 Windows / Linux 上打 mac 目标会直接报错
// （见 app-builder-lib/out/packager.js 的 "Build for macOS is supported only on macOS"），
// 不是配置问题，也没有可行的交叉编译绕法。所以这里启动前先拦一道，给出可操作的提示，
// 而不是让用户等它跑了一半才看到一串英文报错。
//
// 为什么用 electron-builder.mac-arm.yml 这个覆盖配置文件、而不是命令行参数：
//   electron-builder.yml 的 mac.target 里每个目标都写死了 arm64 + x64，命令行给 --arm64
//   只做架构过滤，不会把 target 列表收窄，pkg 仍会被打一遍；而 pkg 的中间产物在 dist/ 下
//   用固定文件名，多架构并行会互相删除导致 ENOENT。覆盖文件用 extends 继承原配置，
//   只把 mac.target 改成 arm64 的 dmg + zip，其余字段原样保留。
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const here = dirname(fileURLToPath(import.meta.url))
const configPath = join(here, '..', 'electron-builder.mac-arm.yml')

if (process.platform !== 'darwin') {
  console.error('')
  console.error('macOS 安装包只能在 macOS 上打（Apple Silicon 或 Intel 的 Mac 都行）。')
  console.error(`当前系统是 ${process.platform}，继续执行会被 electron-builder 直接拒绝。`)
  console.error('')
  console.error('可选做法：')
  console.error('  1. 在 Mac 上运行：npm run build:mac:arm')
  console.error('  2. 推一个 v* 标签，由 GitHub Actions 的 macOS runner 自动产出（见 .github/workflows/release.yml）')
  console.error('')
  process.exit(1)
}

const extra = process.argv.slice(2)

const args = [
  'electron-builder',
  '--mac',
  '--arm64',
  '--config',
  configPath,
  // 只打包不发布；上传由调用方（CI 或人工）决定
  '--publish',
  'never',
  ...extra
]

console.log('正在打包 macOS arm64（dmg + zip）…')
const result = spawnSync('npx', args, { stdio: 'inherit' })
if (result.status !== 0) {
  console.error('')
  console.error('打包失败。常见原因：')
  console.error('  - 首次打包要下载 Electron darwin-arm64 运行时与 dmg 工具链，网络中断会失败')
  console.error('  - 开了代理的话可在运行前设置 HTTPS_PROXY 后重试')
  process.exit(result.status ?? 1)
}
console.log('')
console.log('完成。产物在 dist/ 目录：')
console.log('  *.dmg   —— 拖进「应用程序」安装')
console.log('  *.zip   —— 自动更新用，手动安装请用 dmg')
