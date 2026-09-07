# Poker Ledger Reader

A C++20 console app that reads every poker-night ledger CSV under this folder,
tells you who is up and who is down, works out who should pay whom, remembers
what has been paid, and draws charts of results over time.

## Building and running

Open the folder in CLion and run the `Poker_Ledger_Reader` target as before.
The CMake file passes the project folder in as the default data root, so the
program finds the ledger folders no matter where CLion puts the executable.

From a terminal (no CMake needed):

```bash
clang++ -std=c++20 -Isrc -DPLR_PROJECT_ROOT='"/Users/cameron/CLionProjects/Poker_Ledger_Reader"' main.cpp src/*.cpp -o plr && ./plr
```

Command-line options:

| Flag | What it does |
|---|---|
| `--root PATH` | Use a different folder as the data root |
| `--folder NAME` | Start scoped to one sub-folder (e.g. `data_folder_May_1-7`) |
| `--from YYYY-MM-DD` / `--to YYYY-MM-DD` | Start scoped to a date range |
| `--report [file.html]` | Print the leaderboard, write the HTML report, and exit |
| `--help` | Show usage |

## Folder layout

```
Poker_Ledger_Reader/
  main.cpp                 menu and program flow
  src/
    util.*                 CSV parsing, name normalizing, money and date formatting
    models.hpp             the data structures every module shares
    console.*              input prompts
    ledger.*               finds and parses ledger CSVs (recursively)
    players.*              per-player stats, merge rules, leaderboard, history
    settlement.*           who-pays-whom, pinned preferences, banker mode
    sessions.*             saved settlement sessions and payments against them
    report.*               terminal charts and the HTML/SVG report
  data_folder_*/ SFFS/     your ledger CSVs (any folder name works, any depth)
  Saved_Data/              everything the app remembers between runs
    merge_rules.csv        alias -> canonical name
    payment_preferences.csv  payer -> payee pins
    settings.csv           who "me" is, who the banker is
    session_balances.csv   saved settlements and what has been paid
    player_summary.csv     export from menu 12
    settlements.csv        export from menu 13
    reports/               HTML reports from menu 14
```

Any `.csv` whose header contains `player_nickname` is treated as a ledger. The
app walks every sub-folder, so you can keep organising ledgers by week, month or
group. The same ledger appearing in two folders is only counted once.

## The menu

```
DATA
  1. Change scope (folder / date range)
  2. Leaderboard: everyone's net wins and losses
  3. Player detail: game-by-game history and running total
  4. Merge duplicate player names
SETTLEMENT
  5. Calculate settlement sheet (who sends what to whom)
  6. Payment preferences (pinned payer -> payee, banker, me)
  7. Save settlement sheet as a session
  8. View all session balances
  9. View open session balances
 10. Record a payment
 11. Combined unpaid summary
EXPORT & CHARTS
 12. Export player summary CSV
 13. Export settlement sheet CSV
 14. Generate HTML report with charts
 15. Terminal charts
  0. Save and exit
```

**Scope** is the key idea. Every view (leaderboard, settlement, charts, exports)
is computed for the current scope, which is a folder choice plus an optional
date range. "All folders, no dates" means every game you have ever loaded;
"folder data_folder_May_1-7" is one week; "last 30 days" is a rolling window.
The header of the menu always shows the scope in effect.

### Settlement rules

Menu 5 builds the sheet in three passes:

1. **Banker mode** (if a banker is set in menu 6): every loser pays the banker,
   the banker pays every winner. Nothing else runs.
2. **Pinned preferences** (menu 6): each "A always pays B" rule is applied in
   the order it was added, for as much as A owes and B is owed.
3. **Automatic matching**: whatever is left is matched biggest debt to biggest
   credit, so the number of payments stays small.

The "Why" column on the sheet shows which pass produced each line.

### Sessions and payments

Menu 7 freezes the current sheet under a session ID (it suggests the folder
name or date range). Menus 8 to 11 then show what is still owed, let you record
partial or full payments, and roll unpaid amounts up per pair of people across
every session. The file format is the same as before, so your existing
`session_balances.csv` loads unchanged.

### Charts

Menu 15 prints a net-result bar chart for everyone and a running-total chart
for "me" in the terminal. Menu 14 writes a self-contained HTML file with:

- summary tiles (games, players, buy-in volume, your net and average)
- net result by player (bar chart, hover for details)
- running total over time for you plus the biggest movers (hover for a
  crosshair that reads every line at that game)
- game-by-game bars for you (or the top earner if "me" is not set)
- the full leaderboard, the settlement sheet, and a table of every game in scope

It works offline, follows your light/dark system setting, and can be opened
from the app straight after it is written.

## Name merging

Names are still matched on letters only, lower-cased, so "Yaden ):" and
"yaden" are the same person automatically. Menu 4 first shows nicknames that
share the same ledger account ID (the `player_id` column) and lets you merge
them with one keypress, then lets you merge any two names by hand. Rules are
saved to `merge_rules.csv` and applied every time the app starts.
