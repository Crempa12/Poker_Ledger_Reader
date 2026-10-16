// Hit & run: does a player take their winnings off the table while the game is still going, right
// after hitting them? Port of src/hitrun.hpp/.cpp without the printing. The definitions are in the
// README ("Hit & run (menu 22)") and the C++ header; this file says how each figure is computed.
//
// Every night a person played ends in exactly one exit: stayed to the end, left up, left down, left
// about even, busted out without rebuying, or removed by the admin. Three habits come out of those
// exits, each a share from 0 to 1:
//
//   when up    how much of the night (from their sit-down on) went on without them, on the nights they
//              finished ahead, weighted by the size of the win
//   when down  the same on the nights they finished behind but still had chips
//   the hit    the part of "when up" that came right after their best point of the night, with most of
//              it still in hand
//
//   H&R = 100 x ( whenUp + max(0, whenUp - whenDown) + hit ) / 3
//
// Only nights with a hand log count: a ledger cannot say when someone stopped playing. PokerNow cuts the
// oldest hands off a long night's log; hands keep their numbers, and a seat that began before the log is
// placed by the ledger's times (an "estimated" night when they left before the log begins).
//
// Pure: no file, no clock. Times are whole epoch seconds, or null for "no time" (the C++ NO_TIME).
// Money is double dollars where the C++ adds doubles (a ledger net is netCents / 100, the same double the
// C++ reads from the file), so sums and ties come out as the C++ has them. The CSV numbers use the C
// rounding: the exact binary value, and an exact tie goes to the even digit. The C++ is built by clang
// on arm64, which fuses a multiply and the add that takes it (a + b * c) into one rounding; the seven
// such sums in summarize go through fusedMulAdd, which does the same.

import { libcppSort } from "./libcpp-sort.ts";
import type { HandLog, StyleStats } from "./handlog.ts";
import { displayNameAt, logIdOf, personAt } from "./handlog.ts";
import type { Epoch, Game, LedgerRow, PlayerStats } from "./models.ts";
import type { MergeRules } from "./players.ts";
import { personOf } from "./players.ts";
import type { HitRunFacts } from "./playstyle.ts";
import { bigBlindOf } from "./playstyle.ts";
import { EPSILON_DOLLARS, compareBytes, escapeCSV, fixed2, fixedText, formatLocalDate, fusedMulAdd, itemAt } from "./util.ts";

// The bit-exact printf and the exact a * b + c live in util.ts; re-exported here for the callers that use them by this name.
export { fixedText, fusedMulAdd };

// ---- tunables (the C++ values, with their reasons in src/hitrun.cpp) ----------------------------

// Leaving within this many hands of the end is "stayed".
export const GRACE_HANDS = 10;
// A gap this long, then dealt in again, is a break they came back from.
export const BREAK_HANDS = 30;
// A result inside plus or minus this many big blinds is "about even".
export const EVEN_BB = 5.0;
// A win this big (in big blinds) counts fully toward "when up"; smaller wins count in proportion.
export const FULL_WIN_BB = 50.0;
// Under this many big blinds left is busted.
export const BUST_BB = 1.0;
// The hit's credit halves every this many hands played after the peak.
export const PEAK_HALF_LIFE_HANDS = 20.0;
// Phantom pool-average nights added to "when up" and to the hit, and to "when down".
export const SHRINK_UP_NIGHTS = 2.0;
export const SHRINK_DOWN_NIGHTS = 3.0;
// Winning nights needed before the factor is a tendency (below it, the factor is shown in brackets).
export const MIN_UP_NIGHTS = 3;

// Tag cut-offs, checked in this order; the first that fits wins.
const EARLY_LEAVER_WHEN_UP = 0.4; // leaves 40%+ of the night early when winning...
const EARLY_LEAVER_GAP = 0.1; // ...and within 10 points of that when losing,
const EARLY_LEAVER_DOWN_NIGHTS = 2; // with at least two losing exits to show it
const HIT_RUNNER_AT = 40;
const RUNS_WHEN_UP_AT = 25;
const BUSTS_OUT_SHARE = 0.4; // busts out and goes home on 40%+ of their nights
const STAYS_LATE_BELOW = 10;

// ---- shapes ------------------------------------------------------------------------------------

// How a night ended. The C++ names are in exitName.
export type Exit = "stayed" | "leftUp" | "leftDown" | "leftEven" | "busted" | "removed";

const EXIT_NAMES: Record<Exit, string> = {
  stayed: "Stayed",
  leftUp: "Left up",
  leftDown: "Left down",
  leftEven: "Left even",
  busted: "Busted out",
  removed: "Removed",
};

export function exitName(e: Exit): string {
  return EXIT_NAMES[e];
}

// One person's one night. Hand numbers are PokerNow's (#1 is the night's first hand).
export interface Night {
  gameId: string;
  date: Epoch; // the game's first sit-down; null when unknown
  person: string; // canonical name (the same key the leaderboard uses)
  displayName: string;

  handsInNight: number; // the last hand's number: every hand dealt that night
  handsMissing: number; // hands at the start of the night that the log does not have
  satDownHand: number; // hand number they sat down at (from the ledger's time when before the log)
  lastHand: number; // hand number of the last hand they were dealt
  handsPlayed: number; // hands dealt in (hands before the log: every one since they sat down)
  handsLeft: number; // hands dealt after their last one
  estimated: boolean; // they left before the log begins: placed from the ledger's times

