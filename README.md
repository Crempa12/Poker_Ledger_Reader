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
| Games | every game, newest first; one game's results per player |
| Settle up | who pays whom for the scope or one game, with your pins and banker mode; "send my money to a specific person" requests (menu 5); copy it for the group chat; **Save sheet** to track payments (menu 7) |
| Who owes | what is still owed between each pair, every saved sheet, and **Paid…** to record a payment (menu 10) |
| Checks | what the console app flags at startup; answer new names, merge names by hand or split one back out (menu 4) |
| Settings | pinned payments, the banker, who "me" is, the console's display (menu 6) |
| + Add game | paste a PokerNow game link to file its ledger; pick a downloaded hand log to file it |

The folder and date range at the top work like the console app's scope (menu 1).

### Changing names, sheets and settings

The buttons on Settle up, Who owes, Checks and Settings write the same files in
`Saved_Data/` that the console menus write, byte for byte (checked against the
console app on copies of the data). Two rules keep the two apps from undoing each
other:

- **Quit the console app first** (0. Save and exit). It keeps its own copy of these
  files and writes them all again when it quits, so the site refuses to save while
  it is open and says so at the top of the page.
- If a file changed since the page loaded it, the save is refused; press
  **Refresh** and do it again.

Before each change the old file is kept in `local/backups/` in this folder.

### Adding games

Paste the game's link on **+ Add game**. The ledger is fetched from PokerNow and saved
into `Games/<folder>/` in the console app's folder, the same place menu 19 puts it,
so the console app sees it too. PokerNow puts a captcha on hand logs, so download
the log yourself (the page links to each game missing one) and pick the file there.
Commit the new files on `master` as usual.

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
