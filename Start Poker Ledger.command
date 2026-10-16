#!/bin/bash
# Double-click this in Finder to open the Poker Ledger website. It reads the console
# app's folder next to this one (../Poker_Ledger_Reader). Close the Terminal window
# (or press Ctrl-C) to stop it.
cd "$(dirname "$0")" || exit 1
pause_then_exit() {
  echo ""
  read -r -p "Press Return to close this window. " _
  exit 1
}
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is not installed (npm was not found)."
  echo "Install Node.js 22.18 or newer from https://nodejs.org, then double-click this file again."
  pause_then_exit
fi
if [ ! -d node_modules ]; then
  echo "First run: installing (one time only)..."
  npm install || {
    echo "The install did not finish. Check that Node.js 22.18 or newer is installed and that you are online, then try again."
    pause_then_exit
  }
fi
npm run web