  played: number; // handsPlayed / handsInNight
  away: number; // handsLeft / hands dealt since they sat down (0 when they stayed)
  net: number; // dollars: the night's result from the ledger (from the log without one)
  netCents: number; // the same result in whole cents
  bigBlind: number; // dollars, the blind in force when they left
  bigBlindCents: number; // the same blind in whole cents

  // Their best point of the night, on the same scale as `net`, and what came after it.
  peakKnown: boolean; // false on estimated nights
  peakAtLogStart: boolean; // the best point seen was where the log begins: it may have been earlier
  peak: number; // 0 = never ahead
  peakCents: number; // the same peak in whole cents
  finalRunning: number; // their result when they left, on the same scale as `peak`
  finalRunningCents: number; // the same result in whole cents
  handsAfterPeak: number; // hands they were dealt after the one that took them to the peak
  minutesAfterPeak: number;

  exit: Exit;
  rebuys: number; // busted (under BUST_BB) and put chips back in
  cameBack: number; // left for BREAK_HANDS+ (not busted) and was dealt in again
  cameBackUp: number; // ... of which they were ahead when they left
}

export function newNight(): Night {
  return {
    gameId: "",
    date: null,
    person: "",
    displayName: "",
    handsInNight: 0,
    handsMissing: 0,
    satDownHand: 0,
    lastHand: 0,
    handsPlayed: 0,
    handsLeft: 0,
    estimated: false,
    played: 0,
    away: 0,
    net: 0,
    netCents: 0,
    bigBlind: 0,
    bigBlindCents: 0,
    peakKnown: false,
    peakAtLogStart: false,
    peak: 0,
    peakCents: 0,
    finalRunning: 0,
    finalRunningCents: 0,
    handsAfterPeak: 0,
    minutesAfterPeak: 0,
    exit: "stayed",
    rebuys: 0,
    cameBack: 0,
    cameBackUp: 0,
  };
}

// The net in big blinds (0 with no blind).
export function netBB(n: Night): number {
  return n.bigBlind > 0 ? n.net / n.bigBlind : 0;
}

export function finishedUp(n: Night): boolean {
  return netBB(n) >= EVEN_BB;
}

export function finishedDown(n: Night): boolean {
  return netBB(n) <= -EVEN_BB;
}

// Counts toward "when up" (and the hit): finished ahead and either stayed or left with chips.
export function upSample(n: Night): boolean {
  return finishedUp(n) && (n.exit === "stayed" || n.exit === "leftUp");
}

// Counts toward "when down": finished behind and either stayed or left with chips.
export function downSample(n: Night): boolean {
  return finishedDown(n) && (n.exit === "stayed" || n.exit === "leftDown");
}

// A win's weight: 1 for FULL_WIN_BB or more, proportionally less below it.
export function winWeight(n: Night): number {
  if (!finishedUp(n)) return 0;
  return Math.min(1, netBB(n) / FULL_WIN_BB);
}

// Share of the peak still in hand when they left, 0..1.
export function kept(n: Night): number {
  if (!n.peakKnown || n.peak <= EPSILON_DOLLARS) return 0;
  return clamp01(n.finalRunning / n.peak);
}

// How much this exit was a run from the peak: the share kept, halved for every PEAK_HALF_LIFE_HANDS
// hands played after the peak. 0 when never ahead or not known.
export function fresh(n: Night): number {
  if (!n.peakKnown || n.peak <= EPSILON_DOLLARS) return 0;
  return kept(n) * Math.pow(0.5, n.handsAfterPeak / PEAK_HALF_LIFE_HANDS);
}

// One person's row over every night given: the exits, the three habits and the factor.
export interface Summary {
  person: string;
  displayName: string;
  nights: number;
  estimatedNights: number; // left before their night's log begins
  stayed: number;
  stayedUp: number;
  stayedDown: number;
  leftUp: number;
  leftDown: number;
  leftEven: number;
  busted: number;
  removed: number;
  rebuys: number;
  cameBack: number;
  cameBackUp: number;
  played: number; // mean share of each night's hands they were dealt
  handsLeftWhenUp: number; // mean hands still to come when they left up
  peakNightsLeftUp: number; // nights they left up with a known peak
  handsAfterPeakWhenUp: number; // median hands played after the peak, on nights they left up
  minutesAfterPeakWhenUp: number; // the same in minutes
  keptWhenUp: number; // median share of the peak kept, on nights they left up

  upNights: number; // the "when up" sample
  whenUpRaw: number; // win-weighted mean of Night.away over it
  whenUp: number; // ... leaning toward the pool (SHRINK_UP_NIGHTS)
  downNights: number; // the "when down" sample
  whenDownRaw: number; // plain mean of Night.away over it
  whenDown: number; // ... leaning toward the pool (SHRINK_DOWN_NIGHTS)
  hitRaw: number; // win-weighted mean of away x fresh over up nights with a known peak
  hit: number; // ... leaning toward the pool (SHRINK_UP_NIGHTS)
  factor: number; // 0..100, from the leaning values
  tag: string;
}

