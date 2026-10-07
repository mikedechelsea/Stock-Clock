@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js LTS from https://nodejs.org
  pause
  exit /b 1
)
node.exe -v
npm.cmd install
echo.
echo Installed (BigQuery client, dotenv, wrangler).
echo Next: double-click setup.cmd
pause
