import { boardFor, handlog, players } from "@plr/core";

import { dayScope, type Ctx } from "../context.ts";
import { SeatEditor } from "./Seats.tsx";
import { clockTime, longDate, moneyCents, moneySignedCents, plural, toneOfCents } from "../format.ts";
import { resultsOf } from "../game.ts";
import { href } from "../router.ts";

export function GamePage({ ctx, id, onSaved }: { ctx: Ctx; id: string; onSaved: () => void }) {
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
  // Each player by the name used across every game, and, when it differs, the nickname this game's
  // single-game sheet names them by (menu 5, option 1: the same board the Settle page uses for it).
  const gameBoard = boardFor(world, [game], dayScope(game, tz));
  return (
    <>
      <section className="card">
        <h1>{longDate(game.start, tz)}</h1>
        <p className="muted small">
          {clockTime(game.start, tz)} – {clockTime(game.end, tz)} · {game.folder} · {handlog.logIdOf(game)} ·{" "}
          {plural(results.length, "player")} ·{" "}
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
                    <NightName usual={ctx.nameOf(r.person)} tonight={players.displayName(gameBoard, r.person)} person={r.person} />
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
      <SeatEditor key={game.id} ctx={ctx} game={game} onSaved={onSaved} />
    </>
  );
}

// "Della", or "Della · as D E L L A" when that night's nickname is another name for them.
function NightName({ usual, tonight, person }: { usual: string; tonight: string; person: string }) {
  return (
    <>
      <a href={href("player", person)}>{usual}</a>
      {tonight !== usual ? <span className="muted small">{` · as ${tonight}`}</span> : null}
    </>
  );
}
