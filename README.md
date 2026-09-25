# Poker Ledger Reader

A C++20 console app that reads every poker-night ledger CSV under this folder,
tells you who is up and who is down, works out who should pay whom, remembers
what has been paid, draws charts of results over time, and (when you also save
the PokerNow hand log) shows how everyone actually plays.

## After a game night (the whole routine)

1. On PokerNow, open the finished game and download both files:
   - the **ledger** (`ledger_<gameId>.csv`), and
   - the **log** (`poker_now_log_<gameId>.csv`, "Download log" on the game page).
   Leave the file names as they are. Both land in your Downloads folder.
2. Run the app and choose **19. Import new PokerNow files from Downloads**. It
   lists what it found, asks which folder under `Games/` to file them in
   (the most recent folder is suggested), moves them there, and reloads.
3. Choose **5** to build the settlement sheet for that game, **14** for the HTML
   report, **18** for the playing-style table.

That is it. Nothing else needs to be renamed or copied by hand.

## Where each file goes

```
Poker_Ledger_Reader/
  Games/                            all game data, one sub-folder per period
    Post Summer 2026/
      ledger_pglMu8P6Y6CHdreUuqi1LEw6F.csv          the ledger (who bought in / cashed out)
      poker_now_log_pglMu8P6Y6CHdreUuqi1LEw6F.csv   the hand log for the same game (optional)
      ...
    Fall 2026/                      make a new folder whenever you like (menu 19 can do it)
  Saved_Data/                       everything the app remembers between runs
    merge_rules.csv                 alias -> canonical name
    payment_preferences.csv         payer -> payee pins
    settings.csv                    who "me" is, who the banker is
    adjustments.csv                 forgiven debts and manual corrections
    seat_owners.csv                 buy-ins that belonged to someone other than the name on them
    session_balances.csv            saved settlements and what has been paid
    player_summary.csv              export from menu 12
    settlements.csv                 export from menu 13
    style_stats.csv                 export from menu 18
    reports/                        HTML reports from menu 14
  main.cpp                          menu and program flow
  src/
    util.*                          CSV parsing, name normalizing, money and date formatting
    models.hpp                      the data structures every module shares
    console.*                       input prompts
    ledger.*                        finds and parses ledger CSVs (recursively)
    handlog.*                       finds and parses PokerNow hand logs, playing-style stats
    players.*                       per-player stats, merge rules, leaderboard, history
    settlement.*                    who-pays-whom, pinned preferences, banker mode
    sessions.*                      saved settlement sessions and payments against them
    adjustments.*                   forgiven debts and manual corrections
    seats.*                         seats bought on someone else's account or name
    report.*                        terminal charts and the HTML/SVG report
  tools/validate.py                 recomputes every number from the raw CSVs
```

Rules of thumb:

- A ledger and its log are paired by the game id in the file name, so keep the
  names PokerNow gives them. They should sit in the same folder.
- Folder names are yours to choose. The app walks every sub-folder of `Games/`,
  so a folder per season, month or group all work. The folder name is what the
  scope menu shows.
- Any `.csv` whose header contains `player_nickname` is treated as a ledger;
  any `poker_now_log_*.csv` is treated as a hand log. Other files are ignored.
- Browser copies such as `ledger_x (1).csv` are recognised; the import strips
  the suffix and the duplicate check keeps the fuller export.

## Building and running

Open the folder in CLion and run the `Poker_Ledger_Reader` target. The CMake
file passes the project folder in as the default root, so the program finds
`Games/` and `Saved_Data/` no matter where CLion puts the executable.

From a terminal (no CMake needed):

```bash
g++ -std=c++20 -Isrc -DPLR_PROJECT_ROOT='"C:/Users/Camer/CLionProjects/Poker_Ledger_Reader"' main.cpp src/*.cpp -o plr && ./plr
```

Command-line options:

| Flag | What it does |
|---|---|
| `--root PATH` | Use a different root (the folder that contains `Games/` and `Saved_Data/`) |
| `--folder NAME` | Start scoped to one sub-folder of `Games/` |
| `--from YYYY-MM-DD` / `--to YYYY-MM-DD` | Start scoped to a date range |
| `--report [file.html]` | Print the leaderboard, write the HTML report, and exit |
| `--plain` | Plain text for this run: no colors or symbols (menu 6 makes it permanent) |
| `--help` | Show usage |

If there is no `Games/` folder, the root itself is searched, so an older layout
with ledger folders directly under the project still works.

