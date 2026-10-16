import { useMemo, useState } from "react";
import { boardFor, sessions, settlement, type PaymentPreference, type PlayerStats, type SettlementEntry, type SettlementReason } from "@plr/core";

import { copyToClipboard } from "../clipboard.ts";
import { isSnapshot } from "../data.ts";
import { useSaver } from "../components/saver.tsx";
import { dayScope, type Ctx } from "../context.ts";
import { longDate, moneyCents, plural, shortDate } from "../format.ts";
import { href } from "../router.ts";
import {
  chosenOption,
  defaultSessionId,
  errorText,
  gameSessionId,
  leftOutNote,
  notOnThisSheet,
  pinsToWrite,
  writeSaved,
} from "../saved.ts";
import { balanceRows, copyText, offByLines, printOrder, receiversOf, scopeWords, sheetCsv, sheetRows, sheetSummary } from "../settle-sheet.ts";

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

// The requests kept for one sheet: those, or none when the state is for another sheet.
function forSheet(state: Requests, sheet: string): Requests {
  return state.sheet === sheet ? state : { sheet, list: [], pinnedHere: [] };
}

export function Settle({ ctx, gameId, onSaved }: { ctx: Ctx; gameId: string; onSaved: () => void }) {
  const { world, view, tz, scope } = ctx;
  // The banker is the one in Settings, as menu 5 uses it: there is no switch per sheet.
  const banker = world.settings.banker;
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [asked, setAsked] = useState<Requests>({ sheet: "", list: [], pinnedHere: [] });

  const game = gameId === "" ? undefined : world.games.find((g) => g.id === gameId);
  const games = game !== undefined ? [game] : view.games;
  const target = game !== undefined ? dayScope(game, tz) : scope;
  // The name the console app suggests when this sheet is saved (menu 7).
  const suggested = game !== undefined ? gameSessionId(game, tz) : defaultSessionId(scope, tz, Math.floor(Date.now() / 1000));
  const requests = forSheet(asked, suggested);

  // The board and the sheet are worked out again only when one of their inputs changes, not on every
  // render: a whole folder's sheet takes tens of milliseconds, and the page renders on each small change.
  const { board, sheet } = useMemo(() => {
    const sheetGames = game !== undefined ? [game] : view.games;
    const sheetTarget = game !== undefined ? dayScope(game, tz) : scope;
    const b = boardFor(world, sheetGames, sheetTarget);
    const req = forSheet(asked, suggested);
    // As menu 5 does it: the pins saved when the sheet was started, then this sheet's
    // requests. A pair pinned from here counts as a request, as the console keeps it.
    // With a banker there are no requests.
    const pr = banker !== "" ? world.prefs : [...world.prefs.filter((p) => !req.pinnedHere.includes(pairOf(p))), ...req.list];
    return { board: b, sheet: settlement.calculateSheet(b, pr, banker) };
  }, [world, game, view, scope, tz, banker, asked, suggested]);
  // Menu 5's balances: every player, highest balance first. Who owes and who is owed here are the
  // only choices for a request, in that order.
  const balances = balanceRows(board);
  const losers = balances.filter((b) => b.owes).map((b) => b.p);
  const winners = balances.filter((b) => b.owed).map((b) => b.p);
  // The transfers as menu 5 prints them: grouped by payer, the biggest payers first, each payer's total under their last line.
  const entries = printOrder(sheet.entries);
  const rows = sheetRows(sheet.entries);
  // Who receives what (menu 5's block under the sheet): each receiver's total and who sends it.
  const receivers = receiversOf(sheet.entries);
  // Menu 5's hint: payments and corrections saved under all folders that this sheet leaves out.
  const notHere = notOnThisSheet(world.adjustments, target);
  const pinsHere = world.prefs.filter(
    (p) => losers.some((l) => l.normalizedName === p.payerNormalized) && winners.some((w) => w.normalizedName === p.payeeNormalized),
  );

  const title = game !== undefined ? `Game on ${longDate(game.start, tz)}` : `Everything in ${scopeWords(ctx.choice)}, ${plural(games.length, "game")}`;

  // The sheet as text for the group chat. Where the browser will not copy it, the text is shown to select.
  const copyBody = copyText(title, sheet.entries);
  const copy = (): void => {
    setCopyFailed(false);
    void copyToClipboard(copyBody).then((ok) => {
      setCopied(ok);
      setCopyFailed(!ok);
      if (ok) setTimeout(() => setCopied(false), 2000);
    });
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
        </div>
        {banker !== "" ? (
          <p className="muted small">
            Banker mode is on: everyone settles through {ctx.nameOf(banker)}. Pins and one-off requests are skipped. Turn the banker off to use
            them: change it in {ctx.payload.canWrite ? <a href={href("settings")}>Settings</a> : "Settings"}
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

      {banker === "" && losers.length > 0 && winners.length > 0 && !isSnapshot(ctx.payload) ? (
        <RequestCard
          ctx={ctx}
          losers={losers}
          winners={winners}
          requests={requests}
          // An update is applied to the latest requests, not to the ones this card had when it was clicked.
          onChange={(update) => setAsked((prev) => update(forSheet(prev, suggested)))}
          onSaved={onSaved}
        />
      ) : null}

      <section className="card">
        <h2>{title}</h2>
        {notHere > 0 ? (
          <p className="down small">
            Not on this sheet: {notHere} {notHere === 1 ? "payment/correction" : "payments/corrections"} saved under all folders (settle every
            folder to include them).
          </p>
        ) : null}
        {board.length === 0 ? (
          <p className="muted">No players found in that selection.</p>
        ) : entries.length === 0 ? (
          <p className="muted">Nobody owes anything here.</p>
        ) : (
          <>
            <p className="muted small">{sheetSummary(entries)}</p>
            <ul className="payments">
              {rows.map((row, i) =>
                row.kind === "total" ? (
                  <li key={i} className="muted small">
                    {row.text}
                  </li>
                ) : (
                  <li key={i}>
                    <a href={href("player", row.entry.fromNormalized)}>{row.entry.fromDisplay}</a>
                    <span className="arrow" aria-hidden="true">→</span>
                    <span className="sr-only"> pays </span>
                    <a href={href("player", row.entry.toNormalized)}>{row.entry.toDisplay}</a>
                    <strong className="amount">{moneyCents(row.entry.amountCents)}</strong>
                    {TAG[row.entry.reason] !== "" ? <span className="tag">{TAG[row.entry.reason]}</span> : null}
                  </li>
                ),
              )}
            </ul>
            <div className="controls">
              <button onClick={copy}>{copied ? "Copied" : "Copy for the group chat"}</button>
              <button className="ghost" onClick={() => download("settlements.csv", sheetCsv(sheet.entries))}>
                Download CSV
              </button>
            </div>
            {copyFailed ? (
              <>
                <p className="down small">This browser would not copy it. Select the text below and copy it by hand.</p>
                <textarea
                  className="links"
                  readOnly
                  rows={8}
                  value={copyBody}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Sheet text to copy"
                />
              </>
            ) : null}
            <h3>Who receives what</h3>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Receiver</th>
                    <th className="num">Gets</th>
                    <th>From</th>
                  </tr>
                </thead>
                <tbody>
                  {receivers.map((r) => (
                    <tr key={r.name}>
                      <td>{r.name}</td>
                      <td className="num">{moneyCents(r.cents)}</td>
                      <td className="muted">{r.from.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {sheet.warnings.map((w, i) => (
          <div key={i} className="down small">
            {offByLines(w).map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        ))}
      </section>

      {balances.length > 0 ? (
        <section className="card">
          <h2>Balances on this sheet</h2>
          <p className="muted small">
            Poker results plus payments and corrections (menu 17) · <a href={href("adjust")}>record a payment outside the sheet, or a correction</a>
          </p>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th className="num">Poker net</th>
                  <th className="num">Payments</th>
                  <th>Settles as</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((b) => (
                  <tr key={b.p.normalizedName} className={b.tone === "even" ? "dim" : ""}>
                    <td>{b.p.displayName}</td>
                    <td className="num">{b.poker}</td>
                    <td className="num">{b.payments}</td>
                    <td className={b.tone}>{b.settles}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
  onChange: (update: (prev: Requests) => Requests) => void;
  onSaved: () => void;
}) {
  const [payerPick, setPayer] = useState("");
  const [payeePick, setPayee] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, run, shown } = useSaver(ctx, onSaved);
  const canWrite = ctx.payload.canWrite;
  // Only someone who owes (or is owed) on this sheet can be picked: a choice that has
  // left the sheet is not used, so a request is never saved for a hidden pair.
  const payer = chosenOption(payerPick, losers);
  const payee = chosenOption(payeePick, winners);

  const add = (pin: boolean): void => {
    if (payer === "" || payee === "") return setProblem("Pick who is sending and who they send to.");
    const pair = `${payer}->${payee}`;
    if ([...ctx.world.prefs, ...requests.list].some((p) => pairOf(p) === pair)) return setProblem("That pairing is already on the list.");
    setProblem(null);
    const request: PaymentPreference = { payerNormalized: payer, payeeNormalized: payee, note: "", oneOff: true };
    const withRequest = (prev: Requests): Requests => ({ ...prev, list: [...prev.list, request] });
    if (!pin) {
      onChange(withRequest);
      setPayer("");
      setPayee("");
      return;
    }
    const { keep, left } = pinsToWrite([...ctx.world.prefs, { ...request, oneOff: false }]);
    const done = [`Saved as a pin: ${ctx.nameOf(payer)} always pays ${ctx.nameOf(payee)}.`, leftOutNote(left)].filter((s) => s !== "").join(" ");
    void run("payment_preferences.csv", settlement.serializePreferencesCSV(keep), done).then((ok) => {
      if (!ok) return;
      onChange((prev) => ({ ...withRequest(prev), pinnedHere: [...prev.pinnedHere, pair] }));
      setPayer("");
      setPayee("");
    });
  };
  // Takes one request off the sheet, by its pair: a position from before a save could be
  // another request by the time the save answers.
  const dropRequest = (pair: string): void =>
    onChange((prev) => ({
      ...prev,
      list: prev.list.filter((r) => pairOf(r) !== pair),
      pinnedHere: prev.pinnedHere.filter((k) => k !== pair),
    }));
  // A request pinned from here is also a pin in the file. Removing the request asks
  // whether the pin goes too; if not, the pin keeps applying to every sheet.
  const remove = (gone: PaymentPreference): void => {
    const pair = pairOf(gone);
    const pinned = requests.pinnedHere.includes(pair) && ctx.world.prefs.some((p) => pairOf(p) === pair);
    if (!pinned || !window.confirm("Also remove the pin, so it no longer applies to every sheet?")) return dropRequest(pair);
    const { keep, left } = pinsToWrite(ctx.world.prefs.filter((p) => pairOf(p) !== pair));
    const done = [`Removed the pin: ${ctx.nameOf(gone.payerNormalized)} no longer always pays ${ctx.nameOf(gone.payeeNormalized)}.`, leftOutNote(left)]
      .filter((s) => s !== "")
      .join(" ");
    void run("payment_preferences.csv", settlement.serializePreferencesCSV(keep), done).then((ok) => {
      if (ok) dropRequest(pair);
    });
  };

  return (
    <section className="card">
      <h3>Anyone want to send their money to a specific person?</h3>
      {requests.list.length > 0 ? (
        <ul className="plain pins">
          {requests.list.map((r) => (
            <li key={pairOf(r)}>
              <span>
                <strong>{ctx.nameOf(r.payerNormalized)}</strong> sends to <strong>{ctx.nameOf(r.payeeNormalized)}</strong> first
                {requests.pinnedHere.includes(pairOf(r)) ? <span className="muted"> · pinned</span> : <span className="muted"> · this sheet only</span>}
              </span>
              <button
                className="ghost small"
                disabled={busy}
                onClick={() => remove(r)}
                aria-label={`Remove the request from ${ctx.nameOf(r.payerNormalized)} to ${ctx.nameOf(r.payeeNormalized)}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="controls">
        <label>
          <span className="muted">Who is sending? (owes)</span>
          <select value={payer} onChange={(e) => setPayer(e.target.value)} disabled={busy}>
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
          <select value={payee} onChange={(e) => setPayee(e.target.value)} disabled={busy}>
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
    if (exists && !window.confirm(`A sheet named "${id}" is already saved. Add these amounts on top of it?`))
      return setNote({ ok: false, text: "Nothing saved. Pick a different sheet name next time." });
    setBusy(true);
    setNote(null);
    try {
      const next = sessions.addSettlementBatch(ctx.world.balances, id, entries);
      // false: the person declined the question writeSaved asks, so the sheet is not saved.
      if (!(await writeSaved(ctx, "session_balances.csv", sessions.serializeSessionBalances(next)))) return;
      setNote({ ok: true, text: `Saved ${plural(entries.length, "balance")} under "${id}".` });
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
