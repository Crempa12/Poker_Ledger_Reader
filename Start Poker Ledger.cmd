@echo off
rem Double-click this in File Explorer to open the Poker Ledger website on Windows. It reads
rem the console app's folder next to this one (..\Poker_Ledger_Reader). Close this window (or
rem press Ctrl-C) to stop it. Needs Node.js 22.18 or newer (https://nodejs.org).
cd /d "%~dp0"
if not exist node_modules (
  echo First run: installing ^(one time only^)...
  call npm install || goto failed
)
call npm run web
goto :eof

:failed
echo.
echo The install did not finish. Check that Node.js is installed, then try again.
pause
