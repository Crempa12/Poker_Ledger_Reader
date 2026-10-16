// Deep playing-style profiles from PokerNow hand logs (port of src/playstyle.hpp/.cpp, without
// the printing). handlog.ts gives the hands; this file reads them for how each person plays:
// every preflop and postflop rate with the C++ "had a real chance" rules, the coarse position
// split, bet sizing, aggression by street, the archetype label, and the playstyle.csv export.
//
// Sample-size discipline (as in the C++): a situational rate always travels with its opportunity
// count, and a count under kMinOpportunities is not a read.
//
// Pure: no file is read or written here. The hit & run columns come from the hitrun module (not
// ported yet). They arrive as an optional map keyed by canonical name; when the map has no entry
// for a person, the Profile's own hit & run fields are used, and those default to the C++ values
// (-1, not reliable, empty), which the CSV writes as blank, "no" and empty.
//
// Money is double dollars, summed in the C++ order: per hand, accounts in UTF-8 byte order (the
// C++ std::map), hands in log order, logs in the order given. Where the C++ walks a std::map or
// std::set, this walks the keys in byte order, because the order changes the double sums.
// Frequencies are integer counts, so their order does not matter.
//
// Numbers in the CSV use C printf rules (the exact binary value, rounded half to even), as the
// C++ ostream does with std::fixed.

import type { PlayerStats } from "./models.ts";
import type { MergeRules } from "./players.ts";
import type { Hand, HandLog, Seat, Street } from "./handlog.ts";
import { atShowdown, displayNameAt, personAt, shownCardCount } from "./handlog.ts";
import { libcppSort } from "./libcpp-sort.ts";
import { EPSILON_DOLLARS, compareBytes, escapeCSV, fixedText, itemAt } from "./util.ts";

// Below this many opportunities a situational rate is noise, not a read. The C++ keeps this as a
// mutable global; here it is a constant, and the functions that read it take it as a parameter.
export const kMinOpportunities = 25;

// Seat relative to the button, for the number of players dealt in. Short-handed tables have no
// UTG, MP or CO, so the label set shrinks with the table.
export type Pos = "Unknown" | "BTN" | "SB" | "BB" | "UTG" | "MP" | "CO";

export function posName(p: Pos): string {
  switch (p) {
    case "BTN":
      return "BTN";
    case "SB":
      return "SB";
    case "BB":
      return "BB";
    case "UTG":
      return "UTG";
    case "MP":
      return "MP";
    case "CO":
      return "CO";
    default:
      return "?";
  }
}

// A counter plus its denominator. A rate is only meaningful with its opportunity count.
export interface Rate {
  made: number;
  opportunities: number;
}

export function newRate(): Rate {
  return { made: 0, opportunities: 0 };
}

export function ratePct(r: Rate): number {
  return r.opportunities === 0 ? 0 : (100 * r.made) / r.opportunities;
}

export function rateReliable(r: Rate, minOpp: number = kMinOpportunities): boolean {
  return r.opportunities >= minOpp;
}

// Bet size as a share of the pot, bucketed (a mean is dominated by one all-in into a small pot).
export const SizeBucket = {
  Under33: 0,
  From33To50: 1,
  From50To75: 2,
  From75To100: 3,
  From100To150: 4,
  Over150: 5,
} as const;
export const SIZE_BUCKET_COUNT = 6;
const SIZE_BUCKET_NAMES = ["<1/3 pot", "1/3-1/2", "1/2-3/4", "3/4-pot", "pot-1.5x", ">1.5x pot"] as const;

export interface Profile {
  displayName: string;
  normalizedName: string;
  games: number;
  hands: number; // dealt in
  handsVoluntary: number; // excluding bomb pots, where entry is forced

  // Preflop shape
  vpip: Rate; // voluntarily put money in
  pfr: Rate; // raised
  limp: Rate; // first to act in an unopened pot, and called the big blind
  openRaise: Rate; // first to act in an unopened pot, and raised (not a raise over limpers)
  threeBet: Rate; // re-raised a single raise
  foldToThreeBet: Rate; // opened, then folded to a re-raise
  foldToOpen: Rate; // folded facing a single raise
  steal: Rate; // first-in raise from CO/BTN/SB
  blindDefend: Rate; // in a blind, did not fold to a steal attempt

