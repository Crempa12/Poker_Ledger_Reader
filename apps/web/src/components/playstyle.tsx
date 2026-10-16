// Menu 18 (playing style) and menu 21 (deep profiles), as the website shows them. The rows,
// columns, labels, tags and explanations are the console's; every number goes through the
// core's printf rounding (handformat.ts).
import type { ReactNode } from "react";
import { handlog, hitrun, playstyle, util } from "@plr/core";

// The console's own sort (libc++ std::sort), so equal counts come out in the console's order.
import { libcppSort } from "../../../../packages/core/src/libcpp-sort.ts";

import { href } from "../router.ts";
import type { HandScopePayload } from "../handtypes.ts";
import { afText, cutCell, hrText, pctText, profilesOf, rateText, styleName } from "../handformat.ts";
import { AddLogHint, Legend, Lines } from "./handlines.tsx";

// The Archetype column's width in the console's table (playstyle.cpp printProfiles: W - 68 = 32).
const ARCHETYPE_COLUMNS = 32;

// The Archetype cell. The console cuts a longer label to its column; the whole label is on hover,
// and on the person's long read.
function ArchetypeCell({ label }: { label: string }) {
  const short = cutCell(label, ARCHETYPE_COLUMNS);
  return <td className="label" title={short === label ? undefined : label}>{short}</td>;
}

