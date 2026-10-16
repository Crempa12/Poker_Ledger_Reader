// Changing the console app's Saved_Data from the page: the page works out the new
// file with @plr/core, exactly as the console menu would, and the local server writes
// it (only over the version this page was showing, and never while the console app is
// open, because it writes its own copy when it quits).
import {
  adjustments,
  formatLocalDate,
  seats,
  type Adjustment,
  type Game,
  type PaymentPreference,
  type Scope,
  type SeatOwner,
  type World,
  util,
} from "@plr/core";

import type { Ctx } from "./context.ts";
import { postJSON } from "./data.ts";

export type SavedFile =
  | "merge_rules.csv"
  | "session_balances.csv"
  | "payment_preferences.csv"
  | "settings.csv"
  | "seat_owners.csv"
  | "adjustments.csv";

// The reader codes whose row does not come back when the file is saved: a row left out, or
// an amount read as 0. bad-date is kept apart (writeSaved refuses those); the other codes keep the row
// as it was written.
const LOST_ON_SAVE = new Set(["short-row", "dropped-row", "bad-number", "non-finite-number"]);

// Why a save is refused when the file has a date or time the reader could not read (a hand edit): the row
// itself is kept, but a save writes that cell back blank (seat_owners.csv) or as "unknown" (adjustments.csv),
// so the text would be lost and a seat answer would quietly stop applying. "" when there are none.
export function unreadableDateMessage(file: string, rows: readonly number[]): string {
  if (rows.length === 0) return "";
  const which = rows.length === 1 ? `Row ${rows[0] ?? 0} of ${file} has a date or time` : `Rows ${rows.join(", ")} of ${file} have dates or times`;
  return (
    `${which} the site cannot read, and saving would write ${rows.length === 1 ? "it" : "them"} ${file === "adjustments.csv" ? "as unknown" : "back blank"}. Nothing was saved. ` +
    `Fix ${rows.length === 1 ? "it" : "them"} by hand in Saved_Data/${file} (written like the other rows), or put back the copy from ` +
    "local/backups/, then press Refresh."
  );
}

// The question asked before a save that would drop or zero rows the site could not read,
// with how many there are ("" when there are none). Pure, so the wording is one.
export function lossMessage(file: string, lost: number): string {
  if (lost === 0) return "";
  const rows = lost === 1 ? "1 row" : `${lost} rows`;
  return (
    `${rows} in ${file} could not be read. Saving rewrites the file from the rows that could be read: ` +
    "the rows that could not be read are left out, and an amount that could not be read is saved as 0.00. " +
    "The old file is kept in local/backups/, and the Checks page lists these rows. Save anyway?"
  );
}

// The rows of a file whose date or time the reader could not read and a save would not write back as found.
// "unknown" in adjustments.csv is the console app's own text for no date: it reads as no date and is written
// back as "unknown", so it is not one of them.
export function unreadableDateRows(ctx: Ctx, file: SavedFile): number[] {
  const rows = ctx.world.warnings.filter((w) => w.source === file && w.code === "bad-date").map((w) => w.row);
  if (file !== "adjustments.csv" || rows.length === 0) return rows;
  const cells = util.parseCSV(ctx.payload.saved[file] ?? "");
  return rows.filter((row) => util.trim(cells[row - 1]?.[1] ?? "") !== "unknown");
}

// Asks before a save that would lose rows the site could not read. False when the answer is no.
export function lossConfirmed(ctx: Ctx, file: SavedFile): boolean {
  const lost = ctx.world.warnings.filter((w) => w.source === file && LOST_ON_SAVE.has(w.code)).length;
  const question = lossMessage(file, lost);
  return question === "" || window.confirm(question);
}

// The basis is the server's token for everything the save depends on (game files and
// every Saved_Data file). The server refuses the save when it has changed since this
// page was loaded, so a stale sheet is never written over newer data. Resolves to false,
// and writes nothing, when the person says no to lossConfirmed's question.
export async function writeSaved(ctx: Ctx, file: SavedFile, text: string): Promise<boolean> {
  const badDates = unreadableDateRows(ctx, file);
  if (badDates.length > 0) throw new Error(unreadableDateMessage(file, badDates));
  if (!lossConfirmed(ctx, file)) return false;
  await postJSON<{ saved: string }>("/api/saved-file", { file, before: ctx.payload.saved[file] ?? "", text, basis: ctx.payload.basis });
  return true;
}

