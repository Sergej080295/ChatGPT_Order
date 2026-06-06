@echo off
setlocal

cd /d "%~dp0"

set "PORT=3000"
set "BRANCH=codex/fix-date-calculation-issue"

echo Updating from GitHub branch %BRANCH%...
git fetch origin %BRANCH% --prune
if errorlevel 1 (
  echo Git fetch failed. Check internet connection or Git installation.
  pause
  exit /b 1
)

git merge --ff-only origin/%BRANCH%
if errorlevel 1 (
  echo Git update failed. Local changes may need attention before updating.
  pause
  exit /b 1
)

echo Installing or refreshing dependencies...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

echo Starting server at http://localhost:%PORT%
echo Use stop_server.bat to stop it.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_local_server.ps1" -Port %PORT%
if errorlevel 1 (
  pause
  exit /b 1
)

timeout /t 2 >nul
start "" "http://localhost:%PORT%"

exit /b 0
