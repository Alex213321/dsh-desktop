@echo off
setlocal
cd /d "%~dp0"

echo ==============================================
echo   DSH Desktop - One-click Install
echo ==============================================
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found. Please install Node.js first: https://nodejs.org/
  pause
  exit /b 1
)

if "%ELECTRON_MIRROR%"=="" set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

if exist "node_modules\electron\dist\electron.exe" (
  echo [1/2] Electron already installed, skipping download.
  goto :shortcut
)

echo [1/2] Downloading Electron runtime (one-time, about 110MB)...
call npm install
if errorlevel 1 (
  echo.
  echo [ERROR] npm install failed. Check your network and run this script again.
  pause
  exit /b 1
)

:shortcut
echo [2/2] Creating desktop shortcut "DSH Desktop"...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1"
if errorlevel 1 (
  echo [WARN] Shortcut creation failed. You can start manually with: npm start
  pause
  exit /b 1
)

echo.
echo ==============================================
echo   Done! Double-click "DSH Desktop" on your desktop.
echo   First launch: enter your DeepSeek API Key, then the
echo   official DSH downloads automatically (first time only).
echo ==============================================
pause