// The menu 18 "Games without a log" list (main.cpp handLogStats): the newest games in scope with no
// hand log, and how many more there are. Folded: it is a to-do list, not a result.
export function UnloggedCard({ data, tz, children }: { data: HandScopePayload; tz: string; children?: ReactNode }) {
  const games = data.unlogged ?? [];
  if (games.length === 0) return null;
  const more = data.unloggedMore ?? 0;
  return (
    <details className="fold">
      <summary>Games without a log ({games.length + more})</summary>
      {children}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Folder</th>
              <th scope="col">Game</th>
            </tr>
          </thead>
          <tbody>
            {games.map((g) => (
              <tr key={g.id}>
                <td className="nowrap">{util.formatLocalDate(g.start, tz)}</td>
                <td>{g.folder}</td>
                <td className="mono small">{g.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more > 0 ? (
        <p className="sub">{`${more} more ${more === 1 ? "game" : "games"} without a log ${more === 1 ? "is" : "are"} not listed.`}</p>
      ) : null}
    </details>
  );
}

// The menu 18 "Hand logs in scope" table (handlog.cpp printGameSummaries), in the console's order.
export function NightsCard({ data, tz }: { data: HandScopePayload; tz: string }) {
  if (data.nights.length === 0) return null;
  const unreconciled = data.nights.some((n) => n.stackMismatches > 0);
  return (
    <section className="card">
      <h2>Hand logs in scope</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Folder</th>
              <th className="num">Hands</th>
              <th className="num">Hours</th>
              <th className="num">Players</th>
              <th className="num">Showdown</th>
              <th className="num">Biggest pot</th>
              <th>Won by</th>
            </tr>
          </thead>
          <tbody>
            {data.nights.map((n) => (
              <tr key={n.gameId}>
                <td className="nowrap">{util.formatLocalDate(n.start, tz)}</td>
                <td>{n.folder}</td>
                <td className="num">{n.hands}</td>
                <td className="num">{util.fixedText(n.hours, 1)}</td>
                <td className="num">{n.players}</td>
                <td className="num">{pctText(n.showdownPercent)}</td>
                <td className="num">{util.money(n.biggestPot)}</td>
                <td className="nowrap">
                  {n.biggestPotWinner} <span className="muted">#{n.biggestPotHand}</span>
                  {n.stackMismatches > 0 ? <span className="warn"> *{n.stackMismatches}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {unreconciled ? (
        <p className="warn small">*N: that many hands on the night did not reconcile, so its stats are slightly off.</p>
      ) : null}
    </section>
  );
}

// The menu 18 style table (handlog.cpp printStyleTable): every column the console prints.
export function StyleCard({ style }: { style: handlog.StyleStats[] }) {
  return (
    <section className="card">
      <h2>How everyone plays</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th className="stick">Player</th>
              <th className="num">Games</th>
              <th className="num">Hands</th>
              <th className="num">VPIP</th>
              <th className="num">PFR</th>
              <th className="num">Flop</th>
              <th className="num">WTSD</th>
              <th className="num">W$SD</th>
              <th className="num">FoldR</th>
              <th className="num">AF</th>
              <th className="num">H&amp;R</th>
              <th className="num">Big pot</th>
              <th>Style</th>
            </tr>
          </thead>
          <tbody>
            {style.map((s) => (
              <tr key={s.normalizedName}>
                <td className="stick">
                  <a href={href("player", s.normalizedName)}>{s.displayName}</a>
                </td>
                <td className="num">{s.games}</td>
                <td className="num">{s.hands}</td>
                <td className="num">{pctText(handlog.vpipPct(s))}</td>
                <td className="num">{pctText(handlog.pfrPct(s))}</td>
                <td className="num">{pctText(handlog.sawFlopPct(s))}</td>
                <td className="num">{pctText(handlog.wtsdPct(s))}</td>
                <td className="num">{pctText(handlog.wsdPct(s))}</td>
                <td className="num">{pctText(handlog.foldToRaisePct(s))}</td>
                <td className="num">{afText(handlog.aggression(s))}</td>
                <td className="num">{hrText(s.hitRun, s.hitRunReliable)}</td>
                <td className="num">{util.money(s.biggestPotWon)}</td>
                <td className={s.hands < 30 ? "muted nowrap" : "label nowrap"}>{styleName(s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Legend
        lines={[
          "VPIP = % of hands where money went in voluntarily preflop.  PFR = % raised preflop.",
          "Flop = % of hands that reached the flop.  WTSD = % of flops that went to showdown.",
          "W$SD = % of showdowns won.  FoldR = % folded facing a preflop raise.  AF = (bets + raises) / calls.",
          "H&R = hit & run factor, 0-100: how early they leave the game when winning (the Hit & run tab explains it).",
          `An H&R in (brackets) has fewer than ${hitrun.MIN_UP_NIGHTS} winning nights behind it.`,
        ]}
      />
    </section>
  );
}

// The menu 21 two tables (playstyle.cpp printProfiles). Players under 50 hands are left out of the
// tables, as the console leaves them out; their long reads are listed below the tables.
export function ProfilesView({ data, scope, canWrite = true }: { data: HandScopePayload; scope: string; canWrite?: boolean }) {
  const { poolVpip, poolPfr, counted } = data.pool;
  const profiles = profilesOf(data);
  const shown = profiles.filter((p) => p.hands >= 50);
  const short = profiles.filter((p) => p.hands < 50);
  const link = (normalized: string) => href("style", "profiles", normalized);

  if (data.logged === 0) {
    return (
      <div className="card pad">
        <p>
          No hand logs in scope. <AddLogHint canWrite={canWrite} />
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="muted">{`Deep playstyle for ${scope}: ${data.logged} of ${data.games} games have a log, ${data.hands} hands analysed.`}</p>
      {data.logged < data.games ? (
        <p className="muted small">
          {`NOTE: ${data.games - data.logged} games in scope have no hand log, so these reads cover only part of the money.`}
        </p>
      ) : null}
      <p className="muted small">
        {`Pool average over ${counted} players with 200+ hands: VPIP ${util.fixedText(poolVpip, 0)}%, PFR ${util.fixedText(poolPfr, 0)}%`}
      </p>

      <section className="card">
        <h2>Before the flop</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th className="stick">Player</th>
                <th className="num">Hands</th>
                <th className="num">VPIP</th>
                <th className="num">PFR</th>
                <th className="num">Limp</th>
                <th className="num">3Bet</th>
                <th className="num">Steal</th>
                <th className="num">Def</th>
                <th>Archetype</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.normalizedName}>
                  <td className="stick">
                    <a href={link(p.normalizedName)}>{p.displayName}</a>
                  </td>
                  <td className="num">{p.hands}</td>
                  <td className="num">{rateText(p.vpip)}</td>
                  <td className="num">{rateText(p.pfr)}</td>
                  <td className="num">{rateText(p.limp)}</td>
                  <td className="num">{rateText(p.threeBet)}</td>
                  <td className="num">{rateText(p.steal)}</td>
                  <td className="num">{rateText(p.blindDefend)}</td>
                  <ArchetypeCell label={playstyle.archetype(p, poolVpip, poolPfr)} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>After the flop, and leaving the table</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th className="stick">Player</th>
                <th className="num">CBet</th>
                <th className="num">F&gt;CB</th>
                <th className="num">ChkR</th>
                <th className="num">AF flop</th>
                <th className="num">AF turn</th>
                <th className="num">AF river</th>
                <th className="num">WTSD</th>
                <th className="num">W$SD</th>
                <th className="num">H&amp;R</th>
                <th>Leaving</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.normalizedName}>
                  <td className="stick">
                    <a href={link(p.normalizedName)}>{p.displayName}</a>
                  </td>
                  <td className="num">{rateText(p.cbet)}</td>
                  <td className="num">{rateText(p.foldToCbet)}</td>
                  <td className="num">{rateText(p.checkRaise)}</td>
                  <td className="num">{util.fixedText(playstyle.afFlop(p), 1)}</td>
                  <td className="num">{util.fixedText(playstyle.afTurn(p), 1)}</td>
                  <td className="num">{util.fixedText(playstyle.afRiver(p), 1)}</td>
                  <td className="num">{rateText(p.wtsd)}</td>
                  <td className="num">{rateText(p.wsd)}</td>
                  <td className="num">{hrText(p.hitRun, p.hitRunReliable)}</td>
                  <td className="label">{p.hitRunTag}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Legend
          lines={[
            `A rate in (brackets) has fewer than ${playstyle.kMinOpportunities} opportunities behind it and is not a tendency.`,
            "Limp = called the big blind with the pot unopened.   3Bet = re-raised a single raise.",
            "Steal = first-in raise from CO/BTN/SB.   Def = did not fold a blind to a steal.",
            "CBet = bet the flop having raised preflop.   F>CB = folded facing a flop c-bet.",
            "ChkR = check-raised.   AF = (bets + raises) / calls.   WTSD = flops that reached showdown.",
            "H&R = hit & run factor, 0-100, from every night in scope (the Hit & run tab has the night-by-night exits).",
            `An H&R in (brackets) has fewer than ${hitrun.MIN_UP_NIGHTS} winning nights behind it; its only possible tag is Busts out.`,
          ]}
        />
      </section>

      {short.length > 0 ? (
        <details className="notes">
          <summary>{`Players with under 50 hands (${short.length}): not in the tables`}</summary>
          <ul className="plain">
            {short.map((p) => (
              <li key={p.normalizedName}>
                <a href={link(p.normalizedName)}>{p.displayName}</a> <span className="muted small">{`${p.hands} hands`}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

// The menu 21 long read for one player (playstyle.cpp printOnePlayer), line for line.
export function ProfileDetail({ data, person }: { data: HandScopePayload; person: string }) {
  const p = profilesOf(data).find((x) => x.normalizedName === person);
  if (p === undefined) {
    return (
      <div className="card pad">
        <p>{`No hand logs for this person in this scope.`}</p>
        <a href={href("style", "profiles")}>Back to the deep profiles</a>
      </div>
    );
  }
  const { poolVpip, poolPfr } = data.pool;
  // The console sorts the winning hands from the map's own (byte) order, with the libc++ sort.
  const winning = [...p.showdownHandClass.entries()].sort((a, b) => util.compareBytes(a[0], b[0]));
  libcppSort(winning, 0, winning.length, (a, b) => a[1] > b[1]);
  const top = winning.slice(0, 5);

  const rows: [string, string][] = [
    [
      "Archetype",
      `${playstyle.archetype(p, poolVpip, poolPfr)}${p.hitRunTag === "" ? "" : ` · ${p.hitRunTag}`}`,
    ],
    [
      "VPIP / PFR",
      `${util.fixedText(playstyle.ratePct(p.vpip), 1)}% / ${util.fixedText(playstyle.ratePct(p.pfr), 1)}%   (pool ${util.fixedText(poolVpip, 0)}% / ${util.fixedText(poolPfr, 0)}%)`,
    ],
    ["Passivity gap", `${util.fixedText(playstyle.passivityGap(p), 1)} points between entering a pot and raising it`],
    [
      "Position (VPIP)",
      `late ${rateText(p.vpipLate)} n=${p.vpipLate.opportunities}, blinds ${rateText(p.vpipBlinds)} n=${p.vpipBlinds.opportunities}, early ${rateText(p.vpipEarly)} n=${p.vpipEarly.opportunities}`,
    ],
    [
      "Preflop",
      `limp ${rateText(p.limp)} n=${p.limp.opportunities}, 3bet ${rateText(p.threeBet)} n=${p.threeBet.opportunities}, fold-to-open ${rateText(p.foldToOpen)} n=${p.foldToOpen.opportunities}`,
    ],
    [
      "Blind war",
      `steal ${rateText(p.steal)} n=${p.steal.opportunities}, defend ${rateText(p.blindDefend)} n=${p.blindDefend.opportunities}`,
    ],
    [
      "Flop",
      `cbet ${rateText(p.cbet)} n=${p.cbet.opportunities}, fold-to-cbet ${rateText(p.foldToCbet)} n=${p.foldToCbet.opportunities}, check-raise ${rateText(p.checkRaise)} n=${p.checkRaise.opportunities}`,
    ],
    [
      "Aggression",
      `flop ${util.fixedText(playstyle.afFlop(p), 2)}, turn ${util.fixedText(playstyle.afTurn(p), 2)}, river ${util.fixedText(playstyle.afRiver(p), 2)}`,
    ],
    [
      "Bet sizing",
      `mostly ${playstyle.typicalBetSize(p)}; ${util.fixedText(playstyle.overbetShare(p), 0)}% of bets are pot-sized or bigger (${p.betSizeSamples} bets)`,
    ],
    [
      "Showdown",
      `reached ${rateText(p.wtsd)} of flops seen, won ${rateText(p.wsd)} of ${p.wsd.opportunities}`,
    ],
  ];
  if (top.length > 0) {
    rows.push(["Winning hands", top.map(([hand, count]) => `${hand} x${count}`).join("   ")]);
  }
  rows.push(["Result", `${util.money(p.net)} over ${p.hands} hands (${util.fixedText(playstyle.bbPer100(p), 1)} bb/100)`]);
  if (p.hitRun >= 0) {
    const reliable = p.hitRunReliable;
    rows.push([
      "Hit & run",
      `${hrText(p.hitRun, reliable)}${p.hitRunTag === "" ? "" : ` - ${p.hitRunTag}`}${reliable ? "" : " (fewer than 3 winning nights: not a tendency yet)"}`,
    ]);
    for (const line of p.hitRunLine.split("\n")) rows.push(["", line]);
  }

  return (
    <section className="card">
      <h2>{`${p.displayName} - ${p.hands} hands over ${p.games} games`}</h2>
      <Lines rows={rows} />
      <Legend
        lines={[
          `NOTE  bb/100 over ${p.hands} hands carries a confidence interval far wider than any plausible edge. Read it as description, never as proof of skill.`,
        ]}
      />
      <p className="small">
        <a href={href("style", "profiles")}>All deep profiles</a>
        {p.hitRun >= 0 ? (
          <>
            {" · "}
            <a href={href("style", "hitrun", p.normalizedName)}>Night by night</a>
          </>
        ) : null}
      </p>
    </section>
  );
}
