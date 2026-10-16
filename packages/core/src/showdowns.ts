// Who beats whom at showdown (port of src/showdowns.hpp/.cpp, without the printing; the C++
// spec is docs/specs/playtime-showdown.md section 5).
//
// In every hand that reached showdown, the people still in it split into winners (PokerNow
// named their hand when they collected) and losers (everyone else still in, whether they
// tabled their cards or mucked). Each loser was beaten by each winner once, and lost to them
// their loss in the hand, split between the winners by what each collected. A chop has no
// loser between the chopping players.
//
// Known limit (as in the C++): a player who wins a side pot but loses the main pot is a winner,
// so they are not counted as beaten by the main-pot winner.
//
// Pure: nothing here reads a file. Accounts are resolved to people hand by hand (personAt).

import type { HandLog } from "./handlog.ts";
import { atShowdown, displayNameAt, personAt } from "./handlog.ts";
import type { PlayerStats } from "./models.ts";
import type { MergeRules } from "./players.ts";
import { libcppSort } from "./libcpp-sort.ts";
import { EPSILON_DOLLARS, compareBytes, escapeCSV, fixed2, fusedMulAdd } from "./util.ts";

// The rivals shown on a player's page: the five people who beat them most.
export const TOP_RIVALS = 5;

// One winner who beat a loser: the showdowns they won that the loser lost, and what the loser
// lost to them in those hands.
export interface Rival {
  person: string; // canonical name (normalized)
  displayName: string;
  times: number; // showdowns they won that this player lost
  amount: number; // dollars this player lost to them in those hands (C++ double)
}

// One person's showdowns across the logs given.
export interface ShowdownRecord {
  person: string; // canonical name (normalized)
  displayName: string;
  showdowns: number; // hands they reached showdown in (bomb pots included)
  won: number; // ... and collected at
  lost: number; // ... and collected nothing at
  lostAmount: number; // dollars lost in the hands they lost at showdown (C++ double)
  beatenBy: Rival[]; // most times first, then most money (by more than a cent), then name
}

// The keys of a map or the members of a set, in UTF-8 byte order (the C++ std::map/set order).
function byteOrder(keys: Iterable<string>): string[] {
  return [...keys].sort(compareBytes);
}

// Most times first, then most money (more than a cent apart), then display name.
function rivalBefore(a: Rival, b: Rival): boolean {
  if (a.times !== b.times) return a.times > b.times;
  if (Math.abs(a.amount - b.amount) > EPSILON_DOLLARS) return a.amount > b.amount;
  return compareBytes(a.displayName, b.displayName) < 0;
}

// Every person who reached a showdown in the logs given, keyed by normalized name in byte order.
// `logs` should be the logs of the games in scope, in the order of those games (the C++ order);
// the order is visible in the sums' last digit and in which display name a person is given.
// `ledgerStats` (keyed by normalized name, from players.aggregate for the same scope) supplies
// each person's leaderboard display name.
export function compute(
  logs: readonly HandLog[],
  rules: MergeRules,
  ledgerStats: ReadonlyMap<string, PlayerStats>,
): Map<string, ShowdownRecord> {
  const records = new Map<string, ShowdownRecord>();
  const beaten = new Map<string, Map<string, Rival>>(); // loser -> winner -> tally
  const displayOf = new Map<string, string>(); // person -> name to show

  for (const log of logs) {
    for (const hand of log.hands) {
      if (!hand.showdown) continue;
      // Accounts are resolved to people hand by hand: a shared account can change hands mid-night.
      const keyOf = new Map<string, string>();
      const person = (pid: string): string => {
        let k = keyOf.get(pid);
        if (k === undefined) {
          k = personAt(log, pid, hand.start, rules);
          if (k === "") k = "@" + pid; // a nickname with no letters or digits, as in the style table
          if (!displayOf.has(k)) displayOf.set(k, displayNameAt(log, pid, hand.start, rules, ledgerStats));
          keyOf.set(pid, k);
        }
        return k;
      };

      // The same walk order as the C++ (shows, then the winners, then the nets, then the pots), so
      // the first name a person is given comes from the same account.
      const inHand = new Set<string>();
      for (const pid of atShowdown(hand)) inHand.add(person(pid));
      const winners = new Set<string>();
      for (const pid of byteOrder(hand.rank.keys())) winners.add(person(pid));

      // Each person's result in the hand, without the 7-2 bounty, and what each winner took.
      const result = new Map<string, number>();
      for (const pid of byteOrder(hand.net.keys())) {
        const k = person(pid);
        const net = hand.net.get(pid) ?? 0;
        const bounty = hand.bounty.get(pid);
        result.set(k, (result.get(k) ?? 0) + (net - (bounty ?? 0)));
      }
      const collected = new Map<string, number>();
      for (const pid of byteOrder(hand.collected.keys())) {
        const k = person(pid);
        collected.set(k, (collected.get(k) ?? 0) + (hand.collected.get(pid) ?? 0));
      }
      const winnerList = byteOrder(winners);
      let taken = 0;
      for (const w of winnerList) taken += collected.get(w) ?? 0;

      for (const k of byteOrder(inHand)) {
        let r = records.get(k);
        if (r === undefined) {
          r = { person: k, displayName: "", showdowns: 0, won: 0, lost: 0, lostAmount: 0, beatenBy: [] };
          records.set(k, r);
        }
        r.showdowns += 1;
        if (winners.has(k)) {
          r.won += 1;
          continue;
        }
        r.lost += 1;
        const loss = Math.max(0, -(result.get(k) ?? 0));
        r.lostAmount += loss;
        for (const w of winnerList) {
          // A pot nobody collected (a showdown with no named winner) is split evenly.
          const share = taken > EPSILON_DOLLARS ? (collected.get(w) ?? 0) / taken : 1 / winnerList.length;
          let row = beaten.get(k);
          if (row === undefined) {
            row = new Map<string, Rival>();
            beaten.set(k, row);
          }
          let v = row.get(w);
          if (v === undefined) {
            v = { person: w, displayName: "", times: 0, amount: 0 };
            row.set(w, v);
          }
          v.times += 1;
          // The C++ adds loss * share in one fused multiply-add on arm64 (clang -O2): the same rounding.
          v.amount = fusedMulAdd(loss, share, v.amount);
        }
      }
    }
  }

  const out = new Map<string, ShowdownRecord>();
  for (const k of byteOrder(records.keys())) {
    const r = records.get(k);
    if (r === undefined) continue;
    const ls = ledgerStats.get(k);
    r.displayName = ls !== undefined ? ls.displayName : (displayOf.get(k) ?? "");
    const list: Rival[] = [];
    const row = beaten.get(k);
    if (row !== undefined) {
      for (const w of byteOrder(row.keys())) {
        const v = row.get(w);
        if (v === undefined) continue;
        const wl = ledgerStats.get(w);
        v.displayName = wl !== undefined ? wl.displayName : (displayOf.get(w) ?? "");
        list.push(v);
      }
    }
    libcppSort(list, 0, list.length, rivalBefore);
    r.beatenBy = list;
    out.set(k, r);
  }
  return out;
}