  // Postflop shape (all four skip bomb pots)
  cbet: Rate; // was the preflop raiser, nobody bet into them, and bet the flop
  foldToCbet: Rate; // folded facing a flop continuation bet
  checkRaise: Rate; // checked, faced a bet on the same street, then raised it
  donkBet: Rate; // acted before the preflop raiser on an unbet flop, and bet

  // Aggression by street: (bets + raises) / calls, the standard AF split by street.
  betsFlop: number;
  raisesFlop: number;
  callsFlop: number;
  foldsFlop: number;
  betsTurn: number;
  raisesTurn: number;
  callsTurn: number;
  foldsTurn: number;
  betsRiver: number;
  raisesRiver: number;
  callsRiver: number;
  foldsRiver: number;

  // Showdown
  wtsd: Rate; // of flops seen, how many reached showdown (bomb pots out of both)
  wsd: Rate; // of showdowns (bomb pots included), how many were won
  showdownsTabled: number; // showdowns where they turned over both cards
  courtesyReveals: number; // hands where they showed exactly one card
  showdownHandClass: Map<string, number>; // "Two Pair" -> count, at showdown (C++ std::map)

  // Sizing and commitment
  betSize: number[]; // SIZE_BUCKET_COUNT counts, indexed by SizeBucket
  betSizeSamples: number;
  allIns: number;

  // Money
  net: number; // dollars, from the log
  netBigBlinds: number; // per hand, normalized by the blind in force
  biggestPot: number;

  // Coarse positional split (not per seat)
  vpipLate: Rate; // BTN / CO
  vpipBlinds: Rate; // SB / BB
  vpipEarly: Rate; // everything else

  // Hit & run (filled in from the hitrun module; -1 = no nights to judge)
  hitRun: number;
  hitRunReliable: boolean;
  hitRunTag: string;
  hitRunLine: string;
}

// The hit & run columns for one person, as hitrun::annotate sets them on a Profile.
export interface HitRunFacts {
  hitRun: number; // 0-100, -1 = no nights to judge
  hitRunReliable: boolean;
  hitRunTag: string;
  hitRunLine: string;
}

export function newProfile(): Profile {
  return {
    displayName: "",
    normalizedName: "",
    games: 0,
    hands: 0,
    handsVoluntary: 0,
    vpip: newRate(),
    pfr: newRate(),
    limp: newRate(),
    openRaise: newRate(),
    threeBet: newRate(),
    foldToThreeBet: newRate(),
    foldToOpen: newRate(),
    steal: newRate(),
    blindDefend: newRate(),
    cbet: newRate(),
    foldToCbet: newRate(),
    checkRaise: newRate(),
    donkBet: newRate(),
    betsFlop: 0,
    raisesFlop: 0,
    callsFlop: 0,
    foldsFlop: 0,
    betsTurn: 0,
    raisesTurn: 0,
    callsTurn: 0,
    foldsTurn: 0,
    betsRiver: 0,
    raisesRiver: 0,
    callsRiver: 0,
    foldsRiver: 0,
    wtsd: newRate(),
    wsd: newRate(),
    showdownsTabled: 0,
    courtesyReveals: 0,
    showdownHandClass: new Map(),
    betSize: [0, 0, 0, 0, 0, 0],
    betSizeSamples: 0,
    allIns: 0,
    net: 0,
    netBigBlinds: 0,
    biggestPot: 0,
    vpipLate: newRate(),
    vpipBlinds: newRate(),
    vpipEarly: newRate(),
    hitRun: -1,
    hitRunReliable: false,
    hitRunTag: "",
    hitRunLine: "",
  };
}

// ---- derived figures -----------------------------------------------------------------------

// The modal sizing band as a readable label, with its share of bets. "-" with no bets.
export function typicalBetSize(p: Profile): string {
  if (p.betSizeSamples === 0) return "-";
  let best = 0;
  for (let i = 1; i < SIZE_BUCKET_COUNT; i++) {
    if (itemAt(p.betSize, i) > itemAt(p.betSize, best)) best = i;
  }
  const share = Math.trunc(betSizeShare(p, best) + 0.5);
  return `${itemAt(SIZE_BUCKET_NAMES, best)} (${share}% of bets)`;
}

