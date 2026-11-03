@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

title Kiro Manager Lite - 快速测试

echo ============================================================
echo   Kiro Manager Lite  ^|  编译并运行（快速测试）
echo ============================================================
echo.

rem ---------- 环境检查 ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 22.19 或更高版本。
  goto :fail
)

node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=19)?0:1)"
if errorlevel 1 (
  echo [错误] Node.js 版本过低，需要 22.19 或更高版本，当前：
  node -v
  goto :fail
)

rem ---------- 国内镜像（已设置则沿用） ----------
if not defined ELECTRON_MIRROR set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
if not defined ELECTRON_BUILDER_BINARIES_MIRROR set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

rem ---------- 依赖安装（仅首次） ----------
if not exist "node_modules\electron-vite\package.json" goto :install
echo [1/3] 依赖已安装，跳过 npm install。
goto :electron

:install
echo [1/3] 正在安装依赖，首次运行需要几分钟……
call npm install
if errorlevel 1 goto :fail

rem ---------- Electron 运行时 ----------
rem npm 11 默认不执行依赖的 install 脚本，Electron 二进制需要单独补齐
:electron
if exist "node_modules\electron\path.txt" goto :build
echo.
echo [1/3] 正在下载 Electron 运行时（约 150MB）……
call node "node_modules\electron\install.js"
if errorlevel 1 goto :fail

rem ---------- 编译 ----------
:build
echo.
echo [2/3] 正在编译……
call npx --no-install electron-vite build
if errorlevel 1 goto :fail

rem ---------- 运行 ----------
echo.
echo [3/3] 启动程序，关闭应用窗口即退出……
echo.
call npx --no-install electron .
if errorlevel 1 goto :fail

echo.
echo 程序已退出。
pause
exit /b 0

:fail
echo.
echo 执行失败，请查看上面的错误信息。
pause
exit /b 1
