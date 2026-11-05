@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.10+ is required. Install it from https://www.python.org/downloads/
  pause
  exit /b 1
)

python -c "import fastapi, uvicorn, httpx, chess" >nul 2>nul
if errorlevel 1 (
  echo Installing Python dependencies...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting KnightWatch at http://127.0.0.1:8000
echo Press Ctrl+C to stop.
start "" powershell -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8000'"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