export function betSizeShare(p: Profile, bucket: number): number {
  return p.betSizeSamples === 0 ? 0 : (100 * itemAt(p.betSize, bucket)) / p.betSizeSamples;
}

// Share of bets that are pot-sized or bigger: the overbet tendency.
export function overbetShare(p: Profile): number {
  if (p.betSizeSamples === 0) return 0;
  const big = itemAt(p.betSize, SizeBucket.From100To150) + itemAt(p.betSize, SizeBucket.Over150);
  return (100 * big) / p.betSizeSamples;
}

// (bets + raises) / calls, the standard aggression factor. 99 when there are bets or raises and
// no calls; 0 with neither.
export function af(bets: number, raises: number, calls: number): number {
  if (calls === 0) return bets + raises > 0 ? 99 : 0;
  return (bets + raises) / calls;
}

export function afFlop(p: Profile): number {
  return af(p.betsFlop, p.raisesFlop, p.callsFlop);
}

export function afTurn(p: Profile): number {
  return af(p.betsTurn, p.raisesTurn, p.callsTurn);
}

export function afRiver(p: Profile): number {
  return af(p.betsRiver, p.raisesRiver, p.callsRiver);
}

export function bbPer100(p: Profile): number {
  return p.hands === 0 ? 0 : (100 * p.netBigBlinds) / p.hands;
}

// The gap between how often they enter a pot and how often they enter it with a raise.
export function passivityGap(p: Profile): number {
  return ratePct(p.vpip) - ratePct(p.pfr);
}

// A label that discriminates in this player pool. The cuts are relative to the pool average
// (poolVpip, poolPfr), not to online full-ring norms.
export function archetype(
  p: Profile,
  poolVpip: number,
  poolPfr: number,
  minOpp: number = kMinOpportunities,
): string {
  if (p.handsVoluntary < 200) return "(too few hands)";
  const vpipPct = ratePct(p.vpip);
  const dv = vpipPct - poolVpip;
  const looseness = dv > 8 ? "Loose" : dv < -8 ? "Tight" : "Average";

  const raiseShare = vpipPct > 0 ? ratePct(p.pfr) / vpipPct : 0;
  let aggression: string;
  if (raiseShare >= 0.5) aggression = "aggressive";
  else if (raiseShare >= 0.28) aggression = "balanced";
  else aggression = "passive";

  let label = `${looseness}-${aggression}`;
  // A calling station is defined by what they do facing aggression, not by VPIP.
  const foldToCbetPct = ratePct(p.foldToCbet);
  const cbetReadable = rateReliable(p.foldToCbet, minOpp);
  if (cbetReadable && foldToCbetPct < 35 && raiseShare < 0.35) label += " (station)";
  else if (ratePct(p.pfr) > poolPfr + 10 && cbetReadable && foldToCbetPct > 55) label += " (fires and folds)";
  return label;
}

// The pool averages over players with 200+ voluntary hands (the archetype's reference point).
export function poolAverages(all: readonly Profile[]): { poolVpip: number; poolPfr: number; counted: number } {
  let poolV = 0;
  let poolP = 0;
  let counted = 0;
  for (const q of all) {
    if (q.handsVoluntary >= 200) {
      poolV += ratePct(q.vpip);
      poolP += ratePct(q.pfr);
      counted++;
    }
  }
  if (counted > 0) {
    poolV /= counted;
    poolP /= counted;
  }
  return { poolVpip: poolV, poolPfr: poolP, counted };
}

// ---- positions and blinds ----------------------------------------------------------------------

function isLate(p: Pos): boolean {
  return p === "BTN" || p === "CO";
}

function isBlind(p: Pos): boolean {
  return p === "SB" || p === "BB";
}

// The keys of a map or set in UTF-8 byte order: the order a std::map or std::set walks.
function inByteOrder(keys: Iterable<string>): string[] {
  return [...keys].sort(compareBytes);
}

