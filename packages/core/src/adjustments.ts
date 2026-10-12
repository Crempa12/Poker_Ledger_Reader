// Manual corrections to player totals: forgiven debts, side payments, mistakes
// (port of src/adjustments.cpp, without the prompts and the printing).
//
// Pure: the caller reads and writes adjustments.csv and asks the questions. The
// money rules live here, so the console and the website make the same entries:
// a payment is two balanced rows sharing one group, a correction is one row,
// removing a group removes both sides, and the scope gives the folder tag.

import type { Adjustment, Epoch, Scope } from "./models.ts";
import { scopeContains } from "./models.ts";
import {
  dollarsToCents,
  escapeCSV,
  fixed2,
  fixed2Cents,
  formatLocalDate,
  normalizeName,
  parseCSV,
  parseLocalDate,
  toDoubleSafe,
  trim,
  wallClock,
  zonedTimeToEpoch,
} from "./util.ts";

// The C++ EPSILON: anything under a cent counts as nothing. Dollars for the
// file check, cents for amounts held as whole cents.
const EPSILON_DOLLARS = 0.009;
const EPSILON_CENTS = 0.9;

export const ADJUSTMENTS_HEADER = "group,date,player_normalized,amount,folder,note";

// Result of a rule that can refuse: the value, or the reason for the refusal.
export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function refuse<T>(error: string): Checked<T> {
  return { ok: false, error };
}

function cell(row: string[], i: number): string {
  return row[i] ?? "";
}

// Whole cents of a dollar amount, rounded the way printf rounds it. The file is
// written with printf, so this is what a saved amount reads back as.
function centsOf(dollars: number): number {
  return dollarsToCents(fixed2(dollars));
}

// Reads adjustments.csv text. A row needs four fields. Rows with no player or an
// amount under a cent are left out, as the C++ loadCSV does. A bad date is kept
// as null (the C++ NO_TIME), so it counts only in an unbounded scope.
export function parseAdjustments(text: string, timeZone: string): Adjustment[] {
  const list: Adjustment[] = [];
  for (const row of parseCSV(text)) {
    if (row.length < 4) continue;
    const dollars = toDoubleSafe(cell(row, 3));
    const playerNormalized = normalizeName(cell(row, 2));
    if (playerNormalized === "" || Math.abs(dollars) < EPSILON_DOLLARS) continue;
    list.push({
      group: trim(cell(row, 0)),
      date: parseLocalDate(cell(row, 1), false, timeZone),
      playerNormalized,
      amountCents: centsOf(dollars),
      folder: row.length > 4 ? trim(cell(row, 4)) : "",
      note: row.length > 5 ? trim(cell(row, 5)) : "",
    });
  }
  return list;
}

// The adjustments.csv text: header, then one line per entry.
export function serializeAdjustments(list: readonly Adjustment[], timeZone: string): string {
  let out = ADJUSTMENTS_HEADER + "\n";
  for (const a of list) {
    out +=
      [
        escapeCSV(a.group),
        formatLocalDate(a.date, timeZone),
        escapeCSV(a.playerNormalized),
        fixed2Cents(a.amountCents),
        escapeCSV(a.folder),
        escapeCSV(a.note),
      ].join(",") + "\n";
  }
  return out;
}

// The entries that count in a scope: the folder tag must match a folder scope
// (an untagged entry counts only when every folder is in scope), and the date
// must sit inside the date range.
export function filter(list: readonly Adjustment[], scope: Scope): Adjustment[] {
  return list.filter((a) => scopeContains(scope, a.folder, a.date));
}

// The folder tag a new entry gets: the folder being viewed, or "" for all folders.
export function folderTag(scope: Scope): string {
  return scope.folder;
}

// How a folder tag reads on screen. An untagged entry says "(all folders)".
export function folderLabel(folder: string): string {
  return folder === "" ? "(all folders)" : folder;
}

