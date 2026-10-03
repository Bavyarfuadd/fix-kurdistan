@echo off
cd /d "%~dp0"
title Slemani Fix AI

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org then run this file again.
  pause
  exit /b
)

if not exist .env (
  echo Creating .env ...
  > .env echo ANTHROPIC_API_KEY=
  >> .env echo ADMIN_KEY=admin123
  >> .env echo PORT=3000
)

if not exist "node_modules\better-sqlite3\build\Release\better_sqlite3.node" (
  echo Installing packages, please wait ...
  call npm install
)

echo.
echo Starting server. Keep this window open.
echo Admin key is: admin123
echo.
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"
call npm start
pause
