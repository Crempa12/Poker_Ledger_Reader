// Turning games into per-player statistics, and the name-merge rules (port of
// src/players.hpp/.cpp, without the printing).
//
// Pure: nothing here reads files. Every function returns new data and leaves its
// inputs alone. Money is integer cents, except the export: the C++ kept double
// dollars and wrote them out, so playerDollars replays those double sums in the
// same order. That is what makes a "-0.00" or an average's last cent match.

import type { Adjustment, Epoch, Game, GameResult, LedgerRow, PlayerStats, PlayTime } from "./models.ts";
import { averagePerGameDollars, playTimeHours, playTimeSeconds } from "./models.ts";
import { compareBytes, escapeCSV, fixed2, normalizeName, parseCSV, sumCentsAsDollars } from "./util.ts";

// alias (normalized) -> canonical (normalized). Read it as a snapshot: every
// change returns a new map.
export type MergeRules = Map<string, string>;

export function resolveCanonical(rules: ReadonlyMap<string, string>, key: string): string {
  let current = key;
  for (let guard = 0; guard < 64; guard++) {
    // guard against accidental cycles
    const next = rules.get(current);
    if (next === undefined || next === current) return current;
    current = next;
  }
  return current;
}

// The name a row is filed under before merge rules: its reassigned owner, else its
// nickname. A nickname with neither letters nor digits (emoji only) still has money
// on it, so it is filed under its account ("unnamed" + the account's letters):
// two such players never share a row.
function rowName(row: LedgerRow): string {
  const name = row.owner === "" ? normalizeName(row.nickname) : row.owner;
  return name === "" ? normalizeName(`unnamed ${row.playerId}`) : name;
}

// Who a ledger row really belongs to: its reassigned owner if it has one, else its
// nickname, after merge rules.
export function personOf(rules: ReadonlyMap<string, string>, row: LedgerRow): string {
  return resolveCanonical(rules, rowName(row));
}

// Points every alias straight at its final canonical name.
export function flattenMergeRules(rules: ReadonlyMap<string, string>): MergeRules {
  const out: MergeRules = new Map(rules);
  for (const [alias, canonical] of out) out.set(alias, resolveCanonical(out, canonical));
  return out;
}

// The alias now counts as the canonical name. Anything that pointed at the alias
// points at the canonical from now on.
export function addMergeRule(rules: ReadonlyMap<string, string>, alias: string, canonical: string): MergeRules {
  const out: MergeRules = new Map(rules);
  if (alias === "" || canonical === "" || alias === canonical) return out;
  for (const [key, target] of out) {
    if (target === alias) out.set(key, canonical);
  }
  out.set(alias, canonical);
  // If the canonical was itself an alias, un-alias it (the user chose to keep it).
  out.delete(canonical);
  return flattenMergeRules(out);
}

// Undo: the alias counts as its own player again. Rules are kept flat, so nothing
// else moves.
export function removeMergeRule(rules: ReadonlyMap<string, string>, alias: string): MergeRules {
  const out: MergeRules = new Map(rules);
  out.delete(alias);
  return out;
}

// The rows of merge_rules.csv (header skipped). Blank or one-column rows are ignored.
export function parseMergeRulesCSV(text: string): MergeRules {
  const rules: MergeRules = new Map();
  for (const row of parseCSV(text)) {
    if (row.length < 2) continue;
    const alias = normalizeName(row[0] ?? "");
    const canonical = normalizeName(row[1] ?? "");
    if (alias !== "" && canonical !== "" && alias !== canonical) rules.set(alias, canonical);
  }
  return flattenMergeRules(rules);
}

