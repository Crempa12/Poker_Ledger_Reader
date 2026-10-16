import { useState } from "react";
import {
  boardFor,
  players,
  sessions,
  settlement,
  util,
  type PaymentPreference,
  type PlayerStats,
  type SettlementEntry,
  type SettlementReason,
} from "@plr/core";

import { useSaver } from "../components/saver.tsx";
import { dayScope, type Ctx } from "../context.ts";
import { longDate, money, moneyCents, plural, shortDate } from "../format.ts";
import { href } from "../router.ts";
import { defaultSessionId, errorText, gameSessionId, writeSaved } from "../saved.ts";

const TAG: Record<SettlementReason, string> = { preference: "pinned", requested: "requested", banker: "banker", auto: "" };

// The sheet as menu 13 exports it, saved by the browser.
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pairOf(p: PaymentPreference): string {
  return `${p.payerNormalized}->${p.payeeNormalized}`;
}

// This sheet's one-off requests ("send my money to a specific person"), in the order
// they were asked, and the pairs also pinned from here. They belong to one sheet: a
// different game or scope starts with none, as a new menu 5 run does.
interface Requests {
  sheet: string;
  list: PaymentPreference[];
  pinnedHere: string[];
}

export function Settle({ ctx, gameId, onSaved }: { ctx: Ctx; gameId: string; onSaved: () => void }) {
  const { world, view, tz, scope } = ctx;
  const banker = world.settings.banker;
  const [bankerOn, setBankerOn] = useState(banker !== "");
  const [copied, setCopied] = useState(false);
  const [asked, setAsked] = useState<Requests>({ sheet: "", list: [], pinnedHere: [] });

  const game = gameId === "" ? undefined : world.games.find((g) => g.id === gameId);
  const games = game !== undefined ? [game] : view.games;
  const target = game !== undefined ? dayScope(game, tz) : scope;
  // The name the console app suggests when this sheet is saved (menu 7).
  const suggested = game !== undefined ? gameSessionId(game, tz) : defaultSessionId(scope, tz, Math.floor(Date.now() / 1000));
  const requests = asked.sheet === suggested ? asked : { sheet: suggested, list: [], pinnedHere: [] };

  const board = boardFor(world, games, target);
  const byBalance = board.map((p) => ({ p, dollars: players.balanceDollars(p) }));
  const losers = byBalance.filter((b) => b.dollars < -util.EPSILON_DOLLARS).map((b) => b.p);
  const winners = byBalance.filter((b) => b.dollars > util.EPSILON_DOLLARS).map((b) => b.p);
  // As menu 5 does it: the pins saved when the sheet was started, then this sheet's
  // requests. A pair pinned from here counts as a request, as the console keeps it.
  // With a banker there are no requests.
  const prefs = bankerOn && banker !== "" ? world.prefs : [...world.prefs.filter((p) => !requests.pinnedHere.includes(pairOf(p))), ...requests.list];
  const sheet = settlement.calculateSheet(board, prefs, bankerOn ? banker : "");
  const balances = byBalance.filter((b) => Math.abs(b.dollars) >= 0.005).sort((a, b) => a.dollars - b.dollars);
  const pinsHere = world.prefs.filter(
    (p) => losers.some((l) => l.normalizedName === p.payerNormalized) && winners.some((w) => w.normalizedName === p.payeeNormalized),
  );

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
        {bankerOn && banker !== "" ? (
          <p className="muted small">
            Banker mode is on: pins and requests are skipped. Turn it off above, or in <a href={href("settings")}>Settings</a>.
          </p>
        ) : pinsHere.length > 0 ? (
          <p className="muted small">
            Pinned payments that apply here: {pinsHere.map((p) => `${ctx.nameOf(p.payerNormalized)} always pays ${ctx.nameOf(p.payeeNormalized)}`).join(", ")}
            {ctx.payload.canWrite ? (
              <>
                {" "}
                · <a href={href("settings")}>change pins</a>
              </>
            ) : null}
          </p>
        ) : null}
      </section>

      {!(bankerOn && banker !== "") && losers.length > 0 && winners.length > 0 ? (
        <RequestCard
          ctx={ctx}
          losers={losers}
          winners={winners}
          requests={requests}
          onChange={setAsked}
          onSaved={onSaved}
        />
      ) : null}

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
            <div className="controls">
              <button onClick={copy}>{copied ? "Copied" : "Copy for the group chat"}</button>
              <button className="ghost" onClick={() => download("settlements.csv", settlement.settlementsCSV(sheet.entries))}>
                Download CSV
              </button>
            </div>
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
          <p className="muted small">
            Poker results plus payments and corrections (menu 17) · <a href={href("adjust")}>record a payment outside the sheet, or a correction</a>
          </p>
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

// Menu 5's question: "Does anyone want to send their money to a specific person?"
// A request counts on this sheet only; "and pin it" also saves it for every sheet,
// like the console's "Remember this for future settlements too?".
function RequestCard({
  ctx,
  losers,
  winners,
  requests,
  onChange,
  onSaved,
}: {
  ctx: Ctx;
  losers: PlayerStats[];
  winners: PlayerStats[];
  requests: Requests;
  onChange: (next: Requests) => void;
  onSaved: () => void;
}) {
  const [payer, setPayer] = useState("");
  const [payee, setPayee] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, run, shown } = useSaver(ctx, onSaved);
  const canWrite = ctx.payload.canWrite;

  const add = (pin: boolean): void => {
    if (payer === "" || payee === "") return setProblem("Pick who is sending and who they send to.");
    const pair = `${payer}->${payee}`;
    if ([...ctx.world.prefs, ...requests.list].some((p) => pairOf(p) === pair)) return setProblem("That pairing is already on the list.");
    setProblem(null);
    const request: PaymentPreference = { payerNormalized: payer, payeeNormalized: payee, note: "", oneOff: true };
    const next: Requests = { ...requests, list: [...requests.list, request] };
    if (!pin) {
      onChange(next);
      setPayer("");
      setPayee("");
      return;
    }
    const saved = [...ctx.world.prefs, { ...request, oneOff: false }];
    void run(
      "payment_preferences.csv",
      settlement.serializePreferencesCSV(saved),
      `Saved as a pin: ${ctx.nameOf(payer)} always pays ${ctx.nameOf(payee)}.`,
    ).then((ok) => {
      if (!ok) return;
      onChange({ ...next, pinnedHere: [...next.pinnedHere, pair] });
      setPayer("");
      setPayee("");
    });
  };
  const remove = (i: number): void => {
    const gone = requests.list[i];
    if (gone === undefined) return;
    onChange({ ...requests, list: requests.list.filter((_, j) => j !== i), pinnedHere: requests.pinnedHere.filter((k) => k !== pairOf(gone)) });
  };

  return (
    <section className="card">
      <h3>Anyone want to send their money to a specific person?</h3>
      {requests.list.length > 0 ? (
        <ul className="plain pins">
          {requests.list.map((r, i) => (
            <li key={pairOf(r)}>
              <span>
                <strong>{ctx.nameOf(r.payerNormalized)}</strong> sends to <strong>{ctx.nameOf(r.payeeNormalized)}</strong> first
                {requests.pinnedHere.includes(pairOf(r)) ? <span className="muted"> · pinned</span> : <span className="muted"> · this sheet only</span>}
              </span>
              <button className="ghost small" onClick={() => remove(i)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="controls">
        <label>
          <span className="muted">Who is sending? (owes)</span>
          <select value={payer} onChange={(e) => setPayer(e.target.value)}>
            <option value="">Pick a player…</option>
            {losers.map((p) => (
              <option key={p.normalizedName} value={p.normalizedName}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted">Send to (is owed)</span>
          <select value={payee} onChange={(e) => setPayee(e.target.value)}>
            <option value="">Pick a player…</option>
            {winners.map((p) => (
              <option key={p.normalizedName} value={p.normalizedName}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => add(false)} disabled={busy}>
          Add
        </button>
        {canWrite ? (
          <button className="ghost" onClick={() => add(true)} disabled={busy}>
            Add and pin for every sheet
          </button>
        ) : null}
      </div>
      {problem !== null ? <p className="down small">{problem}</p> : null}
      {shown}
    </section>
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
