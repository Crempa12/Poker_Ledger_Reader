#!/usr/bin/env bash
# Reference harness for the TypeScript port of the ledger side.
#
# Runs the C++ Poker Ledger Reader on one data root and keeps every export and printed view that
# the ledger side needs, so the TypeScript code can be checked against it to the cent.
#
#   reference/run.sh --code <C++ repo> --data <data root> --out <new folder> [--tz America/New_York]
#
#   --code  the C++ repo. Only main.cpp, CMakeLists.txt, src/ and tools/ are copied from it.
#   --data  a folder with Games/ and Saved_Data/. Only those two are copied from it.
#   --out   a folder that must not exist yet. Scenarios, logs and manifest.txt are written there.
#
# Safety: the original folders are only read (a marker and git status are compared at the end).
# The app runs only on copies under <out>/work, with HOME set to an empty folder, a fixed TZ and a
# 180 second cap per run. Menu 19 (moves files out of ~/Downloads) and menu 14 (HTML report with a
# clock time) are never sent. Paths in the output are rewritten to <work>, <out> and <home>.
# See reference/README.md.

HERE="$(cd "$(dirname "$0")" && pwd -P)"
PY=(python3 -I "$HERE/helpers.py")

fail() { echo "error: $*" >&2; exit 1; }
usage() {
  echo "usage: reference/run.sh --code <C++ repo> --data <data root> --out <new folder> [--tz ZONE]" >&2
  exit 2
}

CODE=""; DATA=""; OUT=""; TZ_NAME="America/New_York"
while [ $# -gt 0 ]; do
  case "$1" in
    --code) [ $# -ge 2 ] || usage; CODE="$2"; shift 2 ;;
    --data) [ $# -ge 2 ] || usage; DATA="$2"; shift 2 ;;
    --out)  [ $# -ge 2 ] || usage; OUT="$2"; shift 2 ;;
    --tz)   [ $# -ge 2 ] || usage; TZ_NAME="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$CODE" ] && [ -n "$DATA" ] && [ -n "$OUT" ] || usage

for tool in python3 rsync clang++ perl find; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is needed"
done
for item in main.cpp CMakeLists.txt src tools; do
  [ -e "$CODE/$item" ] || fail "--code is not the C++ repo (no $item): $CODE"
done
for item in Games Saved_Data; do
  [ -d "$DATA/$item" ] || fail "--data needs a $item/ folder: $DATA"
done
[ -e "$OUT" ] && fail "--out already exists; pick a new folder name: $OUT"

CODE="$(cd "$CODE" && pwd -P)"
DATA="$(cd "$DATA" && pwd -P)"
mkdir -p "$(dirname "$OUT")" || fail "cannot create the parent of $OUT"
OUT="$(cd "$(dirname "$OUT")" && pwd -P)/$(basename "$OUT")"
case "$OUT/" in
  "$CODE/"*|"$DATA/"*) fail "--out must not be inside --code or --data" ;;
esac

