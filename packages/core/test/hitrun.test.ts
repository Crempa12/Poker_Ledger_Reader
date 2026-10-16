import { describe, expect, it } from "vitest";

import type { Hand, HandLog, Seat } from "../src/handlog.ts";
import { newStyleStats, parseHandLog } from "../src/handlog.ts";
import type { Game, LedgerRow, PlayerStats } from "../src/models.ts";
import { addMergeRule } from "../src/players.ts";
import type { MergeRules } from "../src/players.ts";
import { newProfile, playstyleCSV } from "../src/playstyle.ts";
import {
  HIT_AND_RUN_HEADER,
  HIT_AND_RUN_NIGHTS_HEADER,
  SHRINK_DOWN_NIGHTS,
  SHRINK_UP_NIGHTS,
  annotateStyle,
  collect,
  exitName,
  finishedUp,
  downSample,
  fixedText,
  fresh,
  fusedMulAdd,
  habitsLine,
  hitRunCSV,
  hitRunFacts,
  hitRunNightsCSV,
  kept,
  netBB,
  newNight,
  nightsFromLog,
  reliable,
  summarize,
  upSample,
  winWeight,
} from "../src/hitrun.ts";
import type { Exit, Night, Summary } from "../src/hitrun.ts";

// Made-up data only: the nights are the ones tools/hitrun_selftest.cpp builds (the same names, the same
// hands, the same hand-worked numbers). Each check of that file is one test here.

// ---- building made-up hand logs ----------------------------------------------------------------

const BB = 0.5;
const T0 = 1790000000; // any fixed moment; hands are 45 seconds apart

function at(hand: number): number {
  return T0 + 45 * hand;
}

// One account's night: the hands it is dealt (inclusive ranges of hand indexes), its starting stack, what
// it wins or loses on given hands, and chips added before given hands (a rebuy).
interface Script {
  pid: string;
  nick: string;
  spans: Array<[number, number]>;
  stack: number;
  net: Map<number, number>;
  add: Map<number, number>;
}

function scriptOf(
  pid: string,
  nick: string,
  spans: Array<[number, number]>,
  stack: number,
  net: Array<[number, number]> = [],
  add: Array<[number, number]> = [],
): Script {
  return { pid, nick, spans, stack, net: new Map(net), add: new Map(add) };
}

function dealt(s: Script, h: number): boolean {
  return s.spans.some(([a, b]) => h >= a && h <= b);
}

function emptyHand(number: number, start: number): Hand {
  return {
    number,
    id: "h" + String(number),
    start,
    dealerId: "",
    seats: [],
    myCards: "",
    board: [],
    actions: [],
    shown: new Map(),
    folded: new Set(),
    showdown: false,
    bombPot: false,
    runItTwice: false,
    rank: new Map(),
    collected: new Map(),
    collectedCents: new Map(),
    net: new Map(),
    netCents: new Map(),
    bounty: new Map(),
    bountyCents: new Map(),
    pot: 0,
    potCents: 0,
  };
}

function emptyLog(gameId: string): HandLog {
  return {
    gameId,
    path: "",
    folder: "",
    hands: [],
    events: [],
    names: new Map(),
    seats: new Map(),
    start: null,
    end: null,
    biggestPot: 0,
    biggestPotCents: 0,
    biggestPotWinner: "",
    biggestPotHand: 0,
    stackMismatches: 0,
  };
}

function seatOf(seat: number, playerId: string, nickname: string, stack: number): Seat {
  return { seat, playerId, nickname, stack, stackCents: Math.round(stack * 100) };
}