// Position from the dealer marker plus the seat order. The blind posts anchor the position when
// PokerNow prints no dealer ("dead button" hands). Only the live small and big blinds may anchor:
// a dead or missed blind belongs to someone re-entering. Unresolvable hands map nobody (every seat
// reads as Unknown) rather than being guessed.
export function positionsFor(hand: Hand): Map<string, Pos> {
  const out = new Map<string, Pos>();
  const n = hand.seats.length;
  if (n < 2) return out;

  const srt: Seat[] = [...hand.seats].sort((a, b) => a.seat - b.seat);

  // A seat number listed twice (or one account twice) means the seat order cannot be trusted.
  for (let i = 1; i < n; i++) {
    if (itemAt(srt, i).seat === itemAt(srt, i - 1).seat) return out;
  }
  const idx = new Map<string, number>();
  for (let i = 0; i < n; i++) idx.set(itemAt(srt, i).playerId, i);
  if (idx.size !== n) return out;

  let sbPid = "";
  let bbPid = "";
  for (const a of hand.actions) {
    if (a.kind !== "post") continue;
    if (a.post === "smallBlind" && sbPid === "") sbPid = a.playerId;
    if (a.post === "bigBlind" && bbPid === "") bbPid = a.playerId;
  }

  const dealerIdx = hand.dealerId !== "" ? idx.get(hand.dealerId) : undefined;
  const sbIdx = sbPid !== "" ? idx.get(sbPid) : undefined;
  const bbIdx = bbPid !== "" ? idx.get(bbPid) : undefined;
  let btn = -1;
  if (dealerIdx !== undefined) {
    btn = dealerIdx;
  } else if (n === 2 && sbIdx !== undefined) {
    btn = sbIdx; // heads-up: the button posts the small blind
  } else if (bbIdx !== undefined) {
    // The big blind sits two seats after the button; heads-up the button is the other seat.
    btn = n === 2 ? (bbIdx + 1) % 2 : (((bbIdx - 2) % n) + n) % n;
  } else if (sbIdx !== undefined) {
    btn = (((sbIdx - 1) % n) + n) % n;
  }
  if (btn < 0) return out; // unresolved: every seat stays Unknown

  for (let i = 0; i < n; i++) {
    const off = (((i - btn) % n) + n) % n;
    let p: Pos;
    if (n === 2) p = off === 0 ? "BTN" : "BB";
    else if (off === 0) p = "BTN";
    else if (off === 1) p = "SB";
    else if (off === 2) p = "BB";
    else if (off === n - 1) p = "CO"; // the last seat before the button
    else if (off === 3) p = "UTG";
    else p = "MP";
    out.set(itemAt(srt, i).playerId, p);
  }
  return out;
}

// The big blind in force for a hand, from the live BB post. 0 when the hand has none.
export function bigBlindOf(hand: Hand): number {
  for (const a of hand.actions) {
    if (a.kind === "post" && a.post === "bigBlind") return a.amount;
  }
  return 0;
}

// ---- analysis ----------------------------------------------------------------------------------

function addGame(gamesOf: Map<string, Set<string>>, k: string, gameId: string): void {
  let games = gamesOf.get(k);
  if (games === undefined) {
    games = new Set();
    gamesOf.set(k, games);
  }
  games.add(gameId);
}

