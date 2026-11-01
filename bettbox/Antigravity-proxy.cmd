@echo off
chcp 65001 >nul
rem Antigravity 代理启动器（Bettbox「系统代理」模式专用）
rem
rem 为什么需要：Antigravity 的 AI 请求由 resources\bin\language_server.exe 发出，
rem   它只认 HTTPS_PROXY 等环境变量，不读 Windows 系统代理，系统代理模式下直连会失败。
rem 作用范围：只对本脚本启动的 Antigravity 及其子进程生效，不改全局环境变量。
rem TUN 模式下不需要本脚本（流量已被 TUN 接管），用了也无害。
rem
rem 用法：双击运行；或右键「发送到桌面快捷方式」替代原来的 Antigravity 图标。
rem ⚠️ 必须先完全退出 Antigravity（含托盘），否则新实例会复用旧进程，环境变量不生效。

setlocal
set "PROXY_PORT=7890"
set "AG_EXE=%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"

if not exist "%AG_EXE%" (
  echo 找不到 Antigravity：%AG_EXE%
  pause
  exit /b 1
)

tasklist /fi "imagename eq Antigravity.exe" /nh | "%SystemRoot%\System32\find.exe" /i "Antigravity.exe" >nul
if not errorlevel 1 (
  echo Antigravity 正在运行，请先完全退出（含托盘图标）再运行本脚本。
  pause
  exit /b 1
)

set "HTTP_PROXY=http://127.0.0.1:%PROXY_PORT%"
set "HTTPS_PROXY=http://127.0.0.1:%PROXY_PORT%"
set "ALL_PROXY=http://127.0.0.1:%PROXY_PORT%"
set "NO_PROXY=localhost,127.0.0.1,::1,*.ts.net,100.64.0.0/10"

start "" "%AG_EXE%" %*
endlocal