// A log of `hands` hands numbered from `firstNumber`. A filler account sits through all of it so every
// hand has a big blind to read; it takes the other side of every result.
function buildNight(scripts: readonly Script[], hands: number, firstNumber = 1): HandLog {
  const log = emptyLog("pgltest");
  const filler = scriptOf("fill", "Filler", [[0, hands - 1]], 10000);
  const stack = new Map<string, number>();
  for (const s of scripts) stack.set(s.pid, s.stack);
  stack.set(filler.pid, filler.stack);
  for (let h = 0; h < hands; h++) {
    const hand = emptyHand(firstNumber + h, at(h));
    let seat = 1;
    let others = 0;
    for (const s of scripts) {
      const add = s.add.get(h);
      if (add !== undefined) stack.set(s.pid, (stack.get(s.pid) ?? 0) + add);
      if (!dealt(s, h)) continue;
      const net = s.net.get(h) ?? 0;
      hand.seats.push(seatOf(seat++, s.pid, s.nick, stack.get(s.pid) ?? 0));
      hand.net.set(s.pid, net);
      stack.set(s.pid, (stack.get(s.pid) ?? 0) + net);
      others += net;
      log.names.set(s.pid, s.nick);
    }
    hand.seats.push(seatOf(seat++, filler.pid, filler.nick, stack.get(filler.pid) ?? 0));
    hand.net.set(filler.pid, -others);
    stack.set(filler.pid, (stack.get(filler.pid) ?? 0) - others);
    log.names.set(filler.pid, filler.nick);
    hand.actions.push({
      playerId: filler.pid,
      street: "preflop",
      kind: "post",
      amount: BB,
      amountCents: 50,
      allIn: false,
      post: "bigBlind",
      bombPot: false,
    });
    log.hands.push(hand);
  }
  const first = log.hands[0];
  const last = log.hands[log.hands.length - 1];
  log.start = first === undefined ? null : first.start;
  log.end = last === undefined ? null : last.start;
  return log;
}

// A ledger seat (times are epoch seconds, null = still seated; money in dollars).
function seatRow(
  nickname: string,
  playerId: string,
  start: number | null,
  end: number | null,
  net: number,
  buyOut = 0,
): LedgerRow {
  return {
    nickname,
    playerId,
    start,
    end,
    buyInCents: 0,
    buyOutCents: Math.round(buyOut * 100),
    stackCents: 0,
    netCents: Math.round(net * 100),
    owner: "",
    ownerReviewed: false,
  };
}

function gameOf(id: string, start: number | null, rows: LedgerRow[]): Game {
  return { id, path: "", folder: "", start, end: null, totalBuyInCents: 0, skippedRows: 0, rows };
}

function must(nights: readonly Night[], person: string): Night {
  const n = nights.find((x) => x.person === person);
  if (n === undefined) throw new Error(`no night for ${person}`);
  return n;
}

function expectNear(actual: number, expected: number, tol = 1e-6): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

// ---- the made-up nights of the self-test -------------------------------------------------------

// Every way a night can end: hands #1-#100, big blind $0.50.
function exitNights(): Night[] {
  const s: Script[] = [
    scriptOf("p1", "Stay", [[0, 99]], 50, [[50, 30]]),
    scriptOf("p2", "UpLeft", [[0, 49]], 50, [[10, 30]]),
    scriptOf("p3", "DownLeft", [[0, 59]], 50, [[10, -20]]),
    scriptOf("p4", "Bust", [[0, 29]], 20, [[29, -20]]),
    scriptOf("p5", "Rebuy", [[0, 99]], 20, [[19, -20]], [[20, 20]]),
    scriptOf("p6", "BreakBack", [[0, 29], [70, 99]], 50, [[5, 30]]),
    scriptOf("p7", "Grace", [[0, 91]], 50, [[5, 30]]),
    scriptOf("p8", "Even", [[0, 49]], 50, [[5, 1]]),
    scriptOf("p9", "Late", [[60, 79]], 50, [[65, 30]]),
    scriptOf("pa", "Kicked", [[0, 39]], 50, [[5, 30]]),
    scriptOf("pb", "Refill", [[0, 39]], 20, [[39, -20]]),
    scriptOf("tA", "Twin A", [[0, 49]], 50, [[5, 10]]),
    scriptOf("tB", "Twin B", [[30, 79]], 50, [[40, 20]]),
    scriptOf("sh", "Shared", [[0, 99]], 50, [
      [10, 30],
      [60, -10],
    ]),
    scriptOf("pq", "Quick", [[0, 40]], 50, [[38, 30]]),
    scriptOf("pg", "GaveBack", [[0, 49]], 50, [
      [5, 40],
      [45, -30],
    ]),
  ];
  const log = buildNight(s, 100);
  // After Kicked's last hand the admin forces them away; Refill rebuys but never plays again.
  log.events.push({ at: at(40), hand: 40, playerId: "pa", kind: "away", amount: 0, amountCents: 0 });
  log.events.push({ at: at(40), hand: 40, playerId: "pb", kind: "rebuy", amount: 20, amountCents: 2000 });
  // "Shared" is one account held by two people: Carol for the first half, Dave after.
  log.seats.set("sh", [
    { start: at(0) - 60, end: at(49) + 10, person: "carol" },
    { start: at(50) - 5, end: null, person: "dave" },
  ]);

  let rules: MergeRules = new Map();
  rules = addMergeRule(rules, "twinb", "twina"); // one person on two accounts

  // The ledger says UpLeft won $40 (the log says $30): the ledger is what the leaderboard counts.
  const game = gameOf("ledger_pgltest", at(0), [seatRow("UpLeft", "p2", at(0), at(49), 40.0, 90.0)]);
  return nightsFromLog(log, game, rules, new Map(), 1.0);
}

