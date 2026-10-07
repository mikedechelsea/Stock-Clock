@echo off
cd /d "%~dp0"
call npx.cmd wrangler deploy
pause