// The date a new entry gets from the typed text. Blank means today: local midnight
// of the day nowSeconds falls on in timeZone. Anything else is YYYY-MM-DD or
// M/D/YY, read as local midnight.
export function chooseDate(text: string, nowSeconds: number, timeZone: string): Checked<number> {
  const typed = trim(text);
  if (typed === "") {
    const today = wallClock(nowSeconds, timeZone);
    return { ok: true, value: zonedTimeToEpoch(today.year, today.month, today.day, 0, 0, 0, timeZone) };
  }
  const date = parseLocalDate(typed, false, timeZone);
  if (date === null) return refuse("Could not read that date.");
  return { ok: true, value: date };
}

// A group id unique in the list: "adj<seconds>-<n>". The counter is the caller's
// state (the C++ used a static one). Pass 0 at the start, then the counter this
// returns, so ids stay unique when two entries fall in the same second.
export function newGroup(
  list: readonly Adjustment[],
  nowSeconds: number,
  counter: number,
): { group: string; counter: number } {
  let n = counter;
  for (;;) {
    n++;
    const group = `adj${nowSeconds}-${n}`;
    if (!list.some((a) => a.group === group)) return { group, counter: n };
  }
}

export interface PaymentInput {
  group: string;
  date: Epoch;
  folder: string; // folderTag(scope)
  note: string; // blank becomes "paid"
  amountCents: number; // the money that changed hands, positive
  creditor: string; // normalized: was owed the money, or let the debt go
  creditorName: string; // display name, for the notes (players::displayName)
  debtor: string; // normalized: paid it, or was let off
  debtorName: string;
}

// A payment, or a debt let go: the debtor's balance goes up and the creditor's
// goes down by the same amount, so the entries still sum to zero. Both rows
// share the group, so removing one removes the other.
export function paymentRows(input: PaymentInput): Checked<[Adjustment, Adjustment]> {
  if (input.creditor === "") return refuse("Pick who got the money, or let the debt go.");
  if (input.debtor === "" || input.debtor === input.creditor) return refuse("Cancelled.");
  if (input.amountCents < EPSILON_CENTS) return refuse("Amount is too small to record.");
  if (input.date === null) return refuse("Pick a date.");
  const note = trim(input.note) === "" ? "paid" : trim(input.note);
  const debtorRow: Adjustment = {
    group: input.group,
    date: input.date,
    playerNormalized: input.debtor,
    amountCents: input.amountCents,
    folder: input.folder,
    note: `${note} (to ${input.creditorName})`,
  };
  const creditorRow: Adjustment = {
    group: input.group,
    date: input.date,
    playerNormalized: input.creditor,
    amountCents: -input.amountCents,
    folder: input.folder,
    note: `${note} (from ${input.debtorName})`,
  };
  return { ok: true, value: [debtorRow, creditorRow] };
}

export interface CorrectionInput {
  group: string;
  date: Epoch;
  folder: string; // folderTag(scope)
  note: string;
  amountCents: number; // signed: positive adds to the balance, negative takes away
  player: string; // normalized
}

// A one-sided correction. It is not balanced on its own, so the settlement sheets
// come up short by its amount until the other side is entered.
export function correctionRow(input: CorrectionInput): Checked<Adjustment> {
  if (input.player === "") return refuse("Pick a player.");
  if (Math.abs(input.amountCents) < EPSILON_CENTS) return refuse("Amount is too small to record.");
  if (input.date === null) return refuse("Pick a date.");
  return {
    ok: true,
    value: {
      group: input.group,
      date: input.date,
      playerNormalized: input.player,
      amountCents: input.amountCents,
      folder: input.folder,
      note: trim(input.note),
    },
  };
}

// The list without every row of one group, and how many rows that removed.
// Removing one side of a payment therefore removes the other side too.
export function removeGroup(list: readonly Adjustment[], group: string): { list: Adjustment[]; removed: number } {
  const kept = list.filter((a) => a.group !== group);
  return { list: kept, removed: list.length - kept.length };
}
