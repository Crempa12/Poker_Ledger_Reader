#!/bin/bash
# Double-click this in Finder to open the Poker Ledger website. It reads the console
# app's folder next to this one (../Poker_Ledger_Reader), or its own data/ folder when
# there is none. Close the Terminal window (or press Ctrl-C) to stop it.
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
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'; then
  echo "This needs Node.js 22.18 or newer; this computer has $(node -v 2>/dev/null || echo none)."
  echo "Install it from https://nodejs.org, then double-click this file again."
  pause_then_exit
fi
if [ ! -d node_modules ]; then
  echo "First run: installing (one time only)..."
  npm install || {
    echo "The install did not finish. Check that Node.js 22.18 or newer is installed and that you are online, then try again."
    pause_then_exit
  }
fi
# Double-clicked again while this copy's site runs: open that one, not a second site on the next port. A Poker
# Ledger site from another folder (with its own data) is left alone: the process on the port must run from here.
here="$(pwd -P)/apps/web"
for port in 5173 5174 5175 5176 5177; do
  if curl -s -m 2 "http://127.0.0.1:$port/" 2>/dev/null | grep -q "<title>Poker Ledger</title>"; then
    pid="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1)"
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    if [ -n "$pid" ] && [ "$cwd" = "$here" ]; then
      echo "The site is already running at http://127.0.0.1:$port (in another Terminal window). Opening it."
      open "http://127.0.0.1:$port/"
      exit 0
    fi
  fi
done
npm run web || {
  echo "The site stopped or did not start. The lines above say why."
  pause_then_exit
}
