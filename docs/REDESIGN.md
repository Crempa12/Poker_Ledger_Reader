# Redesign plan: the quiet receipt

October 2026. Four design directions were drawn with made-up data and scored by three judges: the owner's brief, everyday phone use, and the cost of building it in this app. The **quiet receipt** won (111 points). The card room came second (105), then the ledger book (103) and the sports page (99). This plan builds the receipt, with the best ideas from the other three, and fixes every must-fix the judges found.

## What it looks like

- **Paper and ink.** Warm paper, near-black ink, one green for money won and one red for money lost. A plus or minus sign is always shown, so nothing relies on colour alone. A yellow highlighter marks your own rows.
- **Receipt lines.** A name, a dotted leader, then the amount: `Della ········ $24.34 → Ozzie`. Hairlines and dashed "slip" edges give the structure. There are no cards, shadows or gradients.
- **Two faces, bundled with the site** so they work offline and in a snapshot. Public Sans is for text. IBM Plex Mono is for every number, so columns of money line up.
- **Light and dark** follow the device. Settings can force either one.

## Most important first

1. **You.** Your net for the scope is the big number, with your rank, nights, average and last night under it. The leader's net sits beside it as a reference point, then one plain line about who you owe and who owes you.
2. **Standings.** A real table with column headers. On a phone it shows the top 8, plus your row if you are lower, then "Show all N". On a desktop it adds nights, average, best, worst and the last five nights.
3. **Last night.** The newest night's payments, as receipt lines with a Settle up link. On a phone this comes under the standings; from 1100 px it sits in a side column.
4. **Still owed.** What the saved sheets still say is unpaid, with your own lines highlighted.

## Navigation

- **Phone:** a bottom bar with Standings, Nights, **+ Add** (the one filled item), Who owes and More. In a snapshot, which never adds games, the + Add slot becomes Settle up. Settle up is also reached from Last night and from every night's page.
- **Desktop (900 px and up):** a top row with Standings, Nights, Settle up, Who owes, + Add game and More.
- **More:** Play style, Checks (with its count, which also shows on More), Payments & corrections, Settings, Help, Make a snapshot, the theme choice, and the facts that used to sit under the tiles: hand logs, banker, pins, me, the data folder and the time zone.
- **Scope:** one line, `All folders · All time ▾`, opens a small panel with the folder and date choices. The presets and custom dates work as they do now. The line shows only on the pages it changes: Standings, Nights, Settle up, Play style and a player's page. Who owes says it covers every game.
- **Banners** (console app open, snapshot) are single lines, with any detail in a fold.

## Adding a game (two steps after the link)

1. **Paste the link.** The ledger is fetched as soon as the link is pasted, with no Fetch button. The button stays for keyboard users and for typed links.
2. **The game.** "Found from the link" shows it as a short slip: date, players, bought in, ledger read, and hand log (in Downloads ✓, or "not downloaded yet" with the three steps to get it).
3. **In Downloads.** Each PokerNow file in Downloads that is not filed yet is marked "this game" or "another game". Everything that is ready is ticked.
4. **One button,** **File N into Oct 2026**, on a bar pinned above the bottom nav, so it is always in reach. "Choose another folder" is a small link that opens the folder picker.
5. **Kept from today:** "already in your data", the warning that a download is bigger than the copy already filed, the basis check on every save, the Games-folder rule, and the note when the Folder or Dates at the top hide the new game.

## Starting (first run)

With no games yet, Standings becomes the start page: one heading, the link box and one button.

- **No data folder yet, and the site may start one:** the button is **Start with this game**. It makes the data folder (the existing `POST /api/start-data`, still allowed only where it was), then files the game. Under the button, one line says where the folder goes and to keep it out of git.
- **A data folder with no games:** the button files the game.
- **The site may not start a folder here:** one plain line says why and what to do.
- **The console app's folder:** found next to this one, as now. A line says so.

## Steps

Each step ends with `npm run verify` and `npm run parity` passing, a browser check at 375 and 1280 px in light and dark with made-up data, and a commit.

1. **Foundations.** Colour tokens with a `data-theme` override, the bundled fonts (Latin subset only), and base type, buttons, inputs, focus rings, tables and receipt lines. `styles.css` is rewritten.
2. **Shell.** The bottom bar and the top row, the More page, the scope line and panel, slim banners, and the theme choice. Page names and the Checks badge move.
3. **Standings.** The You block (with the no-me and not-in-scope cases), the standings table, Last night, Still owed, and the side column. The stat tiles and the facts line go.
4. **Nights, a night, Settle up and Who owes.** Receipt lines everywhere. The requests, balances and "who receives what" go into folds. The banker branch, the warnings when a sheet does not balance, and the copy text stay exactly as now.
5. **Add game.** Fetch on paste, the found slip, the Downloads list, and the pinned File bar.
6. **First run.** Start with this game.
7. **The other pages.** Player, Play style, Checks, Seats, Payments & corrections, Settings and Help, in the same style.
8. **Verify.** A review workflow over the whole change, the snapshot build and its size, an accessibility pass (headings, labels, contrast, 44 px targets), and the render tests updated to the new words. Then push.

## Must-fix list from the judges

- No minus sign may end a line on its own: signs and numbers never wrap apart.
- 16 px gutters at 375 px. Nothing may run to the screen edge.
- Nothing may hide under the bottom bar: bottom padding is the bar's height plus the safe-area inset.
- The File button is always on the first screen.
- Desktop standings are a real table with `scope="col"` headers.
- The You figures come from the full board. They are never placeholders. Cover no "me", "me" outside the scope, and a snapshot.
- A snapshot hides every button that changes something.
- Settle up keeps the banker branch, the off-by warnings and `copyText` unchanged.
- Who owes keeps Paid…, Paid in full and the save confirm.
- Fonts are bundled, never fetched from Google.
- The tab is called "Who owes", never "Owed".
- Plain words on first run. Folder names appear only where they help.
