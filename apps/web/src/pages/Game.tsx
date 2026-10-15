import type { Ctx } from "../context.ts";
import { clockTime, longDate, moneyCents, moneySignedCents, plural, toneOfCents } from "../format.ts";
import { resultsOf } from "../game.ts";
import { href } from "../router.ts";

export function GamePage({ ctx, id }: { ctx: Ctx; id: string }) {
  const { world, tz } = ctx;
  const game = world.games.find((g) => g.id === id);
  if (game === undefined) {
    return (
      <div className="card pad">
        <p>That game is not in the data.</p>
        <a href={href("games")}>All games</a>
      </div>
    );
  }
  const results = resultsOf(game, world.rules);
  const offBy = results.reduce((s, r) => s + r.netCents, 0);
  return (
    <>
      <section className="card">
        <h1>{longDate(game.start, tz)}</h1>
        <p className="muted small">
          {clockTime(game.start, tz)} – {clockTime(game.end, tz)} · {game.folder} · {plural(results.length, "player")} ·{" "}
          {moneyCents(game.totalBuyInCents)} bought in
          {game.skippedRows > 0 ? ` · ${plural(game.skippedRows, "never-played seat")} left out` : ""}
        </p>
        <p className={offBy === 0 ? "up small" : "down small"}>
          {offBy === 0 ? "✓ The nets add up to $0.00." : `The nets add up to ${moneySignedCents(offBy)} instead of $0.00.`}
        </p>
        <a className="button" href={href("settle", game.id)}>
          Settle this game
        </a>
      </section>
      <section className="card">
        <h2>Results</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th className="num hide-xs">Buy-ins</th>
                <th className="num">Bought in</th>
                <th className="num hide-xs">Cashed out</th>
                <th className="num">Net</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.person} className={r.person === ctx.me ? "me" : ""}>
                  <td>
                    <a href={href("player", r.person)}>{ctx.nameOf(r.person)}</a>
                  </td>
                  <td className="num hide-xs">{r.seats}</td>
                  <td className="num">{moneyCents(r.buyInCents)}</td>
                  <td className="num hide-xs">{moneyCents(r.cashOutCents)}</td>
                  <td className={`num ${toneOfCents(r.netCents)}`}>{moneySignedCents(r.netCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
