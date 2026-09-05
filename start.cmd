@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 封包進度板啟動中...
node server.mjs
echo.
echo (伺服器已停止，按任意鍵關閉視窗)
pause >nul
