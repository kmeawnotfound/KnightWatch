# Start KnightWatch on http://127.0.0.1:8000
# Usage:  powershell -ExecutionPolicy Bypass -File run.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    throw "Python 3.10+ is required. Install it from https://www.python.org/downloads/ and try again."
}

$missing = @()
foreach ($module in @("fastapi", "uvicorn", "httpx", "chess")) {
    & python -c "import $module" 2>$null
    if ($LASTEXITCODE -ne 0) { $missing += $module }
}
if ($missing.Count -gt 0) {
    Write-Host "Installing Python dependencies…"
    & python -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
}

$stockfish = Get-ChildItem -Path (Join-Path $root "engine") -Recurse -Filter "stockfish*.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $stockfish -and -not $env:STOCKFISH_PATH) {
    Write-Host ""
    Write-Host "No local Stockfish found. The app still works with Lichess analysis and cloud eval."
    $answer = Read-Host "Download Stockfish now? [y/N]"
    if ($answer -match "^[yY]") {
        & powershell -ExecutionPolicy Bypass -File (Join-Path $root "scripts/download_stockfish.ps1")
    }
}

Write-Host ""
Write-Host "Starting KnightWatch at http://127.0.0.1:8000"
Write-Host "Press Ctrl+C to stop."
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 2
    Start-Process "http://127.0.0.1:8000"
} | Out-Null
& python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
