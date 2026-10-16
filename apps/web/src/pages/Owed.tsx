import { Fragment, useState } from "react";
import { fixed2Cents, sessions, type SessionBalance } from "@plr/core";

import { CopyForChat } from "../components/copychat.tsx";
import type { Ctx } from "../context.ts";
import { moneyCents } from "../format.ts";
import { href } from "../router.ts";
import { errorText, typedCents, writeSaved } from "../saved.ts";
import { owedCopyText } from "../settle-sheet.ts";

function pairKey(b: SessionBalance): string {
  return sessions.makeKey(b.sessionId, b.fromNormalized, b.toNormalized);
}

export function Owed({ ctx, onSaved }: { ctx: Ctx; onSaved: () => void }) {
  const { view, world } = ctx;
  const [paying, setPaying] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const rows = sessions.sortedRows(world.balances, false);
  const bySheet = new Map<string, SessionBalance[]>();
  for (const r of rows) bySheet.set(r.sessionId, [...(bySheet.get(r.sessionId) ?? []), r]);

  return (
    <>
      <section className="card">
        <h2>Who still owes whom</h2>
        <p className="muted small">
          Everything still unpaid, added up across every saved sheet (menu 11 in the console app). It is for every game, whatever the
          Folder and Dates at the top say. A payment recorded here (Paid…) changes this list only; Payments &amp; corrections change
          Settle up only and are not counted here. Names stay as each sheet saved them, even after a merge.
        </p>
        {view.owed.length === 0 ? (
          <p className="up">Nobody. Every saved sheet is paid.</p>
        ) : (
          <ul className="payments">
            {view.owed.map((d) => (
              <li key={`${d.fromNormalized}->${d.toNormalized}`}>
                <a href={href("player", d.fromNormalized)}>{d.fromDisplay}</a>
                <span className="arrow" aria-hidden="true">→</span>
                <span className="sr-only"> owes </span>
                <a href={href("player", d.toNormalized)}>{d.toDisplay}</a>
                <strong className="amount">{moneyCents(d.totalCents)}</strong>
              </li>
            ))}
          </ul>
        )}
        {view.owed.length > 0 ? <CopyForChat text={owedCopyText(view.owed)} label="Copy a reminder for the group chat" what="Reminder text" /> : null}
      </section>

      <section className="card">
        <h2>Saved sheets</h2>
        {done !== null ? <p className="up small">{done}</p> : null}
        {bySheet.size === 0 ? (
          <p className="muted">
            No saved sheets yet. Build one on <a href={href("settle")}>Settle up</a> and press Save sheet; then record payments
            here as they come in.
          </p>
        ) : (
          [...bySheet.entries()].map(([id, list]) => {
            const open = list.reduce((s, b) => s + b.remainingCents, 0);
            return (
              <div key={id} className="sheet">
                <h3>
                  {id} <span className={open > 0 ? "down small" : "up small"}>{open > 0 ? `${moneyCents(open)} unpaid` : "all paid"}</span>
                </h3>
                <table>
                  <thead>
                    <tr>
                      <th>From</th>
                      <th>To</th>
                      <th className="num hide-xs">Owed</th>
                      <th className="num">Still owed</th>
                      <th className="hide-xs">Status</th>
                      {ctx.payload.canWrite ? <th aria-label="Record a payment" /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((b) => {
                      const key = pairKey(b);
                      const owing = b.remainingCents > 0;
                      return (
                        <Fragment key={key}>
                          <tr className={b.status === "paid" ? "dim" : ""}>
                            <td>{b.fromDisplay}</td>
                            <td>{b.toDisplay}</td>
                            <td className="num hide-xs">{moneyCents(b.originalCents)}</td>
                            {/* On a phone the Status column is hidden: CSS shows the word under the amount (see .status-xs). */}
                            <td className="num status-xs" data-status={b.status}>
                              {moneyCents(b.remainingCents)}
                            </td>
                            <td className="hide-xs">
                              <span className={`tag ${b.status}`}>{b.status}</span>
                            </td>
                            {ctx.payload.canWrite ? (
                              <td className="num">
                                {owing ? (
                                  <button
                                    className="small"
                                    onClick={() => setPaying(paying === key ? null : key)}
                                    aria-expanded={paying === key}
                                    aria-label={`${paying === key ? "Close" : "Paid…"} the payment from ${b.fromDisplay} to ${b.toDisplay}`}
                                  >
                                    {paying === key ? "Close" : "Paid…"}
                                  </button>
                                ) : null}
                              </td>
                            ) : null}
                          </tr>
                          {paying === key ? (
                            <tr className="formrow">
                              <td colSpan={6}>
                                <PaymentForm
                                  key={b.remainingCents} // a reload that changes what is left starts the amount again
                                  ctx={ctx}
                                  balance={b}
                                  onRecorded={(text) => {
                                    setPaying(null);
                                    setDone(text);
                                    onSaved();
                                  }}
                                />
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })
        )}
      </section>
    </>
  );
}

// Menu 10: a payment against one saved balance. A payment above what is left clears
// it, and the extra is not kept, as in the console app.
function PaymentForm({ ctx, balance, onRecorded }: { ctx: Ctx; balance: SessionBalance; onRecorded: (text: string) => void }) {
  const [amount, setAmount] = useState(fixed2Cents(balance.remainingCents));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = typedCents(amount);

  const record = async (): Promise<void> => {
    if (cents === null) return setError("Type an amount above $0, like 20 or 12.50.");
    const pair = { fromNormalized: balance.fromNormalized, toNormalized: balance.toNormalized };
    const result = sessions.recordPayment(ctx.world.balances, balance.sessionId, pair, cents);
    if (result.refused !== null || result.balance === null) return setError(result.refused ?? "That balance is not on the sheet any more. Press Refresh.");
    setBusy(true);
    setError(null);
    try {
      // false: the person declined the question writeSaved asks, so the payment is not recorded.
      if (!(await writeSaved(ctx, "session_balances.csv", sessions.serializeSessionBalances(result.balances)))) return;
      const extra = result.overpaidCents > 0 ? ` ${moneyCents(result.overpaidCents)} more than was owed was not kept.` : "";
      onRecorded(
        `${balance.fromDisplay} paid ${balance.toDisplay} ${moneyCents(result.appliedCents)} on "${balance.sessionId}": now ${result.balance.status}.${extra}`,
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="controls"
      onSubmit={(e) => {
        e.preventDefault();
        void record();
      }}
    >
      <label>
        <span className="muted">
          {balance.fromDisplay} paid {balance.toDisplay}
        </span>
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-label={`${balance.fromDisplay} paid ${balance.toDisplay}, amount`}
          autoFocus
        />
      </label>
      <button type="submit" disabled={busy || cents === null}>
        {busy ? "Saving…" : cents === balance.remainingCents ? "Paid in full" : "Record payment"}
      </button>
      {error !== null ? <p className="down small">{error}</p> : null}
    </form>
  );
}
