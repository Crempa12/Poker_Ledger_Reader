import { useState } from "react";
import { settlement, type PaymentPreference, type Settings as AppSettings } from "@plr/core";

import { useSaver } from "../components/saver.tsx";
import type { Ctx } from "../context.ts";

// Console menu 6: pinned payments, the banker, who "me" is, and the console's display.
// Each change is saved the way menu 6 saves it: the whole file, straight away.
export function Settings({ ctx, onSaved }: { ctx: Ctx; onSaved: () => void }) {
  const { world } = ctx;
  const people = [...ctx.everyone].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const canWrite = ctx.payload.canWrite;

  return (
    <>
      {canWrite ? null : <p className="banner">Settings can be changed on the computer that runs the site.</p>}
      <Pins ctx={ctx} onSaved={onSaved} people={people} canWrite={canWrite} />
      <PersonSetting
        ctx={ctx}
        onSaved={onSaved}
        people={people}
        canWrite={canWrite}
        title="Banker"
        help="Everyone settles through the banker: losers pay them, they pay the winners. Pins and requests are skipped while it is on."
        offLabel="Off (pins first, then automatic matching)"
        value={world.settings.banker}
        change={(s, v) => ({ ...s, banker: v })}
        done={(v) => (v === "" ? "Banker mode off." : `Banker set. Every settlement now routes through ${ctx.nameOf(v)}.`)}
      />
      <PersonSetting
        ctx={ctx}
        onSaved={onSaved}
        people={people}
        canWrite={canWrite}
        title="Me"
        help="Who you are in the ledgers: highlighted on the leaderboard, and the running total on the overview."
        offLabel="Not set"
        value={world.settings.me}
        change={(s, v) => ({ ...s, me: v })}
        done={(v) => (v === "" ? "\"Me\" cleared." : `Saved: you are ${ctx.nameOf(v)}.`)}
      />
      <Display ctx={ctx} onSaved={onSaved} canWrite={canWrite} />
      <section className="card">
        <h3>Where the data is</h3>
        <p className="small">
          <code>{ctx.payload.dataRoot}</code>
        </p>
        <p className="muted small">
          Games in <code>Games/</code>, settings in <code>Saved_Data/</code>, the same files the console app uses. Times are shown
          in {ctx.tz}. Before this site changes a file in Saved_Data, it keeps the old one in the web project's{" "}
          <code>local/backups/</code> folder.
        </p>
      </section>
    </>
  );
}

type Person = Ctx["everyone"][number];

