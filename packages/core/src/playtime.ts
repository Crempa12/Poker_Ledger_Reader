// Playtime: how long each person was actually at the table (port of src/playtime.hpp/.cpp,
// without the printing; the C++ spec is docs/specs/playtime-showdown.md section 4).
//
// The hand log is the measure. A ledger seat stays open while its player sits out, so a
// hand's length is the time until the next hand starts (capped), and a person's time is the
// length of every hand they were dealt. Where there is no log to measure (a night without
// one, or the start of a night whose log PokerNow cut short), the ledger's seat times stand
// in, and secondsEstimated says so.
//
// Pure: nothing here reads a file or the clock. Times are whole epoch seconds, or null for
// "no time". The result feeds playerSummaryCSV (players.ts), which takes the map this module
// returns keyed by normalized name.

import type { Epoch, Game, PlayTime } from "./models.ts";
import { playTimeHours, playTimeSeconds } from "./models.ts";
import { logIdOf, personAt } from "./handlog.ts";
import type { HandLog } from "./handlog.ts";
import { personOf } from "./players.ts";
import type { MergeRules } from "./players.ts";
import { compareBytes, itemAt } from "./util.ts";

// A gap between two hands longer than this is a break (a food break, a rebuy round), not a hand.
// The median gap in the September logs is 36 seconds; 10 of 14,260 gaps exceed this.
export const MAX_HAND_SECONDS = 600;
// A hand's length when the night gives nothing to go on: the median gap in that corpus.
export const DEFAULT_HAND_SECONDS = 36;

// One person's time on one night.
export interface Night {
  gameId: string;
  person: string; // canonical name (the key the leaderboard uses)
  logged: boolean; // the night has a hand log
  hands: number; // hands dealt to them in the log
  secondsDealt: number; // the length of those hands
  secondsEstimated: number; // ledger seat time the log cannot measure
}

// [from, to) in epoch seconds.
interface Span {
  from: number;
  to: number;
}

interface SeatTime {
  start: number;
  end: number | null; // null = still seated when the ledger was saved (ends with the game)
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? itemAt(v, m) : (itemAt(v, m - 1) + itemAt(v, m)) / 2;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// Total length of some windows, overlaps counted once: two seats at the same time (a second
// account, or a new seat bought before the old one closed) are one person at the table.
function unionLength(windows: readonly Span[]): number {
  const w = [...windows].sort((a, b) => a.from - b.from || a.to - b.to);
  let total = 0;
  let from = 0;
  let to = 0;
  let open = false;
  for (const s of w) {
    if (s.to <= s.from) continue;
    if (!open) {
      from = s.from;
      to = s.to;
      open = true;
    } else if (s.from > to) {
      total += to - from;
      from = s.from;
      to = s.to;
    } else {
      to = Math.max(to, s.to);
    }
  }
  return open ? total + (to - from) : total;
}

// The person a hand's account belongs to. An account with no letters or digits is "@" + its id.
function personKey(log: HandLog, pid: string, at: Epoch, rules: MergeRules): string {
  const k = personAt(log, pid, at, rules);
  return k === "" ? "@" + pid : k;
}

// Every value of a map, keyed by its key in UTF-8 byte order (the C++ std::map order).
function byKey<V>(m: ReadonlyMap<string, V>): [string, V][] {
  return [...m.entries()].sort((a, b) => compareBytes(a[0], b[0]));
}

// Printf-style "%.<dp>f" of a double, rounding the exact binary value and sending an exact tie
// to the even digit (what glibc and macOS printf do). Used for the one-decimal hours text.
function fixedDecimals(v: number, dp: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(v));
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & ((1n << 52n) - 1n);
  let exponent: number;
  if (biased === 0) {
    exponent = -1074;
  } else {
    mantissa |= 1n << 52n;
    exponent = biased - 1075;
  }
  const scaled = mantissa * 10n ** BigInt(dp); // |v| * 10^dp = scaled * 2^exponent exactly
  let whole: bigint;
  if (exponent >= 0) {
    whole = scaled << BigInt(exponent);
  } else {
    const shift = BigInt(-exponent);
    whole = scaled >> shift;
    const remainder = scaled - (whole << shift);
    const half = 1n << (shift - 1n);
    if (remainder > half || (remainder === half && (whole & 1n) === 1n)) whole += 1n;
  }
  const digits = whole.toString().padStart(dp + 1, "0");
  const sign = v < 0 || Object.is(v, -0) ? "-" : "";
  if (dp === 0) return sign + digits;
  return sign + digits.slice(0, digits.length - dp) + "." + digits.slice(digits.length - dp);
}