### Duplicate ledgers

Every file is checked against every other file when the app starts, and a
warning is printed if anything matches. Menu 16 shows the details. Three cases:

| Case | What the app does |
|---|---|
| Identical content (any file name, same folder or not) | Second copy skipped |
| Same ledger id, different content (an earlier export of the same game, including browser copies named `ledger_x (1).csv`) | The fuller export is kept, the other skipped |
| Different ids that share sit-down rows | Both kept but flagged, because the app cannot tell which is right |

Seats that have no start time and no money moved (a buy-in that was requested
but never played) are ignored, and a ledger made only of such rows is not a
game. Two logs for the same game keep the one with more hands.

## The menu

```
╭────────────────────────────────────────────────────────────────────────────╮
│ ♠ POKER LEDGER   39 games · Aug 22 – Sep 23 · all folders                  │
│ 31 players · hand logs 20/39 · ✓ books balanced                            │
│ me not set · banker off · pinned payments 3                                │
╰────────────────────────────────────────────────────────────────────────────╯
 RESULTS                                 SETTLE UP
   1  Change scope                         5  Build settlement sheet
   2  Leaderboard                          6  Pins, banker, me & display
   3  Player history                       7  Save sheet to track payments
   4  Player names  ● 1 new                8  Saved sheets: all
  20  Shared accounts                      9  Saved sheets: unpaid
  17  Payments & corrections  (2)         10  Record a payment
                                          11  Who still owes whom
 REPORTS                                 HAND LOGS
  12  Export players CSV                  18  Playing style
  13  Export sheet CSV                    21  Deep profiles
  14  HTML report                         19  Import from Downloads
  15  Charts
  16  Duplicate check                      0  Save and exit
```

The box at the top says what you are looking at and whether the books balance.
A yellow dot next to a menu means it has something for you to check.

Every screen fits in 100 columns, uses green for money won and red for money
lost, and draws charts with block characters. If your console shows odd
characters instead of lines and blocks (some IDE consoles do), switch the
display to **simple** in menu 6 (option 6), or run with `--plain` once. Simple
is plain text with no colors or symbols; the numbers are the same.

### Leaderboard (menu 2)

```
   #  Player             Nights   Up-Dn         Net  Avg/night       Best      Worst  Last 10 nights
   1  Heech                  25    19-5    +$832.22    +$33.29   +$309.13   -$403.65  ▂·▁▁▁▁▁▂▂█
```

- **Net** is what the player won or lost at the table, and the table is ranked
  by it. Payments and corrections from menu 17 are listed under the table
  instead: they change who owes whom, not who won.
- **Up-Dn** counts the nights they finished up and down.
- **Last 10 nights** is one bar per night, oldest first: taller means a bigger
  night, green up, red down.
- The last line checks that every player's net adds up to $0.00.

**Scope** is the key idea. Every view (leaderboard, settlement, charts, exports,
style stats) is computed for the current scope, which is a folder choice plus
an optional date range. "All folders, no dates" means every game you have ever
loaded; a folder is one period; "last 30 days" is a rolling window. The header
of the menu always shows the scope in effect and how many games in it have a
hand log.

### Settlement rules

Menu 5 is a short guided flow:

1. **Pick what to settle**: one game (listed newest first), one folder, or
   everything in the current scope. Each player is shown with their poker net,
   any payments or corrections (menu 17), and what that means for this sheet:
   "owes $X" or "is owed $X".
2. **Specific sends**: the app asks whether anyone wants to send their money
   to a specific person. Pick the payer from those who owe and the payee from
   those who are owed; repeat for as many pairs as you like, or answer "n" to
   skip straight to the automatic fill. Each request can be remembered as a
   pinned preference for future sheets, or used just this once.
3. **Auto fill**: everything left over is matched automatically.

Saving the sheet as a session (menu 7) suggests the game or folder name as the
session ID. Menus 7 and 13 start this same flow if no sheet exists yet.

Under the hood the sheet is built in three passes:

1. **Banker mode** (if a banker is set in menu 6): every loser pays the banker,
   the banker pays every winner. Nothing else runs.
2. **Pinned preferences** (menu 6) and then the one-off requests from menu 5:
   each "A pays B" rule is applied in order, for as much as A owes and B is owed.
3. **Automatic matching**: whatever is left is split into as many self-contained
   zero-sum groups as possible (a group of m people needs only m-1 payments),
   and inside each group every debt goes to the smallest credit that covers it
   in full, so most people send to just one person.

