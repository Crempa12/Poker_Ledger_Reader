import { useState } from "react";
import { boardFor, players, settlement, util, type Game, type PlayerStats } from "@plr/core";

import { Sparkbars, type LinePoint } from "../components/charts.tsx";
import { useSaver } from "../components/saver.tsx";
import { isSnapshot } from "../data.ts";
import { dayScope, nightsOf, upDown, type Ctx } from "../context.ts";
import { longDate, money, moneyCents, moneySigned, moneySignedCents, plural, shortDate, toneOf, toneOfCents } from "../format.ts";
import { resultsOf } from "../game.ts";
import { href } from "../router.ts";
import { printOrder } from "../settle-sheet.ts";
import { AddGame } from "./AddGame.tsx";

export function runningTotal(p: PlayerStats, timeZone: string): LinePoint[] {
  let cents = 0;
  return nightsOf(p).map((h) => {
    cents += h.netCents;
    return { label: shortDate(h.date, timeZone), value: cents / 100 };
  });
}

// How many rows the standings show before "Show all": on a phone, and on a wide screen.
const PHONE_ROWS = 8;
const WIDE_ROWS = 15;

// Standings: you first (or the leader), then everyone by net, then the latest night and what is still owed.
export function Overview({ ctx, onSaved = () => undefined }: { ctx: Ctx; onSaved?: () => void }) {
  const { view, world } = ctx;

  // No games at all (not just none in this scope). Where a game can be filed (a data folder with none yet, or
  // one the site may start), the start page is + Add itself: paste the first link, press one button. Otherwise
  // the folder read may not be the console app's, and the page says where it has to be.
  if (world.games.length === 0 && !isSnapshot(ctx.payload)) {
    if (ctx.payload.canWrite && (ctx.payload.dataReady === true || ctx.payload.canStartData === true)) {
      return <AddGame ctx={ctx} onSaved={onSaved} first />;
    }
    return <NoGames ctx={ctx} />;
  }
  if (view.games.length === 0) {
    return <p className="lede">No games in this scope. Pick another folder or date range above.</p>;
  }

  const board = view.board;
  // The table lists the players with a game, as the console's does; a player with payments only is listed under it.
  const listed = board.filter((p) => p.games > 0);
  const offBy = board.reduce((s, p) => s + p.totalNetCents, 0);
  const latest = view.games[view.games.length - 1];
  return (
    <div className="homegrid">
      <div>
        <YouBlock ctx={ctx} listed={listed} latest={latest} onSaved={onSaved} />
        <section className="sec" aria-labelledby="standings-h">
          <div className="sec-h">
            <h2 id="standings-h">Standings</h2>
            <span className="sub">
              {plural(board.length, "player")} · net after buy-ins
            </span>
          </div>
          <Standings ctx={ctx} listed={listed} />
          {offBy === 0 ? (
            <p className="note">Every net adds up to $0.00.</p>
          ) : (
            <p className="note down">The games are off by {moneySignedCents(offBy)}: a ledger does not balance (see Checks).</p>
          )}
          <PaymentsInScope ctx={ctx} board={board} />
        </section>
      </div>
      <aside className="side" aria-label="The latest night, and what is still owed">
        {latest !== undefined ? <LatestNight ctx={ctx} game={latest} /> : null}
        <StillOwed ctx={ctx} />
      </aside>
    </div>
  );
}

// "1st", "2nd", "3rd", "11th", "22nd".
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
}

// Whether a night is last night: it started under a day and a half before now (or before the snapshot was made).
function isLastNight(ctx: Ctx, game: Game): boolean {
  const now = isSnapshot(ctx.payload) ? ctx.payload.loadedAt : Date.now();
  if (game.start === null) return false;
  const ago = now / 1000 - game.start;
  return ago >= 0 && ago < 36 * 3600;
}

