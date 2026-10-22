@echo off
setlocal
cd /d "%~dp0"
set "SEAL_PREVIEW_PYTHON=python.exe"
where python.exe >nul 2>nul
if errorlevel 1 (
  if exist "D:\game\youchenghuanjianlu\toolchain\python\python.exe" (
    set "SEAL_PREVIEW_PYTHON=D:\game\youchenghuanjianlu\toolchain\python\python.exe"
  ) else (
    echo Python is not available. See README.md.
    pause
    exit /b 1
  )
)
if not exist "web\manifest.json" (
  "%SEAL_PREVIEW_PYTHON%" tools\extract.py
  if errorlevel 1 (
    echo Extraction failed. See evidence\verification.json.
    pause
    exit /b 1
  )
)
echo Open http://127.0.0.1:8765/ in a browser.
echo Keep this window open. Press Ctrl+C to stop.
"%SEAL_PREVIEW_PYTHON%" serve.py
pause