function Pins({ ctx, onSaved, people, canWrite }: { ctx: Ctx; onSaved: () => void; people: Person[]; canWrite: boolean }) {
  const { world } = ctx;
  const { busy, run, shown } = useSaver(ctx, onSaved);
  const [payer, setPayer] = useState("");
  const [payee, setPayee] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const save = (prefs: PaymentPreference[], done: string): Promise<boolean> =>
    run("payment_preferences.csv", settlement.serializePreferencesCSV(prefs), done);

  const add = (): void => {
    if (payer === "" || payee === "") return setProblem("Pick who pays and who they pay.");
    if (payer === payee) return setProblem("A player cannot pay themselves.");
    if (world.prefs.some((p) => p.payerNormalized === payer && p.payeeNormalized === payee)) return setProblem("That pin is already on the list.");
    setProblem(null);
    const pin: PaymentPreference = { payerNormalized: payer, payeeNormalized: payee, note: note.trim(), oneOff: false };
    void save([...world.prefs, pin], `Pinned: ${ctx.nameOf(payer)} always pays ${ctx.nameOf(payee)}.`).then((ok) => {
      if (ok) {
        setPayer("");
        setPayee("");
        setNote("");
      }
    });
  };
  const remove = (index: number): void => {
    const p = world.prefs[index];
    if (p === undefined) return;
    void save(
      world.prefs.filter((_, i) => i !== index),
      `Removed: ${ctx.nameOf(p.payerNormalized)} always pays ${ctx.nameOf(p.payeeNormalized)}.`,
    );
  };

  return (
    <section className="card">
      <h2>Pinned payments</h2>
      <p className="muted small">
        "Someone always pays someone": when the payer owes and the payee is owed, the payer's losses go to that payee first.
      </p>
      {world.prefs.length === 0 ? (
        <p className="muted">No pinned payments yet.</p>
      ) : (
        <ul className="plain pins">
          {world.prefs.map((p, i) => (
            <li key={`${p.payerNormalized}->${p.payeeNormalized}-${i}`}>
              <span>
                <strong>{ctx.nameOf(p.payerNormalized)}</strong> always pays <strong>{ctx.nameOf(p.payeeNormalized)}</strong>
                {p.note !== "" ? <span className="muted"> · {p.note}</span> : null}
              </span>
              {canWrite ? (
                <button className="ghost small" disabled={busy} onClick={() => remove(i)}>
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <div className="controls">
          <label>
            <span className="muted">Payer</span>
            <PersonSelect people={people} value={payer} onChange={setPayer} />
          </label>
          <label>
            <span className="muted">always pays</span>
            <PersonSelect people={people.filter((p) => p.normalizedName !== payer)} value={payee} onChange={setPayee} />
          </label>
          <label className="grow">
            <span className="muted">Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Venmo only" />
          </label>
          <button disabled={busy} onClick={add}>
            Pin
          </button>
        </div>
      ) : null}
      {problem !== null ? <p className="down small">{problem}</p> : null}
      {shown}
    </section>
  );
}

function PersonSetting(props: {
  ctx: Ctx;
  onSaved: () => void;
  people: Person[];
  canWrite: boolean;
  title: string;
  help: string;
  offLabel: string;
  value: string;
  change: (s: AppSettings, value: string) => AppSettings;
  done: (value: string) => string;
}) {
  const { ctx, people, canWrite, value } = props;
  const { busy, run, shown } = useSaver(ctx, props.onSaved);
  const [picked, setPicked] = useState(value);
  // A saved name that is not among the players (yet) still shows as chosen.
  const list = value === "" || people.some((p) => p.normalizedName === value) ? people : [...people, { normalizedName: value, displayName: value } as Person];

  const save = (): void => {
    void run("settings.csv", settlement.serializeSettingsCSV(props.change(ctx.world.settings, picked)), props.done(picked));
  };

  return (
    <section className="card">
      <h3>{props.title}</h3>
      <p className="muted small">{props.help}</p>
      <div className="controls">
        <select value={picked} onChange={(e) => setPicked(e.target.value)} disabled={!canWrite} aria-label={props.title}>
          <option value="">{props.offLabel}</option>
          {list.map((p) => (
            <option key={p.normalizedName} value={p.normalizedName}>
              {p.displayName}
            </option>
          ))}
        </select>
        {canWrite ? (
          <button disabled={busy || picked === value} onClick={save}>
            Save
          </button>
        ) : null}
      </div>
      {shown}
    </section>
  );
}

function Display({ ctx, onSaved, canWrite }: { ctx: Ctx; onSaved: () => void; canWrite: boolean }) {
  const { busy, run, shown } = useSaver(ctx, onSaved);
  const simple = ctx.world.settings.simpleDisplay;
  const flip = (): void => {
    const next = { ...ctx.world.settings, simpleDisplay: !simple };
    void run("settings.csv", settlement.serializeSettingsCSV(next), `The console app's display is now ${simple ? "fancy" : "simple"}.`);
  };
  return (
    <section className="card">
      <h3>Console display</h3>
      <p className="muted small">
        How the console app draws its screens: <strong>{simple ? "simple" : "fancy"}</strong>{" "}
        {simple ? "(plain text, no colors or symbols)" : "(colors, boxes and charts)"}. This site is not affected.
      </p>
      {canWrite ? (
        <button className="ghost" disabled={busy} onClick={flip}>
          Switch to {simple ? "fancy" : "simple"}
        </button>
      ) : null}
      {shown}
    </section>
  );
}

function PersonSelect({ people, value, onChange }: { people: Person[]; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Pick a player…</option>
      {people.map((p) => (
        <option key={p.normalizedName} value={p.normalizedName}>
          {p.displayName}
        </option>
      ))}
    </select>
  );
}