// You: your net for the scope as the big number, your place, and who you owe. Without a "me" (or with one
// who has no games in this scope) the leader takes the place, and the page says how to see your own.
function YouBlock({ ctx, listed, latest, onSaved }: { ctx: Ctx; listed: PlayerStats[]; latest: Game | undefined; onSaved: () => void }) {
  const { me } = ctx;
  const snapshot = isSnapshot(ctx.payload);
  const meName = me === "" ? "" : ctx.nameOf(me);
  const rank = listed.findIndex((p) => p.normalizedName === me);
  const mine = rank >= 0 ? listed[rank] : undefined;
  const focus = mine ?? listed[0];
  if (focus === undefined) return null;
  const d = players.playerDollars(focus);
  const place = mine !== undefined ? rank + 1 : 1;
  // "You" on the computer that keeps the data. A phone on the Wi-Fi, or a snapshot, is read by the rest of
  // the group, so it names them instead.
  const own = ctx.payload.canWrite;
  // The latest night in scope, for this player, if they played it.
  const tonight = latest === undefined ? undefined : resultsOf(latest, ctx.world.rules).find((r) => r.person === focus.normalizedName);
  const when = latest === undefined ? "" : isLastNight(ctx, latest) ? "last night" : shortDate(latest.start, ctx.tz);
  // Beside your number, the leader's (or, when you lead, how far ahead you are).
  const leader = listed[0];
  const second = listed[1];
  const versus =
    mine === undefined || leader === undefined
      ? null
      : place > 1
        ? (
            <>
              Leader {leader.displayName} <span className={`amt ${toneOf(players.playerDollars(leader).totalNet)}`}>{moneySigned(players.playerDollars(leader).totalNet)}</span>
            </>
          )
        : second !== undefined
          ? (
              <>
                Ahead of {second.displayName} by <span className="amt">{money(d.totalNet - players.playerDollars(second).totalNet)}</span>
              </>
            )
          : null;
  return (
    <section className="you" aria-labelledby="you-h">
      <p className="label" id="you-h">
        {mine === undefined ? `Leader · ${focus.displayName}` : `${own ? "You · " : ""}${focus.displayName} · ${ordinal(place)} of ${listed.length}`}
      </p>
      <p className={`hero ${toneOf(d.totalNet)}`}>{moneySigned(d.totalNet)}</p>
      <p className="facts">
        {plural(focus.games, "night")} · avg <span className="amt">{moneySigned(d.averagePerGame)}</span>
        {tonight !== undefined ? (
          <>
            {" "}
            · {when} <span className={`amt ${toneOfCents(tonight.netCents)}`}>{moneySignedCents(tonight.netCents)}</span>
          </>
        ) : null}
      </p>
      {versus !== null ? <p className="vs">{versus}</p> : null}
      {mine !== undefined ? <OwesLine ctx={ctx} you={own ? null : meName} /> : null}
      {mine === undefined ? (
        me === "" && own ? (
          <WhoAreYou ctx={ctx} onSaved={onSaved} />
        ) : (
          <p className="hint">{me === "" ? "The top earner, in this scope." : `${meName} has no games in this scope, so the top earner is shown.`}</p>
        )
      ) : null}
    </section>
  );
}

// The top earner is shown until the site knows who you are: one pick here says it (Settings' "Me", menu 6).
function WhoAreYou({ ctx, onSaved }: { ctx: Ctx; onSaved: () => void }) {
  const { busy, run, shown } = useSaver(ctx, onSaved);
  const [pick, setPick] = useState("");
  const people = [...ctx.everyone].filter((p) => p.games > 0).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const save = (): void => {
    void run("settings.csv", settlement.serializeSettingsCSV({ ...ctx.world.settings, me: pick }), `Saved: you are ${ctx.nameOf(pick)}.`);
  };
  return (
    <div className="whoyou">
      <p className="hint">
        <label htmlFor="who-you">The top earner, for now. Which one is you? Your own number then comes first here.</label>
      </p>
      <div className="row tight">
        <select id="who-you" value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy}>
          <option value="">Pick your name…</option>
          {people.map((p) => (
            <option key={p.normalizedName} value={p.normalizedName}>
              {p.displayName}
            </option>
          ))}
        </select>
        <button onClick={save} disabled={busy || pick === ""}>
          {busy ? "Saving…" : "That's me"}
        </button>
      </div>
      {shown}
    </div>
  );
}

