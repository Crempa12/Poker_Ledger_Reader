import type { Ctx } from "../context.ts";
import { clockTime, longDate, moneyCents, moneySignedCents, plural, toneOfCents } from "../format.ts";
import { resultsOf } from "../game.ts";
import { href } from "../router.ts";

export function Games({ ctx }: { ctx: Ctx }) {
  const { view, tz, world } = ctx;
  const games = [...view.games].reverse(); // newest first, like menu 5
  if (games.length === 0) return <div className="card pad">No games in this scope.</div>;
  return (
    <section className="card">
      <h2>Games · newest first</h2>
      <ul className="gamelist">
        {games.map((g) => {
          const results = resultsOf(g, world.rules);
          const top = results[0];
          return (
            <li key={g.id}>
              <a href={href("game", g.id)}>
                <span className="when">
                  <strong>{longDate(g.start, tz)}</strong>
                  <span className="muted small">
                    {" "}
                    {clockTime(g.start, tz)} · {g.folder}
                  </span>
                </span>
                <span className="what muted small">
                  {plural(results.length, "player")} · {moneyCents(g.totalBuyInCents)} bought in
                  {top !== undefined && top.netCents > 0 ? (
                    <>
                      {" "}
                      · top <span className="up">{ctx.nameOf(top.person)} {moneySignedCents(top.netCents)}</span>
                    </>
                  ) : null}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function balanceOf(netsCents: number[]): number {
  return netsCents.reduce((s, c) => s + c, 0);
}

export { toneOfCents };
