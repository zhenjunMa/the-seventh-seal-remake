@echo off
setlocal
cd /d "%~dp0..\.."
set "SEAL_RUNTIME_PYTHON=python"
if exist ".venv\Scripts\python.exe" set "SEAL_RUNTIME_PYTHON=.venv\Scripts\python.exe"
if not "%~1"=="" goto first_build
echo Open http://127.0.0.1:8767/ in a browser.
echo Keep this window open. Press Ctrl+C to stop.
"%SEAL_RUNTIME_PYTHON%" -B remake\runtime\serve.py
goto done
:first_build
"%SEAL_RUNTIME_PYTHON%" -B remake\runtime\tools\build_runtime.py --target media --original-dir "%~1" --run --serve
:done
pause
