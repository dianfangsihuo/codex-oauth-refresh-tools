$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $root "scripts\codex-oauth-webui.mjs"
$outLog = Join-Path $root "codex-oauth-webui.log"
$errLog = Join-Path $root "codex-oauth-webui.err.log"
$url = "http://127.0.0.1:1466"

if (-not (Test-Path -LiteralPath $script)) {
  throw "WebUI script not found: $script"
}

$listeners = Get-NetTCPConnection -LocalPort 1466 -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
  Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 500

Start-Process `
  -FilePath "node" `
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