// Every person's time on every game given, in the order of the games; within a game, by
// normalized name in byte order. Games with a hand log are measured hand by hand; games
// without one fall back on the ledger's seat times. `logs` is keyed by logIdOf(game).
export function nights(
  games: readonly Game[],
  logs: ReadonlyMap<string, HandLog>,
  rules: MergeRules,
): Night[] {
  const out: Night[] = [];
  for (const g of games) {
    const byPerson = new Map<string, Night>();
    const night = (k: string): Night => {
      let n = byPerson.get(k);
      if (n === undefined) {
        n = { gameId: g.id, person: k, logged: false, hands: 0, secondsDealt: 0, secondsEstimated: 0 };
        byPerson.set(k, n);
      }
      return n;
    };

    // Everyone with a seat played the night; seats with a start time are windows of time.
    const seatsOf = new Map<string, SeatTime[]>();
    for (const row of g.rows) {
      const k = personOf(rules, row);
      night(k);
      if (row.start !== null) {
        const list = seatsOf.get(k) ?? [];
        list.push({ start: row.start, end: row.end });
        seatsOf.set(k, list);
      }
    }

    const log = logs.get(logIdOf(g));
    const logged = log !== undefined;
    if (log === undefined) {
      // No hand log: the ledger's seat times are all there is. A seat still open when the
      // ledger was saved ends with the game, at its last recorded time.
      for (const [k, seats] of seatsOf) {
        const w: Span[] = [];
        for (const s of seats) {
          const end = s.end ?? g.end;
          if (end !== null) w.push({ from: s.start, to: end });
        }
        night(k).secondsEstimated = unionLength(w);
      }
    } else {
      const hands = log.hands;
      const n = hands.length;
      // Each hand lasts until the next one starts. The last hand of the night has nothing after
      // it, so it gets the night's typical gap (the median of the gaps, capped).
      const gaps: number[] = [];
      for (let h = 0; h + 1 < n; h++) {
        const a = itemAt(hands, h).start;
        const b = itemAt(hands, h + 1).start;
        if (a !== null && b !== null) gaps.push(b - a);
      }
      const lastHand = gaps.length === 0 ? DEFAULT_HAND_SECONDS : clamp(median(gaps), 0, MAX_HAND_SECONDS);
      for (let h = 0; h < n; h++) {
        const hand = itemAt(hands, h);
        let length = lastHand;
        if (h + 1 < n) {
          const a = hand.start;
          const b = itemAt(hands, h + 1).start;
          length = a !== null && b !== null ? clamp(b - a, 0, MAX_HAND_SECONDS) : DEFAULT_HAND_SECONDS;
        }
        // Someone on two accounts was still dealt one hand.
        const people = new Set<string>();
        for (const s of hand.seats) people.add(personKey(log, s.playerId, hand.start, rules));
        for (const k of people) {
          const nt = night(k);
          nt.hands += 1;
          nt.secondsDealt += length;
        }
      }
      // PokerNow cuts the first hands off a long night's log. Time seated before the log begins
      // cannot be measured hand by hand, so the ledger's seat times stand in for it.
      const first = hands[0];
      if (first !== undefined && first.number > 1 && first.start !== null) {
        const logStart = first.start;
        for (const [k, seats] of seatsOf) {
          const w: Span[] = seats.map((s) => ({
            from: s.start,
            to: s.end === null ? logStart : Math.min(s.end, logStart),
          }));
          night(k).secondsEstimated = unionLength(w);
        }
      }
    }
    for (const [, nt] of byKey(byPerson)) {
      nt.logged = logged;
      out.push(nt);
    }
  }
  return out;
}

// The nights added up per person, keyed by normalized name in byte order.
export function summarize(list: readonly Night[]): Map<string, PlayTime> {
  const acc = new Map<string, PlayTime>();
  for (const n of list) {
    let t = acc.get(n.person);
    if (t === undefined) {
      t = { nights: 0, nightsLogged: 0, hands: 0, secondsDealt: 0, secondsEstimated: 0 };
      acc.set(n.person, t);
    }
    t.nights += 1;
    if (n.logged && n.hands > 0) t.nightsLogged += 1;
    t.hands += n.hands;
    t.secondsDealt += n.secondsDealt;
    t.secondsEstimated += n.secondsEstimated;
  }
  return new Map(byKey(acc));
}

// nights() then summarize(): the map the player summary CSV takes.
export function collect(
  games: readonly Game[],
  logs: ReadonlyMap<string, HandLog>,
  rules: MergeRules,
): Map<string, PlayTime> {
  return summarize(nights(games, logs, rules));
}

// True when any of the time is ledger seat time rather than a measured hand (the C++ "~" test).
export function isEstimated(t: PlayTime): boolean {
  return t.secondsEstimated >= 0.5;
}

// "12.4 h", or "~12.4 h" when any of it is an estimate. Same rounding as the C++ printf.
export function hoursText(t: PlayTime): string {
  return (isEstimated(t) ? "~" : "") + fixedDecimals(playTimeHours(t), 1) + " h";
}

// True when there is at least a second of seat time, so a per-hour rate means something.
export function hasSeatTime(t: PlayTime): boolean {
  return playTimeSeconds(t) >= 1.0;
}