Each line on the sheet is tagged with the pass that produced it: "banker",
"pinned" (a saved pin), "requested" (asked for on this sheet), or nothing for
the automatic fill.

### Payments & corrections (menu 17)

Use this for money that changed hands outside PokerNow. Two kinds:

- **Money that changed hands outside the ledger** (a payment, or a debt let
  go). Pick who got the money (or let the debt go) and who paid it (or was let
  off). The one who owed now owes that much less and the one who was owed is
  owed that much less, so everything still sums to zero and the next
  settlement sheet asks only for what is left. Example: Ryan paid Kobe $190
  during the game.
- **Correct one player's balance by hand** (one-sided). Add or subtract any
  amount from one player. The leaderboard lists it and says how much it leaves
  the books short, so you cannot forget it.

Neither kind changes the leaderboard, which is poker results only. Both change
settlement sheets. Each entry has a date and is tagged with the folder you were
scoped to when you added it. It counts in the "all folders" view and in that
folder's view, and only inside date ranges that include its date. An entry
added while viewing all folders is tagged "(all folders)" and counts only when
you settle everything; a folder or single-game sheet says so when it leaves one
out. This way a payment is never counted twice when you settle folders one at
a time. Entries show
in a player's history (dimmed), under the leaderboard, and in the report's
"Adjust" column. They are saved in `Saved_Data/adjustments.csv`. Removing one
side of a payment removes the other side too.

### Shared accounts (menu 20)

PokerNow credits every seat to the name and account it was bought on. When a
friend plays on someone else's account (their phone, their laptop) or buys in
under someone else's name, the ledger puts that result on the wrong person, and
merging the names (menu 4) would only make it worse by folding the friend into
the account owner for good.

Menu 20 fixes it one seat at a time instead of one name at a time. Each seat
(one row of one ledger) can be handed to the person whose money it really was;
the leaderboard, player history, settlement sheets, HTML report and hand-log
stats all count it for them. The ledger CSVs are never edited.

The app flags seats that look shared, and warns at startup until they are checked:

- the account is normally someone else's (one person has at least 3 seats and
  more than half of all seats on it), or
- the same person is sitting on two different accounts at the same time.

A name never seen on any other account is left to menu 4 first, because it is
more often a new nickname than a borrowed phone. Whatever you answer in either
menu is saved in the same place, so neither menu asks about that seat again.

For each flagged seat (seats with the same name on the same account in the same
game are asked about together) choose: the name on the seat is right, the
account's usual owner, someone else, or skip. "The name is right" is remembered
too, so the seat stops being flagged. Option 2 reassigns any seat in any game,
flagged or not; option 3 lists every saved choice and undoes one.

