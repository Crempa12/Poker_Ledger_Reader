import { useState } from "react";
import { adjustments, formatLocalDate, moneyCents, moneySignedCents, players, type Adjustment, type PlayerStats } from "@plr/core";

import { useSaver } from "../components/saver.tsx";
import type { Ctx } from "../context.ts";
import { toneOfCents } from "../format.ts";
import { href } from "../router.ts";
import { chosenOption, newGroup, typedCents, typedSignedCents } from "../saved.ts";

// Console menu 17: money that changed hands outside the ledger (both sides at once,
// so the books stay balanced), a one-sided correction, or removing an entry. New
// entries are tagged with the folder in scope, as the console does.
export function Adjust({ ctx, onSaved }: { ctx: Ctx; onSaved: () => void }) {
  const { world, view, scope, tz } = ctx;
  const saver = useSaver(ctx, onSaved);
  // The console picks from the players in scope and names them as the scope does.
  const people = [...view.board].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const nameOf = (n: string): string => players.displayName(view.board, n);
  const canWrite = ctx.payload.canWrite;

  const save = (next: Adjustment[], done: string): Promise<boolean> =>
    saver.run("adjustments.csv", adjustments.serializeAdjustments(next, tz), done);

  const remove = (group: string): void => {
    const { list, removed } = adjustments.removeGroup(world.adjustments, group);
    const what = removed > 1 ? "both sides of this payment" : "this entry";
    if (!window.confirm(`Remove ${what}?`)) return;
    void save(list, `Removed ${removed} row${removed === 1 ? "" : "s"}${removed > 1 ? " (both sides of the payment)" : ""}.`);
  };

  return (
    <>
      <section className="card">
        <h2>Payments &amp; corrections</h2>
        <p className="muted small">
          Money that changed hands outside the ledger, debts let go, and corrections by hand (console menu 17). They change who
          owes whom on <a href={href("settle")}>Settle up</a>, not the poker results on the leaderboard.
        </p>
        {world.adjustments.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Player</th>
                <th className="num">Amount</th>
                <th className="hide-sm">Folder</th>
                <th className="hide-xs">Note</th>
                {canWrite ? <th aria-label="Remove" /> : null}
              </tr>
            </thead>
            <tbody>
              {world.adjustments.map((a, i) => (
                <tr key={`${a.group}-${i}`}>
                  <td>{a.date === null ? "?" : formatLocalDate(a.date, tz)}</td>
                  <td>{ctx.nameOf(a.playerNormalized)}</td>
                  <td className={`num ${toneOfCents(a.amountCents)}`}>{moneySignedCents(a.amountCents)}</td>
                  <td className="hide-sm">{a.folder === "" ? <span className="muted">(all folders)</span> : a.folder}</td>
                  <td className="hide-xs muted">{a.note}</td>
                  {canWrite ? (
                    <td className="num">
                      <button
                        className="ghost small"
                        disabled={saver.busy}
                        onClick={() => remove(a.group)}
                        aria-label={`Remove the ${moneySignedCents(a.amountCents)} entry for ${ctx.nameOf(a.playerNormalized)}`}
                      >
                        Remove
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {saver.shown}
      </section>

      {canWrite ? (
        <>
          {scope.folder === "" ? (
            <p className="muted small center">
              New entries go under: <strong>all folders</strong> (they count only when settling everything). Pick a folder at the top to
              tag them with it.
            </p>
          ) : (
            <p className="banner">
              New entries go under: <strong>{scope.folder}</strong>. They will count only on {scope.folder}'s sheets. Show all folders at
              the top to count them on every sheet.
            </p>
          )}
          <PaymentForm ctx={ctx} people={people} nameOf={nameOf} save={save} busy={saver.busy} />
          <CorrectionForm ctx={ctx} people={people} save={save} busy={saver.busy} />
        </>
      ) : (
        <p className="muted small center">Entries can be added on the computer that runs the site.</p>
      )}
    </>
  );
}

interface FormProps {
  ctx: Ctx;
  people: PlayerStats[];
  save: (next: Adjustment[], done: string) => Promise<boolean>;
  busy: boolean;
}

function today(): number {
  return Math.floor(Date.now() / 1000);
}

// An entry tagged with a folder counts only on that folder's sheets, so the page says
// so before it is saved. Entries under all folders need no question.
function folderOk(folder: string): boolean {
  return folder === "" || window.confirm(`This entry will count only on ${folder}'s sheets. Save it?`);
}

function PaymentForm({ ctx, people, nameOf, save, busy }: FormProps & { nameOf: (n: string) => string }) {
  const [creditorPick, setCreditor] = useState("");
  const [debtorPick, setDebtor] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [date, setDate] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // A player who has left the list (a new scope, a Refresh) is not saved as chosen.
  const creditor = chosenOption(creditorPick, people);
  const debtorOptions = people.filter((p) => p.normalizedName !== creditor);
  const debtor = chosenOption(debtorPick, debtorOptions);

  const add = (): void => {
    const cents = typedCents(amount);
    if (cents === null) return setProblem("Type an amount above $0, like 20 or 12.50.");
    const now = today();
    const day = adjustments.chooseDate(date, now, ctx.tz);
    if (!day.ok) return setProblem(day.error);
    const rows = adjustments.paymentRows({
      group: newGroup(ctx.world.adjustments, now),
      date: day.value,
      folder: ctx.scope.folder,
      note,
      amountCents: cents,
      creditor,
      creditorName: nameOf(creditor),
      debtor,
      debtorName: nameOf(debtor),
    });
    if (!rows.ok) return setProblem(rows.error === "Cancelled." ? "Pick two different players." : rows.error);
    if (!folderOk(ctx.scope.folder)) return;
    setProblem(null);
    const done = `${nameOf(debtor)} now owes ${moneyCents(cents)} less and ${nameOf(creditor)} is owed ${moneyCents(cents)} less. The leaderboard does not change.`;
    void save([...ctx.world.adjustments, ...rows.value], done).then((ok) => {
      if (ok) {
        setAmount("");
        setNote("");
      }
    });
  };

  return (
    <section className="card">
      <h3>Money that changed hands outside the ledger</h3>
      <p className="muted small">A payment, or a debt let go. Both sides are saved together, so the books stay balanced.</p>
      <div className="controls">
        <label>
          <span className="muted">Who got the money, or let it go? (was owed)</span>
          <Pick people={people} value={creditor} onChange={setCreditor} disabled={busy} />
        </label>
        <label>
          <span className="muted">Who paid it, or was let off? (owed it)</span>
          <Pick people={debtorOptions} value={debtor} onChange={setDebtor} disabled={busy} />
        </label>
        <label>
          <span className="muted">Amount</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="20.00" disabled={busy} />
        </label>
        <label>
          <span className="muted">Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="paid" disabled={busy} />
        </label>
        <label>
          <span className="muted">Date (blank = today)</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={busy} />
        </label>
        <button disabled={busy} onClick={add}>
          Save payment
        </button>
      </div>
      {problem !== null ? <p className="down small">{problem}</p> : null}
    </section>
  );
}

function CorrectionForm({ ctx, people, save, busy }: FormProps) {
  const [playerPick, setPlayer] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [date, setDate] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const player = chosenOption(playerPick, people);

  const add = (): void => {
    const cents = typedSignedCents(amount);
    if (cents === null) return setProblem("Type an amount, like 20 to add or -20 to take away.");
    const now = today();
    const day = adjustments.chooseDate(date, now, ctx.tz);
    if (!day.ok) return setProblem(day.error);
    const row = adjustments.correctionRow({ group: newGroup(ctx.world.adjustments, now), date: day.value, folder: ctx.scope.folder, note, amountCents: cents, player });
    if (!row.ok) return setProblem(row.error);
    if (!folderOk(ctx.scope.folder)) return;
    setProblem(null);
    const done = `Added. It is one-sided: settlement sheets will be short by ${moneyCents(Math.abs(cents))} until the other side is entered.`;
    void save([...ctx.world.adjustments, row.value], done).then((ok) => {
      if (ok) {
        setAmount("");
        setNote("");
      }
    });
  };

  return (
    <section className="card">
      <h3>Correct one player's balance by hand</h3>
      <p className="muted small">One-sided: nobody else's balance changes, so the sheets come up short until the other side is entered.</p>
      <div className="controls">
        <label>
          <span className="muted">Player</span>
          <Pick people={people} value={player} onChange={setPlayer} disabled={busy} />
        </label>
        <label>
          <span className="muted">Add to their balance (negative takes away)</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="-20.00" disabled={busy} />
        </label>
        <label>
          <span className="muted">Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
        </label>
        <label>
          <span className="muted">Date (blank = today)</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={busy} />
        </label>
        <button disabled={busy} onClick={add}>
          Save correction
        </button>
      </div>
      {problem !== null ? <p className="down small">{problem}</p> : null}
    </section>
  );
}

function Pick({ people, value, onChange, disabled = false }: { people: PlayerStats[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">Pick a player…</option>
      {people.map((p) => (
        <option key={p.normalizedName} value={p.normalizedName}>
          {p.displayName}
        </option>
      ))}
    </select>
  );
}
