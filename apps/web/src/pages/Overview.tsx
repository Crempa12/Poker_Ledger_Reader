import { players, util, type PlayerStats } from "@plr/core";

import { LineChart, NetBar, Sparkbars, type LinePoint } from "../components/charts.tsx";
import { nightsOf, upDown, type Ctx } from "../context.ts";
import { longDate, moneyCents, moneySigned, moneySignedCents, plural, shortDate, toneOf, toneOfCents } from "../format.ts";
import { useHandLogs } from "../handlogs.ts";
import { href } from "../router.ts";

export function runningTotal(p: PlayerStats, timeZone: string): LinePoint[] {
  let cents = 0;
  return nightsOf(p).map((h) => {
    cents += h.netCents;
    return { label: shortDate(h.date, timeZone), value: cents / 100 };
  });
}

export function Overview({ ctx }: { ctx: Ctx }) {
  const { view, tz, me, world } = ctx;
  // The hand-log results for this scope: the box's hand-log count comes from them (the rest of the page never waits).
  const hand = useHandLogs(ctx);
  const board = view.board;
  const buyIns = view.games.reduce((s, g) => s + g.totalBuyInCents, 0);
  const offBy = board.reduce((s, p) => s + p.totalNetCents, 0);
  const mine = board.find((p) => p.normalizedName === me);
  const focus = mine ?? board[0];
  const dollars = new Map(board.map((p) => [p.normalizedName, players.playerDollars(p)]));
  const max = Math.max(1, ...[...dollars.values()].map((d) => Math.abs(d.totalNet)));
  // The table lists the players with a game, as the console's does; a player with payments only is listed under it.
  const listed = board.filter((p) => p.games > 0);
  // Payments and corrections in scope, by date and then by name (the console's order), each with its player.
  const payments = board
    .flatMap((p) => p.history.filter((h) => h.adjustment).map((h) => ({ h, p })))
    .sort((a, b) => (a.h.date ?? -1) - (b.h.date ?? -1) || util.compareBytes(a.p.displayName, b.p.displayName));
  const paymentsCents = payments.reduce((s, x) => s + x.h.netCents, 0);
  // The box's facts (startup.txt): hand logs, banker, pinned payments and me. The hand logs are the console's
  // count: the logs that load and pair with a game in scope, out of the games in scope. The count is left out
  // until the results are read (and when a snapshot cannot give them for the dates chosen).
  const banker = world.settings.banker === "" ? "off" : ctx.nameOf(world.settings.banker);
  const meName = me === "" ? "not set" : ctx.nameOf(me);
  const logged = hand.status === "ready" && hand.data !== undefined ? [`hand logs ${hand.data.logged}/${hand.data.games}`] : [];
  const facts = [...logged, `banker ${banker}`, `pinned payments ${world.prefs.length}`, `me ${meName}`].join(" · ");

  if (view.games.length === 0) {
    return <div className="card pad">No games in this scope. Pick another folder or date range above.</div>;
  }

  return (
    <>
      <section className="tiles">
        <Tile label="Games" value={String(view.games.length)} />
        <Tile label="Players" value={String(board.length)} />
        <Tile label="Bought in" value={moneyCents(buyIns)} />
        <Tile
          label="Books"
          value={offBy === 0 ? "✓ balanced" : `off by ${moneySignedCents(offBy)}`}
          tone={offBy === 0 ? "up" : "down"}
        />
        {mine !== undefined ? (
          <Tile
            label="Your net"
            value={moneySigned(dollars.get(mine.normalizedName)?.totalNet ?? 0)}
            tone={toneOf(dollars.get(mine.normalizedName)?.totalNet ?? 0)}
            sub={`${moneySigned(dollars.get(mine.normalizedName)?.averagePerGame ?? 0)} a night`}
          />
        ) : null}
      </section>
      <p className="muted small">{facts}</p>

      {focus !== undefined ? (
        <section className="card">
          <h2>
            Running total · <a href={href("player", focus.normalizedName)}>{focus.displayName}</a>
            {mine === undefined ? (
              <span className="muted small">
                {" "}
                {me === ""
                  ? '(top earner; set "me" in the console app, menu 6)'
                  : `(${meName} has no games in this scope, so the top earner is shown)`}
              </span>
            ) : null}
          </h2>
          <LineChart points={runningTotal(focus, tz)} />
        </section>
      ) : null}

      <section className="card">
        <h2>Leaderboard</h2>
        <div className="tablewrap">
          <table className="board">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Player</th>
                <th className="num">Nights</th>
                <th className="num hide-xs">Up–Dn</th>
                <th className="num">Net</th>
                <th className="num hide-sm">Avg/night</th>
                <th className="num hide-sm">Best</th>
                <th className="num hide-sm">Worst</th>
                <th className="hide-xs">Last 10</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((p, i) => {
                const d = dollars.get(p.normalizedName);
                const ud = upDown(p);
                const last = nightsOf(p).slice(-10).map((h) => h.netCents / 100);
                return (
                  <tr key={p.normalizedName} className={p.normalizedName === me ? "me" : ""}>
                    <td className="num muted">{i + 1}</td>
                    <td>
                      <a href={href("player", p.normalizedName)}>{p.displayName}</a>
                    </td>
                    <td className="num">{p.games}</td>
                    <td className="num hide-xs">
                      {ud.up}-{ud.down}
                    </td>
                    <td className="num">
                      <span className={toneOf(d?.totalNet ?? 0)}>{moneySigned(d?.totalNet ?? 0)}</span>
                      <NetBar value={d?.totalNet ?? 0} max={max} />
                    </td>
                    <td className={`num hide-sm ${toneOf(d?.averagePerGame ?? 0)}`}>{moneySigned(d?.averagePerGame ?? 0)}</td>
                    <td className={`num hide-sm ${toneOf(d?.biggestWin ?? 0)}`}>{moneySigned(d?.biggestWin ?? 0)}</td>
                    <td className={`num hide-sm ${toneOf(d?.biggestLoss ?? 0)}`}>{moneySigned(d?.biggestLoss ?? 0)}</td>
                    <td className="hide-xs">
                      <Sparkbars values={last} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Net is what each player won or lost at the table. {offBy === 0 ? "Every net adds up to $0.00." : ""}
        </p>
        {offBy !== 0 ? (
          <p className="down small">
            The games are off by {moneySignedCents(offBy)}: a ledger does not balance (see Checks).
          </p>
        ) : null}
        {payments.length > 0 ? (
          <div className="adjusted">
            <h3>Payments &amp; corrections</h3>
            <p className="muted small">
              These change who owes whom on a settlement sheet, not who won · <a href={href("adjust")}>see or change them</a>
            </p>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Player</th>
                    <th className="num">Amount</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map(({ h, p }, i) => (
                    <tr key={`${p.normalizedName}-${i}`}>
                      <td>{longDate(h.date, tz)}</td>
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
            <p className={paymentsCents === 0 ? "muted small" : "down small"}>
              {paymentsCents === 0
                ? "They cancel out: every payment is on both sides."
                : `One-sided: they add up to ${moneySignedCents(paymentsCents)}, so a settlement sheet will be short by that much.`}
            </p>
          </div>
        ) : null}
      </section>
      <p className="muted small center">{plural(board.length, "player")} in this scope.</p>
    </>
  );
}

export function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="tile">
      <div className="muted small">{label}</div>
      <div className={`big ${tone ?? ""}`}>{value}</div>
      {sub !== undefined ? <div className="muted small">{sub}</div> : null}
    </div>
  );
}
