#!/bin/bash
# Double-click this in Finder to open the Poker Ledger website. It reads the console
# app's folder next to this one (../Poker_Ledger_Reader). Close the Terminal window
# (or press Ctrl-C) to stop it.
cd "$(dirname "$0")" || exit 1
if [ ! -d node_modules ]; then
  echo "First run: installing (one time only)..."
  npm install || exit 1
fi
npm run web