describe("every way a night can end (hands #1-#100, big blind $0.50)", () => {
  const nights = exitNights();

  it("dealt in to the last hand, up: stayed, counts toward 'when up' at 0%", () => {
    const n = must(nights, "stay");
    expect(n.exit).toBe("stayed");
    expect(n.away).toBe(0);
    expect(finishedUp(n)).toBe(true);
    expect(upSample(n)).toBe(true);
    expect(n.handsInNight).toBe(100);
  });

  it("left up after hand #50 of 100: 50 hands left, walked away from 50%", () => {
    const n = must(nights, "upleft");
    expect(n.exit).toBe("leftUp");
    expect(n.lastHand).toBe(50);
    expect(n.handsLeft).toBe(50);
    expectNear(n.away, 0.5);
    expectNear(n.played, 0.5);
  });

  it("the ledger's $40 is the result (80 bb, a full-weight win), not the log's $30", () => {
    const n = must(nights, "upleft");
    expectNear(n.net, 40.0);
    expectNear(netBB(n), 80.0);
    expectNear(winWeight(n), 1.0);
  });

  it("won $30 on hand #11 and played 39 more hands (29 min): the hit counts 0.5^(39/20)", () => {
    const n = must(nights, "upleft");
    expect(n.peakKnown).toBe(true);
    expectNear(n.peak, 30.0);
    expect(n.handsAfterPeak).toBe(39);
    expectNear(n.minutesAfterPeak, (39 * 45) / 60);
    expectNear(kept(n), 1.0);
    expectNear(fresh(n), Math.pow(0.5, 39 / 20));
  });

  it("left down with chips after hand #60: 40% walked away, counts toward 'when down', never ahead", () => {
    const n = must(nights, "downleft");
    expect(n.exit).toBe("leftDown");
    expect(n.handsLeft).toBe(40);
    expectNear(n.away, 0.4);
    expect(downSample(n)).toBe(true);
    expect(n.peak).toBe(0);
  });

  it("went to $0 on hand #30 and never came back: busted out, in neither habit", () => {
    const n = must(nights, "bust");
    expect(n.exit).toBe("busted");
    expectNear(n.away, 0.7);
    expect(upSample(n)).toBe(false);
    expect(downSample(n)).toBe(false);
  });

  it("busted on hand #20, bought back in, played to the end: stayed with 1 rebuy", () => {
    const n = must(nights, "rebuy");
    expect(n.exit).toBe("stayed");
    expect(n.rebuys).toBe(1);
    expect(n.cameBack).toBe(0);
  });

  it("left up for 40 hands and came back to the end: not a hit and run, 1 return while up", () => {
    const n = must(nights, "breakback");
    expect(n.exit).toBe("stayed");
    expect(n.cameBack).toBe(1);
    expect(n.cameBackUp).toBe(1);
    expect(n.handsPlayed).toBe(60);
  });

  it("left with 8 hands to go (inside the 10-hand grace): stayed", () => {
    const n = must(nights, "grace");
    expect(n.exit).toBe("stayed");
    expect(n.handsLeft).toBe(8);
    expect(n.away).toBe(0);
  });

  it("left $1 (2 bb) up: about even, in neither habit", () => {
    const n = must(nights, "even");
    expect(n.exit).toBe("leftEven");
    expectNear(netBB(n), 2.0);
    expect(upSample(n)).toBe(false);
    expect(downSample(n)).toBe(false);
  });

  it("sat down at #61, left up after #80: 20 of the 40 hands since sitting down (arriving late is not held against them)", () => {
    const n = must(nights, "late");
    expect(n.exit).toBe("leftUp");
    expect(n.satDownHand).toBe(61);
    expect(n.handsLeft).toBe(20);
    expectNear(n.away, 0.5);
    expectNear(n.played, 0.2);
  });

  it("forced to away mode by the admin as they stopped: removed, not judged", () => {
    const n = must(nights, "kicked");
    expect(n.exit).toBe("removed");
    expect(upSample(n)).toBe(false);
  });

  it("went to $0 but rebought after the last hand and left: left down, not busted", () => {
    const n = must(nights, "refill");
    expect(n.exit).toBe("leftDown");
  });

  it("two accounts, one person: one night from #1 to #80, results added (+$30)", () => {
    const n = must(nights, "twina");
    expect(n.exit).toBe("leftUp");
    expect(n.satDownHand).toBe(1);
    expect(n.lastHand).toBe(80);
    expect(n.handsPlayed).toBe(80);
    expectNear(n.net, 30.0);
    expectNear(n.away, 0.2);
  });

  it("the second account is not a person of its own", () => {
    expect(nights.find((x) => x.person === "twinb")).toBeUndefined();
  });

  it("shared account, first holder: left up at half-time", () => {
    const n = must(nights, "carol");
    expect(n.exit).toBe("leftUp");
    expect(n.lastHand).toBe(50);
    expectNear(n.net, 30.0);
    expectNear(n.away, 0.5);
  });

  it("shared account, second holder: stayed to the end down", () => {
    const n = must(nights, "dave");
    expect(n.exit).toBe("stayed");
    expect(n.satDownHand).toBe(51);
    expectNear(n.net, -10.0);
    expect(downSample(n)).toBe(true);
  });

  it("won $30 on hand #39 and left after #41: a hit and run, nearly full credit", () => {
    const n = must(nights, "quick");
    expect(n.exit).toBe("leftUp");
    expect(n.handsAfterPeak).toBe(2);
    expectNear(fresh(n), Math.pow(0.5, 0.1));
  });

  it("up $40 on hand #6, gave $30 back and left after #50: kept 25%, little credit as a hit", () => {
    const n = must(nights, "gaveback");
    expectNear(n.peak, 40.0);
    expectNear(kept(n), 0.25);
    expect(n.handsAfterPeak).toBe(44);
    expectNear(fresh(n), 0.25 * Math.pow(0.5, 44 / 20));
  });
});

