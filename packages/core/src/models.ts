// Plain data shapes shared by every ledger module (port of src/models.hpp).
//
// Conventions:
//  - Money is integer cents in fields named ...Cents. The C++ kept double
//    dollars; the screen and file formats round to the cent (see util.ts).
//  - A time is whole epoch seconds, and a missing time is null. The C++ used
//    NO_TIME (-1) for this, so every "== NO_TIME" check is "=== null" here.
//  - C++ std::set fields are sorted arrays of unique strings, in UTF-8 byte
//    order (compareBytes in util.ts).
//  - C++ methods on these structs are functions that take the struct first.

import { formatLocalDate, sumCentsAsDollars } from "./util.ts";

// Epoch seconds, or null for "no time".
export type Epoch = number | null;

// One line of a ledger CSV: a single buy-in / sit-down by one player.
export interface LedgerRow {
  nickname: string;
  playerId: string;
  start: Epoch;
  end: Epoch;
  buyInCents: number;
  buyOutCents: number;
  stackCents: number;
  netCents: number;
  // Normalized name of the person whose money this seat really was, when it was
  // bought under someone else's account or name (seat owner check). Empty = the
  // nickname says who it was.
  owner: string;
  ownerReviewed: boolean; // someone checked this seat, even if the nickname was right
}

// "This buy-in belonged to <owner>", pinned to one sit-down in one ledger.
export interface SeatOwner {
  ledgerId: string;
  playerId: string;
  start: Epoch;
  nickname: string; // as it appears in the ledger, for matching and for reading the file
  owner: string; // normalized
  note: string;
}

// One ledger file = one game night.
export interface Game {
  id: string; // file stem without a browser copy suffix, e.g. "ledger_pglEX1_ex-1-ExampleId"
  path: string; // path of the CSV relative to the data root
  folder: string; // sub-folder relative to the data root, e.g. "data_folder_example"; "(root)" for the top
  start: Epoch; // earliest sit-down (game night)
  end: Epoch; // latest cash-out
  totalBuyInCents: number;
  skippedRows: number; // never-played seats (no start time, zero net) left out
  rows: LedgerRow[];
}

// A player's result in one game (used for history and charts).
export interface GameResult {
  gameId: string;
  folder: string;
  date: Epoch;
  netCents: number;
  buyIns: number;
  adjustment: boolean; // true = manual correction, not a game
  note: string;
}

// A manual correction to one player's total. A forgiven debt is two of these
// sharing a group: +amount for the debtor, -amount for the creditor.
export interface Adjustment {
  group: string;
  date: Epoch; // local midnight
  playerNormalized: string;
  amountCents: number; // signed
  folder: string; // empty = only counted when no folder scope is chosen
  note: string;
}

// The row-level figures a player's dollar totals are replayed from. The C++ app kept
// double dollars and added them one at a time, so the same adds are replayed here
// (see players.ts playerDollars). It is plain data, so a copy of a PlayerStats (a
// JSON round trip, a server-to-browser prop) replays to the same cents.
export interface PlayerReplay {
  gameRowNetsCents: number[][]; // one list per game, rows in row order, games in input order
  adjustmentCents: number[]; // in input order
}

// Aggregated view of a player across every game in the current scope.
export interface PlayerStats {
  displayName: string;
  normalizedName: string;
  totalNetCents: number; // poker result: the games only (what the leaderboard ranks)
  totalWonCents: number; // sum of winning games
  totalLostCents: number; // sum of losing games (negative)
  biggestWinCents: number;
  biggestLossCents: number;
  adjustmentsCents: number; // payments and corrections (not in totalNetCents)
  games: number;
  buyIns: number;
  history: GameResult[]; // sorted by date
  aliases: string[]; // normalized names folded into this player, sorted
  playerIds: string[]; // ledger account ids seen for this player, sorted
  replay: PlayerReplay;
}

// What a reader noticed about the data it was given. The app's own messages (the
// "Skipped:" and "does not balance" lines) are not warnings; these are for code
// that wants to tell a person what was read as zero, dropped or kept as written.
export type WarningCode =
  | "short-row" // fewer fields than the header needs: the row is read as blanks or skipped
  | "missing-column" // a column the reader uses is not in the header: read as blank
  | "bad-number" // a number field holds no number (or overflows): read as 0
  | "non-finite-number" // inf or nan (or a value too big for a double): the row is refused
  | "bad-date" // a date or time that is not blank but reads as no time
  | "dropped-row" // a row left out for lacking a name, a value or an owner
  | "unknown-status" // a session status other than open, partial or paid: kept as written
  | "merge-cycle"; // merge rules that point round in a circle: the result depends on order

