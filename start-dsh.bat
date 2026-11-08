@echo off
chcp 936 >nul
setlocal
title DeepSeek Harness (dsh web)

REM ============================================================
REM  DeepSeek Harness one-click launcher
REM
REM  NOTE: this file is saved in GBK / ANSI encoding on purpose.
REM  cmd.exe reads .bat byte by byte and ignores chcp, so UTF-8
REM  Chinese text here gets cut into pieces and run as commands.
REM  If you edit this file, save it as ANSI / GBK, never as UTF-8.
REM
REM  DSH_VER pins the version so it matches the deploy manual and
REM  the video. Change it to latest if you want to track upstream.
REM ============================================================

set "DSH_VER=0.2.1-rc.5"
set "DSH_REGISTRY=https://registry.npmmirror.com"

cd /d "%USERPROFILE%"

echo.
echo   DeepSeek Harness -- starting dsh web
echo   version  : %DSH_VER%
echo   registry : %DSH_REGISTRY%
echo.

REM ---------- 1. Node installed ----------
set "NODE_V="
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_V=%%v"
if not defined NODE_V goto :no_node

REM ---------- 2. Node major version ----------
set "NODE_MAJOR=0"
for /f "tokens=1 delims=v." %%a in ("%NODE_V%") do set "NODE_MAJOR=%%a"
if %NODE_MAJOR% LSS 22 goto :old_node

echo   Node %NODE_V%  OK
echo.
echo   浏览器会自动打开。窗口别关，关掉服务就停。
echo   要停止服务，按 Ctrl 加 C，或者直接关窗口。
echo.

REM ---------- 3. start ----------
call npx -y --registry=%DSH_REGISTRY% @deepseek-ai/dsh@%DSH_VER% web
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" goto :fail
echo   dsh 已退出。
goto :end

:no_node
echo   [X] 没有找到 Node.js。
echo.
echo       先装 Node.js 22 LTS，装完关掉这个窗口，重新双击。
echo       下载地址 https://nodejs.org/
echo.
pause
exit /b 1

:old_node
echo   [!] 当前 Node 是 %NODE_V%，这个项目要 22 或更高。
echo.
echo       装完新版 Node 后，关掉这个窗口，重新双击。
echo.
pause
exit /b 1

:fail
echo   [X] 启动失败，退出码 %RC%。
echo.
echo       常见原因三类。
echo       网络不通，换网络重试，或者检查代理设置。
echo       端口占用，关掉已经开着的 DSH 窗口再试。
echo       版本过低，Node 要 22 以上。
echo.
echo       还不行就把上面的报错发给 AI，让它对照 docs 里的部署手册第五节。
pause
exit /b %RC%

:end
echo.
pause
exit /b 0
