# Poker Ledger Web

The web version of the Poker Ledger Reader. This is the `web-app` branch: it has
its own history and holds no game data. The console app lives on `master`,
unchanged, and keeps working as before.

## Open it

Double-click **Start Poker Ledger.command** in this folder (the first run installs
what it needs, which takes a minute). Your browser opens at
<http://127.0.0.1:5173>. Or, from a terminal in this folder:

```bash
npm run web
```

It reads `Games/` and `Saved_Data/` from the console app's folder next to this one
(`../Poker_Ledger_Reader`), every time the page loads or you press **Refresh**, so
it always shows the same numbers as the console app. Set `PLR_DATA_ROOT` to read
another folder.

| Page | What it shows |
|---|---|
| Overview | games, players, money in play, whether the books balance, your running total, the leaderboard |
| Player | every night with the running total and its chart, best and worst nights, nicknames |
| Games | every game, newest first; one game's results per player, and every seat with "whose money was it?" (menu 20) |
| Settle up | who pays whom for the scope or one game, with your pins and banker mode; "send my money to a specific person" requests (menu 5); copy it for the group chat; **Save sheet** to track payments (menu 7) |
| Who owes | what is still owed between each pair, every saved sheet, and **Paid…** to record a payment (menu 10) |
| Checks | what the console app flags at startup; answer new names, merge names by hand or split one back out (menu 4); answer seats that look shared, undo a saved seat owner (menu 20) |
| Settings | pinned payments, the banker, who "me" is, the console's display (menu 6) |
| Payments & corrections | linked from Settle up and the overview: money that changed hands outside the ledger, debts let go, one-sided corrections, removing one (menu 17) |
| + Add game | paste a PokerNow game link to file its ledger; pick a downloaded hand log to file it |

The folder and date range at the top work like the console app's scope (menu 1).

### Changing names, sheets and settings

The buttons on Settle up, Who owes, Checks, Settings, Payments & corrections and a game's Seats write the same files in
`Saved_Data/` that the console menus write, byte for byte (checked against the
console app on copies of the data). Two rules keep the two apps from undoing each
other:

- **Quit the console app first** (0. Save and exit). It keeps its own copy of these
  files and writes them all again when it quits, so the site refuses to save while
  it is open and says so at the top of the page.
- If anything changed since the page loaded (a game was added, or a saved file
  changed, in another tab or by the console app), the save is refused; press
  **Refresh** and do it again.
- If the site cannot tell whether the console app is open, it refuses the save too
  and says so; try again in a moment.
- A file that is not plain UTF-8 text is never rewritten by the site: fix it by hand
  first.
- If a file has rows the site could not read (the Checks page lists them), a save
  asks first, because it would leave those rows out.

Amounts are read the way the site reads them: `1,234` is 1234, and `12,50` is refused.
The console app reads a typed amount only up to its first comma, so there `1,234` is
saved as 1. Type `1234` when you use the console.

Before each change the old file is kept, byte for byte, in `local/backups/` in this
folder (the newest 50 of each file; older ones are removed). To undo a change: quit
the console app, rename the backup to the file's name alone (a backup is named with
the date and time it was kept, a short code, and then the file's name, so a name
ending in `_settings.csv` becomes `settings.csv`), copy it into `Saved_Data/` in place
of the file there, then press **Refresh**.

### Adding games

Paste the game's link on **+ Add game**. The ledger is fetched from PokerNow and saved
into `Games/<folder>/` in the console app's folder, the same place menu 19 puts it,
so the console app sees it too. PokerNow puts a captcha on hand logs, so download
the log yourself (the page links to each game missing one) and pick the file there.
Commit the new files on `master` as usual.

### Share it with the group (any phone, anywhere)

**Settings → Make a snapshot** (or `npm run snapshot`) makes one file,
`local/snapshots/poker-ledger-<date>.html`, with every page of the site and the
results up to now inside it. It opens on any phone or computer, even offline, with
nothing to install: send it by AirDrop, a message or a shared drive. It is
read-only and does not update, so make a new one after each game. It holds
everyone's results, names, notes and PokerNow account ids, and the saved sheets and
payments: send it only to people who may see them.

### On your phone (same Wi-Fi)

```bash
npm run web:phone
```

The terminal prints a `Network:` address; open it on your phone. Anyone on that
Wi-Fi can then read the page, so use it at home, not on public Wi-Fi. Adding games
and every other change work only on this computer.

## Checks

```bash
npm run verify
```

Type checks, the tests, and the privacy check (nothing git would commit may hold a
real name, id, timestamp or note). `npm run parity` compares every number with the
console app on made-up data; `npm run parity:real` does it on your real games
(results stay on this computer). `reference/README.md` explains how the console
app's numbers are produced for that.
