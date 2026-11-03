#!/bin/bash
# macOS 打包：Kiro Manager Lite / Apple Silicon（arm64）
#
# 双击运行（或在终端里 ./3-打包macOS安装包.command）。
# 首次运行如果提示「无法打开，因为来自身份不明的开发者」，先执行一次：
#   chmod +x "3-打包macOS安装包.command"
#
# 产物：dist/*.dmg（拖进「应用程序」安装）、dist/*.zip（自动更新用）

set -e
cd "$(dirname "$0")"

echo "============================================================"
echo "  Kiro Manager Lite  |  编译并打包 macOS arm64 安装包"
echo "============================================================"
echo

# ---------- 环境检查 ----------
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 Node.js，请先安装 Node.js 22.19 或更高版本。"
  exit 1
fi

if ! node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=19)?0:1)"; then
  echo "[错误] Node.js 版本过低，需要 22.19 或更高版本，当前："
  node -v
  exit 1
fi

# ---------- 架构提示 ----------
# 脚本只打 arm64。在 Intel Mac 上跑也能出包（交叉编译），但生成的包装不进 Intel 机器，
# 这里明确提醒一句，避免有人打完发现自己的机器装不上。
ARCH=$(uname -m)
if [ "$ARCH" != "arm64" ]; then
  echo "[提示] 当前机器是 $ARCH，本脚本产出的是 Apple Silicon（arm64）安装包，"
  echo "       只能装在 M 系列芯片的 Mac 上。需要 Intel 版本请用 npm run build:mac。"
  echo
fi

# ---------- 依赖安装（仅首次） ----------
if [ ! -d node_modules/electron-builder ]; then
  echo "[1/4] 正在安装依赖，首次运行需要几分钟……"
  npm install
else
  echo "[1/4] 依赖已安装，跳过 npm install。"
fi

# ---------- 编译 ----------
echo
echo "[2/4] 正在编译……"
npm run prepack:dist

# ---------- 打包 ----------
echo
echo "[3/4] 正在打包 macOS arm64 安装包，需要几分钟……"
if ! npx electron-builder --mac --arm64 --config electron-builder.mac-arm.yml --publish never; then
  echo
  echo "[提示] 打包失败多半是下载 Electron / dmg 工具链时网络中断。"
  echo "       开着代理的话，可以在运行前设置："
  echo "         export HTTPS_PROXY=http://127.0.0.1:7890"
  echo "       然后重新双击本脚本。"
  exit 1
fi

# ---------- 结果 ----------
echo
echo "[4/4] 完成。"
echo "============================================================"
echo "  安装包位于 dist 目录："
echo "============================================================"
ls -lh dist/*.dmg dist/*.zip 2>/dev/null || ls -lh dist/ 2>/dev/null | tail -10
echo
open dist 2>/dev/null || true
