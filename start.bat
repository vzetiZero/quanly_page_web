@echo off
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Dependencies are not installed yet. Running setup.bat...
  call setup.bat
  if errorlevel 1 exit /b 1
)

node server.js