// A log PokerNow cut short: it holds hands #101-#200 of a 200-hand night.
function cutOffNights(): Night[] {
  // The night started (first sit-down) 100 hands' worth of time before the log begins.
  const nightStart = at(-100);
  const s: Script[] = [scriptOf("ps", "Seated", [[0, 99]], 50, [[50, 10]]), scriptOf("pu", "SeatedUp", [[0, 59]], 50, [[5, 20]])];
  const log = buildNight(s, 100, 101);
  const game = gameOf("ledger_pglcut", nightStart, [
    seatRow("Early", "pe", nightStart, at(-50), 40.0, 60.0), // gone by hand #51
    seatRow("Seated", "ps", at(-80), null, -20.0), // down $30 before the log
    seatRow("SeatedUp", "pu", nightStart, null, 50.0), // up $30 before the log
    // Three seats before the log: busted out of the first, cashed out of the second with chips, then sat a
    // third time. Only the second seat follows a bust.
    seatRow("Trip", "pt", at(-100), at(-90), -50.0, 0.0),
    seatRow("Trip", "pt", at(-88), at(-70), 0.0, 50.0),
    seatRow("Trip", "pt", at(-65), at(-55), 10.0, 60.0),
  ]);
  return nightsFromLog(log, game, new Map(), new Map(), 1.0);
}

// A log of only #4-#13: someone who left just before it begins left inside the last 10 hands.
function shortNights(): Night[] {
  const shortLog = buildNight([], 10, 4);
  const shortGame = gameOf("ledger_pglshort", at(-3), [seatRow("Late", "pl", at(-3), at(-1), 25.0, 100.0)]);
  return nightsFromLog(shortLog, shortGame, new Map(), new Map(), 1.0);
}