// The text of merge_rules.csv: sorted by canonical name, then alias. An alias that
// is its own canonical is not written.
export function serializeMergeRulesCSV(rules: ReadonlyMap<string, string>): string {
  const pairs = [...flattenMergeRules(rules)].filter(([alias, canonical]) => alias !== canonical);
  pairs.sort(([aliasA, canonicalA], [aliasB, canonicalB]) =>
    canonicalA === canonicalB ? compareBytes(aliasA, aliasB) : compareBytes(canonicalA, canonicalB),
  );
  let out = "alias_normalized,canonical_normalized\n";
  for (const [alias, canonical] of pairs) out += `${escapeCSV(alias)},${escapeCSV(canonical)}\n`;
  return out;
}

// ---------------- aggregation ----------------

// What playerDollars replays: the row nets as the C++ app added them, and the
// adjustments in input order. Kept beside each PlayerStats that aggregate builds.
interface Replay {
  gameRowNetsCents: number[][]; // one list per game, rows in row order, games in input order
  adjustmentCents: number[];
}

const replays = new WeakMap<PlayerStats, Replay>();

function replayOf(p: PlayerStats): Replay {
  const known = replays.get(p);
  if (known !== undefined) return known;
  // A copy of a PlayerStats has no row-level record, so use its per-game totals.
  // These can differ from the C++ doubles in the last binary digit.
  return {
    gameRowNetsCents: p.history.filter((r) => !r.adjustment).map((r) => [r.netCents]),
    adjustmentCents: p.history.filter((r) => r.adjustment).map((r) => r.netCents),
  };
}

// Bytes a string takes in UTF-8, as the C++ string size. A lone surrogate counts
// as U+FFFD, which is 3 bytes.
function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0xfffd;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

// Sort key for an epoch: "no time" sorts first, as NO_TIME (-1) did in C++.
function epochKey(e: Epoch): number {
  return e ?? -1;
}

interface Accumulator {
  canonical: string;
  aliases: Set<string>;
  playerIds: Set<string>;
  nicknameCounts: Map<string, number>; // raw nickname -> seats, only for seats not reassigned
  games: number;
  buyIns: number;
  netCents: number;
  wonCents: number;
  lostCents: number;
  biggestWinCents: number;
  biggestLossCents: number;
  adjustmentsCents: number;
  history: GameResult[];
  gameRowNets: number[][];
  adjustmentCents: number[];
}

function newAccumulator(canonical: string): Accumulator {
  return {
    canonical,
    aliases: new Set(),
    playerIds: new Set(),
    nicknameCounts: new Map(),
    games: 0,
    buyIns: 0,
    netCents: 0,
    wonCents: 0,
    lostCents: 0,
    biggestWinCents: 0,
    biggestLossCents: 0,
    adjustmentsCents: 0,
    history: [],
    gameRowNets: [],
    adjustmentCents: [],
  };
}

// The nickname used most often; ties go to the shorter one, then to the earlier
// name in byte order. With only reassigned seats or adjustments there is no
// nickname to show, so the normalized name is used, capitalized.
function displayNameFor(acc: Accumulator): string {
  let best = "";
  let bestCount = -1;
  for (const nickname of [...acc.nicknameCounts.keys()].sort(compareBytes)) {
    const count = acc.nicknameCounts.get(nickname) ?? 0;
    if (count > bestCount || (count === bestCount && utf8Length(nickname) < utf8Length(best))) {
      best = nickname;
      bestCount = count;
    }
  }
  if (best === "") {
    best = acc.canonical;
    const first = best.charCodeAt(0);
    if (first >= 97 && first <= 122) best = String.fromCharCode(first - 32) + best.slice(1);
  }
  return best;
}

