@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  PsDesign - Dev mode start
echo ============================================
call npm run tauri dev
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to start. Check message above.
  pause
)