Choices live in `Saved_Data/seat_owners.csv`, keyed by ledger id, account,
sit-down time and nickname. If one seat mixed two people's money (a "first 20 /
last 30" seat), give it to one of them here, then move the other person's share
across with menu 17, option 1 (it moves an amount from one player's balance to
another's).

### Sessions and payments

Menu 7 saves the current sheet under a name (it suggests the game or folder
name) so you can track who has paid. Menus 8 and 9 show saved sheets (all, or
only what is unpaid), menu 10 records a full or partial payment, and menu 11
adds up everything still owed between each pair of people across every sheet.

### Hand logs (menus 18 and 19)

The PokerNow log records every hand of a night: who was seated with what stack,
every fold, call, bet and raise, the board, the cards shown at showdown, and
who collected the pot. Menu 18 turns the logs in scope into one row per player:

| Column | Meaning |
|---|---|
| Hands | hands the player was dealt into |
| VPIP | % of hands where they put money in voluntarily preflop (blinds do not count) |
| PFR | % of hands they raised preflop |
| Flop | % of hands where they saw the flop |
| WTSD | of the flops they saw, % that went to showdown |
| W$SD | % of showdowns they won |
| FoldR | % of the time they folded when facing a preflop raise |
| AF | postflop aggression: (bets + raises) / calls |
| Big pot | the biggest pot they collected |
| Style | a label from VPIP and AF: tight/loose, aggressive/passive (needs 30+ hands) |

Nicknames are folded with the same merge rules as the ledgers, so a person who
changes their PokerNow name stays one row. The 7-2 bounty payments PokerNow
logs after a hand are counted in each player's net (they move real chips) and
are also totalled separately in the CSV export and the HTML report.

Menu 18 also lists any games in scope that have no log yet, so you can see what
to download. Menu 19 files new downloads for you (see the routine at the top).

The app checks its own reading of every log: each hand must sum to zero and
every player's stack at the next hand must equal the previous stack plus the
result of the hand (top-ups excepted). A night that fails this check gets a
yellow `*N` (N hands) in the summary table so you know its numbers are slightly off.

Menu 21 shows deeper profiles in two tables, before the flop and after it.

### Charts

Menu 15 draws two charts in the terminal: every player's net as green (won)
and red (lost) bars, and a running-total chart for "me" (or the top earner),
one dot per night, with the $0 line marked. Both count poker only. Menu 3
shows the same running-total chart under a player's night-by-night history.
Menu 14 writes a self-contained HTML file with:

- summary tiles (games, players, buy-in volume, your net and average)
- net result by player (bar chart, hover for details)
- running total over time for you plus the biggest movers (hover for a
  crosshair that reads every line at that game)
- game-by-game bars for you (or the top earner if "me" is not set)
- the full leaderboard, the settlement sheet, and a table of every game in scope
- the playing-style table for every log in scope
- **night by night**: one collapsible chart per game that has a hand log, with
  each player's running result through the night, hand by hand. The newest
  night starts open; hover to read every stack at any hand.

It works offline, follows your light/dark system setting, and can be opened
from the app straight after it is written.

## Checking the math

Poker is zero-sum, so the app checks itself every time it starts. Each game's
nets must add up to $0.00, and a ledger that does not gets a startup warning.
The menu header and the leaderboard's last line both say "✓ books balanced"
when every player's net adds up to $0.00. Payments and corrections are listed
under the leaderboard with their own total, so a one-sided entry is never
hidden.

In `player_summary.csv` (menu 12), `total_net` is the poker result and
`adjustments` is the menu 17 total; a settlement sheet uses the two added
together.

`tools/validate.py` recomputes every number the app produces from the raw
CSVs using exact integer cents and compares them to the app's own exports:
player totals per scope, settlement sheets (plain, pinned preferences, banker),
session balances and payments, history dates and running totals, and the
duplicate-ledger detection. Run it against a copy of the project folder,
because it drives the app's menus and writes to that copy's Saved_Data:

```bash
cp -RX . /tmp/plr_check && python3 tools/validate.py /tmp/plr_check ./cmake-build-debug/Poker_Ledger_Reader
```

It ends with `ALL CHECKS PASSED` or a list of every mismatch.

## Name merging (menu 4)

Names are matched on letters only, lower-cased, so "Yaden ):" and "yaden" are
the same person automatically. A name with no letters at all ("24242424242424")
is matched on its digits instead; every seat with money on it is always counted.

Two different situations, two menus:

| Situation | Menu | What it changes |
|---|---|---|
| One person, several nicknames ("Kobe", "Kober", "Mamba") | 4 | Merges the names for good: every seat under any of them counts for one person |
| A seat played by someone other than the name on it (a friend on your phone) | 20 | Moves that one seat's money; both names stay as they are |

When a name that has never appeared on any other account shows up on an account
someone else already uses, the app warns at startup and menu 4 asks once:

```
New name to check (1 left)
    24242424242424            +$536.89   never seen before
  has only ever played on account DRSv3IR7B7, which is also used by:
    1. Kobe                        -$6.80
  The same person under a new nickname?  Type their number.
  A different person (the name is right)?  Type d.
  Not sure yet?  Press Enter.
```

A number merges only the new name into that person (anyone else who played
on the account is left alone), `d` saves "the name is right" (the same record
menu 20 keeps, so neither menu asks again), and Enter leaves it for next time.
Two regular players who both have accounts of their own and happened to share
one are never asked here; that is a borrowed phone, and menu 20 handles the seat.

Menu 4 also has:

1. **Merge names by hand**: type the numbers of names that are one person, the
   name to keep first (`12,5`). If they have never played on the same PokerNow
   account, it warns first, because a name alone is weak evidence: anyone who
   later calls themselves "fish" would count for whoever "fish" is merged into.
2. **See merged names / split one back out**: every group, and a way to undo a
   merge by splitting one name out again.

Rules are saved to `merge_rules.csv` and applied every time the app starts, to
ledgers and hand logs alike. Saved payment pins and the "me"/banker settings
follow merges automatically.
