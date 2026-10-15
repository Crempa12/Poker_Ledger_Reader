import { players, type PlayerStats } from "@plr/core";

import { LineChart, NetBar, Sparkbars, type LinePoint } from "../components/charts.tsx";
import { nightsOf, upDown, type Ctx } from "../context.ts";
import { moneyCents, moneySigned, moneySignedCents, plural, shortDate, toneOf, toneOfCents } from "../format.ts";
import { href } from "../router.ts";

export function runningTotal(p: PlayerStats, timeZone: string): LinePoint[] {
  let cents = 0;
  return nightsOf(p).map((h) => {
    cents += h.netCents;
    return { label: shortDate(h.date, timeZone), value: cents / 100 };
  });
}

export function Overview({ ctx }: { ctx: Ctx }) {
  const { view, tz, me } = ctx;
  const board = view.board;
  const buyIns = view.games.reduce((s, g) => s + g.totalBuyInCents, 0);
  const offBy = board.reduce((s, p) => s + p.totalNetCents, 0);
  const mine = board.find((p) => p.normalizedName === me);
  const focus = mine ?? board[0];
  const dollars = new Map(board.map((p) => [p.normalizedName, players.playerDollars(p)]));
  const max = Math.max(1, ...[...dollars.values()].map((d) => Math.abs(d.totalNet)));
  const adjusted = board.filter((p) => p.adjustmentsCents !== 0);

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

      {focus !== undefined ? (
        <section className="card">
          <h2>
            Running total · <a href={href("player", focus.normalizedName)}>{focus.displayName}</a>
            {mine === undefined ? <span className="muted small"> (top earner; set "me" in the console app, menu 6)</span> : null}
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
              {board.map((p, i) => {
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
        {adjusted.length > 0 ? (
          <div className="adjusted">
            <h3>Payments &amp; corrections</h3>
            <p className="muted small">These change who owes whom on a settlement sheet, not who won.</p>
            <ul>
              {adjusted.map((p) => (
                <li key={p.normalizedName}>
                  <a href={href("player", p.normalizedName)}>{p.displayName}</a>{" "}
                  <span className={toneOfCents(p.adjustmentsCents)}>{moneySignedCents(p.adjustmentsCents)}</span>
                </li>
              ))}
            </ul>
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
