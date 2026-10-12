# Reference harness

The C++ console app (branch `master` of the Poker_Ledger_Reader repo) is the oracle for the
TypeScript ledger code. This harness runs it on one data root and keeps every export and printed
view the ledger side needs, so the TypeScript output can be compared with it to the cent.

## Commands

    npm run fixtures                                   # writes the made-up data (fixtures/synthetic)
    npm run reference -- --code <C++ repo> --data fixtures/synthetic --out fixtures/synthetic-reference
    npm run reference -- --code <C++ repo> --data <C++ repo> --out local/reference-real
    npm run check:privacy                              # scans what git would commit

- `--code` is the C++ repo. Only `main.cpp`, `CMakeLists.txt`, `src/` and `tools/` are copied.
- `--data` is a folder with `Games/` and `Saved_Data/`. Only those two are copied.
- `--out` must not exist yet. `--tz` defaults to `America/New_York`.

The made-up run is committed (`fixtures/synthetic-reference`). The real run goes to `local/`,
which git ignores, and must never be committed. Run `npm run check:privacy` before any push.

## Safety rules

1. The original folders are read, never written. The harness compares the file times and the
   `git status` of both folders with their state at the start, and fails if anything changed.
2. The app runs only on copies under `<out>/work`. Every run starts from a fresh copy of the data,
   with `HOME` set to an empty folder, a fixed `TZ`, `--plain`, and a 180 second cap.
3. Menu 19 (moves files out of Downloads) and menu 14 (HTML report with a clock time) are never sent.
   Menu 0 only saves the copy's files.
4. Paths in the saved text are rewritten to `<work>`, `<out>` and `<home>`, so no real folder name
   is saved in the output.
5. `<out>/work` (the copies, which hold the data) is ignored by git through `<out>/.gitignore`.

## What is recorded

Each scenario is a folder under `<out>/scenarios/` (hand-log exports are under `<out>/handlog/`):

| Scenario | What it runs |
| --- | --- |
| `all` | menu 12 (player summary), then menu 5 option 3, `n`, menu 13 (sheet) |
| `folder-<name>` | the same, with `--folder` for every folder |
| `range` | the same, with `--from`/`--to` over the middle third of the game nights |
| `nopins` | the same with `payment_preferences.csv` reduced to its header |
| `banker` | the same with the banker set to the player with the most games (no yes/no question) |
| `single-game` | menu 5 option 1, game 1 (the newest), then menu 13 |
| `sessions` | menu 7 saves the all-data sheet, menu 10 records a part payment, menus 8 and 11 |
| `history` | menu 3 for every player, rank order: `history/history_<n>.txt` |
| `startup` | the text printed before the menu (merge suggestions, seat flags, duplicates, warnings) |
| `views` | menus 6, 2, 8, 11, 16, 17 and 20 (list) |
| `handlog` | menus 18, 21, 22 and the standalone `playstyle_report` (empty without hand logs) |

Inside each scenario folder:

- the CSV exports the app wrote, and `showdown_rivals.csv` where it applies;
- `scenario.json`: the exact menu lines fed in, the app flags, each exit code, and the rows saved;
- `logs/` (the app's output), `menus/` (the input files).

The CSV exports are the exact bytes the app wrote. The text files are the app's printed output
after path rewriting, and they keep some ANSI color codes (`--plain` turns off symbols, not every
color). Strip `ESC[...m` sequences before comparing printed text.

`<out>/manifest.txt` lists every CSV with its row count and header. `<out>/build/` has the compile
logs. The run prints a summary and exits 1 if any scenario is missing an expected export.

## Requirements

`python3` (standard library only), `rsync`, `perl`, `clang++`, `git` (to compare the status).
The helpers run in isolated mode (`python3 -I`).
