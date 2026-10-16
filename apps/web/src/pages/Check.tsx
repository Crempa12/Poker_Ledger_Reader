import { useState } from "react";
import { moneySigned, players, seats } from "@plr/core";

import { Notes } from "../components/handlines.tsx";
import { useSaver, type Saver } from "../components/saver.tsx";
import type { Ctx } from "../context.ts";
import { plural } from "../format.ts";
import { useHandLogs } from "../handlogs.ts";
import { chosenOption, confirmNames } from "../saved.ts";
import { SavedSeatOwners, SharedSeats } from "./Seats.tsx";

// How many things the console app would ask you to look at: the alerts on its menu (new
// names, seats to check, duplicates found, as menus 4, 20 and 16 flag them) and the
// ledgers that do not balance (the startup's WARNING lines).
export function checkCount(ctx: Ctx): number {
  const { world, view } = ctx;
  return view.mergeSuggestions.length + view.seatFlags.length + world.duplicates.length + world.messages.filter((m) => m.startsWith("WARNING")).length;
}

// Poker result over every game, the way the console app prints it next to a name.
function netOf(ctx: Ctx, normalized: string): string {
  const p = ctx.everyone.find((s) => s.normalizedName === normalized);
  return p === undefined ? "" : moneySigned(players.playerDollars(p).totalNet);
}