export const SHOWDOWN_RIVALS_HEADER = "loser,loser_normalized,winner,winner_normalized,times,amount\n";

// The text of showdown_rivals.csv: one row per (loser, winner) pair, the losers in normalized-name
// byte order, then the most times first, then the winner's normalized name. `amount` is two decimals.
export function showdownRivalsCSV(records: ReadonlyMap<string, ShowdownRecord>): string {
  let out = SHOWDOWN_RIVALS_HEADER;
  for (const k of byteOrder(records.keys())) {
    const r = records.get(k);
    if (r === undefined) continue;
    const rows = [...r.beatenBy].sort((a, b) => (a.times !== b.times ? b.times - a.times : compareBytes(a.person, b.person)));
    for (const v of rows) {
      out +=
        [
          escapeCSV(r.displayName),
          escapeCSV(k),
          escapeCSV(v.displayName),
          escapeCSV(v.person),
          String(v.times),
          fixed2(v.amount),
        ].join(",") + "\n";
    }
  }
  return out;
}

// What a player's page says about showdowns: the counts, the rivals, and how many more there are.
export interface ShowdownSummary {
  coverText: string; // "2 of 3 games in scope have a hand log" (the C++ wording)
  noLogs: boolean; // none of the games in scope has a hand log, so there is nothing to read
  reached: boolean; // at least one showdown in the logs in scope
  showdowns: number;
  won: number;
  lost: number;
  wonPercent: number; // won / showdowns, rounded half up (0 when there are none)
  lostAmount: number; // dollars lost in the hands lost at showdown
  beatenBy: Rival[]; // the first TOP_RIVALS
  moreRivals: number; // rivals beyond those shown
}

// The summary for one person. `record` may be undefined (no showdown). `logged` / `nights` are the
// games in scope with a hand log / all games in scope.
export function showdownSummary(record: ShowdownRecord | undefined, logged: number, nights: number): ShowdownSummary {
  const gamesWord = nights === 1 ? "game" : "games";
  const coverText =
    logged === 0
      ? `none of the ${nights} ${gamesWord} in scope ${nights === 1 ? "has" : "have"} a hand log`
      : `${logged} of ${nights} ${gamesWord} in scope ${logged === 1 ? "has" : "have"} a hand log`;
  const base = {
    coverText,
    noLogs: logged === 0,
    showdowns: record?.showdowns ?? 0,
    won: record?.won ?? 0,
    lost: record?.lost ?? 0,
    lostAmount: record?.lostAmount ?? 0,
  };
  if (record === undefined || record.showdowns === 0) {
    return { ...base, reached: false, wonPercent: 0, beatenBy: [], moreRivals: 0 };
  }
  const shown = record.beatenBy.slice(0, TOP_RIVALS);
  return {
    ...base,
    reached: true,
    wonPercent: Math.floor((100 * record.won) / record.showdowns + 0.5),
    beatenBy: shown,
    moreRivals: record.beatenBy.length - shown.length,
  };
}
