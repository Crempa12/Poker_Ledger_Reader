import { useState } from "react";
import { boardFor, players, sessions, sheetFor, type SettlementEntry, type SettlementReason } from "@plr/core";

import { dayScope, type Ctx } from "../context.ts";
import { longDate, money, moneyCents, plural, shortDate } from "../format.ts";
import { href } from "../router.ts";
import { defaultSessionId, errorText, gameSessionId, writeSaved } from "../saved.ts";

const TAG: Record<SettlementReason, string> = { preference: "pinned", requested: "requested", banker: "banker", auto: "" };

export function Settle({ ctx, gameId, onSaved }: { ctx: Ctx; gameId: string; onSaved: () => void }) {
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
  // The name the console app suggests when this sheet is saved (menu 7).
  const suggested = game !== undefined ? gameSessionId(game, tz) : defaultSessionId(scope, tz, Math.floor(Date.now() / 1000));
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
      {sheet.entries.length > 0 ? (
        <SaveSheet key={suggested} ctx={ctx} suggested={suggested} entries={sheet.entries} onSaved={onSaved} />
      ) : null}
    </>
  );
}

// Menu 7: save the sheet under a session id, so payments can be recorded against it
// on Who owes. A name already used adds these amounts on top, as the console app asks.
function SaveSheet({
  ctx,
  suggested,
  entries,
  onSaved,
}: {
  ctx: Ctx;
  suggested: string;
  entries: readonly SettlementEntry[];
  onSaved: () => void;
}) {
  const [name, setName] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  if (!ctx.payload.canWrite) {
    return <p className="muted small center">Saving a sheet works on the computer that runs the site.</p>;
  }
  const save = async (): Promise<void> => {
    const id = name.trim();
    if (id === "") return setNote({ ok: false, text: "Give the sheet a name first." });
    const exists = [...ctx.world.balances.values()].some((b) => b.sessionId === id);
    if (exists && !window.confirm(`A sheet named "${id}" is already saved. Add these amounts on top of it?`)) return;
    setBusy(true);
    setNote(null);
    try {
      const next = sessions.addSettlementBatch(ctx.world.balances, id, entries);
      await writeSaved(ctx, "session_balances.csv", sessions.serializeSessionBalances(next));
      setNote({ ok: true, text: `Saved ${plural(entries.length, "payment")} under "${id}".` });
      onSaved();
    } catch (err) {
      setNote({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Track who has paid</h2>
      <p className="muted small">
        Saves this sheet (console menu 7). Then record payments as they come in on <a href={href("owed")}>Who owes</a>.
      </p>
      <div className="controls">
        <label className="grow">
          <span className="muted">Sheet name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </label>
        <button onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save sheet"}
        </button>
      </div>
      {note !== null ? (
        <p className={note.ok ? "up small" : "down small"}>
          {note.text} {note.ok ? <a href={href("owed")}>See Who owes →</a> : null}
        </p>
      ) : null}
    </section>
  );
}