export function emptySummary(): Summary {
  return {
    person: "",
    displayName: "",
    nights: 0,
    estimatedNights: 0,
    stayed: 0,
    stayedUp: 0,
    stayedDown: 0,
    leftUp: 0,
    leftDown: 0,
    leftEven: 0,
    busted: 0,
    removed: 0,
    rebuys: 0,
    cameBack: 0,
    cameBackUp: 0,
    played: 0,
    handsLeftWhenUp: 0,
    peakNightsLeftUp: 0,
    handsAfterPeakWhenUp: 0,
    minutesAfterPeakWhenUp: 0,
    keptWhenUp: 0,
    upNights: 0,
    whenUpRaw: 0,
    whenUp: 0,
    downNights: 0,
    whenDownRaw: 0,
    whenDown: 0,
    hitRaw: 0,
    hit: 0,
    factor: 0,
    tag: "",
  };
}

// Enough winning nights for the factor to be a tendency.
export function reliable(s: Summary): boolean {
  return s.upNights >= MIN_UP_NIGHTS;
}

// The three habits in one or two lines ("\n" between them), for the deep profile.
export function habitsLine(s: Summary): string {
  if (s.upNights === 0) return "no winning nights to judge";
  let text =
    "leaves with " +
    pct(s.whenUp) +
    " of the night to come when up (" +
    s.upNights +
    " night" +
    (s.upNights === 1 ? "" : "s") +
    "), " +
    pct(s.whenDown) +
    " when down";
  if (s.peakNightsLeftUp !== 0) {
    text +=
      "\nleaving up, typically " +
      fixedText(s.handsAfterPeakWhenUp, 0) +
      " hands (" +
      fixedText(s.minutesAfterPeakWhenUp, 0) +
      " min) after their peak, keeping " +
      pct(s.keptWhenUp) +
      " of it";
  }
  return text;
}

// ---- small helpers -----------------------------------------------------------------------------

// std::clamp(v, 0.0, 1.0): the value itself when it is in range.
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// C round(): halves away from zero.
function cRound(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

function pct(share: number): string {
  return fixedText(100 * share, 0) + "%";
}

// The median of a list (0 for an empty one), as the C++ takes it.
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 === 1 ? itemAt(v, m) : (itemAt(v, m - 1) + itemAt(v, m)) / 2;
}

// The keys of a map, in UTF-8 byte order (the C++ std::map order).
function byteKeys<V>(m: ReadonlyMap<string, V>): string[] {
  return [...m.keys()].sort(compareBytes);
}

// The person behind an account at a moment; an account whose nickname has no letters or digits is its
// own person, as in the style tables.
function personKey(log: HandLog, pid: string, at: Epoch, rules: MergeRules): string {
  const k = personAt(log, pid, at, rules);
  return k === "" ? "@" + pid : k;
}

function displayFor(person: string, fallback: string, ledgerStats: ReadonlyMap<string, PlayerStats>): string {
  const stats = ledgerStats.get(person);
  return stats !== undefined ? stats.displayName : fallback;
}

// The live big blind posted most often over the given logs, for hands with no readable blind. 0 when
// none has one. Ties go to the smaller blind (the C++ walks its map in key order).
function modalBigBlind(logs: readonly HandLog[]): number {
  const count = new Map<number, number>();
  for (const log of logs) {
    for (const hand of log.hands) {
      const bb = bigBlindOf(hand);
      if (bb > EPSILON_DOLLARS) {
        const c = Math.round(bb * 100);
        count.set(c, (count.get(c) ?? 0) + 1);
      }
    }
  }
  let best = 0;
  let bestN = 0;
  for (const c of [...count.keys()].sort((a, b) => a - b)) {
    const v = count.get(c) ?? 0;
    if (v > bestN) {
      best = c;
      bestN = v;
    }
  }
  return best / 100;
}

function classifyByResult(n: Night): void {
  if (finishedUp(n)) n.exit = "leftUp";
  else if (finishedDown(n)) n.exit = "leftDown";
  else n.exit = "leftEven";
}

// Seats taken right after the same person's previous seat ended busted: rebuys the ledger can see (a new
// seat after going broke). Only the seat they left last before each new one counts, so a clean cash-out
// in between is not a bust.
function ledgerRebuys(rows: readonly LedgerRow[], bigBlind: number): number {
  let count = 0;
  for (const seat of rows) {
    if (seat.start === null) continue;
    const seatStart = seat.start;
    let previous: LedgerRow | null = null;
    let previousEnd = 0;
    for (const r of rows) {
      if (r === seat || r.end === null || r.end > seatStart) continue;
      if (previous === null || r.end > previousEnd) {
        previous = r;
        previousEnd = r.end;
      }
    }
    if (previous !== null && previous.buyOutCents / 100 < BUST_BB * bigBlind) count++;
  }
  return count;
}

interface Track {
  display: string;
  first: number; // index into the log's hands, -1 = never dealt in
  last: number;
  played: number;
  running: number; // the log's net so far
  runningCents: number; // the same, in whole cents
  maxRunning: number; // -Infinity until the first hand
  maxRunningCents: number;
  maxHand: number; // index of the hand that took `running` to its highest
  playedAtMax: number; // hands dealt in up to and including that one
  stackAfter: number; // chips after their latest hand dealt in
  runningAtLast: number;
  runningAtLastCents: number;
  bbAtLast: number;
  rebuys: number;
  cameBack: number;
  cameBackUp: number;
  refilledAfterLast: boolean; // chips added after their last hand, never played
  removed: boolean; // the admin took them out right as they stopped
}

