// Console menu 20: a seat played by someone other than the name on it. The seat is
// handed to the person whose money it was; totals, sheets and charts follow. Three
// ways in, as in the console: the seats that look shared (Checks), any seat of a
// game (the game's page), and the saved answers with undo (Checks).
import { useState } from "react";
import { formatLocalDate, moneySigned, moneySignedCents, players, seats, util, type Game, type LedgerRow } from "@plr/core";

import { useSaver, type Saver } from "../components/saver.tsx";
import type { Ctx } from "../context.ts";
import { clockTime, longDate, plural, toneOfCents } from "../format.ts";
import { href } from "../router.ts";
import { chosenOption } from "../saved.ts";

type Choice = seats.OwnerChoice;

// What the console says after an answer (seats.cpp reportAssignment).
function report(ctx: Ctx, rows: readonly LedgerRow[], choice: Choice, movedCents: number): string {
  const what = plural(rows.length, "seat");
  const who = choice.kind === "nickname" ? "the name on the seat" : ctx.nameOf(players.resolveCanonical(ctx.world.rules, choice.person));
  const moved = movedCents !== 0 ? ` Their combined net of ${moneySignedCents(movedCents)} changed hands: build the game's sheet again on Settle up.` : "";
  return `${what} now ${rows.length === 1 ? "counts" : "count"} for ${who}.${moved}`;
}

function answer(ctx: Ctx, saver: Saver, game: Game, rows: readonly LedgerRow[], choice: Choice): Promise<boolean> {
  const { list, movedCents } = seats.assignSeats(ctx.world.seatOwners, game, rows, choice, ctx.world.rules);
  return saver.run("seat_owners.csv", seats.serializeSeatOwnersCSV(list), report(ctx, rows, choice, movedCents));
}

// "Whose money was this seat?" with the console's choices: the name on the seat, the
// account's usual owner (when that is someone else), or anyone else.
function OwnerQuestion({ ctx, rows, usual, busy, onPick }: { ctx: Ctx; rows: readonly LedgerRow[]; usual: string; busy: boolean; onPick: (c: Choice) => void }) {
  const [otherPick, setOther] = useState("");
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const rules = ctx.world.rules;
  const nickPeople = [...new Set(rows.map((r) => seats.nicknamePerson(rules, r)))];
  const offerUsual = usual !== "" && !(nickPeople.length === 1 && nickPeople[0] === usual);
  const people = [...ctx.everyone].sort((a, b) => a.displayName.localeCompare(b.displayName));
  // Only a name still on the list is used (a Refresh can drop one).
  const other = chosenOption(otherPick, people);

  const someoneElse = (): void => {
    setProblem(null);
    if (typed.trim() !== "") {
      const person = players.resolveCanonical(rules, util.normalizeName(typed));
      // As seats.cpp: a name with no letters in it is not a name.
      if (person === "") return setProblem("A name needs at least one letter.");
      const known = ctx.everyone.some((p) => p.normalizedName === person);
      if (!known && !window.confirm(`Nobody called "${typed.trim()}" has played yet. Count it for a new player?`)) return;
      onPick({ kind: "person", person });
      return;
    }
    if (other !== "") onPick({ kind: "person", person: other });
  };

  return (
    <>
      <div className="choices">
        <button disabled={busy} onClick={() => onPick({ kind: "nickname" })}>
          {nickPeople.length === 1 ? `${ctx.nameOf(nickPeople[0] ?? "")}'s (the name is right)` : "Whoever each name says"}
        </button>
        {offerUsual ? (
          <button disabled={busy} onClick={() => onPick({ kind: "person", person: usual })}>
            {ctx.nameOf(usual)}'s (normally uses this account)
          </button>
        ) : null}
        <span className="someone">
          <select value={other} onChange={(e) => setOther(e.target.value)} aria-label="Someone else" disabled={busy}>
            <option value="">Someone else…</option>
            {people.map((p) => (
              <option key={p.normalizedName} value={p.normalizedName}>
                {p.displayName}
              </option>
            ))}
          </select>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="or type a name"
            aria-label="Type a name"
            size={12}
            disabled={busy}
          />
          <button
            className="ghost"
            disabled={busy || (other === "" && typed.trim() === "")}
            onClick={someoneElse}
            aria-label={`Theirs: ${other !== "" ? ctx.nameOf(other) : typed.trim()}`}
          >
            Theirs
          </button>
        </span>
      </div>
      {problem !== null ? (
        <p className="down small" role="alert">
          {problem}
        </p>
      ) : null}
    </>
  );
}

