@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

title Kiro Manager Lite - 打包 Windows x64 安装包

echo ============================================================
echo   Kiro Manager Lite  ^|  编译并打包 Windows x64 安装包
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
if not exist "node_modules\electron-builder\package.json" goto :install
echo [1/5] 依赖已安装，跳过 npm install。
goto :electron

:install
echo [1/5] 正在安装依赖，首次运行需要几分钟……
call npm install
if errorlevel 1 goto :fail

rem ---------- Electron 运行时 ----------
rem npm 11 默认不执行依赖的 install 脚本，Electron 二进制需要单独补齐
:electron
if exist "node_modules\electron\path.txt" goto :clean
echo.
echo [1/5] 正在下载 Electron 运行时（约 150MB）……
call node "node_modules\electron\install.js"
if errorlevel 1 goto :fail

rem ---------- 清理旧产物 ----------
:clean
echo.
echo [2/5] 清理旧编译产物与安装包……
call npm run clean
if errorlevel 1 goto :fail

rem ---------- 编译 ----------
echo.
echo [3/5] 正在编译……
call npx --no-install electron-vite build
if errorlevel 1 goto :fail

rem ---------- 打包 ----------
echo.
echo [4/5] 正在打包 Windows x64 安装包，需要几分钟……
call npx --no-install electron-builder --win --x64 --publish never
if errorlevel 1 (
  echo.
  echo [提示] 打包失败多半是下载 NSIS / winCodeSign 工具链时网络中断。
  echo        如果你本机开着代理，可在运行前设置：
  echo          set HTTPS_PROXY=http://127.0.0.1:7899
  echo        然后重新双击本脚本。
  goto :fail
)

rem ---------- 结果 ----------
echo.
echo [5/5] 完成。
echo ============================================================
echo   安装包位于 dist 目录：
echo ============================================================
dir /b /o-d "dist\*.exe" 2>nul
echo.
start "" "dist"
pause
exit /b 0

:fail
echo.
echo 执行失败，请查看上面的错误信息。
pause
exit /b 1