describe("a log PokerNow cut short (it holds hands #101-#200 of a 200-hand night)", () => {
  const nights = cutOffNights();

  it("left before the log begins: placed at #1-#51 by the ledger's times, left up with 149 hands to come", () => {
    const n = must(nights, "early");
    expect(n.estimated).toBe(true);
    expect(n.satDownHand).toBe(1);
    expect(n.lastHand).toBe(51);
    expect(n.handsLeft).toBe(149);
    expectNear(n.away, 149 / 200);
    expect(n.exit).toBe("leftUp");
    expect(n.peakKnown).toBe(false);
  });

  it("seated before the log begins (~#21): the ledger's -$20 is the result, never ahead on the night", () => {
    const n = must(nights, "seated");
    expect(n.satDownHand).toBe(21);
    expect(n.handsPlayed).toBe(180);
    expect(n.handsInNight).toBe(200);
    expect(n.handsMissing).toBe(100);
    expect(n.exit).toBe("stayed");
    expect(n.peak).toBe(0);
    expectNear(n.net, -20.0);
  });

  it("up $30 before the log, $20 more on #106, left after #160: peak $50 on the ledger's scale, 54 hands before leaving", () => {
    const n = must(nights, "seatedup");
    expect(n.satDownHand).toBe(1);
    expect(n.lastHand).toBe(160);
    expect(n.handsLeft).toBe(40);
    expectNear(n.away, 0.2);
    expect(n.exit).toBe("leftUp");
    expectNear(n.peak, 50.0);
    expect(n.peakAtLogStart).toBe(false);
    expect(n.handsAfterPeak).toBe(54);
    expectNear(kept(n), 1.0);
  });

  it("three seats before the log (busted, cashed out, sat again): one rebuy, not two", () => {
    const n = must(nights, "trip");
    expect(n.estimated).toBe(true);
    expect(n.rebuys).toBe(1);
    expect(n.exit).toBe("leftDown");
  });

  it("a 13-hand night whose log has #4-#13: left after #3, 10 hands from the end, so stayed", () => {
    const n = must(shortNights(), "late");
    expect(n.estimated).toBe(true);
    expect(n.lastHand).toBe(3);
    expect(n.handsLeft).toBe(10);
    expect(n.exit).toBe("stayed");
    expect(n.away).toBe(0);
  });
});

// Four winning and four losing nights each for three kinds of player, all wins 60 bb.
function fakeNight(who: string, away: number, netBBValue: number, handsAfterPeak: number): Night {
  const n = newNight();
  n.person = who;
  n.displayName = who;
  n.bigBlind = 1.0;
  n.net = netBBValue;
  n.away = away;
  n.exit = away === 0 ? "stayed" : netBBValue > 0 ? "leftUp" : "leftDown";
  n.peakKnown = true;
  n.peak = Math.max(0, netBBValue);
  n.finalRunning = netBBValue;
  n.handsAfterPeak = handsAfterPeak;
  return n;
}

function factorNights(): Night[] {
  const nights: Night[] = [];
  for (let i = 0; i < 4; i++) {
    nights.push(fakeNight("stayer", 0.1, 60, 40), fakeNight("stayer", 0.1, -60, 0));
    nights.push(fakeNight("bedtime", 0.8, 60, 40), fakeNight("bedtime", 0.8, -60, 0));
    nights.push(fakeNight("runner", 0.8, 60, 0), fakeNight("runner", 0.2, -60, 0));
  }
  return nights;
}

function byPerson(list: readonly Summary[]): Map<string, Summary> {
  const out = new Map<string, Summary>();
  for (const s of list) out.set(s.person, s);
  return out;
}