// Builds player stats from the given games (plus manual adjustments), folding
// aliases with the merge rules. The map is in byte order of the normalized name.
export function aggregate(
  games: readonly Game[],
  rules: ReadonlyMap<string, string>,
  adjustments: readonly Adjustment[] = [],
): Map<string, PlayerStats> {
  const people = new Map<string, Accumulator>();
  const personFor = (canonical: string): Accumulator => {
    let acc = people.get(canonical);
    if (acc === undefined) {
      acc = newAccumulator(canonical);
      people.set(canonical, acc);
    }
    return acc;
  };

  for (const game of games) {
    const perGame = new Map<string, { result: GameResult; rowNets: number[] }>();

    for (const row of game.rows) {
      const canonical = personOf(rules, row);
      const acc = personFor(canonical);
      acc.aliases.add(rowName(row));
      // A reassigned seat was played under someone else's name or account, so
      // neither that nickname nor that account says anything about this player.
      if (row.owner === "") {
        if (row.playerId !== "") acc.playerIds.add(row.playerId);
        acc.nicknameCounts.set(row.nickname, (acc.nicknameCounts.get(row.nickname) ?? 0) + 1);
      }
      acc.buyIns++;
      acc.netCents += row.netCents;

      let entry = perGame.get(canonical);
      if (entry === undefined) {
        entry = {
          result: {
            gameId: game.id,
            folder: game.folder,
            date: game.start,
            netCents: 0,
            buyIns: 0,
            adjustment: false,
            note: "",
          },
          rowNets: [],
        };
        perGame.set(canonical, entry);
      }
      entry.result.netCents += row.netCents;
      entry.result.buyIns++;
      entry.rowNets.push(row.netCents);
    }

    for (const [canonical, entry] of perGame) {
      const acc = personFor(canonical);
      const net = entry.result.netCents;
      acc.games++;
      if (net > 0) acc.wonCents += net;
      else if (net < 0) acc.lostCents += net;
      if (acc.games === 1) {
        acc.biggestWinCents = net;
        acc.biggestLossCents = net;
      } else {
        acc.biggestWinCents = Math.max(acc.biggestWinCents, net);
        acc.biggestLossCents = Math.min(acc.biggestLossCents, net);
      }
      acc.history.push(entry.result);
      acc.gameRowNets.push(entry.rowNets);
    }
  }

  for (const a of adjustments) {
    const canonical = resolveCanonical(rules, a.playerNormalized);
    const acc = personFor(canonical);
    acc.aliases.add(a.playerNormalized);
    // Counts on settlement sheets, not in the poker result.
    acc.adjustmentsCents += a.amountCents;
    acc.adjustmentCents.push(a.amountCents);
    acc.history.push({
      gameId: "adjustment",
      folder: a.folder === "" ? "(all folders)" : a.folder,
      date: a.date,
      netCents: a.amountCents,
      buyIns: 0,
      adjustment: true,
      note: a.note,
    });
  }

  const out = new Map<string, PlayerStats>();
  const accs = [...people.values()].sort((a, b) => compareBytes(a.canonical, b.canonical));
  for (const acc of accs) {
    // C++ std::sort: by date, then game id. Two adjustments on one date tie; the C++
    // order for those is not defined, so they keep their input order here.
    acc.history.sort((a, b) => {
      const da = epochKey(a.date);
      const db = epochKey(b.date);
      if (da !== db) return da < db ? -1 : 1;
      return compareBytes(a.gameId, b.gameId);
    });
    const stats: PlayerStats = {
      displayName: displayNameFor(acc),
      normalizedName: acc.canonical,
      totalNetCents: acc.netCents,
      totalWonCents: acc.wonCents,
      totalLostCents: acc.lostCents,
      biggestWinCents: acc.biggestWinCents,
      biggestLossCents: acc.biggestLossCents,
      adjustmentsCents: acc.adjustmentsCents,
      games: acc.games,
      buyIns: acc.buyIns,
      history: acc.history,
      aliases: [...acc.aliases].sort(compareBytes),
      playerIds: [...acc.playerIds].sort(compareBytes),
    };
    replays.set(stats, { gameRowNetsCents: acc.gameRowNets, adjustmentCents: acc.adjustmentCents });
    out.set(acc.canonical, stats);
  }
  return out;
}