function SeatRows({ ctx, rows }: { ctx: Ctx; rows: readonly LedgerRow[] }) {
  return (
    <ul className="plain small">
      {rows.map((r, i) => (
        <li key={i}>
          <strong>{r.nickname}</strong> <span className="muted">on account {r.playerId} · sat down {clockTime(r.start, ctx.tz)} ·</span>{" "}
          <span className={toneOfCents(r.netCents)}>{moneySignedCents(r.netCents)}</span>
          <span className="muted"> · counts for {ctx.nameOf(players.personOf(ctx.world.rules, r))}{r.owner !== "" ? " (reassigned)" : ""}</span>
        </li>
      ))}
    </ul>
  );
}

// Menu 20, option 1: one question per name + account + game, newest game first.
export function SharedSeats({ ctx, onSaved }: { ctx: Ctx; onSaved: () => void }) {
  const { world, view, tz } = ctx;
  const saver = useSaver(ctx, onSaved);
  const gameById = new Map(world.games.map((g) => [g.id, g]));

  const groups: { key: string; game: Game; flags: typeof view.seatFlags }[] = [];
  for (const f of [...view.seatFlags].reverse()) {
    const game = gameById.get(f.gameId);
    const row = game?.rows[f.row];
    if (game === undefined || row === undefined) continue;
    const key = `${game.id}|${row.playerId}|${util.normalizeName(row.nickname)}`;
    const group = groups.find((g) => g.key === key);
    if (group === undefined) groups.push({ key, game, flags: [f] });
    else group.flags.push(f);
  }

  if (groups.length === 0) {
    return !saver.said ? null : (
      <section className="sec">
        <h2>Seats that look shared · menu 20</h2>
        {saver.shown}
        <p className="up small">✓ No shared seats left to check.</p>
      </section>
    );
  }

  return (
    <section className="sec">
      <h2>Seats that look shared · menu 20</h2>
      <p className="sub">
        PokerNow credits a seat to the name and account it was bought on. When someone played on a friend's account or under a
        friend's name, hand the seat to the person whose money it was. Someone who only changed nickname is a merge instead.
        Until you answer, each seat counts for the name on it.
      </p>
      <ul className="plain questions">
        {groups.map((g) => {
          const rows = g.flags.map((f) => g.game.rows[f.row]).filter((r): r is LedgerRow => r !== undefined);
          const reasons = new Set<string>();
          for (const f of g.flags) {
            const r = g.game.rows[f.row];
            if (r === undefined) continue;
            const person = ctx.nameOf(seats.nicknamePerson(world.rules, r));
            if (f.usualOwner !== "") reasons.add(`account ${r.playerId} is normally ${ctx.nameOf(f.usualOwner)}'s, not ${person}'s`);
            for (const other of f.overlapAccounts) {
              const otherName = [...g.game.rows].reverse().find((o) => o.playerId === other)?.nickname ?? "?";
              reasons.add(`${person} was also sitting as "${otherName}" on account ${other} at the same time`);
            }
          }
          return (
            <li key={g.key}>
              <p>
                <a href={href("game", g.game.id)}>{longDate(g.game.start, tz)}</a> <span className="muted">· {g.game.folder}</span>
              </p>
              <SeatRows ctx={ctx} rows={rows} />
              {[...reasons].sort(util.compareBytes).map((why) => (
                <p key={why} className="muted small">
                  Why: {why}
                </p>
              ))}
              {ctx.payload.canWrite ? (
                <OwnerQuestion
                  ctx={ctx}
                  rows={rows}
                  usual={g.flags[0]?.usualOwner ?? ""}
                  busy={saver.busy}
                  onPick={(c) => void answer(ctx, saver, g.game, rows, c)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {saver.shown}
    </section>
  );
}

// Menu 20, option 3: every saved answer, and undo one so the seat counts for its
// nickname again.
export function SavedSeatOwners({ ctx, onSaved }: { ctx: Ctx; onSaved: () => void }) {
  const { world, tz } = ctx;
  const saver = useSaver(ctx, onSaved);
  const list = world.seatOwners;
  const reassigned = world.games.reduce((n, g) => n + g.rows.filter((r) => r.owner !== "").length, 0);

  const undo = (i: number): void => {
    const s = list[i];
    if (s === undefined) return;
    void saver.run("seat_owners.csv", seats.serializeSeatOwnersCSV(seats.removeSeatOwner(list, i)), `Undone: "${s.nickname}" in ${s.ledgerId}.`);
  };

  return (
    <details>
      <summary>
        Saved seat owners ({list.length} saved, {plural(reassigned, "seat")} reassigned)
      </summary>
      {list.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Game</th>
                <th>Nickname</th>
                <th className="hide-sm">Account</th>
                <th className="num">Net</th>
                <th>Counted for</th>
                <th className="hide-sm">Note</th>
                {ctx.payload.canWrite ? <th aria-label="Undo" /> : null}
              </tr>
            </thead>
            <tbody>
              {list.map((s, i) => {
                const game = world.games.find((g) => g.id === s.ledgerId);
                const row = game?.rows.find((r) => game !== undefined && seats.seatMatches(s, game, r));
                return (
                  <tr key={i}>
                    <td>{game === undefined ? <span className="muted">(not loaded)</span> : <a href={href("game", game.id)}>{formatLocalDate(game.start, tz)}</a>}</td>
                    <td>{s.nickname}</td>
                    <td className="hide-sm muted">{s.playerId}</td>
                    <td className={`num ${row === undefined ? "" : toneOfCents(row.netCents)}`}>{row === undefined ? "-" : moneySigned(row.netCents / 100)}</td>
                    <td>{ctx.nameOf(players.resolveCanonical(world.rules, s.owner))}</td>
                    <td className="hide-sm muted">{s.note}</td>
                    {ctx.payload.canWrite ? (
                      <td className="num">
                        <button
                          className="link"
                          disabled={saver.busy}
                          onClick={() => undo(i)}
                          aria-label={`undo the saved answer for ${s.nickname}`}
                        >
                          undo
                        </button>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {saver.shown}
    </details>
  );
}

// Menu 20, option 2: any seat of one game. Tick the seats, then say whose money they were.
export function SeatEditor({ ctx, game, onSaved }: { ctx: Ctx; game: Game; onSaved: () => void }) {
  const saver = useSaver(ctx, onSaved);
  const [picked, setPicked] = useState<number[]>([]);
  const rows = picked.map((i) => game.rows[i]).filter((r): r is LedgerRow => r !== undefined);
  const accounts = new Set(rows.map((r) => r.playerId));
  const usualMap = seats.usualOwners(ctx.world.games, ctx.world.rules);
  const [account] = [...accounts];
  const usual = accounts.size === 1 && account !== undefined ? (usualMap.get(account) ?? "") : "";

  const toggle = (i: number): void => setPicked(picked.includes(i) ? picked.filter((j) => j !== i) : [...picked, i]);

  return (
    <section className="sec">
      <h2>Seats</h2>
      <p className="sub">
        {ctx.payload.canWrite
          ? "Every sit-down in this game. A seat played by someone other than its name? Tick it and say whose money it was (console menu 20)."
          : "Every sit-down in this game. Whose money a seat was is set on the computer that runs the site (console menu 20)."}
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              {ctx.payload.canWrite ? <th aria-label="Pick" /> : null}
              <th>Nickname</th>
              <th className="hide-sm">Account</th>
              <th className="hide-xs">Sat down</th>
              <th className="num">Net</th>
              <th>Counted for</th>
            </tr>
          </thead>
          <tbody>
            {game.rows.map((r, i) => (
              <tr key={i} className={picked.includes(i) ? "me" : ""}>
                {ctx.payload.canWrite ? (
                  <td>
                    <input
                      type="checkbox"
                      checked={picked.includes(i)}
                      onChange={() => toggle(i)}
                      aria-label={`Pick ${r.nickname}`}
                      disabled={saver.busy}
                    />
                  </td>
                ) : null}
                <td>{r.nickname}</td>
                <td className="hide-sm muted">{r.playerId}</td>
                <td className="hide-xs">{clockTime(r.start, ctx.tz)}</td>
                <td className={`num ${toneOfCents(r.netCents)}`}>{moneySignedCents(r.netCents)}</td>
                <td>
                  {ctx.nameOf(players.personOf(ctx.world.rules, r))}
                  {r.owner !== "" ? <span className="muted small"> (reassigned)</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ctx.payload.canWrite && rows.length > 0 ? (
        <>
          <p className="small">Whose money {rows.length === 1 ? "was this seat" : `were these ${rows.length} seats`}?</p>
          <OwnerQuestion
            ctx={ctx}
            rows={rows}
            usual={usual}
            busy={saver.busy}
            onPick={(c) =>
              void answer(ctx, saver, game, rows, c).then((ok) => {
                if (ok) setPicked([]);
              })
            }
          />
        </>
      ) : null}
      {saver.shown}
    </section>
  );
}
