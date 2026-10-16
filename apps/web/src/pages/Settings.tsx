import { useState } from "react";
import { settlement, type PaymentPreference, type Settings as AppSettings } from "@plr/core";

import { useSaver } from "../components/saver.tsx";
import type { Ctx } from "../context.ts";
import { postJSON } from "../data.ts";
import { plural } from "../format.ts";
import { chosenOption, errorText, leftOutNote, pinsToWrite } from "../saved.ts";

// Console menu 6: pinned payments, the banker, who "me" is, and the console's display.
// Each change is saved the way menu 6 saves it: the whole file, straight away.
export function Settings({ ctx, onSaved }: { ctx: Ctx; onSaved: () => void }) {
  const { world } = ctx;
  const people = [...ctx.everyone].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const canWrite = ctx.payload.canWrite;

  return (
    <>
      <h1>Settings</h1>
      {canWrite ? <Share /> : <p className="banner">Settings can be changed on the computer that runs the site.</p>}
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
        help="Who you are in the ledgers: highlighted on Standings, with your own figures at the top."
        offLabel="Not set"
        value={world.settings.me}
        change={(s, v) => ({ ...s, me: v })}
        done={(v) => (v === "" ? "\"Me\" cleared." : `Saved: you are ${ctx.nameOf(v)}.`)}
      />
      <Display ctx={ctx} onSaved={onSaved} canWrite={canWrite} />
      <section className="sec">
        <h2>Where the data is</h2>
        <p className="small">
          <code>{ctx.payload.dataRoot}</code>
        </p>
        <p className="sub">
          Games in <code>Games/</code>, settings in <code>Saved_Data/</code>, the same files the console app uses. Times are shown
          in {ctx.tz}. Before this site changes a file in Saved_Data, it keeps the old one in the web project's{" "}
          <code>local/backups/</code> folder.
        </p>
      </section>
    </>
  );
}

type Person = Ctx["everyone"][number];

interface Made {
  name: string;
  bytes: number;
  games: number;
  file: string;
}

// One file with the whole site and the data up to now, for people without this
// computer: it opens on any phone or computer, offline, with nothing to install.
function Share() {
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Made | null>(null);
  const [error, setError] = useState<string | null>(null);
  const make = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setMade(await postJSON<Made>("/api/snapshot", {}));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="sec">
      <h2>Share a snapshot</h2>
      <p className="sub">
        One file with every page of this site and the results up to now. It opens on any phone or computer, even offline, with
        nothing to install: send it by AirDrop, a message or a shared drive. It does not update, so make a new one after each
        game. It holds everyone's results, names, notes, PokerNow account ids and saved sheets: send it only to people who may see
        them.
      </p>
      <button onClick={() => void make()} disabled={busy}>
        {busy ? "Making it…" : "Make a snapshot"}
      </button>
      {made !== null ? (
        <p className="up small">
          Made {made.name} ({Math.round(made.bytes / 1024)} KB, {plural(made.games, "game")}).{" "}
          <a href={`/api/snapshot/${encodeURIComponent(made.name)}`} download={made.name}>
            Download it
          </a>{" "}
          · also kept at <code>{made.file}</code>
        </p>
      ) : null}
      {error !== null ? (
        <p className="down small" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Pins({ ctx, onSaved, people, canWrite }: { ctx: Ctx; onSaved: () => void; people: Person[]; canWrite: boolean }) {
  const { world } = ctx;
  const { busy, run, shown } = useSaver(ctx, onSaved);
  const [payerPick, setPayer] = useState("");
  const [payeePick, setPayee] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // Only players still on the list are used (a Refresh can drop one).
  const payer = chosenOption(payerPick, people);
  const payee = chosenOption(payeePick, people.filter((p) => p.normalizedName !== payer));

  // The whole file is written, as menu 6 does. A pin that now pays the same person is
  // left out (see pinsToWrite), and the message says so.
  const save = (prefs: PaymentPreference[], done: string): Promise<boolean> => {
    const { keep, left } = pinsToWrite(prefs);
    return run("payment_preferences.csv", settlement.serializePreferencesCSV(keep), [done, leftOutNote(left)].filter((s) => s !== "").join(" "));
  };

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
    <section className="sec">
      <h2>Pinned payments</h2>
      <p className="sub">
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
                <button
                  className="ghost small"
                  disabled={busy}
                  onClick={() => remove(i)}
                  aria-label={`Remove the pinned payment from ${ctx.nameOf(p.payerNormalized)} to ${ctx.nameOf(p.payeeNormalized)}`}
                >
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
            <PersonSelect people={people} value={payer} onChange={setPayer} disabled={busy} />
          </label>
          <label>
            <span className="muted">always pays</span>
            <PersonSelect people={people.filter((p) => p.normalizedName !== payer)} value={payee} onChange={setPayee} disabled={busy} />
          </label>
          <label className="grow">
            <span className="muted">Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Venmo only" disabled={busy} />
          </label>
          <button disabled={busy} onClick={add}>
            Pin
          </button>
        </div>
      ) : null}
      {problem !== null ? (
        <p className="down small" role="alert">
          {problem}
        </p>
      ) : null}
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
  // When the saved value changes (after a save, or a change made in the console) the pick
  // starts again from it, so a stale choice is never saved. Done during render, so the
  // message from the last save stays on screen.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setPicked(value);
  }
  const pick = picked === "" ? "" : chosenOption(picked, list);

  const save = (): void => {
    void run("settings.csv", settlement.serializeSettingsCSV(props.change(ctx.world.settings, pick)), props.done(pick));
  };

  return (
    <section className="sec">
      <h2>{props.title}</h2>
      <p className="sub">{props.help}</p>
      <div className="controls">
        <select value={pick} onChange={(e) => setPicked(e.target.value)} disabled={!canWrite || busy} aria-label={props.title}>
          <option value="">{props.offLabel}</option>
          {list.map((p) => (
            <option key={p.normalizedName} value={p.normalizedName}>
              {p.displayName}
            </option>
          ))}
        </select>
        {canWrite ? (
          <button disabled={busy || pick === value} onClick={save} aria-label={`Save: ${props.title}`}>
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
    <section className="sec">
      <h2>Console display</h2>
      <p className="sub">
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

function PersonSelect({ people, value, onChange, disabled = false }: { people: Person[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
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
