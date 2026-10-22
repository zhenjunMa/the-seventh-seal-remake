@echo off
cd /d "%~dp0"
set "SEAL_RUNTIME_PYTHON=python"
where python >nul 2>nul
if errorlevel 1 set "SEAL_RUNTIME_PYTHON=D:\game\youchenghuanjianlu\toolchain\python\python.exe"
echo Open http://127.0.0.1:8767/ in a browser.
echo Keep this window open. Press Ctrl+C to stop.
"%SEAL_RUNTIME_PYTHON%" -B serve.py
pause