function newTrack(): Track {
  return {
    display: "",
    first: -1,
    last: -1,
    played: 0,
    running: 0,
    runningCents: 0,
    maxRunning: Number.NEGATIVE_INFINITY,
    maxRunningCents: 0,
    maxHand: -1,
    playedAtMax: 0,
    stackAfter: 0,
    runningAtLast: 0,
    runningAtLastCents: 0,
    bbAtLast: 0,
    rebuys: 0,
    cameBack: 0,
    cameBackUp: 0,
    refilledAfterLast: false,
    removed: false,
  };
}

// Every person's night in one hand log. `game` (may be undefined) is the paired ledger: its nets are the
// results, and its times place anything before a cut-off log. `defaultBigBlind` is used when the night
// has no readable big blind.
export function nightsFromLog(
  log: HandLog,
  game: Game | undefined,
  rules: MergeRules,
  ledgerStats: ReadonlyMap<string, PlayerStats>,
  defaultBigBlind: number,
): Night[] {
  const out: Night[] = [];
  const hands = log.hands;
  const n = hands.length;
  if (n === 0) return out;
  let nightBB = modalBigBlind([log]);
  if (nightBB <= EPSILON_DOLLARS) nightBB = defaultBigBlind;

  // Hands keep their numbers when PokerNow cuts the start off a long night's log, so the last number is
  // the length of the whole night. Fall back on counting when the numbers do not run in order.
  const firstHand = itemAt(hands, 0);
  const lastHandOfLog = itemAt(hands, n - 1);
  const numbered = firstHand.number >= 1 && lastHandOfLog.number - firstHand.number + 1 === n;
  const numberOf = (h: number): number => (numbered ? itemAt(hands, h).number : h + 1);
  const firstNo = numberOf(0);
  const lastNo = numberOf(n - 1);
  const missing = firstNo - 1;
  const logStart: Epoch = firstHand.start;
  const gameStart: Epoch = game !== undefined ? game.start : null;
  // The hand being dealt at a moment before the log begins, pacing the missing hands evenly from the
  // ledger's first sit-down to the log's first hand.
  const numberAt = (t: Epoch): number => {
    if (missing === 0 || gameStart === null || t === null || logStart === null || logStart <= gameStart) {
      return firstNo;
    }
    const f = (t - gameStart) / (logStart - gameStart);
    return 1 + Math.round(clamp01(f) * missing);
  };

  const tracks = new Map<string, Track>();
  const trackOf = (k: string): Track => {
    let t = tracks.get(k);
    if (t === undefined) {
      t = newTrack();
      tracks.set(k, t);
    }
    return t;
  };

  for (let h = 0; h < n; h++) {
    const hand = itemAt(hands, h);
    let bb = bigBlindOf(hand);
    if (bb <= EPSILON_DOLLARS) bb = nightBB;

    // Accounts are resolved to people hand by hand: a shared account can change hands mid-night.
    const keyOf = new Map<string, string>();
    const key = (pid: string): string => {
      let k = keyOf.get(pid);
      if (k === undefined) {
        k = personKey(log, pid, hand.start, rules);
        keyOf.set(pid, k);
      }
      return k;
    };

    // Someone on two accounts in one hand is one person with the two stacks added up.
    const startStack = new Map<string, number>();
    const endStack = new Map<string, number>();
    for (const s of hand.seats) {
      const k = key(s.playerId);
      const netv = hand.net.get(s.playerId);
      startStack.set(k, (startStack.get(k) ?? 0) + s.stack);
      endStack.set(k, (endStack.get(k) ?? 0) + (s.stack + (netv === undefined ? 0 : netv)));
      const t = trackOf(k);
      if (t.display === "") t.display = displayNameAt(log, s.playerId, hand.start, rules, ledgerStats);
    }
    for (const k of byteKeys(startStack)) {
      const st = startStack.get(k) ?? 0;
      const t = trackOf(k);
      if (t.first < 0) {
        t.first = h;
      } else {
        // Busted last time and sitting with more chips now: they bought back in, whether by a rebuy, a
        // new seat or an admin top-up. Otherwise a long gap is a break they came back from.
        const bustedBefore = t.stackAfter < BUST_BB * t.bbAtLast;
        const addedChips = st > t.stackAfter + EPSILON_DOLLARS;
        if (bustedBefore && addedChips) {
          t.rebuys++;
        } else if (h - t.last - 1 >= BREAK_HANDS) {
          t.cameBack++;
          if (t.runningAtLast >= EVEN_BB * t.bbAtLast) t.cameBackUp++;
        }
      }
      t.last = h;
      t.played++;
    }
    for (const pid of byteKeys(hand.net)) {
      const t = tracks.get(key(pid));
      if (t !== undefined) {
        const netv = hand.net.get(pid) ?? 0;
        t.running += netv;
        t.runningCents += Math.round(netv * 100);
      }
    }
    for (const k of byteKeys(endStack)) {
      const t = trackOf(k);
      t.stackAfter = endStack.get(k) ?? 0;
      t.runningAtLast = t.running;
      t.runningAtLastCents = t.runningCents;
      t.bbAtLast = bb;
      if (t.running > t.maxRunning + EPSILON_DOLLARS) {
        t.maxRunning = t.running;
        t.maxRunningCents = t.runningCents;
        t.maxHand = h;
        t.playedAtMax = t.played;
      }
    }
  }

  // What happened after each person's last hand: chips put back on the table that were never played (so
  // they did not leave busted), or the admin forcing them away or removing them.
  for (const ev of log.events) {
    const t = tracks.get(personKey(log, ev.playerId, ev.at, rules));
    if (t === undefined || t.first < 0) continue;
    if ((ev.kind === "rebuy" || ev.kind === "topup") && ev.hand > t.last) t.refilledAfterLast = true;
    if ((ev.kind === "away" || ev.kind === "kick") && ev.hand >= t.last && ev.hand <= t.last + 1 + GRACE_HANDS) {
      t.removed = true;
    }
  }

  // The ledger is what the leaderboard counts and covers the whole night, cut-off log or not: it decides
  // up or down, and its times place anything from before the log begins.
  const seatsOf = new Map<string, LedgerRow[]>();
  const ledgerNet = new Map<string, number>();
  const ledgerNetCents = new Map<string, number>();
  if (game !== undefined) {
    for (const r of game.rows) {
      const k = personOf(rules, r);
      const list = seatsOf.get(k) ?? [];
      list.push(r);
      seatsOf.set(k, list);
      ledgerNet.set(k, (ledgerNet.get(k) ?? 0) + r.netCents / 100);
      ledgerNetCents.set(k, (ledgerNetCents.get(k) ?? 0) + r.netCents);
    }
  }
  const earliestSeat = (k: string): Epoch => {
    let e: Epoch = null;
    for (const r of seatsOf.get(k) ?? []) {
      if (r.start !== null && (e === null || r.start < e)) e = r.start;
    }
    return e;
  };

  for (const k of byteKeys(tracks)) {
    const t = tracks.get(k);
    if (t === undefined || t.first < 0) continue;
    const nt = newNight();
    nt.gameId = game !== undefined ? game.id : log.gameId;
    nt.date = game !== undefined ? game.start : log.start;
    nt.person = k;
    nt.displayName = displayFor(k, t.display, ledgerStats);
    nt.handsInNight = lastNo;
    nt.handsMissing = missing;

    const firstNumber = numberOf(t.first);
    const earliest = earliestSeat(k);
    const seatedBefore = missing > 0 && earliest !== null && logStart !== null && earliest < logStart;
    nt.satDownHand = seatedBefore ? Math.min(firstNumber, numberAt(earliest)) : firstNumber;
    nt.lastHand = numberOf(t.last);
    nt.handsLeft = lastNo - nt.lastHand;
    nt.handsPlayed = t.played + (seatedBefore ? Math.max(0, firstNo - nt.satDownHand) : 0);
    nt.played = nt.handsPlayed / lastNo;
    nt.bigBlind = t.bbAtLast > EPSILON_DOLLARS ? t.bbAtLast : nightBB;
    nt.bigBlindCents = Math.round(nt.bigBlind * 100);
    const ln = ledgerNet.get(k);
    const lnCents = ledgerNetCents.get(k);
    nt.net = ln !== undefined ? ln : t.running;
    nt.netCents = lnCents !== undefined ? lnCents : t.runningCents;
    nt.rebuys = t.rebuys;
    nt.cameBack = t.cameBack;
    nt.cameBackUp = t.cameBackUp;

    // The peak on the same scale as the ledger's result. Someone already seated when the log begins starts
    // it with whatever they had won or lost in the hands it does not have.
    const before = seatedBefore && ln !== undefined ? ln - t.running : 0;
    const beforeCents = seatedBefore && lnCents !== undefined ? lnCents - t.runningCents : 0;
    let best = before;
    let atStart = true;
    if (t.maxHand >= 0 && before + t.maxRunning > best + EPSILON_DOLLARS) {
      best = before + t.maxRunning;
      atStart = false;
    }
    const bestCents = atStart ? beforeCents : beforeCents + t.maxRunningCents;
    nt.peakKnown = true;
    nt.finalRunning = before + t.runningAtLast;
    nt.finalRunningCents = beforeCents + t.runningAtLastCents;
    if (best > EPSILON_DOLLARS) {
      nt.peak = best;
      nt.peakCents = bestCents;
      nt.peakAtLogStart = atStart;
      nt.handsAfterPeak = atStart ? t.played : t.played - t.playedAtMax;
      const from = itemAt(hands, atStart ? t.first : t.maxHand).start;
      const to = itemAt(hands, t.last).start;
      if (from !== null && to !== null && to > from) nt.minutesAfterPeak = (to - from) / 60;
    }

    if (nt.handsLeft <= GRACE_HANDS) {
      nt.exit = "stayed";
      nt.away = 0;
    } else {
      // Of the hands dealt from their sit-down to the end of the night, the share after they left.
      const window = lastNo - nt.satDownHand + 1;
      nt.away = window > 0 ? nt.handsLeft / window : 0;
      if (t.stackAfter < BUST_BB * nt.bigBlind && !t.refilledAfterLast) nt.exit = "busted";
      else if (t.removed) nt.exit = "removed";
      else classifyByResult(nt);
    }
    out.push(nt);
  }

  // People the cut-off log never deals in, whose seats began before it: they left in the hands it does
  // not have. Place them from the ledger's times.
  if (missing > 0 && game !== undefined) {
    for (const k of byteKeys(seatsOf)) {
      const rows = seatsOf.get(k) ?? [];
      const tr = tracks.get(k);
      if (tr !== undefined && tr.first >= 0) continue;
      const earliest = earliestSeat(k);
      if (earliest === null || logStart === null || earliest >= logStart) continue; // sat down later, never dealt in

      let leftAt: Epoch = null;
      let open = false;
      let lastOut: LedgerRow | null = null;
      let net = 0;
      let netCents = 0;
      for (const r of rows) {
        net += r.netCents / 100;
        netCents += r.netCents;
        if (r.start === null) continue;
        if (r.end === null) open = true;
        else if (leftAt === null || r.end > leftAt) {
          leftAt = r.end;
          lastOut = r;
        }
      }
      // Still seated at the end, or cashed out after the log begins, yet never dealt a logged hand: they
      // were sitting out, so their last hand came before the log.
      if (open || leftAt === null || leftAt > logStart) {
        leftAt = logStart;
        if (open) lastOut = null;
      }

      const nt = newNight();
      nt.gameId = game.id;
      nt.date = game.start;
      nt.person = k;
      nt.displayName = displayFor(k, itemAt(rows, 0).nickname, ledgerStats);
      nt.estimated = true;
      nt.handsInNight = lastNo;
      nt.handsMissing = missing;
      nt.satDownHand = numberAt(earliest);
      nt.lastHand = Math.max(nt.satDownHand, Math.min(numberAt(leftAt), firstNo - 1));
      nt.handsLeft = lastNo - nt.lastHand;
      nt.handsPlayed = nt.lastHand - nt.satDownHand + 1;
      nt.played = nt.handsPlayed / lastNo;
      nt.net = net;
      nt.netCents = netCents;
      nt.bigBlind = nightBB;
      nt.bigBlindCents = Math.round(nightBB * 100);
      nt.rebuys = ledgerRebuys(rows, nightBB);
      // The same order as a logged night; staying is only possible here when the log is that short.
      if (nt.handsLeft <= GRACE_HANDS) {
        nt.exit = "stayed";
      } else {
        const window = lastNo - nt.satDownHand + 1;
        nt.away = window > 0 ? nt.handsLeft / window : 0;
        if (lastOut !== null && lastOut.buyOutCents / 100 < BUST_BB * nightBB) nt.exit = "busted";
        else classifyByResult(nt);
      }
      out.push(nt);
    }
  }
  return out;
}

