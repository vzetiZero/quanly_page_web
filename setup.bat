@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Install Node.js 18+ first.
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found in PATH. Install Python 3.10+ first.
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [1/4] Creating Python virtual environment...
  python -m venv .venv
  if errorlevel 1 goto :error
) else (
  echo [1/4] Python virtual environment already exists.
)

echo [2/4] Installing Python dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto :error
".venv\Scripts\python.exe" -m pip install -r python\requirements.txt
if errorlevel 1 goto :error

echo [3/4] Installing Node dependencies...
call npm install
if errorlevel 1 goto :error

if not exist ".env" (
  echo [4/4] Creating .env from .env.example...
  copy /Y ".env.example" ".env" >nul
) else (
  echo [4/4] .env already exists, keeping it.
)

echo.
echo Setup complete. Run start.bat to open the app.
exit /b 0

:error
echo.
echo Setup failed. Please check the messages above.
exit /b 1
