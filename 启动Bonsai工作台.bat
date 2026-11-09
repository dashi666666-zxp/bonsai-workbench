@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "BW_PORT=4790"
set "BW_CONFIG=%~dp0bonsai.config.json"
if not exist "%~dp0bonsai.config.json" if exist "%~dp0bonsai.config.example.json" copy /Y "%~dp0bonsai.config.example.json" "%~dp0bonsai.config.json" >nul
set "BW_OPEN=1"
netstat -ano | findstr /C:":4790 " | findstr /C:"LISTENING" >nul
if not errorlevel 1 (
  start "" http://127.0.0.1:4790
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  pause
  exit /b 1
)
node server.mjs
if errorlevel 1 pause