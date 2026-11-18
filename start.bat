@echo off
cd /d "%~dp0"
echo Starting KeepAlive Console ...
start "" http://127.0.0.1:8787
node server.js
pause