# Labels for scenario.json: no absolute paths in the committed output.
CODE_LABEL="$(basename "$CODE")"
case "$DATA" in
  "$(pwd -P)"/*) DATA_LABEL="${DATA#"$(pwd -P)"/}" ;;
  *) DATA_LABEL="$(basename "$DATA")" ;;
esac

mkdir "$OUT" || fail "cannot create $OUT"
WORK="$OUT/work"; BIN="$WORK/code"; PRISTINE="$WORK/pristine"; RUNS="$WORK/runs"; HOME_DIR="$WORK/home"
mkdir -p "$BIN" "$PRISTINE" "$RUNS" "$HOME_DIR" "$OUT/build" "$OUT/scenarios" || fail "cannot create the work folders"
printf 'work/\n' > "$OUT/.gitignore"   # the work copies (they hold the data) stay out of git
export SAN_WORK="$WORK" SAN_OUT="$OUT" SAN_HOME="${HOME:-}"

# git status of a folder when it is its own repo, else a note. Compared before and after the run.
status_snapshot() {
  if [ "$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" = "$1" ]; then
    git --no-optional-locks -C "$1" status --porcelain > "$2" 2>&1
  else
    echo "(not a repo top level)" > "$2"
  fi
}
MARK="$WORK/.start-marker"
touch "$MARK" || fail "cannot write the start marker"
status_snapshot "$CODE" "$WORK/.git-status-code-before"
status_snapshot "$DATA" "$WORK/.git-status-data-before"

# ---- copies: code and data only, nothing else from either folder ----------------------------
rsync -a "$CODE/main.cpp" "$CODE/CMakeLists.txt" "$BIN/" || fail "copy of the C++ entry files failed"
rsync -a "$CODE/src/" "$BIN/src/" || fail "copy of src/ failed"
rsync -a "$CODE/tools/" "$BIN/tools/" || fail "copy of tools/ failed"
rsync -a "$DATA/Games/" "$PRISTINE/Games/" || fail "copy of Games/ failed"
rsync -a "$DATA/Saved_Data/" "$PRISTINE/Saved_Data/" || fail "copy of Saved_Data/ failed"
if [ -n "$(find "$BIN" "$PRISTINE" -type l)" ]; then
  fail "refusing to run: the copies contain symbolic links"
fi

# ---- build inside the copy -------------------------------------------------------------------
( cd "$BIN" && clang++ -std=c++20 -O2 -Isrc "-DPLR_PROJECT_ROOT=\"$BIN\"" main.cpp src/*.cpp -o plr ) \
  > "$OUT/build/plr.txt" 2>&1 || fail "build of plr failed, see $OUT/build/plr.txt"
grep -a -q -F "$BIN" "$BIN/plr" || fail "plr does not carry its copy path (build problem)"
( cd "$BIN" && clang++ -std=c++20 -O2 -Isrc tools/playstyle_report.cpp src/*.cpp -o playstyle_report ) \
  > "$OUT/build/playstyle_report.txt" 2>&1 || fail "build of playstyle_report failed, see $OUT/build/playstyle_report.txt"

# ---- helpers ---------------------------------------------------------------------------------

# Rewrites the work, output and home paths so the saved text names no real folder.
sanitize_file() {
  [ -f "$1" ] || return 0
  if [ -n "$SAN_HOME" ]; then
    perl -pi -e 's/\Q$ENV{SAN_WORK}\E/<work>/g; s/\Q$ENV{SAN_OUT}\E/<out>/g; s/\Q$ENV{SAN_HOME}\E/<home>/g' "$1"
  else
    perl -pi -e 's/\Q$ENV{SAN_WORK}\E/<work>/g; s/\Q$ENV{SAN_OUT}\E/<out>/g' "$1"
  fi
}

# One app run: empty HOME, fixed TZ, 180 second cap, --plain, stdin from the menu file.
# run_app <root> <menu file or /dev/null> <log file> [app args...]
run_app() {
  local root="$1" input="$2" log="$3"
  shift 3
  mkdir -p "$(dirname "$log")" || return 1
  env -i HOME="$HOME_DIR" PATH=/usr/bin:/bin TZ="$TZ_NAME" \
    perl -e 'alarm 180; exec @ARGV' "$BIN/plr" --root "$root" --plain "$@" < "$input" > "$log" 2>&1
}

# A standalone tool run (no menu): same environment and cap.
tool_run() { # tool_run <log file> <program> [args...]
  local log="$1"
  shift
  mkdir -p "$(dirname "$log")" || return 1
  env -i HOME="$HOME_DIR" PATH=/usr/bin:/bin TZ="$TZ_NAME" \
    perl -e 'alarm 180; exec @ARGV' "$@" < /dev/null > "$log" 2>&1
  local rc=$?
  sanitize_file "$log"
  return $rc
}

# write_menu <file> <lines...>   ("" is a blank line: the Enter that answers a pause)
write_menu() {
  local file="$1"
  shift
  mkdir -p "$(dirname "$file")" || fail "cannot create $(dirname "$file")"
  printf '%s\n' "$@" > "$file"
}

# fresh_root <name>: ROOT becomes a new copy of the pristine data, so every run starts the same.
fresh_root() {
  ROOT="$RUNS/$1"
  mkdir -p "$ROOT" && rsync -a --delete "$PRISTINE/" "$ROOT/" || fail "cannot prepare $ROOT"
}

# step <scenario dir> <kind> <log path inside it> <menu file | -> [app args...]
# Runs the app on ROOT, saves its output, and records the menu, arguments and exit code.
step() {
  local sdir="$1" kind="$2" rel="$3" menu="$4" rc a
  shift 4
  local log="$sdir/$rel" input="$menu"
  [ "$menu" = "-" ] && input=/dev/null
  mkdir -p "$sdir/logs" || fail "cannot create $sdir/logs"
  run_app "$ROOT" "$input" "$log" "$@"
  rc=$?
  sanitize_file "$log"
  local record=("--steps" "$sdir/logs/steps.jsonl" "--kind" "$kind" "--log" "$rel" "--exit" "$rc")
  [ "$menu" != "-" ] && record+=("--menu" "$menu")
  for a in "$@"; do record+=("--arg=$a"); done
  "${PY[@]}" step "${record[@]}" || fail "could not record step $kind"
  return "$rc"
}

# grab <scenario dir> <root> <file>...: copies exports from the run's Saved_Data (missing ones are reported at finish)
grab() {
  local sdir="$1" root="$2" f
  shift 2
  for f in "$@"; do
    if [ -f "$root/Saved_Data/$f" ]; then
      cp -p "$root/Saved_Data/$f" "$sdir/$f" || fail "cannot save $f"
    fi
  done
}

# finish <scenario dir> <name> <description> [--expect=F] [--flag=X] [--note=X]...
finish() {
  local sdir="$1" name="$2" desc="$3"
  shift 3
  "${PY[@]}" finish --dir "$sdir" --steps "$sdir/logs/steps.jsonl" --name "$name" --description "$desc" \
    --code "$CODE_LABEL" --data "$DATA_LABEL" --tz "$TZ_NAME" "$@" || fail "could not write scenario.json for $name"
}

# ---- scenarios -------------------------------------------------------------------------------

# Player summary (menu 12) and the settlement sheet (menu 5, 3 = everything in scope, n = no
# specific sends, Enter = pause after menu 5, then 13 exports it). Extra arguments are app flags.
# HOOK (a function) and SETTLE_ASK=no (banker mode asks no question) and NOTE are optional.
scenario_settle() { # scenario_settle <name> <description> [app flags...]
  local name="$1" desc="$2" sdir a
  local flags=()
  shift 2
  sdir="$OUT/scenarios/$name"
  for a in "$@"; do flags+=("--flag=$a"); done
  mkdir -p "$sdir/menus" "$sdir/logs" || fail "cannot create $sdir"
  write_menu "$sdir/menus/01-summary.txt" 12 0
  if [ "${SETTLE_ASK:-yes}" = "yes" ]; then
    write_menu "$sdir/menus/02-settle.txt" 5 3 n "" 13 0
  else
    write_menu "$sdir/menus/02-settle.txt" 5 3 "" 13 0
  fi

  fresh_root "$name/summary"
  [ -n "${HOOK:-}" ] && "$HOOK"
  step "$sdir" summary logs/summary.txt "$sdir/menus/01-summary.txt" "$@"
  grab "$sdir" "$ROOT" player_summary.csv showdown_rivals.csv

  fresh_root "$name/settle"
  [ -n "${HOOK:-}" ] && "$HOOK"
  step "$sdir" settle logs/settle.txt "$sdir/menus/02-settle.txt" "$@"
  grab "$sdir" "$ROOT" settlements.csv

  finish "$sdir" "$name" "$desc" \
    --expect=player_summary.csv --expect=showdown_rivals.csv --expect=settlements.csv \
    ${flags[@]+"${flags[@]}"} --note="${NOTE:-}"
}

# The app's dates for the range: the middle third of the game nights.
IFS=$'\t' read -r FROM TO < <("${PY[@]}" range "$PRISTINE/Games" "$TZ_NAME")
[ -n "$FROM" ] && [ -n "$TO" ] || fail "cannot pick a date range from the ledgers"

scenario_settle all \
  "Everything in the data: player summary (menu 12) and the settlement sheet (menu 5, option 3)."

# One scenario per folder: the same two exports, scoped with --folder.
"${PY[@]}" folders "$PRISTINE/Games" > "$WORK/folders.txt" || fail "cannot list the folders"
USED=" "
while IFS= read -r folder; do
  [ -n "$folder" ] || continue
  slug="$(printf '%s' "$folder" | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  [ -n "$slug" ] || slug="folder"
  base="$slug"; n=2
  while case "$USED" in *" $slug "*) true ;; *) false ;; esac; do
    slug="$base-$n"; n=$((n + 1))
  done
  USED="$USED$slug "
  NOTE="" scenario_settle "folder-$slug" \
    "One folder: player summary and settlement sheet for that folder only (--folder)." --folder "$folder"
done < "$WORK/folders.txt"

NOTE="range: the middle third of the game nights (the picks tools/validate.py makes): $FROM to $TO" \
  scenario_settle range \
  "Dates from $FROM to $TO: player summary and settlement sheet for that stretch (--from, --to)." \
  --from "$FROM" --to "$TO"

hook_nopins() {   # payment_preferences.csv reduced to its header in the run copy
  head -n 1 "$ROOT/Saved_Data/payment_preferences.csv" > "$ROOT/Saved_Data/payment_preferences.csv.tmp" \
    && mv "$ROOT/Saved_Data/payment_preferences.csv.tmp" "$ROOT/Saved_Data/payment_preferences.csv"
}
HOOK=hook_nopins NOTE="payment_preferences.csv reduced to its header in the run copy" \
  scenario_settle nopins \
  "The all-data sheet with no pinned payments: payment_preferences.csv reduced to its header."

# Banker: the player with the most games in the all-data summary. The menu has no yes/no question.
IFS=$'\t' read -r BANKER BANKER_GAMES < <("${PY[@]}" banker "$OUT/scenarios/all/player_summary.csv")
[ -n "$BANKER" ] || fail "cannot pick a banker"
hook_banker() {   # banker line in settings.csv, the rest of the file kept
  local f="$ROOT/Saved_Data/settings.csv"
  { grep -v '^banker,' "$f"; echo "banker,$BANKER"; } > "$f.tmp" && mv "$f.tmp" "$f"
}
HOOK=hook_banker SETTLE_ASK=no \
  NOTE="banker set in the run copy: the player with the most games in the all-data sheet ($BANKER_GAMES games)" \
  scenario_settle banker \
  "Banker mode: everyone settles through one person (the most games in the all-data sheet)."

# Single game: menu 5, option 1, game 1 is the newest. Only its sheet is exported.
scenario_single_game() {
  local sdir="$OUT/scenarios/single-game" id
  mkdir -p "$sdir/menus" "$sdir/logs" || fail "cannot create $sdir"
  write_menu "$sdir/menus/settle-newest.txt" 5 1 1 n "" 13 0
  fresh_root "single-game/settle"
  step "$sdir" settle logs/settle.txt "$sdir/menus/settle-newest.txt"
  # The game list row for game 1: its date is in the second column; the id is the last column.
  id="$(awk '$1=="1" && $2 ~ /^[0-9][0-9][0-9][0-9]-/ {print $NF; exit}' "$sdir/logs/settle.txt")"
  grab "$sdir" "$ROOT" settlements.csv
  finish "$sdir" single-game \
    "Only the newest game (menu 5, option 1, game 1): its settlement sheet (menu 13)." \
    --expect=settlements.csv --note="newest game id: $id"
}
scenario_single_game

# Sessions: save the all-data sheet as a session (menu 7), record one part payment on its first
# open balance (menu 10), then the saved balances and the views (menus 8 and 11).
scenario_sessions() {
  local sdir="$OUT/scenarios/sessions" id="reference-all" choice amt
  mkdir -p "$sdir/menus" "$sdir/logs" || fail "cannot create $sdir"
  write_menu "$sdir/menus/01-save.txt" 5 3 n "" 7 "$id" 13 0
  fresh_root "sessions"
  step "$sdir" save logs/save.txt "$sdir/menus/01-save.txt"
  grab "$sdir" "$ROOT" settlements.csv session_balances.csv

  IFS=$'\t' read -r choice amt < <("${PY[@]}" partial "$ROOT/Saved_Data/session_balances.csv" "$id")
  [ -n "$choice" ] && [ -n "$amt" ] || fail "no open balance to part-pay"
  write_menu "$sdir/menus/02-part-pay.txt" 10 "$choice" "$amt" 0
  step "$sdir" part-pay logs/part-pay.txt "$sdir/menus/02-part-pay.txt"
  grab "$sdir" "$ROOT" session_balances.csv

  write_menu "$sdir/menus/03-views.txt" 8 "" 11 "" 0
  step "$sdir" views logs/views.txt "$sdir/menus/03-views.txt"
  finish "$sdir" sessions \
    "Session: the all-data sheet saved (menu 7), one part payment (menu 10), then the saved sheets (menus 8, 11)." \
    --expect=settlements.csv --expect=session_balances.csv \
    --note="session id $id; part payment on open balance $choice of the saved list"
}
scenario_sessions

# Startup: the output printed before the menu (loaded ledgers, merge suggestions, seat flags,
# duplicate notes, unbalanced-game warnings). Then menu 0.
scenario_startup() {
  local sdir="$OUT/scenarios/startup"
  mkdir -p "$sdir/menus" "$sdir/logs" || fail "cannot create $sdir"
  write_menu "$sdir/menus/quit.txt" 0
  fresh_root "startup"
  step "$sdir" startup startup.txt "$sdir/menus/quit.txt"
  finish "$sdir" startup \
    "Startup output only: loaded ledgers, merge suggestions, seat flags, duplicate notes, unbalanced-game warnings."
}
scenario_startup

# Views: menu 6 (pins and settings), 2 (leaderboard), 8 and 11 (saved sheets), 16 (duplicates),
# 17 (payments and corrections), 20 (seat owners, list only).
scenario_views() {
  local sdir="$OUT/scenarios/views"
  mkdir -p "$sdir/menus" "$sdir/logs" || fail "cannot create $sdir"
  write_menu "$sdir/menus/views.txt" 6 0 2 "" 8 "" 11 "" 16 "" 17 0 20 3 0 0 0
  fresh_root "views"
  step "$sdir" views views.txt "$sdir/menus/views.txt"
  finish "$sdir" views \
    "Printed views: settings and pins (6), leaderboard (2), saved sheets (8, 11), duplicates (16), payments (17), seat owners (20)."
}
scenario_views

# History: menu 3 for every player in rank order (the same call tools/validate.py makes).
scenario_history() {
  local sdir="$OUT/scenarios/history" n i
  mkdir -p "$sdir/menus" "$sdir/history" || fail "cannot create $sdir"
  n="$("${PY[@]}" players "$OUT/scenarios/all/player_summary.csv")"
  [ -n "$n" ] && [ "$n" -gt 0 ] 2>/dev/null || fail "no players to read history for"
  for i in $(seq 1 "$n"); do
    write_menu "$sdir/menus/history-$i.txt" 3 "$i" "" 0
    fresh_root "history/$i"
    step "$sdir" history "history/history_$i.txt" "$sdir/menus/history-$i.txt"
  done
  finish "$sdir" history \
    "Player history (menu 3) for every player in rank order, all data: one plain-text file per player."
}
scenario_history

# Hand-log exports for later steps (kept as they were): menus 18, 21, 22 and the standalone tool.
# With no hand logs in the data, these files are empty or are not written.
scenario_handlog() {
  local sdir="$OUT/handlog" hasLogs="no"
  mkdir -p "$sdir/menus" "$sdir/logs" "$sdir/tool" || fail "cannot create $sdir"
  # Without a hand log the menus stop before their questions, so the answers are left out.
  if [ -n "$(find "$PRISTINE/Games" -name 'poker_now_log_*' -print -quit)" ]; then
    hasLogs="yes"
    write_menu "$sdir/menus/style.txt" 18 y "" 0
    write_menu "$sdir/menus/playstyle.txt" 21 n y "" 0
    write_menu "$sdir/menus/hit-and-run.txt" 22 n y "" 0
  else
    write_menu "$sdir/menus/style.txt" 18 "" 0
    write_menu "$sdir/menus/playstyle.txt" 21 "" 0
    write_menu "$sdir/menus/hit-and-run.txt" 22 "" 0
  fi

  fresh_root "handlog/style"
  step "$sdir" style logs/style.txt "$sdir/menus/style.txt"
  grab "$sdir" "$ROOT" style_stats.csv

  fresh_root "handlog/playstyle"
  step "$sdir" playstyle logs/playstyle.txt "$sdir/menus/playstyle.txt"
  grab "$sdir" "$ROOT" playstyle.csv

  fresh_root "handlog/hit-and-run"
  step "$sdir" hit-and-run logs/hit-and-run.txt "$sdir/menus/hit-and-run.txt"
  grab "$sdir" "$ROOT" hit_and_run.csv hit_and_run_nights.csv

  fresh_root "handlog/tool"
  tool_run "$sdir/logs/tool-hitrun.txt" "$BIN/playstyle_report" --root "$ROOT" --hitrun \
    --csv "$sdir/tool/hit_and_run_nights_tool.csv"
  tool_run "$sdir/logs/tool-playstyle.txt" "$BIN/playstyle_report" --root "$ROOT" \
    --csv "$sdir/tool/playstyle_tool.csv"

  # Written by menu 12 in the all-data run (the hand-log side of the same export).
  cp -p "$OUT/scenarios/all/showdown_rivals.csv" "$sdir/showdown_rivals.csv" 2>/dev/null
  finish "$sdir" handlog \
    "Hand-log exports (menus 18, 21, 22, the standalone playstyle_report, showdown rivals). Empty when the data has no hand logs." \
    --note="hand-log files in the data: $hasLogs"
}
scenario_handlog

# ---- manifest, sanitizing, and the no-change checks -------------------------------------------

find "$OUT" -path "$WORK" -prune -o -type f -print | while IFS= read -r f; do sanitize_file "$f"; done
"${PY[@]}" manifest "$OUT" > "$OUT/manifest.txt" || fail "manifest failed"

status_snapshot "$CODE" "$WORK/.git-status-code-after"
status_snapshot "$DATA" "$WORK/.git-status-data-after"
cmp -s "$WORK/.git-status-code-before" "$WORK/.git-status-code-after" || fail "git status of --code changed during the run"
cmp -s "$WORK/.git-status-data-before" "$WORK/.git-status-data-after" || fail "git status of --data changed during the run"
CHANGED="$(find "$CODE" "$DATA" \( -name .git -prune \) -o -newer "$MARK" -print 2>/dev/null)"
if [ -n "$CHANGED" ]; then
  printf '%s\n' "$CHANGED" | head -n 20 >&2
  fail "files under --code or --data changed during the run"
fi

echo
"${PY[@]}" summary "$OUT"
SUMMARY_RC=$?
echo
echo "manifest: $OUT/manifest.txt"
echo "work copies (ignored by git): $WORK"
if [ "$SUMMARY_RC" -ne 0 ]; then
  echo "one or more scenarios failed; see the scenario.json files" >&2
  exit 1
fi
echo "done: $OUT"
