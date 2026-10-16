import { players } from "@plr/core";

import { LineChart } from "../components/charts.tsx";
import { AtTheTable, BeatenAtShowdown, beatenFor } from "../components/hands.tsx";
import { HandStatus } from "../components/handlines.tsx";
import { nightsOf, upDown, type Ctx } from "../context.ts";
import { longDate, moneySigned, moneySignedCents, plural, toneOf, toneOfCents } from "../format.ts";
import { entryOf } from "../handformat.ts";
import { useHandLogs } from "../handlogs.ts";
import { href } from "../router.ts";
import { runningTotal, Tile } from "./Overview.tsx";

export function PlayerPage({ ctx, normalized }: { ctx: Ctx; normalized: string }) {
  const { view, tz } = ctx;
  // The hand logs are read here so the rest of the page never waits for them (the cards below wait).
  const hand = useHandLogs(ctx);
  const p = view.board.find((x) => x.normalizedName === normalized);
  if (p === undefined) {
    const known = ctx.everyone.some((x) => x.normalizedName === normalized);
    return (
      <div className="card pad">
        <h1 className="sr-only">Player</h1>
        <p>{known ? `${ctx.nameOf(normalized)} has no games in this scope.` : "No player by that name."}</p>
        <a href={href()}>Back to the leaderboard</a>
      </div>
    );
  }
  const d = players.playerDollars(p);
  const ud = upDown(p);
  const aliases = p.aliases.filter((a) => a !== p.normalizedName);

  // Newest first, each night with the running total after it (poker only, like the chart).
  let running = 0;
  const rows = p.history.map((h) => {
    if (!h.adjustment) running += h.netCents;
    return { h, runningCents: running };
  });
  rows.reverse();

  return (
    <>
      <section className="card">
        <h1>{p.displayName}</h1>
        <p className="muted small">
          {plural(p.games, "night")} · {plural(p.buyIns, "buy-in")} · {plural(p.playerIds.length, "PokerNow account")}
          {aliases.length > 0 ? ` · also plays as ${aliases.join(", ")}` : ""}
        </p>
        <div className="tiles">
          <Tile label="Net" value={moneySigned(d.totalNet)} tone={toneOf(d.totalNet)} />
          <Tile label="Up–Down" value={`${ud.up}–${ud.down}`} />
          <Tile label="Avg/night" value={moneySigned(d.averagePerGame)} tone={toneOf(d.averagePerGame)} />
          <Tile label="Best night" value={moneySigned(d.biggestWin)} tone={toneOf(d.biggestWin)} />
          <Tile label="Worst night" value={moneySigned(d.biggestLoss)} tone={toneOf(d.biggestLoss)} />
          {p.adjustmentsCents !== 0 ? (
            <>
              <Tile label="Payments & corrections" value={moneySignedCents(p.adjustmentsCents)} tone={toneOfCents(p.adjustmentsCents)} />
              {/* The console's header line: poker net plus payments and corrections, the figure a settlement sheet uses. */}
              <Tile
                label="Balance"
                value={moneySigned(players.balanceDollars(p))}
                tone={toneOf(players.balanceDollars(p))}
                sub="net plus payments"
              />
            </>
          ) : null}
        </div>
      </section>

      <section className="card">
        <h2>Running total</h2>
        <LineChart points={runningTotal(p, tz)} />
      </section>

      <section className="card">
        <h2>At the table</h2>
        {hand.data !== undefined ? (
          <AtTheTable displayName={p.displayName} totalNet={d.totalNet} time={entryOf(hand.data.playtime, normalized)} />
        ) : (
          <HandStatus hand={hand} compact />
        )}
      </section>

      <section className="card">
        <h2>Beaten at showdown by</h2>
        {hand.data !== undefined ? (
          <BeatenAtShowdown displayName={p.displayName} games={hand.data.games} summary={beatenFor(hand.data, normalized)} />
        ) : (
          <HandStatus hand={hand} compact />
        )}
        {hand.data !== undefined &&
        (hand.data.profiles.some((h) => h.normalizedName === normalized) ||
          hand.data.hitRun.summaries.some((s) => s.person === normalized)) ? (
          <p className="small">
            {hand.data.profiles.some((h) => h.normalizedName === normalized) ? (
              <a href={href("style", "profiles", normalized)}>Deep profile</a>
            ) : null}
            {hand.data.profiles.some((h) => h.normalizedName === normalized) &&
            hand.data.hitRun.summaries.some((s) => s.person === normalized)
              ? " · "
              : null}
            {hand.data.hitRun.summaries.some((s) => s.person === normalized) ? (
              <a href={href("style", "hitrun", normalized)}>Hit &amp; run nights</a>
            ) : null}
          </p>
        ) : null}
      </section>

      <section className="card">
        <h2>Every night</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th className="hide-xs">Folder</th>
                <th className="num hide-xs">Buy-ins</th>
                <th className="num">Result</th>
                <th className="num">Running</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ h, runningCents }, i) => (
                <tr key={`${h.gameId}-${i}`} className={h.adjustment ? "dim" : ""}>
                  <td>
                    {h.adjustment ? (
                      <>
                        {longDate(h.date, tz)} <span className="small">· {h.note === "" ? "correction" : h.note}</span>
                      </>
                    ) : (
                      <a href={href("game", h.gameId)}>{longDate(h.date, tz)}</a>
                    )}
                  </td>
                  <td className="hide-xs muted">{h.folder}</td>
                  <td className="num hide-xs muted">{h.adjustment ? "-" : h.buyIns}</td>
                  <td className={`num ${toneOfCents(h.netCents)}`}>{moneySignedCents(h.netCents)}</td>
                  <td className={`num ${toneOfCents(runningCents)}`}>{h.adjustment ? "" : moneySignedCents(runningCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">{nightsOf(p).length} nights. Payments and corrections are dimmed and not in the running total.</p>
      </section>
    </>
  );
}
