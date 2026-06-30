@echo off
REM Double-click to start the 4H sweep monitor. Leave this window open.
cd /d "%~dp0"
:loop
node monitor.mjs
echo.
echo Monitor stopped (exit code %errorlevel%). Restarting in 10s... Press Ctrl+C to quit.
timeout /t 10 /nobreak >nul
goto loop