export interface CollectResult {
  nights: Night[];
  unmeasured: number; // games in scope with no hand log: left out, and the table says so
}

// Every person's night in the games given that have a hand log, in game order. `logs` is keyed by logIdOf.
export function collect(
  games: readonly Game[],
  logs: ReadonlyMap<string, HandLog>,
  rules: MergeRules,
  ledgerStats: ReadonlyMap<string, PlayerStats>,
): CollectResult {
  const logged: Array<{ game: Game; log: HandLog }> = [];
  let unmeasured = 0;
  for (const game of games) {
    const log = logs.get(logIdOf(game));
    if (log === undefined) unmeasured++;
    else logged.push({ game, log });
  }

  // A night with no readable big blind at all falls back on the stake of the rest.
  let usual = modalBigBlind(logged.map((p) => p.log));
  if (usual <= EPSILON_DOLLARS) usual = 1.0;

  const nights: Night[] = [];
  for (const p of logged) {
    for (const night of nightsFromLog(p.log, p.game, rules, ledgerStats, usual)) nights.push(night);
  }
  return { nights, unmeasured };
}

// ---- summaries ---------------------------------------------------------------------------------

interface Sums {
  up: number;
  upWeight: number;
  hit: number;
  hitWeight: number;
  down: number;
  handsLeftUp: number;
  afterPeak: number[];
  afterPeakMinutes: number[];
  kept: number[];
}

