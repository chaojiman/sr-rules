@echo off
setlocal
cd /d "%~dp0"

rem ===== Pull latest GitHub script + inject local landing nodes into Bettbox =====
rem Edit proxies.local.json to change nodes, then run this file, then reconnect Bettbox.

set "NODE_USE_ENV_PROXY=1"
if not defined HTTPS_PROXY set "HTTPS_PROXY=http://127.0.0.1:7890"

node scripts\inject-local-nodes.mjs
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo Injection failed - Bettbox script left untouched.
  pause
  exit /b 1
)

echo.
pause
exit /b 0
