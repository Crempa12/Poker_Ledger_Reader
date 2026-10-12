// Buy-ins made under someone else's name or account (port of src/seats.hpp/.cpp,
// without the menus and the printing).
//
// A seat can be handed to the person whose money it really was. Every total,
// settlement and chart then counts it for them instead of for the nickname on the
// ledger. Pure: the functions return new data and leave their inputs alone.

import type { Epoch, Game, LedgerRow, SeatOwner } from "./models.ts";
import { accountsByPerson, personOf, resolveCanonical } from "./players.ts";
import { compareBytes, escapeCSV, normalizeName, parseCSV, parseISO8601UTC, trim, wallClock } from "./util.ts";

export const SEAT_OWNERS_HEADER = "ledger_id,player_id,session_start_at,nickname,owner_normalized,note\n";

// The note for a seat whose name was right. Such a seat stays an ordinary seat.
export const NAME_RIGHT_NOTE = "checked: name was right";

// A seat that looks like it was bought by someone other than the name on it. It
// refers to its game by id, and to its row by index in that game's rows.
export interface Flag {
  gameId: string;
  row: number;
  usualOwner: string; // who normally uses this account, when that is someone else; "" if none
  overlapAccounts: string[]; // other accounts the same person sat on at the same time, sorted
}

// What the person answered for a seat: the name on it, or someone else (normalized).
export type OwnerChoice = { kind: "nickname" } | { kind: "person"; person: string };

// ---------------- seat_owners.csv ----------------

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

// Written back in the same shape PokerNow uses, so the file lines up with the
// ledger by eye.
function formatUTC(epoch: Epoch): string {
  if (epoch === null) return "";
  const w = wallClock(epoch, "UTC");
  return `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)}T${pad(w.hour, 2)}:${pad(w.minute, 2)}:${pad(w.second, 2)}Z`;
}

// The rows of seat_owners.csv (header skipped). A row with fewer than five fields,
// or without a ledger id or an owner, is ignored.
export function parseSeatOwnersCSV(text: string): SeatOwner[] {
  const out: SeatOwner[] = [];
  for (const row of parseCSV(text)) {
    if (row.length < 5) continue;
    const seat: SeatOwner = {
      ledgerId: trim(row[0] ?? ""),
      playerId: trim(row[1] ?? ""),
      start: parseISO8601UTC(row[2] ?? ""),
      nickname: trim(row[3] ?? ""),
      owner: normalizeName(row[4] ?? ""),
      note: row.length > 5 ? trim(row[5] ?? "") : "",
    };
    if (seat.ledgerId === "" || seat.owner === "") continue;
    out.push(seat);
  }
  return out;
}

// The text of seat_owners.csv, in the list's order.
export function serializeSeatOwnersCSV(list: readonly SeatOwner[]): string {
  let out = SEAT_OWNERS_HEADER;
  for (const s of list) {
    out +=
      [
        escapeCSV(s.ledgerId),
        escapeCSV(s.playerId),
        formatUTC(s.start),
        escapeCSV(s.nickname),
        escapeCSV(s.owner),
        escapeCSV(s.note),
      ].join(",") + "\n";
  }
  return out;
}

// ---------------- matching and the name on the seat ----------------

// A saved entry belongs to a seat when the ledger, account, sit-down time and
// nickname (normalized) all agree.
export function seatMatches(s: SeatOwner, game: Game, row: LedgerRow): boolean {
  return (
    s.ledgerId === game.id &&
    s.playerId === row.playerId &&
    s.start === row.start &&
    normalizeName(s.nickname) === normalizeName(row.nickname)
  );
}

// Who the nickname on the seat says it was, ignoring any reassignment.
export function nicknamePerson(rules: ReadonlyMap<string, string>, row: LedgerRow): string {
  return personOf(rules, { ...row, owner: "" });
}

