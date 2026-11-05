# Download the latest Stockfish Windows build into engine/stockfish.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/download_stockfish.ps1

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$engineDir = Join-Path $root "engine"
$target = Join-Path $engineDir "stockfish"
$zip = Join-Path $engineDir "stockfish.zip"

New-Item -ItemType Directory -Force -Path $engineDir | Out-Null

Write-Host "Looking up the latest Stockfish release…"
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/official-stockfish/Stockfish/releases/latest" `
    -Headers @{ "User-Agent" = "KnightWatch-setup" }

$asset = $release.assets | Where-Object { $_.name -match "windows-x86-64-universal\.zip$" } | Select-Object -First 1
if (-not $asset) {
    throw "Could not find a Windows x86-64 universal build in release $($release.tag_name)."
}

Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)…"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing

if (Test-Path $target) {
    Remove-Item -Recurse -Force $target
}
Expand-Archive -Path $zip -DestinationPath $target -Force
Remove-Item $zip -Force

$exe = Get-ChildItem -Path $target -Recurse -Filter "stockfish*.exe" | Select-Object -First 1
if (-not $exe) {
    throw "Extraction finished but no stockfish executable was found."
}

Write-Host ""
Write-Host "Stockfish ready: $($exe.FullName)"
Write-Host "KnightWatch will find it automatically. You can also set STOCKFISH_PATH to use another build."