// One profile per person over the logs given, in the C++ order: byte order of the canonical name,
// then hands (most first), then display name. Accounts resolve to people hand by hand.
export function analyze(
  logs: readonly HandLog[],
  rules: MergeRules,
  ledgerStats: ReadonlyMap<string, PlayerStats>,
): Profile[] {
  const rows = new Map<string, Profile>();
  const gamesOf = new Map<string, Set<string>>();
  const rowFor = (k: string): Profile => {
    let r = rows.get(k);
    if (r === undefined) {
      r = newProfile();
      rows.set(k, r);
    }
    return r;
  };

  for (const log of logs) {
    for (const hand of log.hands) {
      // Accounts resolve to people per hand: a shared account can change hands mid-night.
      const keyOf = new Map<string, string>();
      const person = (pid: string): string => {
        const cached = keyOf.get(pid);
        if (cached !== undefined) return cached;
        let key = personAt(log, pid, hand.start, rules);
        if (key === "") key = "@" + pid; // a nickname with no letters or digits
        const r = rowFor(key);
        if (r.normalizedName === "") {
          r.normalizedName = key;
          r.displayName = displayNameAt(log, pid, hand.start, rules, ledgerStats);
        }
        keyOf.set(pid, key);
        return key;
      };

      const pos = positionsFor(hand);
      const bb = bigBlindOf(hand);
      const posOf = (pid: string): Pos => pos.get(pid) ?? "Unknown";

      const seated = new Set<string>();
      for (const s of hand.seats) seated.add(person(s.playerId));
      for (const k of seated) {
        const r = rowFor(k);
        r.hands++;
        if (!hand.bombPot) r.handsVoluntary++;
        addGame(gamesOf, k, log.gameId);
      }

      // ---------- preflop ----------
      let raiseCount = 0;
      let lastRaiser = ""; // account
      let opener = ""; // account
      let potUnopened = true; // no raise and no limp yet
      let stealAttempt = false;
      const foldedPre = new Set<string>(); // accounts
      const vpipSet = new Set<string>(); // people
      const pfrSet = new Set<string>(); // people
      const decidedPre = new Set<string>(); // people
      const sawVsOpen = new Set<string>(); // people
      const sawVs3Bet = new Set<string>(); // people
      const sawDefendSpot = new Set<string>(); // people

      for (const a of hand.actions) {
        if (a.street !== "preflop" || a.kind === "post") continue;
        const k = person(a.playerId);
        const r = rowFor(k);
        const p = posOf(a.playerId);
        const firstDecision = !decidedPre.has(k);
        decidedPre.add(k);

        if (a.kind === "fold") foldedPre.add(a.playerId);

        if (!hand.bombPot && !a.bombPot) {
          if (a.kind === "call" || a.kind === "bet" || a.kind === "raise") vpipSet.add(k);
          if (a.kind === "raise") pfrSet.add(k);
        }

        // The situational rates skip bomb pots: nobody chose to be in them.
        if (!hand.bombPot && firstDecision && potUnopened) {
          // Limp, open raise and steal need the pot unopened when the player first acts.
          // A call behind a limper is not a limp; a raise over limpers is not "first in".
          r.openRaise.opportunities++;
          r.limp.opportunities++;
          if (a.kind === "raise") r.openRaise.made++;
          if (a.kind === "call") r.limp.made++;
          // A steal is a first-in raise from CO, BTN or the small blind.
          if (isLate(p) || p === "SB") {
            r.steal.opportunities++;
            if (a.kind === "raise") r.steal.made++;
          }
        // Accounts, not people, in this branch, the three-bet branch below, the aggressor rules on the
        // flop and the per-seat VPIP buckets: the C++ app compares accounts the same way
        // (playstyle.cpp). Spec section 0 says one person on two accounts is one person in a hand;
        // that differs here and is an open decision. See playstyle-two-accounts.test.ts.
        } else if (!hand.bombPot && raiseCount === 1 && a.playerId !== lastRaiser && !sawVsOpen.has(k)) {
          sawVsOpen.add(k);
          r.threeBet.opportunities++;
          r.foldToOpen.opportunities++;
          if (a.kind === "raise") r.threeBet.made++;
          if (a.kind === "fold") r.foldToOpen.made++;
          if (stealAttempt && isBlind(p) && !sawDefendSpot.has(k)) {
            sawDefendSpot.add(k);
            r.blindDefend.opportunities++;
            if (a.kind !== "fold") r.blindDefend.made++;
          }
        } else if (!hand.bombPot && raiseCount >= 2 && a.playerId === opener && !sawVs3Bet.has(k)) {
          sawVs3Bet.add(k);
          r.foldToThreeBet.opportunities++;
          if (a.kind === "fold") r.foldToThreeBet.made++;
        }

        if (a.kind === "raise") {
          if (raiseCount === 0) {
            opener = a.playerId;
            stealAttempt = potUnopened && (isLate(p) || p === "SB");
          }
          raiseCount++;
          lastRaiser = a.playerId;
          potUnopened = false;
        } else if (a.kind === "call") {
          potUnopened = false;
        }
      }
      const aggressor = lastRaiser;

      if (!hand.bombPot) {
        for (const k of vpipSet) rowFor(k).vpip.made++;
        for (const k of pfrSet) rowFor(k).pfr.made++;
        for (const k of seated) {
          rowFor(k).vpip.opportunities++;
          rowFor(k).pfr.opportunities++;
        }
        // Coarse positional split: three buckets, not six, because a per-seat rate is noise here.
        for (const s of hand.seats) {
          const p = posOf(s.playerId);
          if (p === "Unknown") continue;
          const k = person(s.playerId);
          const r = rowFor(k);
          const bucket = isLate(p) ? r.vpipLate : isBlind(p) ? r.vpipBlinds : r.vpipEarly;
          bucket.opportunities++;
          if (vpipSet.has(k)) bucket.made++;
        }
      }

      // ---------- postflop ----------
      const sawFlop = hand.board.length >= 3;
      const flopPlayers = new Set<string>(); // accounts
      if (sawFlop) {
        for (const s of hand.seats) if (!foldedPre.has(s.playerId)) flopPlayers.add(s.playerId);
      }
      if (sawFlop && !hand.bombPot) {
        const people = new Set<string>(); // one flop per person, however many accounts
        for (const pid of flopPlayers) people.add(person(pid));
        for (const k of people) rowFor(k).wtsd.opportunities++;
      }

      let potBefore = 0; // running pot, for bet sizing
      const streetIn = new Map<string, number>(); // accounts: the "to" amount committed this street
      let street: Street = "preflop";
      let firstAggressorThisStreet = ""; // account
      const checkedThisStreet = new Set<string>(); // accounts
      const checkRaiseSpot = new Set<string>(); // people who faced a bet after checking, this street
      let aggressorActedOnFlop = false;
      const sawCbetDecision = new Set<string>(); // people
      const sawDonkSpot = new Set<string>(); // people
      const readFlop = !hand.bombPot && aggressor !== "" && flopPlayers.has(aggressor);

      for (const a of hand.actions) {
        if (a.street !== street) {
          street = a.street;
          streetIn.clear();
          checkedThisStreet.clear();
          checkRaiseSpot.clear();
          firstAggressorThisStreet = "";
        }
        const k = person(a.playerId);
        const r = rowFor(k);
        if (a.allIn) r.allIns++;

        const isFlop = a.street === "flop";
        const isTurn = a.street === "turn";
        const isRiver = a.street === "river";

        if (isFlop || isTurn || isRiver) {
          if (a.kind === "bet") {
            if (isFlop) r.betsFlop++;
            else if (isTurn) r.betsTurn++;
            else r.betsRiver++;
          } else if (a.kind === "raise") {
            if (isFlop) r.raisesFlop++;
            else if (isTurn) r.raisesTurn++;
            else r.raisesRiver++;
          } else if (a.kind === "call") {
            if (isFlop) r.callsFlop++;
            else if (isTurn) r.callsTurn++;
            else r.callsRiver++;
          } else if (a.kind === "fold") {
            if (isFlop) r.foldsFlop++;
            else if (isTurn) r.foldsTurn++;
            else r.foldsRiver++;
          }

          // Check-raise: the chance comes when someone bets behind a player who checked, so it is
          // counted when that player acts again (fold, call or raise), once per street.
          if (
            !hand.bombPot &&
            checkedThisStreet.has(a.playerId) &&
            (a.kind === "fold" || a.kind === "call" || a.kind === "raise") &&
            !checkRaiseSpot.has(k)
          ) {
            checkRaiseSpot.add(k);
            r.checkRaise.opportunities++;
            if (a.kind === "raise") r.checkRaise.made++;
          }
          if (a.kind === "check") checkedThisStreet.add(a.playerId);
        }

        // Flop continuation betting, measured only on the flop, where the preflop story is intact.
        if (isFlop && readFlop) {
          // C-bet: the preflop raiser's first flop action, if nobody bet into them first.
          if (a.playerId === aggressor && !aggressorActedOnFlop) {
            aggressorActedOnFlop = true;
            if (firstAggressorThisStreet === "") {
              r.cbet.opportunities++;
              if (a.kind === "bet") r.cbet.made++;
            }
          }
          // Donk bet: someone acting before the preflop raiser, on an unbet flop, leads out.
          // A bet after the raiser checks is a stab, not a donk.
          if (a.playerId !== aggressor && !aggressorActedOnFlop && !sawDonkSpot.has(k)) {
            sawDonkSpot.add(k);
            if (firstAggressorThisStreet === "") {
              r.donkBet.opportunities++;
              if (a.kind === "bet") r.donkBet.made++;
            }
          }
          // Fold to c-bet: facing a flop bet made by the preflop raiser, the first time they decide.
          if (
            a.playerId !== aggressor &&
            !sawCbetDecision.has(k) &&
            firstAggressorThisStreet === aggressor &&
            (a.kind === "fold" || a.kind === "call" || a.kind === "raise")
          ) {
            sawCbetDecision.add(k);
            r.foldToCbet.opportunities++;
            if (a.kind === "fold") r.foldToCbet.made++;
          }
        }

        // Bet sizing as a share of the pot. Clean bets only: a raise amount is a "to" figure that
        // mixes the call with the increment.
        if (a.kind === "bet" && potBefore > EPSILON_DOLLARS) {
          const pct = (100 * a.amount) / potBefore;
          let b: number;
          if (pct < 33) b = SizeBucket.Under33;
          else if (pct < 50) b = SizeBucket.From33To50;
          else if (pct < 75) b = SizeBucket.From50To75;
          else if (pct < 100) b = SizeBucket.From75To100;
          else if (pct < 150) b = SizeBucket.From100To150;
          else b = SizeBucket.Over150;
          r.betSize[b] = itemAt(r.betSize, b) + 1;
          r.betSizeSamples++;
        }

        let delta = 0;
        if (a.kind === "post") {
          delta = a.amount;
          streetIn.set(a.playerId, (streetIn.get(a.playerId) ?? 0) + a.amount);
        } else if (a.kind === "call" || a.kind === "bet" || a.kind === "raise") {
          delta = a.amount - (streetIn.get(a.playerId) ?? 0);
          if (delta < 0) delta = 0;
          streetIn.set(a.playerId, a.amount);
        }
        potBefore += delta;

        if ((a.kind === "bet" || a.kind === "raise") && firstAggressorThisStreet === "") {
          firstAggressorThisStreet = a.playerId;
        }
      }

      // ---------- showdown and money ----------
      // Everyone still in the hand at showdown, tabled or mucked (handlog atShowdown).
      const atShow = new Set<string>();
      const winners = new Set<string>();
      const flashed = new Set<string>();
      const tabled = new Set<string>();
      for (const pid of atShowdown(hand)) atShow.add(person(pid));
      for (const pid of inByteOrder(hand.rank.keys())) {
        const k = person(pid);
        winners.add(k);
        const r = rowFor(k);
        const handClass = hand.rank.get(pid) ?? "";
        r.showdownHandClass.set(handClass, (r.showdownHandClass.get(handClass) ?? 0) + 1);
      }
      for (const pid of inByteOrder(hand.shown.keys())) {
        const cards = shownCardCount(hand.shown.get(pid) ?? "");
        const k = person(pid);
        if (cards === 1) flashed.add(k);
        else if (cards >= 2 && atShow.has(k)) tabled.add(k);
      }
      for (const k of flashed) rowFor(k).courtesyReveals++;
      for (const k of tabled) rowFor(k).showdownsTabled++;
      for (const k of atShow) {
        const r = rowFor(k);
        if (!hand.bombPot) r.wtsd.made++; // the flops it is a share of leave bomb pots out
        r.wsd.opportunities++;
        if (winners.has(k)) r.wsd.made++;
      }
      for (const pid of inByteOrder(hand.collected.keys())) {
        const r = rowFor(person(pid));
        const c = hand.collected.get(pid) ?? 0;
        // std::max(a, b): the first argument on a tie.
        r.biggestPot = r.biggestPot < c ? c : r.biggestPot;
      }
      for (const pid of inByteOrder(hand.net.keys())) {
        const nv = hand.net.get(pid) ?? 0;
        const r = rowFor(person(pid));
        r.net += nv;
        if (bb > EPSILON_DOLLARS) r.netBigBlinds += nv / bb;
      }
    }
  }

  const out: Profile[] = [];
  for (const k of inByteOrder(rows.keys())) {
    const r = rows.get(k);
    if (r === undefined) continue;
    r.games = gamesOf.get(k)?.size ?? 0;
    out.push(r);
  }
  libcppSort(out, 0, out.length, (a, b) => {
    if (a.hands !== b.hands) return a.hands > b.hands;
    return compareBytes(a.displayName, b.displayName) < 0;
  });
  return out;
}

