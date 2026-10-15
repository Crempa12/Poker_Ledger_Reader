// The one entry point for a caller (the website, the parity check): the raw texts go
// in, and everything the app computes comes out. The caller does not need to know
// the order of operations (dedupe, merge rules, seat owners, preferences, scope,
// board, sheet), because it is all here, in the order main.cpp uses.
//
// Facts this relies on, as the app does them:
//   loadWorld  = main.cpp loadData and refresh, once per data root and time zone;
//   boardFor   = the leaderboard for some games, with the adjustments in a scope;
//   sheetFor   = the settlement sheet for some games (menu 5), with the saved
//                payment preferences and the banker from the settings;
//   viewOf     = the screen for one scope: its games, board, sheet, what is owed,
//                merge suggestions and seats to check.
//
// Pure: no file is read here. tools/load.ts reads a data root from disk and passes the
// texts in. Every value the core holds is integer cents or whole epoch seconds.

import type {
  Adjustment,
  DataWarning,
  Game,
  PaymentPreference,
  PlayerStats,
  Scope,
  SeatOwner,
  Settings,
  WarnFn,
} from "./models.ts";
import { filterGames, loadAllGames } from "./ledger.ts";
import type { DuplicateNote, LedgerInput } from "./ledger.ts";
import { apply, findSuspicious, parseSeatOwnersCSV } from "./seats.ts";
import type { Flag } from "./seats.ts";
import { filter as filterAdjustments, parseAdjustments } from "./adjustments.ts";
import {
  aggregate,
  parseMergeRulesCSV,
  resolveCanonical,
  sortedByNet,
  suggestMergesByPlayerId,
} from "./players.ts";
import type { MergeRules, MergeSuggestion } from "./players.ts";
import { calculateSheet, parsePreferencesCSV, parseSettingsCSV } from "./settlement.ts";
import type { SheetResult } from "./settlement.ts";
import { combinedUnpaid, parseSessionBalances } from "./sessions.ts";
import type { Balances, CombinedDebt } from "./sessions.ts";
import { isValidTimeZone } from "./util.ts";

// What the caller has. Saved_Data texts are keyed by file name; a missing file is "".
export interface WorldInput {
  timeZone: string; // an IANA zone name, explicit (no default)
  ledgers: readonly LedgerInput[]; // every .csv under the game folder, paths relative to it
  saved: Readonly<Record<string, string>>; // Saved_Data CSV texts by file name
}

// What the app holds after startup.
export interface World {
  timeZone: string;
  games: Game[]; // de-duplicated and sorted, with the saved seat owners applied
  messages: string[]; // the loader's messages: skipped files, then unbalanced ledgers
  duplicates: DuplicateNote[]; // duplicate and overlapping ledgers found
  warnings: DataWarning[]; // malformed input, from every reader, as data
  rules: MergeRules; // alias -> canonical, flat
  seatOwners: SeatOwner[];
  prefs: PaymentPreference[]; // pinned payments, names through the merge rules
  adjustments: Adjustment[]; // every saved adjustment, unfiltered
  settings: Settings; // me and banker through the merge rules
  balances: Balances; // saved session balances
}

// Everything the screen shows for one scope.
export interface WorldView {
  scope: Scope;
  games: Game[]; // the games in scope, in the order the world holds them
  board: PlayerStats[]; // highest poker result first; adjustments in scope included
  sheet: SheetResult; // the settlement sheet for the scope, with the world's preferences and banker
  owed: CombinedDebt[]; // what each pair still owes across every saved sheet, biggest first
  mergeSuggestions: MergeSuggestion[]; // accounts with a name never seen before (every game)
  seatFlags: Flag[]; // seats that look bought by someone else (every game)
}

// Reads the raw inputs into a World. Throws a RangeError for a time zone the runtime
// does not know, at the boundary where it was given. Malformed rows never throw: they
// are reported in world.warnings.
export function loadWorld(input: WorldInput): World {
  if (!isValidTimeZone(input.timeZone)) throw new RangeError(`unknown time zone: ${input.timeZone}`);
  const warnings: DataWarning[] = [];
  const warn: WarnFn = (w) => {
    warnings.push(w);
  };
  const saved = (name: string): string => input.saved[name] ?? "";

  const loaded = loadAllGames(input.ledgers, warn);
  const rules = parseMergeRulesCSV(saved("merge_rules.csv"), warn);
  const seatOwners = parseSeatOwnersCSV(saved("seat_owners.csv"), warn);
  // The app applies the saved seat owners on every refresh.
  const games = apply(loaded.games, seatOwners, rules).games;
  const prefs = parsePreferencesCSV(saved("payment_preferences.csv"), warn).map((p) => ({
    ...p,
    payerNormalized: resolveCanonical(rules, p.payerNormalized),
    payeeNormalized: resolveCanonical(rules, p.payeeNormalized),
  }));
  const read = parseSettingsCSV(saved("settings.csv"), { me: "", banker: "", simpleDisplay: false });
  const settings: Settings = {
    ...read,
    me: resolveCanonical(rules, read.me),
    banker: resolveCanonical(rules, read.banker),
  };
  return {
    timeZone: input.timeZone,
    games,
    messages: loaded.messages,
    duplicates: loaded.duplicates,
    warnings,
    rules,
    seatOwners,
    prefs,
    adjustments: parseAdjustments(saved("adjustments.csv"), input.timeZone, warn),
    settings,
    balances: parseSessionBalances(saved("session_balances.csv"), warn),
  };
}

// The leaderboard for some games, with the adjustments that fall in adjustmentScope.
export function boardFor(world: World, games: readonly Game[], adjustmentScope: Scope): PlayerStats[] {
  return sortedByNet(aggregate(games, world.rules, filterAdjustments(world.adjustments, adjustmentScope)));
}

// The settlement sheet for some games. The banker defaults to the one in the settings;
// pass "" for no banker mode.
export function sheetFor(
  world: World,
  games: readonly Game[],
  adjustmentScope: Scope,
  banker: string = world.settings.banker,
): SheetResult {
  return calculateSheet(boardFor(world, games, adjustmentScope), world.prefs, banker);
}

// The screen for one scope: the games in it, their board and sheet, what is owed, and
// the merge suggestions and seat flags, which look at every game.
export function viewOf(world: World, scope: Scope): WorldView {
  const games = filterGames(world.games, scope);
  return {
    scope,
    games,
    board: boardFor(world, games, scope),
    sheet: sheetFor(world, games, scope),
    owed: combinedUnpaid(world.balances),
    mergeSuggestions: suggestMergesByPlayerId(world.games, world.rules),
    seatFlags: findSuspicious(world.games, world.rules),
  };
}
