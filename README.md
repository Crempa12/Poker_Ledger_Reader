# Poker Ledger Web

The web version of the Poker Ledger Reader. This is the `web-app` branch: it has
its own history and holds no game data. The console app lives on `master`,
unchanged, and keeps working as before.

## Open it

Double-click **Start Poker Ledger.command** in this folder (the first run installs
what it needs, which takes a minute, and needs [Node.js](https://nodejs.org) 22.18 or
newer). Your browser opens at <http://127.0.0.1:5173> (if another program already uses
that port, the next free one: the window shows the address). Or, from a terminal in
this folder, install once and start it:

```bash
npm install
npm run web
```

On Windows, double-click **Start Poker Ledger.cmd** instead (it needs
[Node.js](https://nodejs.org) 22.18 or newer). This folder must sit next to the console
app's folder; from a checkout of the console app, make it with:

```bash
git worktree add ../Poker_Ledger_Web web-app
```

The site's **Help** tab walks through a week of using it.

### Without the console app

Another group can use the site on its own. With no `Poker_Ledger_Reader` folder next to
this one, the site keeps its data in `data/` inside this folder (git ignores it): the
Overview offers **Start a new data folder**, then add games on **+ Add game**. The files
are the same ones the console app reads, so it can be pointed at that folder later.
`PLR_DATA_ROOT` names any other folder; the site starts a data folder only in one that
is empty or not there yet.

It reads `Games/` and `Saved_Data/` from the console app's folder next to this one
(`../Poker_Ledger_Reader`), every time the page loads or you press **Refresh**, so
it always shows the same numbers as the console app. Set `PLR_DATA_ROOT` to read
another folder. If that folder is not there, or has neither `Games/` nor `Saved_Data/`,
the page says so, and nothing is saved anywhere.

| Page | What it shows |
|---|---|
| Overview | games, players, money in play, whether the books balance, your running total, the leaderboard |
| Player | every night with the running total and its chart, best and worst nights, nicknames, time at the table and who beat them at showdown (menu 3) |
| Play style | from the hand logs: how everyone plays (menu 18), deep profiles (menu 21) and the hit & run factor (menu 22), with the console's CSV files to download |
| Games | every game, newest first; one game's results per player, and every seat with "whose money was it?" (menu 20) |
| Settle up | who pays whom for the scope or one game, with your pins and banker mode; "send my money to a specific person" requests (menu 5); copy it for the group chat; **Save sheet** to track payments (menu 7) |
| Who owes | what is still owed between each pair (with a reminder to copy for the group chat), every saved sheet, and **Paid…** to record a payment (menu 10) |
| Checks | what the console app flags at startup; answer new names, merge names by hand or split one back out (menu 4); answer seats that look shared, undo a saved seat owner (menu 20) |
| Settings | pinned payments, the banker, who "me" is, the console's display (menu 6) |
| Payments & corrections | linked from Settle up and the overview: money that changed hands outside the ledger, debts let go, one-sided corrections, removing one (menu 17) |
| + Add game | paste a PokerNow game link to file its ledger; file the hand logs (and ledgers) in your Downloads folder, or pick them (menu 19) |

The folder and date range at the top work like the console app's scope (menu 1).

### Changing names, sheets and settings

The buttons on Settle up, Who owes, Checks, Settings, Payments & corrections and a game's Seats write the same files in
`Saved_Data/` that the console menus write, byte for byte (checked against the
console app on copies of the data). Two rules keep the two apps from undoing each
other:

- **Quit the console app first** (0. Save and exit). It keeps its own copy of these
  files and writes them all again when it quits, so the site refuses to save names,
  sheets and settings while it is open and says so at the top of the page. (Adding a
  game is not refused: see Adding games below.)
- Every save is checked against the data the page was built from. If anything changed
  since the page loaded (a game was added, or a saved file changed, in another tab or
  by the console app), the save is refused; press **Refresh** and do it again. Adding
  a game is checked the same way.
- If the site cannot tell whether the console app is open, it refuses the save too
  and says so; try again in a moment.
- A file that is not plain UTF-8 text is never rewritten by the site: fix it by hand
  first. A saved file keeps its own line endings (a file the console wrote on Windows
  has CRLF line ends, and stays that way) and its byte order mark, if it has one.
- If a file has rows the site could not read (the Checks page lists them), a save
  asks first, because it would leave those rows out.

Amounts are read the way the site reads them: `1,234` is 1234, and `12,50` is refused.
The console app reads a typed amount only up to its first comma, so there `1,234` is
saved as 1. Type `1234` when you use the console.

Before each change the old file is kept, byte for byte, in `local/backups/` in this
folder: in a folder of its own there, named by a short code for the data folder it
came from (the newest 50 of each file in that folder; older ones are removed). Backups
made before this change stay where they are, in `local/backups/` itself. To undo a
change: quit the console app, rename the backup to the file's name alone (a backup is
named with the date and time it was kept, a short code, and then the file's name, so a
name ending in `_settings.csv` becomes `settings.csv`), copy it into `Saved_Data/` in
place of the file there, then press **Refresh**.

### Adding games

Paste the game's link on **+ Add game**. The ledger is fetched from PokerNow and saved
into `Games/<folder>/` in the console app's folder, the same place menu 19 puts it,
so the console app sees it too. (A data folder with no `Games` folder yet gets the
folder at its top, where the console app also reads games.) PokerNow puts a captcha on hand logs, so download
the log yourself (the page links to each game missing one). The page lists the PokerNow
files in your Downloads folder that are not filed yet, as menu 19 does: press **Add all**
(**Add it** for one file), then **Save all** (or the file's own **Save to** button). It
files a copy and leaves Downloads as it is (menu 19 moves the files). You can also pick
the files by hand. On a Mac, the first time, macOS may ask whether Terminal may open
your Downloads folder.
Game files hold everyone's names, PokerNow ids and results. If the console app's
repository is public on GitHub, committing them there publishes all of that: keep them
out of git, or make that repository private.

A game that is already filed in any folder is not filed again (menu 19 does the same).
A game can be filed while the console app is open, but the console app lists it only
after it is restarted. A folder can be named `Games` only once the data has a `Games`
folder, because otherwise the games at the top of the folder would stop being read.

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

Do not put the site on the internet through a tunnel (ngrok, `ssh -R`, Tailscale Funnel
and the like). Tunnels that say they are one are refused, but a plain TCP tunnel looks
to the site like this computer, and anyone who reaches it could change your files.

## Checks

```bash
npm run verify
```

Type checks, the tests, and the privacy check (nothing git would commit may hold a
real name, id, timestamp or note; it is skipped, and says so, on a computer with no
console app folder next to this one). `npm run parity` compares every number with the
console app on made-up data; `npm run parity:real` does it on your real games
(results stay on this computer). `reference/README.md` explains how the console
app's numbers are produced for that.