// ---- export ------------------------------------------------------------------------------------

export const PLAYSTYLE_CSV_HEADER =
  "player,games,hands,hands_voluntary,vpip_pct,vpip_n,pfr_pct,pfr_n,limp_pct,limp_n," +
  "open_pct,open_n,threebet_pct,threebet_n,fold_to_open_pct,fold_to_open_n," +
  "fold_to_3bet_pct,fold_to_3bet_n,steal_pct,steal_n,blind_defend_pct,blind_defend_n," +
  "cbet_pct,cbet_n,fold_to_cbet_pct,fold_to_cbet_n,checkraise_pct,checkraise_n," +
  "donk_pct,donk_n,af_flop,af_turn,af_river,wtsd_pct,wtsd_n,wsd_pct,wsd_n," +
  "showdowns_tabled,courtesy_reveals,bet_lt33_pct,bet_33_50_pct,bet_50_75_pct," +
  "bet_75_100_pct,bet_100_150_pct,bet_over150_pct,overbet_pct,bet_samples,all_ins,net,bb_per_100," +
  "biggest_pot,vpip_late_pct,vpip_late_n,vpip_blinds_pct,vpip_blinds_n,vpip_early_pct,vpip_early_n," +
  "hit_run,hit_run_reliable,hit_run_tag,normalized\n";

