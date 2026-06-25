$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $root "scripts\codex-oauth-webui.mjs"
$outLog = Join-Path $root "codex-oauth-webui.log"
$errLog = Join-Path $root "codex-oauth-webui.err.log"
$url = "http://127.0.0.1:1466"

if (-not (Test-Path -LiteralPath $script)) {
  throw "WebUI script not found: $script"
}

$node = Get-Command -Name "node" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
  throw "Node.js was not found on PATH. Install Node.js 18 or newer, then run npm install."
}

$listeners = Get-NetTCPConnection -LocalPort 1466 -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
  Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 500

Start-Process `
  -FilePath $node.Source `
  -ArgumentList @($script) `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog

Start-Sleep -Seconds 1
Start-Process $url

Write-Host "Codex OAuth WebUI started: $url"
Write-Host "Logs:"
Write-Host "  $outLog"
Write-Host "  $errLog"
