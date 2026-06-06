param(
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot

$env:PORT = [string]$Port
$stdoutLog = Join-Path $ProjectRoot 'server.out.log'
$stderrLog = Join-Path $ProjectRoot 'server.err.log'
$pidFile = Join-Path $ProjectRoot 'server.pid'

$existingConnections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existingConnections) {
  $ownerIds = $existingConnections | Select-Object -ExpandProperty OwningProcess -Unique
  $savedPid = $null
  if (Test-Path -LiteralPath $pidFile) {
    $savedPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  }
  if ($savedPid -match '^\d+$' -and $ownerIds -contains [int]$savedPid) {
    Write-Host ("Restarting existing server process {0}..." -f $savedPid)
    Stop-Process -Id ([int]$savedPid) -Force
    Start-Sleep -Seconds 2
  } else {
    Write-Host ("Port {0} is already in use by another process. Run stop_server.bat or free the port." -f $Port)
    exit 1
  }
}

$process = Start-Process `
  -FilePath 'node.exe' `
  -ArgumentList 'server.js' `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
Start-Sleep -Seconds 3

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listening) {
  Write-Host 'Server process started but the port is not listening yet. Check server.err.log.'
  exit 1
}

Write-Host ("Server started. PID: {0}" -f $process.Id)
exit 0