function rateCells(r: Rate): string[] {
  return [fixedText(ratePct(r), 2), String(r.opportunities)];
}

// The playstyle.csv export: the header and one line per profile, in the order given. `hitRun`
// (keyed by canonical name) fills the hit & run columns; a person without an entry keeps the
// Profile's own hit & run fields.
export function playstyleCSV(rows: readonly Profile[], hitRun?: ReadonlyMap<string, HitRunFacts>): string {
  let out = PLAYSTYLE_CSV_HEADER;
  for (const p of rows) {
    const hr: HitRunFacts = hitRun?.get(p.normalizedName) ?? p;
    const cells: string[] = [
      escapeCSV(p.displayName),
      String(p.games),
      String(p.hands),
      String(p.handsVoluntary),
      ...rateCells(p.vpip),
      ...rateCells(p.pfr),
      ...rateCells(p.limp),
      ...rateCells(p.openRaise),
      ...rateCells(p.threeBet),
      ...rateCells(p.foldToOpen),
      ...rateCells(p.foldToThreeBet),
      ...rateCells(p.steal),
      ...rateCells(p.blindDefend),
      ...rateCells(p.cbet),
      ...rateCells(p.foldToCbet),
      ...rateCells(p.checkRaise),
      ...rateCells(p.donkBet),
      fixedText(afFlop(p), 3),
      fixedText(afTurn(p), 3),
      fixedText(afRiver(p), 3),
      ...rateCells(p.wtsd),
      ...rateCells(p.wsd),
      String(p.showdownsTabled),
      String(p.courtesyReveals),
    ];
    for (let b = 0; b < SIZE_BUCKET_COUNT; b++) cells.push(fixedText(betSizeShare(p, b), 2));
    cells.push(
      fixedText(overbetShare(p), 2),
      String(p.betSizeSamples),
      String(p.allIns),
      fixedText(p.net, 2),
      fixedText(bbPer100(p), 3),
      fixedText(p.biggestPot, 2),
      ...rateCells(p.vpipLate),
      ...rateCells(p.vpipBlinds),
      fixedText(ratePct(p.vpipEarly), 2),
      String(p.vpipEarly.opportunities),
      hr.hitRun < 0 ? "" : fixedText(hr.hitRun, 2),
      hr.hitRunReliable ? "yes" : "no",
      escapeCSV(hr.hitRunTag),
      escapeCSV(p.normalizedName),
    );
    out += cells.join(",") + "\n";
  }
  return out;
}
