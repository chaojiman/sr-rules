@echo off
setlocal
cd /d "%~dp0"

rem ============ Build + install Bettbox override script ============
rem Nodes:  proxies.local.json here (gitignored, holds credentials)
rem         if missing -> auto-extract from Bettbox script cache
rem Output: bettbox\mihomoScript.js  (holds nodes, NEVER commit)
rem Install: %%APPDATA%%\com.appshub\Bettbox\scripts\<script id>.js

if exist "proxies.local.json" (
  set "BETTBOX_PROXIES_FILE=%~dp0proxies.local.json"
  echo Nodes source: proxies.local.json
) else (
  set "BETTBOX_PROXIES_FILE=auto"
  echo Nodes source: Bettbox script cache ^(auto^)
)

set "NODE_USE_ENV_PROXY=1"
if not defined HTTPS_PROXY set "HTTPS_PROXY=http://127.0.0.1:7890"

echo.
echo [1/5] Build...
node scripts\build-bettbox.mjs || goto :fail

echo.
echo [2/5] Validate...
node scripts\validate-configs.mjs || goto :fail

echo.
echo [3/5] Prepare paste-ready copy...
node -e "const fs=require('fs');fs.copyFileSync('bettbox/mihomoScript.js','paste-me.js');console.log('  ready: '+require('path').resolve('paste-me.js'))" || goto :fail
rem IMPORTANT: rebuild workspace output without nodes (avoid committing credentials)
echo.
echo [4/5] Restore credential-free workspace copy...
set "BETTBOX_PROXIES_FILE="
node scripts\build-bettbox.mjs >nul 2>&1
node -e "const fs=require('fs');const s=fs.readFileSync('bettbox/mihomoScript.js','utf8');const leak=/^const customizeProxies = \[\s*\{/m.test(s);console.log(leak?'  WARN: workspace copy still has nodes':'  clean (no credentials in repo output)');process.exit(leak?1:0)" || goto :fail

echo.
echo [5/5] Done
echo   Open paste-me.js, Ctrl+A / Ctrl+C, paste into Bettbox script editor, save + reconnect.
echo     cha-shi-luo-di / cha-shi-luo-di-riben / cha-shi-luo-di-meiguo
echo   Verify exit IP matches your landing node
echo.
pause
exit /b 0

:fail
echo.
echo Build or validation failed. Nothing copied.
pause
exit /b 1
