@echo off
setlocal
echo ============================================
echo  OPUS - Dev mode start
echo ============================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dev.ps1"
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to start. Check message above.
  pause
)