// The dollar values the C++ app holds as doubles, replayed in its order of adds.
export interface PlayerDollars {
  totalNet: number;
  totalWon: number;
  totalLost: number;
  biggestWin: number;
  biggestLoss: number;
  adjustments: number;
  averagePerGame: number;
}

export function playerDollars(p: PlayerStats): PlayerDollars {
  const replay = replayOf(p);
  const rowsInOrder = replay.gameRowNetsCents.flat();
  let totalWon = 0;
  let totalLost = 0;
  let biggestWin = 0;
  let biggestLoss = 0;
  replay.gameRowNetsCents.forEach((rows, i) => {
    const dollars = sumCentsAsDollars(rows);
    const cents = rows.reduce((sum, c) => sum + c, 0);
    // The C++ threshold is EPSILON (under a cent), so the sign of the cents decides it.
    if (cents > 0) totalWon += dollars;
    else if (cents < 0) totalLost += dollars;
    if (i === 0) {
      biggestWin = dollars;
      biggestLoss = dollars;
    } else {
      // std::max and std::min on the doubles, first argument on a tie.
      biggestWin = biggestWin < dollars ? dollars : biggestWin;
      biggestLoss = dollars < biggestLoss ? dollars : biggestLoss;
    }
  });
  return {
    totalNet: sumCentsAsDollars(rowsInOrder),
    totalWon,
    totalLost,
    biggestWin,
    biggestLoss,
    adjustments: sumCentsAsDollars(replay.adjustmentCents),
    averagePerGame: averagePerGameDollars(rowsInOrder, p.games),
  };
}

// The balance a settlement sheet uses, in dollars: the poker result plus payments and
// corrections, added as the C++ balance() adds them (two double sums, then one add).
// From aggregate() this replays the row nets, so an exact tie between two balances
// comes out as in the C++. A copy with no replay record uses its whole-cent balance.
export function balanceDollars(p: PlayerStats): number {
  if (!replays.has(p)) return p.totalNetCents / 100 + p.adjustmentsCents / 100;
  const dollars = playerDollars(p);
  return dollars.totalNet + dollars.adjustments;
}

// Highest poker result first; equal results by normalized name in byte order. The
// results are compared as the C++ doubles are.
export function sortedByNet(stats: ReadonlyMap<string, PlayerStats>): PlayerStats[] {
  const keyed = [...stats.values()].map((p) => ({ p, net: playerDollars(p).totalNet }));
  keyed.sort((a, b) => {
    if (a.net !== b.net) return a.net > b.net ? -1 : 1;
    return compareBytes(a.p.normalizedName, b.p.normalizedName);
  });
  return keyed.map((k) => k.p);
}

// The map's order: byte order of the normalized name.
export function sortedByName(stats: ReadonlyMap<string, PlayerStats>): PlayerStats[] {
  return [...stats.values()].sort((a, b) => compareBytes(a.normalizedName, b.normalizedName));
}

export function find(stats: ReadonlyMap<string, PlayerStats>, normalized: string): PlayerStats | undefined {
  return stats.get(normalized);
}

// The name to show for a normalized name (or any of its aliases): the player's
// display name, else the name itself, or "(none)" when empty.
export function displayName(list: readonly PlayerStats[], normalized: string): string {
  if (normalized === "") return "(none)";
  for (const p of list) {
    if (p.normalizedName === normalized || p.aliases.includes(normalized)) return p.displayName;
  }
  return normalized;
}

// Every PokerNow account (player_id) each person has played on. Reassigned seats
// are left out: they were played on someone else's account and say nothing about
// the person.
export function accountsByPerson(games: readonly Game[], rules: ReadonlyMap<string, string>): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const g of games) {
    for (const row of g.rows) {
      if (row.playerId === "" || row.owner !== "") continue;
      const person = personOf(rules, row);
      let accounts = out.get(person);
      if (accounts === undefined) {
        accounts = new Set();
        out.set(person, accounts);
      }
      accounts.add(row.playerId);
    }
  }
  const sorted = new Map<string, string[]>();
  for (const person of [...out.keys()].sort(compareBytes)) {
    sorted.set(person, [...(out.get(person) ?? [])].sort(compareBytes));
  }
  return sorted;
}