// "You owe Ozzie $40.00. Della owes you $10.00." from the saved sheets, for every game (as Who owes counts it).
// you: the name to use instead of "you" (a snapshot is read by others), or null.
function OwesLine({ ctx, you }: { ctx: Ctx; you: string | null }) {
  const { me, world } = ctx;
  if (world.balances.size === 0) return null;
  const canon = (n: string): string => players.resolveCanonical(world.rules, n);
  const lines = ctx.view.owed.flatMap((d) => {
    if (canon(d.fromNormalized) === me) return [`${you ?? "You"} ${you === null ? "owe" : "owes"} ${d.toDisplay} ${moneyCents(d.totalCents)}.`];
    if (canon(d.toNormalized) === me) return [`${d.fromDisplay} owes ${you ?? "you"} ${moneyCents(d.totalCents)}.`];
    return [];
  });
  return (
    <p className="owes">
      {lines.length === 0 ? `${you ?? "You"} ${you === null ? "owe" : "owes"} nothing on the saved sheets, and nobody owes ${you === null ? "you" : you}.` : lines.join(" ")}{" "}
      <a href={href("owed")}>Who owes</a>
    </p>
  );
}

// The standings: a real table, with every figure the console's leaderboard has on a wide screen (nights,
// up-down, net, average, best, worst, the last ten nights) and rank, name, net and the last five on a phone.
function Standings({ ctx, listed }: { ctx: Ctx; listed: PlayerStats[] }) {
  const [all, setAll] = useState(false);
  const { me } = ctx;
  const longer = listed.length > PHONE_ROWS;
  return (
    <>
      <div className={all ? "boardwrap" : "boardwrap collapsed"}>
        <table className="board">
          <thead>
            <tr>
              <th scope="col" className="num">
                #
              </th>
              <th scope="col">Player</th>
              <th scope="col" className="num wide">
                Nights
              </th>
              <th scope="col" className="num wide">
                Up–Dn
              </th>
              <th scope="col" className="num">
                Net
              </th>
              <th scope="col" className="num wide">
                Avg/night
              </th>
              <th scope="col" className="num wide">
                Best
              </th>
              <th scope="col" className="num wide">
                Worst
              </th>
              <th scope="col" className="form">
                <span className="sm-only">Last 5</span>
                <span className="lg-only">Last 10</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {listed.map((p, i) => {
              const d = players.playerDollars(p);
              const ud = upDown(p);
              const nights = nightsOf(p).map((h) => h.netCents / 100);
              const rows = [i >= PHONE_ROWS ? "later" : "", i >= WIDE_ROWS ? "later2" : "", p.normalizedName === me ? "me" : ""].filter((c) => c !== "");
              return (
                <tr key={p.normalizedName} className={rows.length > 0 ? rows.join(" ") : undefined}>
                  <td className="num rk">{i + 1}</td>
                  <td className="nm">
                    <a href={href("player", p.normalizedName)}>{p.displayName}</a>
                    <span className="line2">
                      {plural(p.games, "night")} · avg {moneySigned(d.averagePerGame)}
                    </span>
                  </td>
                  <td className="num wide">{p.games}</td>
                  <td className="num wide">
                    {ud.up}-{ud.down}
                  </td>
                  <td className={`num net ${toneOf(d.totalNet)}`}>{moneySigned(d.totalNet)}</td>
                  <td className={`num wide ${toneOf(d.averagePerGame)}`}>{moneySigned(d.averagePerGame)}</td>
                  <td className={`num wide ${toneOf(d.biggestWin)}`}>{moneySigned(d.biggestWin)}</td>
                  <td className={`num wide ${toneOf(d.biggestLoss)}`}>{moneySigned(d.biggestLoss)}</td>
                  <td className="form">
                    <Form values={nights.slice(-5)} subject={p.displayName} />
                    <span className="lg-only">
                      <Sparkbars values={nights.slice(-10)} subject={p.displayName} />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {longer ? (
        <button className={listed.length > WIDE_ROWS ? "link showall" : "link showall sm-only"} aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${listed.length}`}
        </button>
      ) : null}
    </>
  );
}

// The last nights as signs, oldest first: + won, − lost, · even. Read out as the amounts.
function Form({ values, subject }: { values: number[]; subject: string }) {
  const said = `${subject}, last ${plural(values.length, "night")}: ${values.map((v) => moneySigned(v)).join(", ")}`;
  return (
    <span className="sm-only" role="img" aria-label={said}>
      {values.map((v, i) => {
        const tone = toneOf(v);
        return (
          <span key={i} className={tone} aria-hidden="true">
            {tone === "up" ? "+" : tone === "down" ? "−" : "·"}
          </span>
        );
      })}
    </span>
  );
}

// Payments and corrections in scope, by date and then by name (the console's order), each with its player:
// under the table, folded, since they change who owes whom and not who won.
function PaymentsInScope({ ctx, board }: { ctx: Ctx; board: PlayerStats[] }) {
  const payments = board
    .flatMap((p) => p.history.filter((h) => h.adjustment).map((h) => ({ h, p })))
    .sort((a, b) => (a.h.date ?? -1) - (b.h.date ?? -1) || util.compareBytes(a.p.displayName, b.p.displayName));
  if (payments.length === 0) return null;
  const cents = payments.reduce((s, x) => s + x.h.netCents, 0);
  return (
    <details className="fold">
      <summary>
        Payments &amp; corrections in this scope ({payments.length}){cents === 0 ? "" : " · one-sided"}
      </summary>
      <div className="adjusted">
        <p className="sub">
          These change who owes whom on a settlement sheet, not who won · <a href={href("adjust")}>see or change them</a>
        </p>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Player</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {payments.map(({ h, p }, i) => (
                <tr key={`${p.normalizedName}-${i}`}>
                  <td>{longDate(h.date, ctx.tz)}</td>
                  <td>
                    <a href={href("player", p.normalizedName)}>{p.displayName}</a>
                  </td>
                  <td className={`num ${toneOfCents(h.netCents)}`}>{moneySignedCents(h.netCents)}</td>
                  <td className="muted">{h.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={cents === 0 ? "sub" : "small down"}>
          {cents === 0
            ? "They cancel out: every payment is on both sides."
            : `One-sided: they add up to ${moneySignedCents(cents)}, so a settlement sheet will be short by that much.`}
        </p>
      </div>
    </details>
  );
}

// The latest night in scope: who won, and the payments that settle it (as Settle up works it out for that
// night: its folder and day, the pins and the banker in Settings).
function LatestNight({ ctx, game }: { ctx: Ctx; game: Game }) {
  const { world, tz, me } = ctx;
  const results = resultsOf(game, world.rules);
  const top = results[0];
  const sheet = settlement.calculateSheet(boardFor(world, [game], dayScope(game, tz)), world.prefs, world.settings.banker);
  const entries = printOrder(sheet.entries);
  const shown = entries.slice(0, 4);
  return (
    <section className="sec" aria-labelledby="latest-h">
      <div className="sec-h">
        <h2 id="latest-h">
          {isLastNight(ctx, game) ? "Last night" : "Latest night"} · {shortDate(game.start, tz)}
        </h2>
        <a href={href("game", game.id)}>The night</a>
      </div>
      <p className="sub">
        {plural(results.length, "player")} · {moneyCents(game.totalBuyInCents)} in
        {top !== undefined && top.netCents > 0 ? (
          <>
            {" "}
            · top {ctx.nameOf(top.person)} <span className="amt up">{moneySignedCents(top.netCents)}</span>
          </>
        ) : null}
      </p>
      {entries.length === 0 ? (
        <p className="sub">Nobody owes anything for it.</p>
      ) : (
        <ul className="pays">
          {shown.map((e, i) => (
            <li key={i} className={players.resolveCanonical(world.rules, e.fromNormalized) === me || players.resolveCanonical(world.rules, e.toNormalized) === me ? "pl you" : "pl"}>
              <span className="who">{e.fromDisplay}</span>
              <span className="lead" aria-hidden="true" />
              <span className="amt">{moneyCents(e.amountCents)}</span>
              <span className="to">
                <span aria-hidden="true">→ </span>
                <span className="sr-only">pays </span>
                {e.toDisplay}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="note">
        <a href={href("settle", game.id)}>{entries.length > shown.length ? `Settle up: all ${plural(entries.length, "payment")}` : "Settle up this night"}</a>
      </p>
    </section>
  );
}

// What the saved sheets still say is unpaid, for every game (Who owes), your own lines marked.
function StillOwed({ ctx }: { ctx: Ctx }) {
  const { world, me, view } = ctx;
  if (world.balances.size === 0) return null;
  const total = view.owed.reduce((s, d) => s + d.totalCents, 0);
  const canon = (n: string): string => players.resolveCanonical(world.rules, n);
  const shown = view.owed.slice(0, 5);
  return (
    <section className="sec" aria-labelledby="owed-h">
      <div className="sec-h">
        <h2 id="owed-h">Still owed</h2>
        <a href={href("owed")}>Who owes</a>
      </div>
      {view.owed.length === 0 ? (
        <p className="sub">Nothing. Every saved sheet is paid.</p>
      ) : (
        <>
          <p className="hero-s">
            {moneyCents(total)}
            <small>on the saved sheets</small>
          </p>
          <ul className="pays">
            {shown.map((d) => (
              <li key={`${d.fromNormalized}->${d.toNormalized}`} className={canon(d.fromNormalized) === me || canon(d.toNormalized) === me ? "pl you" : "pl"}>
                <span className="who">{d.fromDisplay}</span>
                <span className="lead" aria-hidden="true" />
                <span className="amt">{moneyCents(d.totalCents)}</span>
                <span className="to">
                  <span aria-hidden="true">→ </span>
                  <span className="sr-only">owes </span>
                  {d.toDisplay}
                </span>
              </li>
            ))}
          </ul>
          {view.owed.length > shown.length ? (
            <p className="note">
              <a href={href("owed")}>All {plural(view.owed.length, "debt")}</a>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

// No games, and none can be filed from here: a phone on the Wi-Fi, or a folder that is not the console app's
// (and that the site may not start one in).
function NoGames({ ctx }: { ctx: Ctx }) {
  const folder = ctx.payload.dataRoot.split(/[\\/]/).filter((part) => part !== "").pop() ?? ctx.payload.dataRoot;
  if (ctx.payload.dataReady === true) {
    return (
      <>
        <h1>No games yet</h1>
        <p className="lede">
          The data folder <code>{folder}</code> has no games in it yet. Games are added on the computer that runs the site.
        </p>
      </>
    );
  }
  return (
    <>
      <h1>No games were found</h1>
      <p className="lede">
        No games were found in <code>{folder}</code>.
      </p>
      {ctx.payload.dataStartable === true ? (
        <p>
          Not using the console app? The site starts a data folder of its own only in a folder that is empty (or not there yet), that
          it may write to, and that is not a link. If <code>{ctx.payload.dataRoot}</code> holds other files, move them out; otherwise
          set <code>PLR_DATA_ROOT</code> to such a folder. Then press <strong>Refresh</strong>.
        </p>
      ) : null}
      <p className="sub">
        If you use the console app, the site reads its folder (its <code>Games</code> and <code>Saved_Data</code> folders): it must sit
        next to this one, as <code>Poker_Ledger_Reader</code>, or <code>PLR_DATA_ROOT</code> must name it. Then press{" "}
        <strong>Refresh</strong>.
      </p>
    </>
  );
}
