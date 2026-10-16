// What the hand-log pages get for one scope: the console app's menus 18 (playing style),
// 21 (deep profiles) and 22 (hit & run), and the player history's "At the table" and
// "Beaten at showdown by". The hand logs are tens of megabytes, so the server works these
// out (GET /api/handlogs) and the page gets only the results; a snapshot carries them
// ready-made for the scopes it holds. Types only: no code, so the page and the server can
// both import it.
//
// Numbers are the core's numbers (dollars as the C++ doubles, where the C++ prints them).
// A page that shows a number the console prints formats it the way the console does, with
// the core's printf-exact helpers (util / hitrun fixedText), not toFixed.
import type { HandExports, PlayTime, handlog, hitrun, playstyle, showdowns } from "@plr/core";

// The scope the results are for, as the page's Scope (epoch seconds; null = open).
export interface HandScope {
  folder: string; // "" = every folder
  from: number | null;
  to: number | null;
}

// One hand-logged night, as menu 18 lists it under "Hand logs in scope" (handlog.cpp
// printGameSummaries), in the console's order.
export interface HandNight {
  gameId: string;
  start: number | null; // the log's start, epoch seconds; null when no entry has a time (formatLocalDate prints "unknown")
  folder: string;
  hands: number;
  hours: number; // (end - start) / 3600, 0 when either is unknown; the console prints 1 decimal
  players: number; // PokerNow accounts dealt in
  showdownPercent: number; // 100 * showdown hands / hands (0 with no hands); the console's pct1
  biggestPot: number; // dollars
  biggestPotWinner: string; // the person's display name at that hand (displayNameAt)
  biggestPotHand: number;
  stackMismatches: number; // hands whose stacks did not reconcile ("*N" in the console)
}

// A menu 21 profile; its one Map becomes pairs in the same (C++ std::map) order.
export type HandProfile = Omit<playstyle.Profile, "showdownHandClass"> & {
  showdownHandClass: [string, number][];
};

// One game in scope with no hand log, as menu 18 lists it under "Games without a log".
export interface UnloggedGame {
  id: string; // the game's id, as the console prints it (ledger_...)
  start: number | null; // the game's start, epoch seconds (formatLocalDate prints "unknown" for null)
  folder: string;
}

export interface HandScopePayload {
  basis: string; // the server's data basis these results were worked out from ("" in a snapshot)
  scope: HandScope;
  games: number; // games in scope
  logged: number; // ... of which have a hand log
  hands: number; // hands in those logs
  messages: string[]; // the loader's messages (files skipped, duplicate logs), as the console prints them
  style: handlog.StyleStats[]; // menu 18 rows, hit & run filled in, in the console's order
  nights: HandNight[]; // menu 18's nights
  unlogged?: UnloggedGame[]; // up to five games in scope with no hand log, newest first (absent in payloads from before this field)
  unloggedMore?: number; // games without a log beyond those five (the console's "...")
  profiles: HandProfile[]; // menu 21 rows, in the console's order
  pool: { poolVpip: number; poolPfr: number; counted: number }; // playstyle.poolAverages(profiles)
  hitRun: {
    summaries: hitrun.Summary[]; // menu 22, one per person, in the console's order
    nights: hitrun.Night[]; // every person's night in scope
    unmeasured: number; // nights the rules could not measure
  };
  playtime: Record<string, PlayTime>; // by normalized name: "At the table"
  showdowns: Record<string, showdowns.ShowdownSummary>; // by normalized name, every player in scope: "Beaten at showdown by"
  exports: HandExports; // the CSV texts the console menus write (null = it would not write that one)
}

// GET /api/handlogs?folder=<folder>&from=<epoch>&to=<epoch> (from/to omitted = open; each value
// percent-encoded, and a "+" reads as a space, as in a form, so a plus sign is sent as %2B;
// from/to are whole seconds from 1970 to 2100, from not after to):
//   200 HandScopePayload; 400 { error } for a bad query; 403 { error } as for /api/data;
//   503 { error } when the data kept changing while it was read (the page asks again).
// A snapshot (server/snapshot.ts) embeds, in its payload's "handlogs" field, one
// HandScopePayload for every folder together (key "") and one for each folder (key: the
// folder's name), all dates open.
export type SnapshotHandLogs = Record<string, HandScopePayload>;