// Who normally uses each account: the person with the most seats on it, when that
// is at least 3 seats and more than half of them. Ties go to the earlier name in
// byte order.
export function usualOwners(games: readonly Game[], rules: ReadonlyMap<string, string>): Map<string, string> {
  const uses = new Map<string, Map<string, number>>();
  for (const g of games) {
    for (const row of g.rows) {
      if (row.playerId === "") continue;
      const person = personOf(rules, row);
      let counts = uses.get(row.playerId);
      if (counts === undefined) {
        counts = new Map();
        uses.set(row.playerId, counts);
      }
      counts.set(person, (counts.get(person) ?? 0) + 1);
    }
  }
  const out = new Map<string, string>();
  for (const [account, counts] of uses) {
    let total = 0;
    let bestCount = 0;
    let best = "";
    for (const person of [...counts.keys()].sort(compareBytes)) {
      const n = counts.get(person) ?? 0;
      total += n;
      if (n > bestCount) {
        best = person;
        bestCount = n;
      }
    }
    if (bestCount >= 3 && bestCount * 2 > total) out.set(account, best);
  }
  return out;
}

// The usual owner for a set of seats that all sit on one account ("" otherwise).
export function usualOwnerForSeats(usual: ReadonlyMap<string, string>, rows: readonly LedgerRow[]): string {
  const accounts = new Set(rows.map((r) => r.playerId));
  if (accounts.size !== 1) return "";
  const [account] = accounts;
  return account === undefined ? "" : (usual.get(account) ?? "");
}

// The seat numbers the user typed (1-based), as row indexes in the game. Repeats
// are kept once, in the order given. Null when there are none, or one is out of range.
export function pickSeatRows(game: Game, numbers: readonly number[]): number[] | null {
  if (numbers.length === 0) return null;
  const picked: number[] = [];
  for (const n of numbers) {
    if (n < 1 || n > game.rows.length) return null;
    if (!picked.includes(n - 1)) picked.push(n - 1);
  }
  return picked;
}

// Is time a before time b? A missing time counts as -1, the C++ NO_TIME value.
function before(a: Epoch, b: Epoch): boolean {
  return (a ?? -1) < (b ?? -1);
}

// A seat still open when the ledger was exported ran to the end of the game.
function seatEnd(g: Game, r: LedgerRow): Epoch {
  return r.end ?? g.end;
}

// ---------------- applying the saved entries ----------------

export interface AppliedSeats {
  games: Game[]; // new games: each row has owner and ownerReviewed set from the entries
  unmatched: number; // saved entries that matched no row (their ledger is not loaded)
}

// Sets owner and ownerReviewed on every row that has a saved entry. A row with no
// entry is reset to its nickname. An entry that says the name was right leaves the
// owner empty.
export function apply(
  games: readonly Game[],
  list: readonly SeatOwner[],
  rules: ReadonlyMap<string, string>,
): AppliedSeats {
  const used: boolean[] = list.map(() => false);
  const out = games.map((g) => {
    const rows = g.rows.map((original) => {
      const r: LedgerRow = { ...original, owner: "", ownerReviewed: false };
      list.forEach((s, i) => {
        if (!seatMatches(s, g, r)) return;
        used[i] = true;
        r.ownerReviewed = true;
        // A seat confirmed as the nickname's own stays an ordinary seat.
        if (resolveCanonical(rules, s.owner) !== nicknamePerson(rules, r)) r.owner = s.owner;
      });
      return r;
    });
    return { ...g, rows };
  });
  return { games: out, unmatched: used.filter((u) => !u).length };
}

// ---------------- saving an answer ----------------

// The saved entry for one seat: the name on the seat is right, or the seat belongs
// to the person chosen.
export function seatOwnerFor(
  rules: ReadonlyMap<string, string>,
  game: Game,
  row: LedgerRow,
  choice: OwnerChoice,
): SeatOwner {
  const nameSays = nicknamePerson(rules, row);
  const owner = choice.kind === "nickname" ? nameSays : choice.person;
  const note =
    choice.kind === "nickname" || choice.person === nameSays
      ? NAME_RIGHT_NOTE
      : `bought under "${row.nickname}" on account ${row.playerId}`;
  return {
    ledgerId: game.id,
    playerId: row.playerId,
    start: row.start,
    nickname: row.nickname,
    owner,
    note,
  };
}

