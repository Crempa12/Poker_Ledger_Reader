// The hand-log side of the app, as one entry point. A caller passes the ledger World
// (from loadWorld) and the raw texts of every hand-log file, and gets what the C++ app's
// menus 12, 18, 21 and 22 compute for a scope, and what the player history adds
// ("At the table", "Beaten at showdown by"). Nothing here reads a file or the clock.
//
// The order is the C++ app's (main.cpp refresh and the menus):
//   loadHandWorld = loadAllLogs (every log, orphans included), then pairWithLedger for
//                   every game that has a log (refresh runs it on all games, not only the
//                   scope);
//   handViewOf    = the scoped games, the ledger stats for the scope (adjustments in scope
//                   included), the logs of the scoped games in game order, and every
//                   export a menu writes. An export that the app would not write is null.
//
// Money: the exports print the same doubles the C++ prints; the core types keep their
// cents twins for everything else.

import { filterGames } from "./ledger.ts";
import { filter as filterAdjustments } from "./adjustments.ts";
import { aggregate, playerSummaryCSV, sortedByNet } from "./players.ts";
import type { Game, PlayerStats, PlayTime, Scope } from "./models.ts";
import { computeStyle, loadAllLogs, logIdOf, pairWithLedger, styleStatsCSV } from "./handlog.ts";
import type { HandLog, HandLogInput, StyleStats } from "./handlog.ts";
import * as hitrun from "./hitrun.ts";
import type { Night, Summary } from "./hitrun.ts";
import * as playstyle from "./playstyle.ts";
import type { Profile } from "./playstyle.ts";
import * as playtime from "./playtime.ts";
import * as showdowns from "./showdowns.ts";
import type { ShowdownRecord, ShowdownSummary } from "./showdowns.ts";
import type { World } from "./world.ts";

// Every hand log of a data root, loaded and paired with its ledger game.
export interface HandWorld {
  world: World;
  logs: Map<string, HandLog>; // by game id (the C++ app.logs): every log that loaded, orphans included
  messages: string[]; // the loader's messages: skipped files and duplicates, as the app prints them
}

// The hand-log results for one scope.
export interface HitRunView {
  nights: Night[]; // every person's night in scope (hit & run, hand-logged games only)
  unmeasured: number; // nights the rules could not measure
  summaries: Summary[]; // one per person, from the nights
}

// The exports one scope produces. A null is an export the app does not write for this scope
// (menu 18 and 21 write only when logs are in scope; menu 22 only when a person has nights).
export interface HandExports {
  playerSummary: string; // menu 12, Saved_Data/player_summary.csv (ledger columns and time columns)
  showdownRivals: string; // menu 12, Saved_Data/showdown_rivals.csv
  styleStats: string | null; // menu 18, Saved_Data/style_stats.csv
  playstyle: string | null; // menu 21, Saved_Data/playstyle.csv
  hitAndRun: string | null; // menu 22, Saved_Data/hit_and_run.csv
  hitAndRunNights: string | null; // menu 22, Saved_Data/hit_and_run_nights.csv
}

// Everything the hand-log menus show for one scope, and their exports.
export interface HandView {
  scope: Scope;
  scoped: Game[]; // the games in scope, in the world's order
  stats: Map<string, PlayerStats>; // the ledger stats for the scope, adjustments in scope included
  logs: HandLog[]; // the hand logs of the scoped games, in game order (logsInScope)
  playtime: Map<string, PlayTime>; // time at the table, by normalized name
  showdownRivals: Map<string, ShowdownRecord>; // who beat whom at showdown, by normalized name
  style: StyleStats[]; // menu 18 rows, hit & run already annotated
  profiles: Profile[]; // menu 21 rows, in the app's order
  hitRun: HitRunView; // menu 22
  exports: HandExports;
}

// Loads every hand log from the raw files, paired with the ledger game of the same id.
// Takes the World, so the pairing uses the merge rules and seat owners the World holds.
export function loadHandWorld(world: World, files: readonly HandLogInput[]): HandWorld {
  const loaded = loadAllLogs(files);
  for (const game of world.games) {
    const log = loaded.logs.get(logIdOf(game));
    if (log !== undefined) pairWithLedger(log, game, world.rules);
  }
  return { world, logs: loaded.logs, messages: loaded.messages };
}

// The hand-log results for one scope.
export function handViewOf(hw: HandWorld, scope: Scope): HandView {
  const { world } = hw;
  const scoped = filterGames(world.games, scope);
  // The app's stats for the scope: the scoped games, adjustments in the scope included.
  const stats = aggregate(scoped, world.rules, filterAdjustments(world.adjustments, scope));
  const logs: HandLog[] = [];
  for (const game of scoped) {
    const log = hw.logs.get(logIdOf(game));
    if (log !== undefined) logs.push(log);
  }

  const time = playtime.collect(scoped, hw.logs, world.rules);
  const rivals = showdowns.compute(logs, world.rules, stats);
  const style = computeStyle(logs, world.rules, stats);
  const hitRunNights = hitrun.collect(scoped, hw.logs, world.rules, stats);
  const summaries = hitrun.summarize(hitRunNights.nights);
  const profiles = playstyle.analyze(logs, world.rules, stats);

  const annotatedStyle = hitrun.annotateStyle(style, summaries);
  const facts = hitrun.hitRunFacts(summaries);
  const hasNights = summaries.length > 0;
  return {
    scope,
    scoped,
    stats,
    logs,
    playtime: time,
    showdownRivals: rivals,
    style: annotatedStyle,
    profiles,
    hitRun: { nights: hitRunNights.nights, unmeasured: hitRunNights.unmeasured, summaries },
    exports: {
      playerSummary: playerSummaryCSV(sortedByNet(stats), time),
      showdownRivals: showdowns.showdownRivalsCSV(rivals),
      styleStats: logs.length > 0 ? styleStatsCSV(annotatedStyle) : null,
      playstyle: logs.length > 0 ? playstyle.playstyleCSV(profiles, facts) : null,
      hitAndRun: hasNights ? hitrun.hitRunCSV(summaries) : null,
      hitAndRunNights: hasNights ? hitrun.hitRunNightsCSV(hitRunNights.nights, world.timeZone) : null,
    },
  };
}

// The "At the table" block of a player's history: their time, or undefined when they have
// no seat time in the scope.
export function atTheTable(view: HandView, normalizedName: string): PlayTime | undefined {
  return view.playtime.get(normalizedName);
}

// The "Beaten at showdown by" block of a player's history: the summary the app prints, with
// how many hand logs and games the scope has.
export function beatenAtShowdown(view: HandView, normalizedName: string): ShowdownSummary {
  return showdowns.showdownSummary(view.showdownRivals.get(normalizedName), view.logs.length, view.scoped.length);
}
