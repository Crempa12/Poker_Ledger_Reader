@echo off
rem Double-click this in File Explorer to open the Poker Ledger website on Windows. It reads
rem the console app's folder next to this one (..\Poker_Ledger_Reader). Close this window (or
rem press Ctrl-C) to stop it. Needs Node.js 22.18 or newer (https://nodejs.org).
cd /d "%~dp0"
where npm >nul 2>nul || goto nonode
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)" || goto oldnode
if not exist node_modules (
  echo First run: installing ^(one time only^)...
  call npm install || goto noinstall
)
call npm run web || goto nostart
goto :eof

:nonode
echo Node.js is not installed (npm was not found).
echo Install Node.js 22.18 or newer from https://nodejs.org, then double-click this file again.
goto failed

:oldnode
echo This needs Node.js 22.18 or newer. Install it from https://nodejs.org, then double-click this file again.
goto failed

:noinstall
echo The install did not finish. Check that you are online, then try again.
goto failed

:nostart
echo The site stopped or did not start. The lines above say why.

:failed
echo.
pause