function newSums(): Sums {
  return {
    up: 0,
    upWeight: 0,
    hit: 0,
    hitWeight: 0,
    down: 0,
    handsLeftUp: 0,
    afterPeak: [],
    afterPeakMinutes: [],
    kept: [],
  };
}

// Most-trusted rows first (reliable before thin), then the higher factor, more nights, and the name.
function summaryBefore(a: Summary, b: Summary): boolean {
  if (reliable(a) !== reliable(b)) return reliable(a);
  if (Math.abs(a.factor - b.factor) > 1e-9) return a.factor > b.factor;
  if (a.nights !== b.nights) return a.nights > b.nights;
  return compareBytes(a.displayName, b.displayName) < 0;
}

// One row per person over every night given. The pool's habits, over every night by anyone, are what
// the thin personal samples lean toward.
export function summarize(nights: readonly Night[]): Summary[] {
  let poolUp = 0;
  let poolUpWeight = 0;
  let poolHit = 0;
  let poolHitWeight = 0;
  let poolDown = 0;
  let poolDownN = 0;
  for (const n of nights) {
    if (upSample(n)) {
      poolUp = fusedMulAdd(winWeight(n), n.away, poolUp);
      poolUpWeight += winWeight(n);
      if (n.peakKnown) {
        poolHit = fusedMulAdd(winWeight(n) * n.away, fresh(n), poolHit);
        poolHitWeight += winWeight(n);
      }
    }
    if (downSample(n)) {
      poolDown += n.away;
      poolDownN++;
    }
  }
  if (poolUpWeight > 0) poolUp /= poolUpWeight;
  if (poolHitWeight > 0) poolHit /= poolHitWeight;
  if (poolDownN > 0) poolDown /= poolDownN;

  const rows = new Map<string, Summary>();
  const sums = new Map<string, Sums>();
  for (const n of nights) {
    let s = rows.get(n.person);
    if (s === undefined) {
      s = emptySummary();
      rows.set(n.person, s);
    }
    let x = sums.get(n.person);
    if (x === undefined) {
      x = newSums();
      sums.set(n.person, x);
    }
    if (s.person === "") {
      s.person = n.person;
      s.displayName = n.displayName;
    }
    s.nights++;
    if (n.estimated) s.estimatedNights++;
    s.played += n.played;
    s.rebuys += n.rebuys;
    s.cameBack += n.cameBack;
    s.cameBackUp += n.cameBackUp;
    switch (n.exit) {
      case "stayed":
        s.stayed++;
        if (finishedUp(n)) s.stayedUp++;
        else if (finishedDown(n)) s.stayedDown++;
        break;
      case "leftUp":
        s.leftUp++;
        x.handsLeftUp += n.handsLeft;
        if (n.peakKnown && n.peak > EPSILON_DOLLARS) {
          x.afterPeak.push(n.handsAfterPeak);
          x.afterPeakMinutes.push(n.minutesAfterPeak);
          x.kept.push(kept(n));
        }
        break;
      case "leftDown":
        s.leftDown++;
        break;
      case "leftEven":
        s.leftEven++;
        break;
      case "busted":
        s.busted++;
        break;
      case "removed":
        s.removed++;
        break;
    }
    if (upSample(n)) {
      s.upNights++;
      x.up = fusedMulAdd(winWeight(n), n.away, x.up);
      x.upWeight += winWeight(n);
      if (n.peakKnown) {
        x.hit = fusedMulAdd(winWeight(n) * n.away, fresh(n), x.hit);
        x.hitWeight += winWeight(n);
      }
    }
    if (downSample(n)) {
      s.downNights++;
      x.down += n.away;
    }
  }

  const out: Summary[] = [];
  for (const person of byteKeys(rows)) {
    const s = rows.get(person);
    const x = sums.get(person);
    if (s === undefined || x === undefined) continue;
    s.played = s.nights ? s.played / s.nights : 0;
    s.handsLeftWhenUp = s.leftUp ? x.handsLeftUp / s.leftUp : 0;
    s.peakNightsLeftUp = x.afterPeak.length;
    s.handsAfterPeakWhenUp = median(x.afterPeak);
    s.minutesAfterPeakWhenUp = median(x.afterPeakMinutes);
    s.keptWhenUp = median(x.kept);
    s.whenUpRaw = x.upWeight > 0 ? x.up / x.upWeight : 0;
    s.whenUp = fusedMulAdd(SHRINK_UP_NIGHTS, poolUp, x.up) / (x.upWeight + SHRINK_UP_NIGHTS);
    s.whenDownRaw = s.downNights ? x.down / s.downNights : 0;
    s.whenDown = fusedMulAdd(SHRINK_DOWN_NIGHTS, poolDown, x.down) / (s.downNights + SHRINK_DOWN_NIGHTS);
    s.hitRaw = x.hitWeight > 0 ? x.hit / x.hitWeight : 0;
    s.hit = fusedMulAdd(SHRINK_UP_NIGHTS, poolHit, x.hit) / (x.hitWeight + SHRINK_UP_NIGHTS);
    s.factor = s.upNights === 0 ? 0 : (100 * (s.whenUp + Math.max(0, s.whenUp - s.whenDown) + s.hit)) / 3;

    // Tags compare the factor as it is printed, so a "15" is never called "Stays late".
    const shown = cRound(s.factor);
    const enough = reliable(s);
    if (
      enough &&
      s.downNights >= EARLY_LEAVER_DOWN_NIGHTS &&
      s.whenUp >= EARLY_LEAVER_WHEN_UP &&
      s.whenUp - s.whenDown < EARLY_LEAVER_GAP
    ) {
      s.tag = "Early leaver";
    } else if (enough && shown >= HIT_RUNNER_AT) {
      s.tag = "Hit & runner";
    } else if (enough && shown >= RUNS_WHEN_UP_AT) {
      s.tag = "Runs when up";
    } else if (
      s.nights >= MIN_UP_NIGHTS &&
      s.busted >= BUSTS_OUT_SHARE * s.nights &&
      (!enough || shown < RUNS_WHEN_UP_AT)
    ) {
      s.tag = "Busts out";
    } else if (enough && shown < STAYS_LATE_BELOW) {
      s.tag = "Stays late";
    }
    out.push(s);
  }
  libcppSort(out, 0, out.length, summaryBefore);
  return out;
}

