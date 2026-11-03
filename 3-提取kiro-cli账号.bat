@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

title 提取 kiro-cli 已登录账号

echo ============================================================
echo   提取本机 kiro-cli 已登录账号 -^> JSON
echo ============================================================
echo.

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

node "scripts\extract-kiro-cli-account.mjs"
if errorlevel 1 goto :fail

echo.
echo 复制上面输出的 JSON，粘贴到程序「导入 ^-^> 输入 JSON 导入」即可。
echo 同样的内容也保存在本目录的 kiro-cli-account.json。
echo.
pause
exit /b 0

:fail
echo.
echo 提取失败，请查看上面的错误信息。
pause
exit /b 1
