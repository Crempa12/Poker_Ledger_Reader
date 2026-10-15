import { useState } from "react";
import { boardFor, players, sheetFor, type SettlementReason } from "@plr/core";

import { dayScope, type Ctx } from "../context.ts";
import { longDate, money, moneyCents, plural, shortDate } from "../format.ts";
import { href } from "../router.ts";

const TAG: Record<SettlementReason, string> = { preference: "pinned", requested: "requested", banker: "banker", auto: "" };

export function Settle({ ctx, gameId }: { ctx: Ctx; gameId: string }) {
  const { world, view, tz, scope } = ctx;
  const banker = world.settings.banker;
  const [bankerOn, setBankerOn] = useState(banker !== "");
  const [copied, setCopied] = useState(false);

  const game = gameId === "" ? undefined : world.games.find((g) => g.id === gameId);
  const games = game !== undefined ? [game] : view.games;
  const target = game !== undefined ? dayScope(game, tz) : scope;
  const sheet = sheetFor(world, games, target, bankerOn ? banker : "");
  const balances = boardFor(world, games, target)
    .map((p) => ({ p, dollars: players.balanceDollars(p) }))
    .filter((b) => Math.abs(b.dollars) >= 0.005)
    .sort((a, b) => a.dollars - b.dollars);

  const title = game !== undefined ? `Game on ${longDate(game.start, tz)}` : `Everything in scope (${plural(view.games.length, "game")})`;
  const text = [
    `Poker settle-up: ${title}`,
    ...sheet.entries.map((e) => `${e.fromDisplay} → ${e.toDisplay}: ${moneyCents(e.amountCents)}`),
  ].join("\n");

  const copy = (): void => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  };

  const newestFirst = [...view.games].reverse();
  return (
    <>
      <section className="card">
        <h2>Settle up</h2>
        <div className="controls">
          <label>
            <span className="muted">What to settle</span>
            <select
              value={game?.id ?? ""}
              onChange={(e) => {
                window.location.hash = e.target.value === "" ? href("settle") : href("settle", e.target.value);
              }}
            >
              <option value="">Everything in scope ({plural(view.games.length, "game")})</option>
              {game !== undefined && !newestFirst.includes(game) ? <option value={game.id}>{shortDate(game.start, tz)} · {game.folder}</option> : null}
              {newestFirst.map((g) => (
                <option key={g.id} value={g.id}>
                  One game: {shortDate(g.start, tz)} · {g.folder}
                </option>
              ))}
            </select>
          </label>
          {banker !== "" ? (
            <label className="check">
              <input type="checkbox" checked={bankerOn} onChange={(e) => setBankerOn(e.target.checked)} />
              Banker mode ({ctx.nameOf(banker)} collects and pays everyone)
            </label>
          ) : null}
        </div>
        {world.prefs.length > 0 ? (
          <p className="muted small">
            Pinned payments from the console app: {world.prefs.map((p) => `${ctx.nameOf(p.payerNormalized)} → ${ctx.nameOf(p.payeeNormalized)}`).join(", ")}.
          </p>
        ) : null}
      </section>

      <section className="card">
        <h2>{title}</h2>
        {sheet.entries.length === 0 ? (
          <p className="muted">Nobody owes anything here.</p>
        ) : (
          <>
            <ul className="payments">
              {sheet.entries.map((e, i) => (
                <li key={i}>
                  <a href={href("player", e.fromNormalized)}>{e.fromDisplay}</a>
                  <span className="arrow" aria-label="pays">→</span>
                  <a href={href("player", e.toNormalized)}>{e.toDisplay}</a>
                  <strong className="amount">{moneyCents(e.amountCents)}</strong>
                  {TAG[e.reason] !== "" ? <span className="tag">{TAG[e.reason]}</span> : null}
                </li>
              ))}
            </ul>
            <button onClick={copy}>{copied ? "Copied" : "Copy for the group chat"}</button>
          </>
        )}
        {sheet.warnings.map((w, i) => (
          <p key={i} className="down small">
            The balances add up to {moneyCents(w.totalCents)} instead of $0.00, so this sheet is off by that much.
          </p>
        ))}
      </section>

      {balances.length > 0 ? (
        <section className="card">
          <h2>Balances on this sheet</h2>
          <p className="muted small">Poker results plus payments and corrections from the console app (menu 17).</p>
          <ul className="balances">
            {balances.map(({ p, dollars }) => (
              <li key={p.normalizedName}>
                <span>{p.displayName}</span>
                <span className={dollars < 0 ? "down" : "up"}>
                  {dollars < 0 ? `owes ${money(-dollars)}` : `is owed ${money(dollars)}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="muted small center">
        To track who has paid, save the sheet in the console app (menu 7); it then shows on <a href={href("owed")}>Who owes</a>.
      </p>
    </>
  );
}
