import { boardFor, handlog, players } from "@plr/core";

import { dayScope, type Ctx } from "../context.ts";
import { SeatEditor } from "./Seats.tsx";
import { clockTime, longDate, moneyCents, moneySignedCents, plural, toneOfCents } from "../format.ts";
import { resultsOf } from "../game.ts";
import { href } from "../router.ts";

// One night: when and how big, whether its books balance, its results, and the way to settle it.
export function GamePage({ ctx, id, onSaved }: { ctx: Ctx; id: string; onSaved: () => void }) {
  const { world, tz } = ctx;
  const game = world.games.find((g) => g.id === id);
  if (game === undefined) {
    return (
      <>
        <h1>Night not found</h1>
        <p>That game is not in the data.</p>
        <a href={href("games")}>All nights</a>
      </>
    );
  }
  const results = resultsOf(game, world.rules);
  const offBy = results.reduce((s, r) => s + r.netCents, 0);
  const top = results[0];
  const bottom = results.length > 1 ? results[results.length - 1] : undefined;
  const mine = ctx.me === "" ? undefined : results.find((r) => r.person === ctx.me);
  // Each player by the name used across every game, and, when it differs, the nickname this game's
  // single-game sheet names them by (menu 5, option 1: the same board the Settle page uses for it).
  const gameBoard = boardFor(world, [game], dayScope(game, tz));
  return (
    <>
      <a className="back" href={href("games")}>
        ‹ Nights
      </a>
      <h1>{longDate(game.start, tz)}</h1>
      <p className="sub">
        {clockTime(game.start, tz)} – {clockTime(game.end, tz)} · {plural(results.length, "player")} · {moneyCents(game.totalBuyInCents)} bought in
        · {game.folder} · {handlog.logIdOf(game)}
        {game.skippedRows > 0 ? ` · ${plural(game.skippedRows, "never-played seat")} left out` : ""}
      </p>
      <div className="facts3">
        <Fact label="Top" result={top} ctx={ctx} />
        <Fact label="Bottom" result={bottom} ctx={ctx} />
        {mine !== undefined ? (
          <Fact label={ctx.payload.canWrite ? "You" : ctx.nameOf(ctx.me)} result={mine} ctx={ctx} named={false} />
        ) : (
          <div>
            <span className="label">Bought in</span>
            <span className="big">{moneyCents(game.totalBuyInCents)}</span>
          </div>
        )}
      </div>
      <p className={offBy === 0 ? "small up" : "small down"}>
        {offBy === 0 ? "✓ The nets add up to $0.00." : `The nets add up to ${moneySignedCents(offBy)} instead of $0.00.`}
      </p>
      <div className="btnrow">
        <a className="button block" href={href("settle", game.id)}>
          Settle this game
        </a>
      </div>
      <section className="sec results" aria-labelledby="results-h">
        <h2 id="results-h">Results</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col" className="num hide-xs">
                  Buy-ins
                </th>
                <th scope="col" className="num">
                  Bought in
                </th>
                <th scope="col" className="num hide-xs">
                  Cashed out
                </th>
                <th scope="col" className="num">
                  Net
                </th>
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

// One of the night's three facts: a result in big figures over its label, with whose it is under it.
function Fact({ label, result, ctx, named = true }: { label: string; result: { person: string; netCents: number } | undefined; ctx: Ctx; named?: boolean }) {
  return (
    <div>
      <span className="label">{label}</span>
      <span className={`big ${result !== undefined ? toneOfCents(result.netCents) : ""}`}>{result !== undefined ? moneySignedCents(result.netCents) : "—"}</span>
      {named && result !== undefined ? <span className="sub">{ctx.nameOf(result.person)}</span> : null}
    </div>
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
