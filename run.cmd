@echo off
REM Stock Clock - BigQuery snapshot to Cloudflare KV (Node, not PowerShell - Avast-safe)
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install LTS from https://nodejs.org then double-click this file again.
  pause
  exit /b 1
)

echo.
echo Stock Clock pipeline
echo Folder: %cd%
echo.

node.exe pipeline_engine.js
set ERR=%ERRORLEVEL%

echo.
if %ERR%==0 (
  echo Done. KV was updated. Refresh the site.
) else (
  echo Pipeline stopped with code %ERR%.
  echo If it says 0 rows, run sql\01_sku_snapshot.sql in BigQuery first.
)
echo.
pause
exit /b %ERR%
