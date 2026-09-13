@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [FWV] Node.js 20.10 or newer is required. Install Node.js and try again.
  set "FWV_START_EXIT_CODE=1"
  goto failed
)
node tools\start-editor.mjs %*
set "FWV_START_EXIT_CODE=%ERRORLEVEL%"
if not "%FWV_START_EXIT_CODE%"=="0" goto failed
endlocal & exit /b 0

:failed
echo [FWV] Could not open the workbench. See the error above.
if not "%FW_START_NO_PAUSE%"=="1" pause
endlocal & exit /b %FWV_START_EXIT_CODE%
