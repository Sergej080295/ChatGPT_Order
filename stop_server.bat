@echo off
setlocal

set "PORT=3000"

echo Stopping server on port %PORT%...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop_local_server.ps1" -Port %PORT%
if errorlevel 1 (
  pause
  exit /b 1
)

exit /b 0
