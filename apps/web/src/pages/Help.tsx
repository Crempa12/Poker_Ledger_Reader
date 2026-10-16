// How to use the site: the weekly routine on the computer that runs it, or how to read a
// snapshot someone sent. Plain text only; nothing here reads or writes data.
import type { Ctx } from "../context.ts";
import { isSnapshot } from "../data.ts";
import { longDate } from "../format.ts";
import { href } from "../router.ts";

// Each page and the console menus it stands for, for anyone who knows the console app.
const MENUS: { page: string; path: string | null; menus: string }[] = [
  { page: "Overview", path: "", menus: "2 (leaderboard), the startup box" },
  { page: "A player (tap a name)", path: null, menus: "3 (player history)" },
  { page: "Games", path: "games", menus: "20 (whose money was it?), one game's results" },
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
      <section className="card pad">
        <h1>How to use it</h1>
        <p className="muted">
          The site reads its data folder (the console app&apos;s folder, if you use the console app) every time a page loads, and
          again when you come back to its tab after something changed there, so it always shows what the console app shows.
        </p>
        <h2>After each game</h2>
        <ol>
          <li>
            <a href={href("add")}>+ Add game</a>: paste the game&apos;s PokerNow link. The ledger is saved where the console app keeps
            its games. PokerNow puts a captcha on hand logs, so download the hand log yourself: the page finds it in your Downloads
            folder (press <strong>Add all</strong>, or <strong>Add it</strong> for one file, then <strong>Save all</strong> or the
            file&apos;s own <strong>Save to</strong> button), or you can pick the file. Filed a game in the wrong folder? Move its
            file (and its hand log) to the right folder yourself, in Finder or File Explorer, then press <strong>Refresh</strong>.
          </li>
          <li>
            <a href={href("check")}>Checks</a>: answer any new name (a new nickname, or a new player) and any seat that looks like
            someone else&apos;s money.
          </li>
          <li>
            <a href={href("settle")}>Settle up</a>: choose what to settle (the folder, or one game) and look over who pays whom. If
            someone wants to pay a particular person, add it there. Copy the sheet for the group chat, then press{" "}
            <strong>Save sheet</strong> to track who has paid. Save one sheet per night or one for the whole folder, not both: Who
            owes adds up every saved sheet.
          </li>
          <li>
            <a href={href("owed")}>Who owes</a>: press <strong>Paid…</strong> as the money comes in. That changes Who owes only;
            a payment on <a href={href("adjust")}>Payments &amp; corrections</a> changes Settle up only, as in the console app.
          </li>
          <li>
            Share it: <a href={href("settings")}>Settings</a> → <strong>Make a snapshot</strong>, then <strong>Download it</strong>,
            and send that file to the group (a group chat or AirDrop). It opens in any phone&apos;s browser, even offline, and does
            not change, so make a new one after the next game.
          </li>
        </ol>
      </section>

      <section className="card pad">
        <h2>Before you change anything</h2>
        <ul>
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

      <section className="card">
        <h2>The console app&apos;s menus</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Page</th>
                <th>Console menu</th>
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
        </div>
      </section>
    </>
  );
}

function SnapshotHelp({ ctx }: { ctx: Ctx }) {
  return (
    <section className="card pad">
      <h1>How to read this</h1>
      <p>
        This is a copy of the poker results up to {longDate(Math.floor(ctx.payload.loadedAt / 1000), ctx.tz)}. It does not change:
        ask for a new one after the next game.
      </p>
      <ul>
        <li>
          Folder and Dates at the top choose the games Overview, Games and Settle up count. Who owes is for every game, and Play
          style has all dates only.
        </li>
        <li>
          <a href={href()}>Overview</a> has the leaderboard; tap a name for that player&apos;s nights.
        </li>
        <li>
          <a href={href("settle")}>Settle up</a> says who pays whom, and <a href={href("owed")}>Who owes</a> what is still unpaid on
          the saved sheets.
        </li>
        <li>
          <a href={href("style")}>Play style</a> reads the hand logs: how everyone plays, and the hit &amp; run factor.
        </li>
      </ul>
    </section>
  );
}
