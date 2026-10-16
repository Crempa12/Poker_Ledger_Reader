// How to use the site: the weekly routine on the computer that runs it, or how to read a
// snapshot someone sent. Plain text only; nothing here reads or writes data.
import type { Ctx } from "../context.ts";
import { isSnapshot } from "../data.ts";
import { longDate } from "../format.ts";
import { href } from "../router.ts";

// Each page and the console menus it stands for, for anyone who knows the console app.
const MENUS: { page: string; path: string | null; menus: string }[] = [
  { page: "Standings", path: "", menus: "2 (leaderboard), the startup box (now under More)" },
  { page: "A player (tap a name)", path: null, menus: "3 (player history)" },
  { page: "Nights, and one night", path: "games", menus: "one game's results, 20 (whose money was it?)" },
  { page: "Play style", path: "style", menus: "18 (style), 21 (deep profiles), 22 (hit & run)" },
  { page: "Settle up", path: "settle", menus: "5 (sheet and requests), 7 (save sheet)" },
  { page: "Who owes", path: "owed", menus: "8, 9, 11 (saved sheets), 10 (record a payment)" },
  { page: "Payments & corrections", path: "adjust", menus: "17" },
  { page: "Checks", path: "check", menus: "4 (names), 16 (duplicates), 20 (shared seats), the startup warnings" },
  { page: "Settings", path: "settings", menus: "6 (pins, banker, me, display)" },
  { page: "+ Add game", path: "add", menus: "19 (import from Downloads)" },
];

export function Help({ ctx }: { ctx: Ctx }) {
  if (isSnapshot(ctx.payload)) return <SnapshotHelp ctx={ctx} />;
  return (
    <>
      <h1>How to use it</h1>
      <p className="lede">
        The site reads the data folder (the console app&apos;s folder, if you use the console app) each time a page opens, and again
        when you come back to its tab, so it always shows what the console app shows.
      </p>
      <section className="sec" aria-labelledby="after-h">
        <h2 id="after-h">After each game</h2>
        <ol className="steps">
          <li>
            <span>
              <strong>Add it.</strong> Press <a href={href("add")}>+ Add</a> and paste the game&apos;s PokerNow link: the page
              fetches the ledger. PokerNow puts a captcha on hand logs, so download the hand log from PokerNow yourself; the page
              finds it in your Downloads. Then press the one button at the bottom (<strong>File it</strong>, <strong>File both</strong>
              …). Filed into the wrong folder? Move the files in Finder or File Explorer, then press <strong>Refresh</strong>.
            </span>
          </li>
          <li>
            <span>
              <strong>Answer the checks.</strong> <a href={href("check")}>Checks</a>, under More, shows a count when something needs
              an answer: a new name (a new nickname, or a new player), or a seat that looks like someone else&apos;s money.
            </span>
          </li>
          <li>
            <span>
              <strong>Settle up.</strong> <a href={href("settle")}>Settle up</a> shows the latest night, or everything. Copy it for
              the group chat, then press <strong>Save sheet</strong> to track who has paid. Save one sheet per night or one for the
              whole folder, not both: Who owes adds up every saved sheet.
            </span>
          </li>
          <li>
            <span>
              <strong>Mark what is paid.</strong> On <a href={href("owed")}>Who owes</a>, press <strong>Paid…</strong> as the money
              comes in. That changes Who owes only; a payment on <a href={href("adjust")}>Payments &amp; corrections</a> changes
              Settle up only, as in the console app.
            </span>
          </li>
          <li>
            <span>
              <strong>Share it.</strong> <a href={href("settings")}>Settings</a> → <strong>Make a snapshot</strong>, then{" "}
              <strong>Download it</strong> and send the file to the group (a group chat or AirDrop). It opens in any phone&apos;s
              browser, even offline, and does not change, so make a new one after the next game.
            </span>
          </li>
        </ol>
      </section>

      <section className="sec" aria-labelledby="before-h">
        <h2 id="before-h">Before you change anything</h2>
        <ul className="plain">
          <li>
            Quit the console app first (<strong>0. Save and exit</strong>). It writes its own copy of the names, sheets and settings
            when it quits, so the site will not save those while it is open. A new game can still be filed; the console app lists it
            after it restarts.
          </li>
          <li>
            If the site says something changed since the page loaded, press <strong>Refresh</strong> and do it again.
          </li>
          <li>
            Close the Saved_Data files (adjustments.csv, settings.csv and the rest) in Excel, Numbers or any other program first. A
            program that still has the old copy open writes it back over the change the next time it saves.
          </li>
          <li>Every change keeps the old file in the web folder&apos;s local/backups/; the README says how to put one back.</li>
          <li>
            On your phone, on the same Wi-Fi: in Terminal, in the Poker_Ledger_Web folder, run <code>npm run web:phone</code>, then
            open on the phone the address on the line that starts <code>Network:</code>. Phones can look, not change. Ctrl-C in
            Terminal stops it.
          </li>
        </ul>
      </section>

      <details className="fold">
        <summary>The console app&apos;s menus, page by page</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Page</th>
              <th scope="col">Console menu</th>
            </tr>
          </thead>
          <tbody>
            {MENUS.map((m) => (
              <tr key={m.page}>
                <td>{m.path === null ? m.page : <a href={m.path === "" ? href() : href(m.path)}>{m.page}</a>}</td>
                <td>{m.menus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

function SnapshotHelp({ ctx }: { ctx: Ctx }) {
  return (
    <>
      <h1>How to read this</h1>
      <p className="lede">
        This is a copy of the poker results up to {longDate(Math.floor(ctx.payload.loadedAt / 1000), ctx.tz)}. It does not change:
        ask for a new one after the next game.
      </p>
      <ul className="plain">
        <li>
          The line at the top (all folders, all time) chooses the games that Standings, Nights and Settle up count. Who owes is for
          every game, and Play style has all dates only.
        </li>
        <li>
          <a href={href()}>Standings</a> is the leaderboard; tap a name for that player&apos;s nights.
        </li>
        <li>
          <a href={href("settle")}>Settle up</a> says who pays whom, and <a href={href("owed")}>Who owes</a> what is still unpaid on
          the saved sheets.
        </li>
        <li>
          <a href={href("style")}>Play style</a> reads the hand logs: how everyone plays, and the hit &amp; run factor.
        </li>
      </ul>
    </>
  );
}