// The hit & run columns on the menu 18 style rows. A person with no summary keeps their own fields; a
// person with no winning night keeps the factor at -1 and gets the tag only.
export function annotateStyle(rows: readonly StyleStats[], summaries: readonly Summary[]): StyleStats[] {
  const by = new Map<string, Summary>();
  for (const s of summaries) by.set(s.person, s);
  return rows.map((r) => {
    const s = by.get(r.normalizedName);
    if (s === undefined) return { ...r };
    if (s.upNights === 0) return { ...r, hitRunTag: s.tag };
    return { ...r, hitRunTag: s.tag, hitRun: s.factor, hitRunReliable: reliable(s) };
  });
}

// The H&R facts for the playing-style rows (menu 21), keyed by canonical name: pass to playstyleCSV.
// Same rule as annotateStyle: with no winning night the factor is -1 and not reliable, but the tag and
// the habits line are still given.
export function hitRunFacts(summaries: readonly Summary[]): Map<string, HitRunFacts> {
  const out = new Map<string, HitRunFacts>();
  for (const s of summaries) {
    out.set(s.person, {
      hitRun: s.upNights === 0 ? -1 : s.factor,
      hitRunReliable: s.upNights === 0 ? false : reliable(s),
      hitRunTag: s.tag,
      hitRunLine: habitsLine(s),
    });
  }
  return out;
}