describe("the factor, worked by hand", () => {
  const by = byPerson(summarize(factorNights()));

  // Hit per night = away x fresh; fresh = 1 at the peak, 0.25 forty hands after it.
  // Pool: when up (0.4 + 3.2 + 3.2) / 12, hit (0.1 + 0.8 + 3.2) / 12, when down (0.4 + 3.2 + 0.8) / 12.
  const poolUp = 6.8 / 12;
  const poolHit = 4.1 / 12;
  const poolDown = 4.4 / 12;
  function expectHabits(who: string, sumUp: number, sumHit: number, sumDown: number, tag: string): void {
    const up = (sumUp + SHRINK_UP_NIGHTS * poolUp) / (4 + SHRINK_UP_NIGHTS);
    const hit = (sumHit + SHRINK_UP_NIGHTS * poolHit) / (4 + SHRINK_UP_NIGHTS);
    const down = (sumDown + SHRINK_DOWN_NIGHTS * poolDown) / (4 + SHRINK_DOWN_NIGHTS);
    const factor = (100 * (up + Math.max(0, up - down) + hit)) / 3;
    const s = by.get(who);
    if (s === undefined) throw new Error(`no summary for ${who}`);
    expectNear(s.whenUp, up);
    expectNear(s.whenDown, down);
    expectNear(s.hit, hit);
    expectNear(s.factor, factor);
    expect(s.tag).toBe(tag);
  }

  it("stayer: up 0.400, down 0.400, hit 0.100 (with the pool), no tag", () => {
    expectHabits("stayer", 0.4, 0.1, 0.4, "");
  });

  it("bedtime: up 3.200, down 3.200, hit 0.800 (with the pool), tagged Runs when up", () => {
    expectHabits("bedtime", 3.2, 0.8, 3.2, "Runs when up");
  });

  it("runner: up 3.200, down 0.800, hit 3.200 (with the pool), tagged Hit & runner", () => {
    expectHabits("runner", 3.2, 3.2, 0.8, "Hit & runner");
  });

  it("leaving winners early right after the peak outranks a bedtime, which outranks staying", () => {
    expect(by.get("runner")!.factor).toBeGreaterThan(by.get("bedtime")!.factor);
    expect(by.get("bedtime")!.factor).toBeGreaterThan(by.get("stayer")!.factor);
  });

  it("raw habits are kept alongside", () => {
    const runner = by.get("runner")!;
    expectNear(runner.whenUpRaw, 0.8);
    expectNear(runner.whenDownRaw, 0.2);
    expectNear(runner.hitRaw, 0.8);
  });

  it("20 winning and 20 losing nights all left at 80%: tagged Early leaver", () => {
    const curfew: Night[] = [];
    for (let i = 0; i < 20; i++) {
      curfew.push(fakeNight("curfew", 0.8, 60, 60));
      curfew.push(fakeNight("curfew", 0.8, -60, 0));
    }
    const c = summarize(curfew)[0];
    expect(c?.tag).toBe("Early leaver");
  });

  it("two winning nights: factor shown in brackets, no tag", () => {
    const thin: Night[] = [fakeNight("thin", 0.9, 60, 0), fakeNight("thin", 0.9, 60, 0)];
    const t = byPerson(summarize(thin)).get("thin");
    expect(t).toBeDefined();
    expect(reliable(t!)).toBe(false);
    expect(t!.tag).toBe("");
  });

  it("busted out on 3 of 4 nights: tagged Busts out", () => {
    const thin: Night[] = [fakeNight("thin", 0.9, 60, 0), fakeNight("thin", 0.9, 60, 0)];
    const b = fakeNight("buster", 0.5, -40, 0);
    b.exit = "busted";
    for (let i = 0; i < 3; i++) thin.push(b);
    thin.push(fakeNight("buster", 0.0, 60, 0));
    const t = byPerson(summarize(thin));
    expect(t.get("buster")?.busted).toBe(3);
    expect(t.get("buster")?.tag).toBe("Busts out");
  });
});

// The admin's away / removal lines, read from a made-up log file.
describe("reading the admin's away / removal lines", () => {
  it("forced away and queued removal read as events on B, before hand index 1", () => {
    const text = [
      "entry,at,order",
      `"-- starting hand #1 (id: abc)  No Limit Texas Hold'em (dealer: ""A @ pa"") --",2026-09-01T02:00:00.000Z,1`,
      `"Player stacks: #1 ""A @ pa"" (10.00) | #2 ""B @ pb"" (10.00)",2026-09-01T02:00:00.000Z,2`,
      `"""A @ pa"" posts a small blind of 0.25",2026-09-01T02:00:00.000Z,3`,
      `"""B @ pb"" posts a big blind of 0.50",2026-09-01T02:00:00.000Z,4`,
      `"""A @ pa"" folds",2026-09-01T02:00:05.000Z,5`,
      `"Uncalled bet of 0.25 returned to ""B @ pb""",2026-09-01T02:00:05.000Z,6`,
      `"""B @ pb"" collected 0.50 from pot",2026-09-01T02:00:05.000Z,7`,
      `"-- ending hand #1 --",2026-09-01T02:00:05.000Z,8`,
      `"The admin ""A @ pa"" forced the player ""B @ pb"" to away mode in the next hand.",2026-09-01T02:00:06.000Z,9`,
      `"The admin ""A @ pa"" enqueued the removal of the player ""B @ pb"".",2026-09-01T02:00:07.000Z,10`,
      "",
    ].join("\n");
    const parsed = parseHandLog({ relativePath: "poker_now_log_pgladmin.csv", text });
    if (!parsed.ok) throw new Error(parsed.error);
    const events = parsed.log.events;
    const away = events.filter((e) => e.kind === "away" && e.playerId === "pb" && e.hand === 1).length;
    const kick = events.filter((e) => e.kind === "kick" && e.playerId === "pb" && e.hand === 1).length;
    expect(away).toBe(1);
    expect(kick).toBe(1);
  });
});

