import type { Ctx } from "../context.ts";
import { clockTime, longDate, moneyCents, moneySignedCents, plural, toneOfCents } from "../format.ts";
import { resultsOf } from "../game.ts";
import { href } from "../router.ts";

// Nights: every game in scope, newest first (like menu 5), each with its size, its winner and how you did.
export function Games({ ctx }: { ctx: Ctx }) {
  const { view, tz, world, me } = ctx;
  const games = [...view.games].reverse(); // newest first, like menu 5
  return (
    <>
      <h1>Nights</h1>
      {games.length === 0 ? (
        <p className="lede">No games in this scope.</p>
      ) : (
        <>
          <p className="lede">{plural(games.length, "night")}, newest first. Tap one for its results and its settle-up.</p>
          <ul className="nights">
            {games.map((g) => {
              const results = resultsOf(g, world.rules);
              const top = results[0];
              const mine = me === "" ? undefined : results.find((r) => r.person === me);
              return (
                <li key={g.id}>
                  <a href={href("game", g.id)}>
                    <span>
                      <span className="d">
                        {longDate(g.start, tz)} <span className="when">{clockTime(g.start, tz)}</span>
                      </span>
                      <span className="f">
                        {plural(results.length, "player")} · {moneyCents(g.totalBuyInCents)} bought in
                        {top !== undefined && top.netCents > 0 ? ` · top ${ctx.nameOf(top.person)} ${moneySignedCents(top.netCents)}` : ""} ·{" "}
                        {g.folder}
                      </span>
                    </span>
                    <span className={`amt ${mine === undefined ? "" : toneOfCents(mine.netCents)}`}>
                      {mine === undefined ? "" : moneySignedCents(mine.netCents)}
                      {mine === undefined ? null : <small>{ctx.payload.canWrite ? "you" : ctx.nameOf(me)}</small>}
                    </span>
                    <span className="chev" aria-hidden="true">
                      ›
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}

export function balanceOf(netsCents: number[]): number {
  return netsCents.reduce((s, c) => s + c, 0);
}

export { toneOfCents };
