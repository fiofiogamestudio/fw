@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [FWB] Node.js 22 or newer is required. Install Node.js and try again.
  set "FWB_START_EXIT_CODE=1"
  goto failed
)
node tools\start-editor.mjs %*
set "FWB_START_EXIT_CODE=%ERRORLEVEL%"
if not "%FWB_START_EXIT_CODE%"=="0" goto failed
endlocal & exit /b 0

:failed
echo [FWB] Could not open the workbench. See the error above.
if not "%FW_START_NO_PAUSE%"=="1" pause
endlocal & exit /b %FWB_START_EXIT_CODE%