// Saves the choice for each seat, replacing any earlier entry for it. Returns the
// new list and the money that changed hands in cents (the seats whose counted
// person is not the one their ledger row gave).
export function assignSeats(
  list: readonly SeatOwner[],
  game: Game,
  rows: readonly LedgerRow[],
  choice: OwnerChoice,
  rules: ReadonlyMap<string, string>,
): { list: SeatOwner[]; movedCents: number } {
  let out = [...list];
  let moved = 0;
  for (const row of rows) {
    out = out.filter((s) => !seatMatches(s, game, row));
    const entry = seatOwnerFor(rules, game, row, choice);
    out.push(entry);
    if (personOf(rules, row) !== resolveCanonical(rules, entry.owner)) moved += row.netCents;
  }
  return { list: out, movedCents: moved };
}

// Undo: the entry at this index is removed, so the seat counts for its nickname again.
export function removeSeatOwner(list: readonly SeatOwner[], index: number): SeatOwner[] {
  return list.filter((_, i) => i !== index);
}

// Menu 4's "different people" answer: every unchecked seat on `account` played
// under one of `people` is saved as "name was right". Returns the new list and how
// many were added. The caller applies the list to the games.
export function confirmNames(
  games: readonly Game[],
  list: readonly SeatOwner[],
  rules: ReadonlyMap<string, string>,
  account: string,
  people: readonly string[],
): { list: SeatOwner[]; added: number } {
  const out = [...list];
  let added = 0;
  for (const g of games) {
    for (const r of g.rows) {
      if (r.playerId !== account || r.ownerReviewed || r.owner !== "") continue;
      if (!people.includes(nicknamePerson(rules, r))) continue;
      out.push(seatOwnerFor(rules, g, r, { kind: "nickname" }));
      added++;
    }
  }
  return { list: out, added };
}

// ---------------- finding seats that look shared ----------------

// Seats not yet reviewed where the account usually belongs to someone else, or the
// same person is seated on two accounts at the same time. Games in the order given,
// rows in row order.
export function findSuspicious(games: readonly Game[], rules: ReadonlyMap<string, string>): Flag[] {
  const usual = usualOwners(games, rules);
  const accounts = accountsByPerson(games, rules);
  const out: Flag[] = [];
  for (const g of games) {
    g.rows.forEach((r, i) => {
      if (r.ownerReviewed) return;
      const person = personOf(rules, r);
      // A name never seen on any other account is menu 4's question first (a new nickname?).
      if (r.owner === "" && (accounts.get(person)?.length ?? 0) === 1) return;

      const flag: Flag = { gameId: g.id, row: i, usualOwner: "", overlapAccounts: [] };
      const u = usual.get(r.playerId);
      if (u !== undefined && u !== person) flag.usualOwner = u;

      // One person cannot sit in two seats at once, so one of them was someone else.
      if (r.start !== null) {
        const others = new Set<string>();
        g.rows.forEach((o, j) => {
          if (j === i || o.playerId === r.playerId || o.start === null) return;
          if (personOf(rules, o) !== person) return;
          if (before(r.start, seatEnd(g, o)) && before(o.start, seatEnd(g, r))) others.add(o.playerId);
        });
        flag.overlapAccounts = [...others].sort(compareBytes);
      }
      if (flag.usualOwner !== "" || flag.overlapAccounts.length > 0) out.push(flag);
    });
  }
  return out;
}

// Menu 20's grouping: flagged seats with the same name on the same account in the
// same game get one answer. The newest game comes first, as in the menu.
export function groupSharedSeats(flags: readonly Flag[], games: readonly Game[]): Flag[][] {
  const byId = new Map<string, Game>();
  for (const g of games) if (!byId.has(g.id)) byId.set(g.id, g);
  const groups: Flag[][] = [];
  const groupOf = new Map<string, number>();
  for (const f of [...flags].reverse()) {
    const game = byId.get(f.gameId);
    const row = game?.rows[f.row];
    if (game === undefined || row === undefined) throw new Error(`flag points at no seat: ${f.gameId} row ${f.row}`);
    const key = `${f.gameId}|${row.playerId}|${normalizeName(row.nickname)}`;
    const at = groupOf.get(key);
    if (at === undefined) {
      groupOf.set(key, groups.length);
      groups.push([f]);
    } else {
      groups[at]?.push(f);
    }
  }
  return groups;
}
