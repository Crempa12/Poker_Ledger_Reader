import { players } from "@plr/core";

import { LineChart } from "../components/charts.tsx";
import { AtTheTable, BeatenAtShowdown, beatenFor } from "../components/hands.tsx";
import { HandStatus } from "../components/handlines.tsx";
import { nightsOf, upDown, type Ctx } from "../context.ts";
import { longDate, moneySigned, moneySignedCents, plural, toneOf, toneOfCents } from "../format.ts";
import { entryOf } from "../handformat.ts";
import { useHandLogs } from "../handlogs.ts";
import { href } from "../router.ts";
import { ordinal, runningTotal } from "./Overview.tsx";

export function PlayerPage({ ctx, normalized: asked }: { ctx: Ctx; normalized: string }) {
  const { view, tz } = ctx;
  // A name merged into another (a saved sheet on Who owes keeps the old one) opens the merged person's page.
  const normalized = players.resolveCanonical(ctx.world.rules, asked);
  // The hand logs are read here so the rest of the page never waits for them (the cards below wait).
  const hand = useHandLogs(ctx);
  const p = view.board.find((x) => x.normalizedName === normalized);
  if (p === undefined) {
    const known = ctx.everyone.some((x) => x.normalizedName === normalized);
    return (
      <>
        <h1>{known ? ctx.nameOf(normalized) : "Player not found"}</h1>
        <p className="lede">{known ? `${ctx.nameOf(normalized)} has no games in this scope.` : "No player by that name."}</p>
        <a href={href()}>Back to Standings</a>
      </>
    );
  }
  const d = players.playerDollars(p);
  const ud = upDown(p);
  const aliases = p.aliases.filter((a) => a !== p.normalizedName);
  // Where they stand among the players with a game, as on Standings (a player with payments only has no place).
  const listed = view.board.filter((x) => x.games > 0);
  const place = listed.findIndex((x) => x.normalizedName === p.normalizedName) + 1;

  // Newest first, each night with the running total after it (poker only, like the chart).
  let running = 0;
  const rows = p.history.map((h) => {
    if (!h.adjustment) running += h.netCents;
    return { h, runningCents: running };
  });
  rows.reverse();

  return (
    <>
      <a className="back" href={href()}>
        ‹ Standings
      </a>
      <h1>{p.displayName}</h1>
      <p className="sub">
        {plural(p.games, "night")} · {plural(p.buyIns, "buy-in")} · {plural(p.playerIds.length, "PokerNow account")}
        {aliases.length > 0 ? ` · also plays as ${aliases.join(", ")}` : ""}
      </p>
      <section className="phead" aria-label="Results">
        <dl className="phero">
          <div>
            <dt className="label">Net</dt>
            <dd className={`hero ${toneOf(d.totalNet)}`}>{moneySigned(d.totalNet)}</dd>
          </div>
        </dl>
        {place > 0 ? (
          <p className="facts">
            {ordinal(place)} of {listed.length} on the standings{p.normalizedName === ctx.me ? " · you" : ""}
          </p>
        ) : null}
        <dl className="pstats">
          <Stat label="Up–Down" value={`${ud.up}–${ud.down}`} />
          <Stat label="Avg/night" value={moneySigned(d.averagePerGame)} tone={toneOf(d.averagePerGame)} />
          <Stat label="Best night" value={moneySigned(d.biggestWin)} tone={toneOf(d.biggestWin)} />
          <Stat label="Worst night" value={moneySigned(d.biggestLoss)} tone={toneOf(d.biggestLoss)} />
          {p.adjustmentsCents !== 0 ? (
            <>
              <Stat label="Payments & corrections" value={moneySignedCents(p.adjustmentsCents)} tone={toneOfCents(p.adjustmentsCents)} />
              {/* The console's header line: poker net plus payments and corrections, the figure a settlement sheet uses. */}
              <Stat label="Balance" value={moneySigned(players.balanceDollars(p))} tone={toneOf(players.balanceDollars(p))} sub="net plus payments" total />
            </>
          ) : null}
        </dl>
      </section>

      <section className="sec">
        <h2>Running total</h2>
        <LineChart points={runningTotal(p, tz)} />
      </section>

      <section className="sec">
        <h2>At the table</h2>
        {hand.data !== undefined ? (
          <AtTheTable displayName={p.displayName} totalNet={d.totalNet} time={entryOf(hand.data.playtime, normalized)} />
        ) : (
          <HandStatus hand={hand} compact />
        )}
      </section>

      <section className="sec">
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

      <section className="sec">
        <h2>Every night</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col" className="hide-xs">
                  Folder
                </th>
                <th scope="col" className="num hide-xs">
                  Buy-ins
                </th>
                <th scope="col" className="num">
                  Result
                </th>
                <th scope="col" className="num">
                  Running
                </th>
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
        <p className="sub">{nightsOf(p).length} nights. Payments and corrections are dimmed and not in the running total.</p>
      </section>
    </>
  );
}

// One line of the player's receipt: the label, a dotted leader, the figure.
function Stat({ label, value, tone, sub, total = false }: { label: string; value: string; tone?: string; sub?: string; total?: boolean }) {
  return (
    <div className={total ? "pl total" : "pl"}>
      <dt>
        {label}
        {sub !== undefined ? <small>{sub}</small> : null}
      </dt>
      <dd className={`amount ${tone ?? ""}`}>{value}</dd>
    </div>
  );
}
