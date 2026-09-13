@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
where node >nul 2>nul
if errorlevel 1 (
  echo [FW] Node.js 20.10 or newer is required. Install Node.js and reopen this launcher.
  set "FW_START_EXIT=1"
  goto failed
)
node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major<20 || (major===20 && minor<10) ? 1 : 0)" >nul 2>nul
if errorlevel 1 (
  echo [FW] Node.js 20.10 or newer is required. Update Node.js and reopen this launcher.
  set "FW_START_EXIT=1"
  goto failed
)
node tools\start.mjs %*
set "FW_START_EXIT=%ERRORLEVEL%"
if not "%FW_START_EXIT%"=="0" goto failed
popd
exit /b 0
:failed
echo [FW] Startup failed. See the error above.
if not defined FW_START_NO_PAUSE pause
popd
exit /b %FW_START_EXIT%
