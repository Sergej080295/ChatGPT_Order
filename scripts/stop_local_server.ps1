param(
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot

$pidFile = Join-Path $ProjectRoot 'server.pid'
$stopped = New-Object System.Collections.Generic.HashSet[int]

if (Test-Path -LiteralPath $pidFile) {
  $savedPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($savedPid -match '^\d+$') {
    $savedProcess = Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
    if ($savedProcess) {
      Stop-Process -Id $savedProcess.Id -Force
      [void]$stopped.Add($savedProcess.Id)
      Write-Host ("Stopped saved process {0}" -f $savedProcess.Id)
    }
  }
}

$connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($connections) {
  $ownerIds = $connections | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($ownerId in $ownerIds) {
    if ($stopped.Contains([int]$ownerId)) {
      continue
    }
    $process = Get-Process -Id $ownerId -ErrorAction SilentlyContinue
    if ($process) {
      Stop-Process -Id $ownerId -Force
      [void]$stopped.Add([int]$ownerId)
      Write-Host ("Stopped process {0}" -f $ownerId)
    }
  }
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue

if ($stopped.Count -eq 0) {
  Write-Host 'No server is listening on this port.'
}

exit 0