export function Check({ ctx, onSaved }: { ctx: Ctx; onSaved: () => void }) {
  const { world, view } = ctx;
  // Kept here, so the answer to the last question still shows once the card is gone.
  const answers = useSaver(ctx, onSaved);
  // The startup's hand-log lines (skipped and duplicate logs) are the same for every scope; they show once the results are read.
  const hand = useHandLogs(ctx);
  const handNotes = hand.status === "ready" && hand.data !== undefined ? hand.data.messages : [];

  return (
    <>
      <section className="card">
        <h2>Checks</h2>
        <p className="muted small">
          {ctx.payload.canWrite
            ? "What the console app flags at startup. New names can be answered here; for the rest, use the console menu named next to each one, then press Refresh."
            : "What the console app flags at startup. This copy is read-only: answers and changes are made on the computer that runs the site."}
        </p>
        {checkCount(ctx) === 0 && world.warnings.length === 0 ? <p className="up">✓ Nothing to check.</p> : null}
      </section>

      {view.mergeSuggestions.length > 0 ? (
        <NewNames ctx={ctx} saver={answers} />
      ) : answers.shown !== null ? (
        <section className="card">
          <h3>New names to check · menu 4</h3>
          {answers.shown}
          <p className="up small">✓ No new names left to check.</p>
        </section>
      ) : null}

      <SharedSeats ctx={ctx} onSaved={onSaved} />

      {world.duplicates.length > 0 ? (
        <section className="card">
          <h3>Duplicate ledgers · menu 16</h3>
          <ul className="plain">
            {world.duplicates.map((d, i) => (
              <li key={i}>
                <code>{d.path}</code> <span className="muted">{d.kind === "overlap" ? `shares ${plural(d.sharedRows, "sit-down")} with` : d.kind === "identical" ? "is a copy of" : "is an earlier export of"}</span>{" "}
                <code>{d.otherPath}</code> {d.skipped ? <span className="tag">not counted</span> : <span className="tag down">counted twice?</span>}
                {d.kind === "overlap" ? (
                  <span className="muted small">
                    {" "}
                    Both files are still counted. If they are the same game, delete the older export.
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {world.messages.length > 0 ? (
        <section className="card">
          <h3>Ledger notes</h3>
          {world.messages.some((m) => m.startsWith("WARNING") && m.includes("does not balance")) ? (
            <p className="muted small">
              A ledger that does not balance may have been cut short or changed by hand. On the computer that runs the site, download it again
              from PokerNow, put it in place of the old file, then press Refresh. A payment or correction does not clear this.
            </p>
          ) : null}
          <ul className="plain">
            {world.messages.map((m, i) => (
              <li key={i} className={m.startsWith("WARNING") ? "down" : "muted"}>
                {m}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {handNotes.length > 0 ? (
        <section className="card">
          <h3>Hand logs · Play style</h3>
          <Notes messages={handNotes} />
        </section>
      ) : null}

      {world.warnings.length > 0 ? (
        <section className="card">
          <h3>Rows that could not be read</h3>
          <ul className="plain">
            {world.warnings.map((w, i) => (
              <li key={i} className="muted">
                <code>{w.source}</code> row {w.row}
                {w.field !== null ? `, ${w.field}` : ""}: {w.code.replace(/-/g, " ")}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Names ctx={ctx} onSaved={onSaved} />
      <section className="card">
        <h3>Seat owners · menu 20</h3>
        <p className="muted small">
          Seats handed to someone other than their name, and seats checked as right. Any seat of a game can be handed over from
          that game's page.
        </p>
        <SavedSeatOwners ctx={ctx} onSaved={onSaved} />
      </section>
    </>
  );
}

// Menu 4's first step: a name never seen before, on an account someone else uses.
// The same person under a new nickname is merged; a different person is saved as a
// checked seat, so the question is not asked again (C++ reviewNewNames).
function NewNames({ ctx, saver }: { ctx: Ctx; saver: Saver }) {
  const { world, view } = ctx;
  const { busy, run, shown } = saver;
  const canWrite = ctx.payload.canWrite;

  const merge = (alias: string, keep: string): void => {
    const rules = players.addMergeRule(world.rules, alias, keep);
    void run("merge_rules.csv", players.serializeMergeRulesCSV(rules), `Merged "${ctx.nameOf(alias)}" into "${ctx.nameOf(keep)}".`);
  };
  const different = (account: string, name: string): void => {
    const list = confirmNames(world, account, [name]);
    void run("seat_owners.csv", seats.serializeSeatOwnersCSV(list), `Saved: "${ctx.nameOf(name)}" is a different person. This will not be asked again.`);
  };

  return (
    <section className="card">
      <h3>New names to check · menu 4</h3>
      <ul className="plain questions">
        {view.mergeSuggestions.flatMap((s) =>
          s.newNames.map((n) => {
            const others = s.canonicals.filter((c) => c !== n);
            return (
              <li key={`${s.playerId}|${n}`}>
                <p>
                  <strong>{ctx.nameOf(n)}</strong> <span className="muted">{netOf(ctx, n)} · never seen before, and has only played on an account also used by:</span>
                </p>
                {canWrite ? (
                  <div className="choices">
                    {others.map((o) => (
                      <button key={o} disabled={busy} onClick={() => merge(n, o)}>
                        Same person as {ctx.nameOf(o)} <span className="muted">{netOf(ctx, o)}</span>
                        {s.newNames.includes(o) ? <span className="muted"> (also new)</span> : null}
                      </button>
                    ))}
                    <button className="ghost" disabled={busy} onClick={() => different(s.playerId, n)}>
                      Different person
                    </button>
                  </div>
                ) : (
                  <p className="muted">{others.map((o) => ctx.nameOf(o)).join(", ")}</p>
                )}
              </li>
            );
          }),
        )}
      </ul>
      {shown}
    </section>
  );
}

// Menu 4's other two choices: merge any names by hand, or split one back out.
function Names({ ctx, onSaved }: { ctx: Ctx; onSaved: () => void }) {
  const { world } = ctx;
  const { busy, run, shown } = useSaver(ctx, onSaved);
  const [keepPick, setKeep] = useState("");
  const [otherPick, setOther] = useState("");
  const list = [...ctx.everyone].sort((a, b) => a.displayName.localeCompare(b.displayName));
  // Only names still on the list are used (a Refresh can drop one), and the name folded
  // in is never the one kept.
  const keep = chosenOption(keepPick, list);
  const other = chosenOption(otherPick, list.filter((p) => p.normalizedName !== keep));

  // canonical -> its aliases, the way menu 4 lists the merged names.
  const groups = new Map<string, string[]>();
  for (const [alias, canonical] of world.rules) groups.set(canonical, [...(groups.get(canonical) ?? []), alias]);
  const grouped = [...groups.entries()]
    .map(([canonical, aliases]) => ({ canonical, display: ctx.nameOf(canonical), aliases: aliases.sort() }))
    .sort((a, b) => a.display.localeCompare(b.display));

  // A shared account is real evidence; a matching name alone is not.
  const accounts = players.accountsByPerson(world.games, world.rules);
  const linked = keep !== "" && other !== "" && (accounts.get(other) ?? []).some((a) => (accounts.get(keep) ?? []).includes(a));

  const mergeByHand = (): void => {
    if (keep === "" || other === "" || keep === other) return;
    if (
      !linked &&
      !window.confirm(
        `${ctx.nameOf(other)} never played on the same PokerNow account as ${ctx.nameOf(keep)}, so only you know they are one person. ` +
          "Anyone who uses that name later will count for them too. Merge anyway?",
      )
    ) {
      return;
    }
    const rules = players.addMergeRule(world.rules, other, keep);
    void run("merge_rules.csv", players.serializeMergeRulesCSV(rules), `Merged "${ctx.nameOf(other)}" into "${ctx.nameOf(keep)}".`).then((ok) => {
      if (ok) setOther("");
    });
  };
  const split = (alias: string, canonical: string): void => {
    if (!window.confirm(`"${alias}" will count as its own player again, not as ${ctx.nameOf(canonical)}. Go ahead?`)) return;
    const rules = players.removeMergeRule(world.rules, alias);
    void run("merge_rules.csv", players.serializeMergeRulesCSV(rules), `"${alias}" counts as its own player again.`);
  };

  return (
    <section className="card">
      <h3>Player names · menu 4</h3>
      <p className="muted small">
        Same person under different nicknames? Merge them. A seat played by someone other than the name on it is menu 20
        instead: that moves one seat's money and leaves both names alone.
      </p>
      {ctx.payload.canWrite ? (
        <div className="controls">
          <label>
            <span className="muted">Keep this name</span>
            <select value={keep} onChange={(e) => setKeep(e.target.value)} disabled={busy}>
              <option value="">Pick a player…</option>
              {list.map((p) => (
                <option key={p.normalizedName} value={p.normalizedName}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="muted">Fold this name into it</span>
            <select value={other} onChange={(e) => setOther(e.target.value)} disabled={busy}>
              <option value="">Pick a player…</option>
              {list
                .filter((p) => p.normalizedName !== keep)
                .map((p) => (
                  <option key={p.normalizedName} value={p.normalizedName}>
                    {p.displayName}
                  </option>
                ))}
            </select>
          </label>
          <button disabled={busy || keep === "" || other === "" || keep === other} onClick={mergeByHand}>
            Merge
          </button>
        </div>
      ) : null}
      {keep !== "" && other !== "" && !linked ? (
        <p className="down small">Heads-up: these two never played on the same PokerNow account.</p>
      ) : null}
      {shown}
      <details>
        <summary>
          Merged names ({plural(grouped.length, "person", "people")}, {plural(world.rules.size, "extra name")})
        </summary>
        <ul className="plain merged">
          {grouped.map((g) => (
            <li key={g.canonical}>
              <strong>{g.display}</strong> <span className="muted">also:</span>{" "}
              {g.aliases.map((a) => (
                <span key={a} className="alias">
                  {a}
                  {ctx.payload.canWrite ? (
                    <button
                      className="link"
                      disabled={busy}
                      onClick={() => split(a, g.canonical)}
                      title={`Count "${a}" as its own player again`}
                      aria-label={`split "${a}" from ${g.display}`}
                    >
                      split
                    </button>
                  ) : null}
                </span>
              ))}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
