@echo off
REM Stock Clock one-time setup: D1 database, secrets, first deploy.
cd /d "%~dp0"

echo.
echo === 1/4  Cloudflare login (skip with Ctrl+C if already logged in) ===
call npx.cmd wrangler whoami
if errorlevel 1 call npx.cmd wrangler login

echo.
echo === 2/4  Create D1 database and load tables + demo people ===
node.exe scripts\setup-d1.mjs
if errorlevel 1 goto fail

echo.
echo === 3/4  Secrets (paste each value, then Enter) ===
echo OWNER_TOKEN = any long random password. It unlocks owner mode on the site.
call npx.cmd wrangler secret put OWNER_TOKEN
echo SLACK_WEBHOOK_URL = https://hooks.slack.com/services/...
call npx.cmd wrangler secret put SLACK_WEBHOOK_URL
echo RESEND_API_KEY = re_...
call npx.cmd wrangler secret put RESEND_API_KEY
echo ALERT_EMAIL_TO = the email address you signed up to Resend with
call npx.cmd wrangler secret put ALERT_EMAIL_TO

echo.
echo === 4/4  Deploy ===
call npx.cmd wrangler deploy
if errorlevel 1 goto fail
echo.
echo Done. Copy the workers.dev URL above into PUBLIC_URL in wrangler.toml, then run deploy.cmd once more.
pause
exit /b 0

:fail
echo Setup stopped. Read the message above.
pause
exit /b 1