// The value a select can show and save: the chosen player while they are still one of
// the options, else "" (the placeholder). After a scope change or a Refresh a choice can
// drop out of the list, and must not be saved as if it were still on screen.
export function chosenOption(value: string, options: readonly { readonly normalizedName: string }[]): string {
  return options.some((o) => o.normalizedName === value) ? value : "";
}

// The pins that go into payment_preferences.csv. A pin whose payer and payee are one
// person now (after a merge) is left out: the console drops such rows when it loads the
// file (settlement.cpp loadPreferencesCSV), so it never applied them. `left` says how
// many were left out, for the message.
export function pinsToWrite(prefs: readonly PaymentPreference[]): { keep: PaymentPreference[]; left: number } {
  const keep = prefs.filter((p) => p.payerNormalized !== p.payeeNormalized);
  return { keep, left: prefs.length - keep.length };
}

// The sentence a save adds when some pins were left out ("" when none were).
export function leftOutNote(left: number): string {
  if (left === 0) return "";
  return left === 1 ? "One pin that now pays the same person was left out of the file." : `${left} pins that now pay the same person were left out of the file.`;
}

// Menu 5's "Not on this sheet" count (main.cpp): the payments and corrections saved under
// "all folders" whose date falls in the sheet's date range. Each side of a payment counts,
// as the console counts the rows.
export function notOnThisSheet(list: readonly Adjustment[], target: Scope): number {
  if (target.folder === "") return 0;
  return adjustments.filter(list, { ...target, folder: "" }).filter((a) => a.folder === "").length;
}

// The session id the console app suggests when you save a sheet (main.cpp
// defaultSessionId): the folder, else the date range, else "all games as of today".
export function defaultSessionId(scope: Scope, timeZone: string, nowSeconds: number): string {
  if (scope.folder !== "") return scope.folder;
  if (scope.from !== null || scope.to !== null) {
    const from = scope.from === null ? "start" : formatLocalDate(scope.from, timeZone);
    return `${from}_to_${formatLocalDate(scope.to ?? nowSeconds, timeZone)}`;
  }
  return `all_games_as_of_${formatLocalDate(nowSeconds, timeZone)}`;
}

// The id for one game's sheet (menu 5, option 1).
export function gameSessionId(game: Game, timeZone: string): string {
  return `game_${formatLocalDate(game.start, timeZone)}_${game.id}`;
}

// A typed dollar amount ("20", "12.5", "$1,234.50") in whole cents; null when it is
// not one, or not above zero. A comma only groups thousands, so "12,50" is refused
// rather than read as $1,250.
export function typedCents(text: string): number | null {
  const t = text.trim().replace(/^\$/, "");
  if (t.includes(",") && !/^\d{1,3}(,\d{3})+(\.\d{0,2})?$/.test(t)) return null;
  const digits = t.replace(/,/g, "");
  const m = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(digits) ?? /^()\.(\d{1,2})$/.exec(digits);
  if (m === null) return null;
  const cents = Number(m[1] === "" ? "0" : m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

// The same with a sign: "-20" takes away, "20" or "+20" adds; null when it is not
// an amount, or is zero.
export function typedSignedCents(text: string): number | null {
  const t = text.trim();
  const negative = t.startsWith("-");
  const cents = typedCents(negative || t.startsWith("+") ? t.slice(1) : t);
  return cents === null ? null : negative ? -cents : cents;
}

// A new adjustment group id, as the console app makes them (adjustments.cpp
// newGroup): "adj<epoch seconds>-<n>", bumping n until no saved entry uses it.
export function newGroup(list: readonly Adjustment[], nowSeconds: number): string {
  for (let n = 1; ; n++) {
    const candidate = `adj${nowSeconds}-${n}`;
    if (!list.some((a) => a.group === candidate)) return candidate;
  }
}

// "Different person, the name is right" for new names on an account (C++
// seats::confirmNames): every seat of theirs on that account, not yet checked, is
// saved as checked, so the question is not asked again.
export function confirmNames(world: World, account: string, people: readonly string[]): SeatOwner[] {
  const out = [...world.seatOwners];
  for (const g of world.games) {
    for (const r of g.rows) {
      if (r.playerId !== account || r.ownerReviewed || r.owner !== "") continue;
      const person = seats.nicknamePerson(world.rules, r);
      if (!people.includes(person)) continue;
      out.push({ ledgerId: g.id, playerId: r.playerId, start: r.start, nickname: r.nickname, owner: person, note: seats.NAME_RIGHT_NOTE });
    }
  }
  return out;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
