// Changing the console app's Saved_Data from the page: the page works out the new
// file with @plr/core, exactly as the console menu would, and the local server writes
// it (only over the version this page was showing, and never while the console app is
// open, because it writes its own copy when it quits).
import { formatLocalDate, seats, type Game, type Scope, type SeatOwner, type World } from "@plr/core";

import type { Ctx } from "./context.ts";
import { postJSON } from "./data.ts";

export type SavedFile =
  | "merge_rules.csv"
  | "session_balances.csv"
  | "payment_preferences.csv"
  | "settings.csv"
  | "seat_owners.csv"
  | "adjustments.csv";

export async function writeSaved(ctx: Ctx, file: SavedFile, text: string): Promise<void> {
  await postJSON<{ saved: string }>("/api/saved-file", { file, before: ctx.payload.saved[file] ?? "", text });
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
// not one, or not above zero.
export function typedCents(text: string): number | null {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "");
  const m = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(t) ?? /^()\.(\d{1,2})$/.exec(t);
  if (m === null) return null;
  const cents = Number(m[1] === "" ? "0" : m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return cents > 0 ? cents : null;
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