export interface DataWarning {
  code: WarningCode;
  source: string; // the file it came from, by its name (a path inside the data root, or a saved file)
  row: number; // 1-based, counting the data rows after the header; 0 when the whole file is meant
  field: string | null; // the column, when one column is to blame
}

export type WarnFn = (warning: DataWarning) => void;

// Time at the table for one person over the games in scope.
export interface PlayTime {
  nights: number; // games in scope they played
  nightsLogged: number; // ... of which have a hand log that dealt them a hand
  hands: number; // hands dealt, from the hand logs
  secondsDealt: number; // the length of every hand they were dealt, from the hand logs
  secondsEstimated: number; // ledger seat time: nights without a log, and seats before a log begins
}

// "requested" is a one-off request for one sheet only (the C++ writes that tag).
export type SettlementReason = "preference" | "requested" | "banker" | "auto";

export interface SettlementEntry {
  fromDisplay: string;
  fromNormalized: string;
  toDisplay: string;
  toNormalized: string;
  amountCents: number;
  reason: SettlementReason;
}

// "payer always sends their losses to payee" (when payee is owed money).
export interface PaymentPreference {
  payerNormalized: string;
  payeeNormalized: string;
  note: string;
  oneOff: boolean; // true = requested for one sheet only, never written to disk
}

export type SessionStatus = "open" | "partial" | "paid";

export interface SessionBalance {
  sessionId: string;
  fromDisplay: string;
  fromNormalized: string;
  toDisplay: string;
  toNormalized: string;
  originalCents: number;
  remainingCents: number;
  // "open", "partial" or "paid" as the app writes them. A hand edit may put another
  // word here: it is kept as written, and a warning says so (see parseSessionBalances).
  status: SessionStatus | string;
}

// Which games are being looked at: a folder and a date range.
export interface Scope {
  folder: string; // empty = every folder
  from: Epoch; // inclusive, local midnight
  to: Epoch; // inclusive, local end of day
}

// Persistent user settings (Saved_Data/settings.csv).
export interface Settings {
  me: string; // normalized name of the person running the app
  banker: string; // normalized name; empty = no banker mode
  simpleDisplay: boolean; // plain text, no colors or symbols
}

// Average result per game, in dollars (0 with no games). rowNetsCents are the
// player's row nets in the order the C++ app adds them to totalNet; the sum is
// replayed as doubles, then divided by the game count. Print it with fixed2 or
// money: an exact cents division can differ from the console app's last cent.
export function averagePerGameDollars(rowNetsCents: number[], games: number): number {
  return games === 0 ? 0 : sumCentsAsDollars(rowNetsCents) / games;
}

export function playTimeSeconds(time: PlayTime): number {
  return time.secondsDealt + time.secondsEstimated;
}

export function playTimeHours(time: PlayTime): number {
  return playTimeSeconds(time) / 3600;
}

export function scopeIsEverything(scope: Scope): boolean {
  return scope.folder === "" && scope.from === null && scope.to === null;
}

// Is something from `itemFolder`, dated `date`, inside this scope? (Games and
// adjustments alike.) A bounded scope never contains an item without a date.
export function scopeContains(scope: Scope, itemFolder: string, date: Epoch): boolean {
  if (scope.folder !== "" && itemFolder !== scope.folder) return false;
  if (scope.from !== null && (date === null || date < scope.from)) return false;
  if (scope.to !== null && (date === null || date > scope.to)) return false;
  return true;
}

// "folder "May"", "2031-05-01 to 2031-05-31" and similar, for headings. The
// time zone is needed to print the dates.
export function scopeDescribe(scope: Scope, timeZone: string): string {
  let s = scope.folder === "" ? "all folders" : `folder "${scope.folder}"`;
  if (scope.from !== null || scope.to !== null) {
    s += ", ";
    s += scope.from === null ? "start" : formatLocalDate(scope.from, timeZone);
    s += " to ";
    s += scope.to === null ? "now" : formatLocalDate(scope.to, timeZone);
  }
  return s;
}
