@echo off
setlocal
cd /d "%~dp0"
title 云手机保活控制台

set "NODE_EXE="

rem 1) 优先用 PATH 里的 node
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"

rem 2) 再找常见安装位置
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

rem 3) 最后扫 nvm / WorkBuddy 自带的 node
if not defined NODE_EXE if exist "%APPDATA%\nvm\node.exe" set "NODE_EXE=%APPDATA%\nvm\node.exe"
for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if not defined NODE_EXE if exist "%%~d\node.exe" set "NODE_EXE=%%~d\node.exe"

if not defined NODE_EXE (
  echo.
  echo  [x] 没有找到 Node.js
  echo.
  echo      请先安装 Node 18 或更高版本（网页登录 / 真实截屏功能需 22+）：
  echo          https://nodejs.org/
  echo.
  echo      安装时保持勾选 "Add to PATH"，装完关掉本窗口重新双击 start.bat。
  echo.
  pause
  exit /b 1
)

echo.
echo  [*] 使用 Node: %NODE_EXE%
echo  [*] 启动中，稍后自动打开浏览器 ...
echo.

rem 2 秒后自动开浏览器，避免页面先于服务加载
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8787'"

"%NODE_EXE%" server.js

echo.
echo  [!] 服务已退出。若上方有报错，按此排查：
echo      - 端口被占用：set PORT=9000 后重新运行
echo      - 依赖或数据异常：删除 data\db.json 后重试（会重建默认管理员）
echo.
pause