// ---- the rest of the module --------------------------------------------------------------------

describe("exit names and the formatting of numbers", () => {
  it("names the exits as the C++ does", () => {
    const names: Array<[Exit, string]> = [
      ["stayed", "Stayed"],
      ["leftUp", "Left up"],
      ["leftDown", "Left down"],
      ["leftEven", "Left even"],
      ["busted", "Busted out"],
      ["removed", "Removed"],
    ];
    for (const [e, text] of names) expect(exitName(e)).toBe(text);
  });

  it("rounds like printf: exact ties go to the even digit, signs are kept", () => {
    expect(fixedText(2.5, 0)).toBe("2");
    expect(fixedText(3.5, 0)).toBe("4");
    expect(fixedText(0.125, 2)).toBe("0.12");
    expect(fixedText(1234.5678, 2)).toBe("1234.57");
    expect(fixedText(-0.001, 2)).toBe("-0.00");
    expect(fixedText(0, 1)).toBe("0.0");
    expect(fixedText(45, 1)).toBe("45.0");
  });

  it("writes the habits line as the C++ does, with and without a winning night", () => {
    const none = summarize([fakeNight("none", 0.5, -60, 0)])[0];
    expect(none).toBeDefined();
    expect(habitsLine(none!)).toBe("no winning nights to judge");
    const runner = byPerson(summarize(factorNights())).get("runner");
    expect(runner).toBeDefined();
    expect(habitsLine(runner!)).toMatch(/^leaves with \d+% of the night to come when up \(4 nights\), \d+% when down\n/);
  });
});

describe("the CSV exports", () => {
  it("writes the header alone for no rows", () => {
    expect(hitRunCSV([])).toBe(HIT_AND_RUN_HEADER);
    expect(hitRunNightsCSV([], "America/New_York")).toBe(HIT_AND_RUN_NIGHTS_HEADER);
  });

  it("writes hit_and_run.csv with the factor, the habits and the tag", () => {
    const rows = summarize(factorNights());
    const lines = hitRunCSV(rows).split("\n");
    expect(lines[0]).toBe(HIT_AND_RUN_HEADER.trimEnd());
    const runner = lines.find((l) => l.startsWith("runner,runner,"));
    expect(runner).toBeDefined();
    expect(runner!.endsWith(",yes,Hit & runner")).toBe(true);
    expect(runner!.split(",")).toHaveLength(HIT_AND_RUN_HEADER.trimEnd().split(",").length);
  });

  it("writes one nights row with 'unknown' for no time and the peak columns filled", () => {
    const n = fakeNight("runner", 0.8, 60, 0);
    n.gameId = "pglx";
    const lines = hitRunNightsCSV([n], "America/New_York").split("\n");
    expect(lines[0]).toBe(HIT_AND_RUN_NIGHTS_HEADER.trimEnd());
    expect(lines[1]).toBe(
      "unknown,pglx,runner,runner,0,0,0,0,0,0,no,0.00,80.00,60.00,1.00,60.00,Left up,0,0,0,60.00,no,60.00,100.00,0,0.0,1.0000",
    );
  });

  it("writes the nights' calendar day in the zone given", () => {
    const n = fakeNight("runner", 0.8, 60, 0);
    n.gameId = "pglx";
    n.date = 1790000000; // 2026-09-21 in New York (UTC-4 at that date)
    const lines = hitRunNightsCSV([n], "America/New_York").split("\n");
    expect(lines[1]?.startsWith("2026-09-")).toBe(true);
  });

  it("gives playstyle.csv the hit & run columns from hitRunFacts", () => {
    const rows = summarize(factorNights());
    const facts = hitRunFacts(rows);
    const profile = { ...newProfile(), displayName: "Runner", normalizedName: "runner" };
    const csv = playstyleCSV([profile], facts);
    const line = csv.split("\n").find((l) => l.endsWith(",runner"));
    expect(line).toBeDefined();
    expect(line!.endsWith(",yes,Hit & runner,runner")).toBe(true);
  });

  it("annotates the menu 18 style rows with the tag and, with a winning night, the factor", () => {
    const rows = summarize(factorNights());
    const style = [
      { ...newStyleStats(), displayName: "Runner", normalizedName: "runner" },
      { ...newStyleStats(), displayName: "Nobody", normalizedName: "nobody" },
    ];
    const out = annotateStyle(style, rows);
    expect(out[0]?.hitRunTag).toBe("Hit & runner");
    expect(out[0]?.hitRunReliable).toBe(true);
    expect(out[0]?.hitRun).toBeGreaterThan(40);
    expect(out[1]?.hitRun).toBe(-1);
    expect(out[1]?.hitRunTag).toBe("");
  });
});

