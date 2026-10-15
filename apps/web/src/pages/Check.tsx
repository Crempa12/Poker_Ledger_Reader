import type { Ctx } from "../context.ts";
import { longDate, plural } from "../format.ts";
import { href } from "../router.ts";

// How many things the console app would ask you to look at.
export function checkCount(ctx: Ctx): number {
  const { world, view } = ctx;
  return view.mergeSuggestions.length + view.seatFlags.length + world.duplicates.filter((d) => !d.skipped || d.kind === "overlap").length + world.messages.filter((m) => m.startsWith("WARNING")).length;
}

export function Check({ ctx }: { ctx: Ctx }) {
  const { world, view, tz } = ctx;
  const unbalanced = world.messages.filter((m) => m.startsWith("WARNING"));
  const notes = world.messages.filter((m) => !m.startsWith("WARNING"));
  const gameById = new Map(world.games.map((g) => [g.id, g]));

  return (
    <>
      <section className="card">
        <h2>Checks</h2>
        <p className="muted small">
          What the console app flags at startup. This site only shows them; fix them in the console app (the menu is named
          next to each one), then press Refresh.
        </p>
        {checkCount(ctx) === 0 && world.warnings.length === 0 ? <p className="up">✓ Nothing to check.</p> : null}
      </section>

      {view.mergeSuggestions.length > 0 ? (
        <section className="card">
          <h3>New names to check · menu 4</h3>
          <ul className="plain">
            {view.mergeSuggestions.map((s) => (
              <li key={s.playerId}>
                <strong>{s.newNames.map((n) => ctx.nameOf(n)).join(", ")}</strong>{" "}
                <span className="muted">is new, on an account also used by</span>{" "}
                {s.canonicals.filter((c) => !s.newNames.includes(c)).map((c) => ctx.nameOf(c)).join(", ")}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.seatFlags.length > 0 ? (
        <section className="card">
          <h3>Seats that look shared · menu 20</h3>
          <ul className="plain">
            {view.seatFlags.map((f) => {
              const g = gameById.get(f.gameId);
              const row = g?.rows[f.row];
              return (
                <li key={`${f.gameId}-${f.row}`}>
                  <a href={href("game", f.gameId)}>{longDate(g?.start ?? null, tz)}</a> · <strong>{row?.nickname ?? "?"}</strong>
                  {f.usualOwner !== "" ? <span className="muted"> on {ctx.nameOf(f.usualOwner)}'s account</span> : null}
                  {f.overlapAccounts.length > 0 ? <span className="muted"> · sitting on {plural(f.overlapAccounts.length, "other account")} at the same time</span> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {world.duplicates.length > 0 ? (
        <section className="card">
          <h3>Duplicate ledgers · menu 16</h3>
          <ul className="plain">
            {world.duplicates.map((d, i) => (
              <li key={i}>
                <code>{d.path}</code> <span className="muted">{d.kind === "overlap" ? `shares ${plural(d.sharedRows, "sit-down")} with` : d.kind === "identical" ? "is a copy of" : "is an earlier export of"}</span>{" "}
                <code>{d.otherPath}</code> {d.skipped ? <span className="tag">not counted</span> : <span className="tag down">counted twice?</span>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {unbalanced.length > 0 || notes.length > 0 ? (
        <section className="card">
          <h3>Ledger notes</h3>
          <ul className="plain">
            {[...unbalanced, ...notes].map((m, i) => (
              <li key={i} className={m.startsWith("WARNING") ? "down" : "muted"}>
                {m}
              </li>
            ))}
          </ul>
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
    </>
  );
}