// An account played under a name that has never been seen on any other account,
// next to other names: probably a new nickname, worth one question. Accounts shared
// by people who each have their own accounts too are a borrowed phone, not a new
// name. Seats confirmed as "the name is right" count as answered.
export interface MergeSuggestion {
  playerId: string;
  canonicals: string[]; // every person on the account, normalized, sorted
  newNames: string[]; // the ones never seen on any other account, not yet confirmed
}

export function suggestMergesByPlayerId(games: readonly Game[], rules: ReadonlyMap<string, string>): MergeSuggestion[] {
  const accounts = accountsByPerson(games, rules);
  const people = new Map<string, Set<string>>(); // account -> everyone seen on it
  const unchecked = new Set<string>(); // "account|person" with a seat nobody has confirmed
  for (const g of games) {
    for (const row of g.rows) {
      if (row.playerId === "" || row.owner !== "") continue;
      const person = personOf(rules, row);
      let seen = people.get(row.playerId);
      if (seen === undefined) {
        seen = new Set();
        people.set(row.playerId, seen);
      }
      seen.add(person);
      if (!row.ownerReviewed) unchecked.add(`${row.playerId}|${person}`);
    }
  }
  const out: MergeSuggestion[] = [];
  for (const account of [...people.keys()].sort(compareBytes)) {
    const names = [...(people.get(account) ?? [])].sort(compareBytes);
    if (names.length < 2) continue;
    const newNames = names.filter(
      (n) => (accounts.get(n)?.length ?? 0) === 1 && unchecked.has(`${account}|${n}`),
    );
    if (newNames.length > 0) out.push({ playerId: account, canonicals: names, newNames });
  }
  return out;
}

// ---------------- export ----------------

export const PLAYER_SUMMARY_HEADER =
  "rank,display_name,normalized_name,games,buy_ins,total_won,total_lost,adjustments,total_net,avg_per_game," +
  "biggest_win,biggest_loss,aliases,hands_dealt,nights_logged,seconds_dealt,seconds_estimated,hours,per_hour\n";

const NO_PLAY_TIME: PlayTime = { nights: 0, nightsLogged: 0, hands: 0, secondsDealt: 0, secondsEstimated: 0 };

// The text of the player summary CSV. `time` (keyed by normalized name) fills the
// time columns; a player missing from it gets zeros.
export function playerSummaryCSV(list: readonly PlayerStats[], time: ReadonlyMap<string, PlayTime> = new Map()): string {
  let out = PLAYER_SUMMARY_HEADER;
  list.forEach((p, i) => {
    const dollars = playerDollars(p);
    let aliases = "";
    for (const a of p.aliases) aliases += (aliases === "" ? "" : " | ") + a;
    const t = time.get(p.normalizedName) ?? NO_PLAY_TIME;
    // Same "no time" line as the console's leaderboard: under a second has no rate.
    const perHour = playTimeSeconds(t) >= 1.0 ? fixed2(dollars.totalNet / playTimeHours(t)) : "";
    out +=
      [
        i + 1,
        escapeCSV(p.displayName),
        escapeCSV(p.normalizedName),
        p.games,
        p.buyIns,
        fixed2(dollars.totalWon),
        fixed2(dollars.totalLost),
        fixed2(dollars.adjustments),
        fixed2(dollars.totalNet),
        fixed2(dollars.averagePerGame),
        fixed2(dollars.biggestWin),
        fixed2(dollars.biggestLoss),
        escapeCSV(aliases),
        t.hands,
        t.nightsLogged,
        fixed2(t.secondsDealt),
        fixed2(t.secondsEstimated),
        fixed2(playTimeHours(t)),
        perHour,
      ].join(",") + "\n";
  });
  return out;
}