describe("the money beside the dollars, in whole cents", () => {
  it("gives the ledger's $40 result, the $0.50 blind and the $30 peak as cents", () => {
    const n = must(exitNights(), "upleft");
    expect(n.netCents).toBe(4000);
    expect(n.bigBlindCents).toBe(50);
    expect(n.peakCents).toBe(3000);
    expect(n.finalRunningCents).toBe(3000);
  });

  it("gives a night placed from the ledger's times its ledger result in cents", () => {
    const early = must(cutOffNights(), "early");
    expect(early.netCents).toBe(4000);
    expect(early.peakCents).toBe(0);
  });
});

describe("the fused multiply-add the C++ build uses", () => {
  it("rounds a * b + c once: 0.1 * 10 - 1 is 2^-54 fused, 0 unfused", () => {
    expect(fusedMulAdd(0.1, 10, -1)).toBe(2 ** -54);
    expect(0.1 * 10 - 1).toBe(0);
  });

  it("agrees with plain arithmetic when the product is exact", () => {
    expect(fusedMulAdd(2, 3, 4)).toBe(10);
    expect(fusedMulAdd(0.5, 0.25, 1)).toBe(1.125);
    expect(fusedMulAdd(3, -0.5, 2)).toBe(0.5);
  });

  it("rounds an exact tie to the even double", () => {
    // 1 + 2^-53 is exactly halfway between 1 and the next double up: it rounds to 1.
    expect(fusedMulAdd(1, 1, 2 ** -53)).toBe(1);
    // 1 + 3 * 2^-53 is halfway between 1 + 2^-52 and 1 + 2^-51: the even one is 1 + 2^-51.
    expect(fusedMulAdd(1, 1, 3 * 2 ** -53)).toBe(1 + 2 ** -51);
  });
});

describe("collecting the games in scope", () => {
  it("leaves out a game with no hand log and counts it", () => {
    const logA = buildNight([scriptOf("p1", "Stay", [[0, 9]], 50, [[5, 10]])], 10);
    const logs = new Map<string, HandLog>([["gameA", logA]]);
    const games = [gameOf("ledger_gameA", at(0), []), gameOf("ledger_gameB", at(0), [])];
    const { nights, unmeasured } = collect(games, logs, new Map(), new Map());
    expect(unmeasured).toBe(1);
    expect(nights.map((n) => n.person)).toContain("stay");
    expect(new Set(nights.map((n) => n.gameId))).toEqual(new Set(["ledger_gameA"]));
  });

  it("uses the ledger's result and the stats' display name for a person", () => {
    const log = buildNight([scriptOf("p1", "Stay", [[0, 9]], 50, [[5, 10]])], 10);
    const stats = new Map<string, PlayerStats>([["stay", fakeStats("stay", "Staying Put")]]);
    const game = gameOf("ledger_gameA", at(0), [seatRow("Stay", "p1", at(0), null, 12.5)]);
    const nights = nightsFromLog(log, game, new Map(), stats, 1);
    expect(must(nights, "stay").net).toBe(12.5);
    expect(must(nights, "stay").displayName).toBe("Staying Put");
  });
});

function fakeStats(normalizedName: string, displayName: string): PlayerStats {
  return {
    displayName,
    normalizedName,
    totalNetCents: 0,
    totalWonCents: 0,
    totalLostCents: 0,
    biggestWinCents: 0,
    biggestLossCents: 0,
    adjustmentsCents: 0,
    games: 0,
    buyIns: 0,
    history: [],
    aliases: [],
    playerIds: [],
    replay: { gameRowNetsCents: [], adjustmentCents: [] },
  };
}