// ---- export ------------------------------------------------------------------------------------

export const HIT_AND_RUN_HEADER =
  "player,normalized,nights,estimated_nights,played_pct,stayed,stayed_up,stayed_down,left_up,left_down,left_even," +
  "busted,removed,rebuys,came_back,came_back_up,hands_left_when_up,up_nights,when_up_raw_pct,when_up_pct,down_nights," +
  "when_down_raw_pct,when_down_pct,peak_nights_left_up,hands_after_peak_when_up,minutes_after_peak_when_up," +
  "kept_of_peak_when_up_pct,hit_raw_pct,hit_pct,hit_run,reliable,tag\n";

// The text of hit_and_run.csv: one row per person, in summarize's order.
export function hitRunCSV(rows: readonly Summary[]): string {
  let out = HIT_AND_RUN_HEADER;
  for (const s of rows) {
    const cells = [
      escapeCSV(s.displayName),
      escapeCSV(s.person),
      String(s.nights),
      String(s.estimatedNights),
      fixedText(100 * s.played, 2),
      String(s.stayed),
      String(s.stayedUp),
      String(s.stayedDown),
      String(s.leftUp),
      String(s.leftDown),
      String(s.leftEven),
      String(s.busted),
      String(s.removed),
      String(s.rebuys),
      String(s.cameBack),
      String(s.cameBackUp),
      fixedText(s.handsLeftWhenUp, 1),
      String(s.upNights),
      fixedText(100 * s.whenUpRaw, 2),
      fixedText(100 * s.whenUp, 2),
      String(s.downNights),
      fixedText(100 * s.whenDownRaw, 2),
      fixedText(100 * s.whenDown, 2),
      String(s.peakNightsLeftUp),
      fixedText(s.handsAfterPeakWhenUp, 1),
      fixedText(s.minutesAfterPeakWhenUp, 1),
      fixedText(100 * s.keptWhenUp, 2),
      fixedText(100 * s.hitRaw, 2),
      fixedText(100 * s.hit, 2),
      fixedText(s.factor, 2),
      reliable(s) ? "yes" : "no",
      escapeCSV(s.tag),
    ];
    out += cells.join(",") + "\n";
  }
  return out;
}

export const HIT_AND_RUN_NIGHTS_HEADER =
  "date,game,player,normalized,hands_in_night,hands_missing_from_log,sat_down_hand,last_hand,hands_played,hands_left," +
  "estimated,played_pct,away_pct,net,big_blind,net_bb,exit,rebuys,came_back,came_back_up,peak,peak_at_log_start," +
  "final_running,kept_pct,hands_after_peak,minutes_after_peak,fresh\n";

// The text of hit_and_run_nights.csv: one row per person per night, in the order given. The date column is
// the calendar day in `timeZone` (the C++ used the machine's zone).
export function hitRunNightsCSV(nights: readonly Night[], timeZone: string): string {
  let out = HIT_AND_RUN_NIGHTS_HEADER;
  for (const n of nights) {
    const cells = [
      formatLocalDate(n.date, timeZone),
      escapeCSV(n.gameId),
      escapeCSV(n.displayName),
      escapeCSV(n.person),
      String(n.handsInNight),
      String(n.handsMissing),
      String(n.satDownHand),
      String(n.lastHand),
      String(n.handsPlayed),
      String(n.handsLeft),
      n.estimated ? "yes" : "no",
      fixedText(100 * n.played, 2),
      fixedText(100 * n.away, 2),
      fixed2(n.net),
      fixed2(n.bigBlind),
      fixedText(netBB(n), 2),
      exitName(n.exit),
      String(n.rebuys),
      String(n.cameBack),
      String(n.cameBackUp),
      n.peakKnown ? fixed2(n.peak) : "",
      n.peakAtLogStart ? "yes" : "no",
      n.peakKnown ? fixed2(n.finalRunning) : "",
      n.peakKnown ? fixedText(100 * kept(n), 2) : "",
      n.peakKnown ? String(n.handsAfterPeak) : "",
      n.peakKnown ? fixedText(n.minutesAfterPeak, 1) : "",
      n.peakKnown ? fixedText(fresh(n), 4) : "",
    ];
    out += cells.join(",") + "\n";
  }
  return out;
}
