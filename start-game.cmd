@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo 请在浏览器打开 http://127.0.0.1:8767/
echo 游戏运行期间请保持此窗口开启，按 Ctrl+C 停止服务。
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -X utf8 -B remake\runtime\serve.py
) else (
    python -X utf8 -B remake\runtime\serve.py
)
if errorlevel 1 pause
