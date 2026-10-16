import { describe, expect, it } from "vitest";

import { loadAllLogs, logIdOf, pairWithLedger } from "../src/handlog.ts";
import type { HandLog } from "../src/handlog.ts";
import { aggregate, playerSummaryCSV, sortedByNet } from "../src/players.ts";
import type { PlayTime } from "../src/models.ts";
import {
  collect,
  DEFAULT_HAND_SECONDS,
  hasSeatTime,
  hoursText,
  isEstimated,
  MAX_HAND_SECONDS,
  nights,
  summarize,
} from "../src/playtime.ts";
import type { Night } from "../src/playtime.ts";
import { SCENARIO_GAMES, SCENARIO_GAME_IDS, SCENARIO_LOGS, SCENARIO_RULES } from "./playtime-scenario.ts";

// Made-up data only (see playtime-scenario.ts). The expected numbers were produced by the C++
// reader (playtime::nights, summarize, hoursText and exportPlayerSummaryCSV) on the same made-up
// input, and the port reproduces them byte for byte.

// The scenario's hand logs, paired with their ledgers the way the app pairs them.
function pairedLogs(): Map<string, HandLog> {
  const logs = loadAllLogs(SCENARIO_LOGS).logs;
  for (const g of SCENARIO_GAMES) {
    const log = logs.get(logIdOf(g));
    if (log !== undefined) pairWithLedger(log, g, SCENARIO_RULES);
  }
  return logs;
}

function allNights(): Night[] {
  return nights(SCENARIO_GAMES, pairedLogs(), SCENARIO_RULES);
}

function nightOf(list: readonly Night[], gameId: string, person: string): Night {
  const found = list.find((n) => n.gameId === gameId && n.person === person);
  if (found === undefined) throw new Error(`no night for ${person} in ${gameId}`);
  return found;
}

function totalOf(person: string): PlayTime {
  const t = summarize(allNights()).get(person);
  if (t === undefined) throw new Error(`no time for ${person}`);
  return t;
}

describe("a hand lasts until the next hand starts", () => {
  it("counts each hand by the gap to the next one, and caps a break at ten minutes", () => {
    // Game A starts at 03:00:00, 03:00:20, 03:00:50, 03:20:50 and 03:21:10: gaps of 20, 30, 1200
    // (a break, so 600) and 20. The last hand gets the median gap, 25.
    expect(MAX_HAND_SECONDS).toBe(600);
    expect(DEFAULT_HAND_SECONDS).toBe(36);
    expect(nightOf(allNights(), SCENARIO_GAME_IDS.a, "alpha")).toMatchObject({
      logged: true,
      hands: 5,
      secondsDealt: 695,
      secondsEstimated: 0,
    });
  });

  it("gives the last hand of a night the median of that night's gaps", () => {
    // Game B's hands 3 to 6 start 40 seconds apart, then 30, then 40: the last hand gets 40.
    expect(nightOf(allNights(), SCENARIO_GAME_IDS.b, "alpha")).toMatchObject({ hands: 4, secondsDealt: 150 });
  });

  it("gives a one-hand night the default 36 seconds", () => {
    expect(nightOf(allNights(), SCENARIO_GAME_IDS.d, "foxtrot")).toMatchObject({
      logged: true,
      hands: 1,
      secondsDealt: 36,
      secondsEstimated: 0,
    });
  });

  it("counts a person once in a hand even when they sit on two accounts", () => {
    // Echo is Alpha's second account. Hand 3 of game B has both; Alpha is dealt it once.
    expect(nightOf(allNights(), SCENARIO_GAME_IDS.b, "alpha").hands).toBe(4);
  });

  it("counts someone dealt into a hand who has no ledger seat in that game", () => {
    expect(nightOf(allNights(), SCENARIO_GAME_IDS.b, "charlie")).toMatchObject({
      logged: true,
      hands: 1,
      secondsDealt: 40,
      secondsEstimated: 0,
    });
  });
});

describe("ledger seat time stands in where no hand log measures it", () => {
  it("uses the ledger seat windows for a night with no hand log, the open seat ending at the game's end", () => {
    const list = allNights();
    // Alpha's two overlapping seats are one stretch (04:30 to 04:50); Foxtrot's open seat runs to 05:00.
    expect(nightOf(list, SCENARIO_GAME_IDS.c, "alpha")).toMatchObject({ logged: false, hands: 0, secondsEstimated: 1200 });
    expect(nightOf(list, SCENARIO_GAME_IDS.c, "charlie")).toMatchObject({ logged: false, secondsEstimated: 1800 });
    expect(nightOf(list, SCENARIO_GAME_IDS.c, "foxtrot")).toMatchObject({ logged: false, secondsEstimated: 1200 });
    // A seat with no start time is not counted.
    expect(nightOf(list, SCENARIO_GAME_IDS.c, "delta")).toMatchObject({ logged: false, secondsEstimated: 0 });
  });

  it("counts the time seated before a cut-short log starts as an estimate, once where seats overlap", () => {
    // Game B's log starts at hand 3 (04:00:00). Alpha was seated from 03:50 (and Echo from 03:55): 600 s.
    // Bravo was seated from 03:40 to 03:58: 1080 s.
    const list = allNights();
    expect(nightOf(list, SCENARIO_GAME_IDS.b, "alpha").secondsEstimated).toBe(600);
    expect(nightOf(list, SCENARIO_GAME_IDS.b, "bravo").secondsEstimated).toBe(1080);
  });

  it("estimates nothing for a log that starts at hand 1", () => {
    for (const n of allNights()) {
      if (n.gameId === SCENARIO_GAME_IDS.a || n.gameId === SCENARIO_GAME_IDS.d) expect(n.secondsEstimated).toBe(0);
    }
  });
});

describe("per person, over the games in scope", () => {
  it("adds the nights up, counting the nights with a hand log that dealt them a hand", () => {
    expect(totalOf("alpha")).toEqual({
      nights: 4,
      nightsLogged: 3,
      hands: 10,
      secondsDealt: 881,
      secondsEstimated: 1800,
    });
    expect(totalOf("bravo")).toEqual({ nights: 2, nightsLogged: 2, hands: 9, secondsDealt: 845, secondsEstimated: 1080 });
    expect(totalOf("charlie")).toEqual({ nights: 3, nightsLogged: 2, hands: 6, secondsDealt: 735, secondsEstimated: 1800 });
    expect(totalOf("delta")).toEqual({ nights: 2, nightsLogged: 1, hands: 1, secondsDealt: 25, secondsEstimated: 0 });
    // Foxtrot: game C (no log, 1200 seconds of seat time) and game D (a log that dealt him one hand).
    expect(totalOf("foxtrot")).toEqual({ nights: 2, nightsLogged: 1, hands: 1, secondsDealt: 36, secondsEstimated: 1200 });
  });

  it("keys the result by normalized name, in byte order", () => {
    expect([...collect(SCENARIO_GAMES, pairedLogs(), SCENARIO_RULES).keys()]).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "foxtrot",
    ]);
  });

  it("writes the hours text with a tilde when any of the time is an estimate, and one decimal", () => {
    expect(hoursText(totalOf("alpha"))).toBe("~0.7 h");
    expect(hoursText(totalOf("delta"))).toBe("0.0 h");
    expect(isEstimated(totalOf("alpha"))).toBe(true);
    expect(isEstimated(totalOf("delta"))).toBe(false);
  });

  it("rounds the hours text the way printf does, an exact tie to the even digit", () => {
    const at = (secondsDealt: number, secondsEstimated = 0): PlayTime => ({
      nights: 1,
      nightsLogged: 0,
      hands: 0,
      secondsDealt,
      secondsEstimated,
    });
    expect(hoursText(at(900))).toBe("0.2 h"); // 0.25 exactly: the even digit
    expect(hoursText(at(1800))).toBe("0.5 h");
    expect(hoursText(at(1000, 2000))).toBe("~0.8 h"); // 0.8333 h, estimated
  });

  it("gives a rate only when there is a second of seat time", () => {
    expect(hasSeatTime(totalOf("delta"))).toBe(true); // 25 seconds
    expect(hasSeatTime({ nights: 0, nightsLogged: 0, hands: 0, secondsDealt: 0.5, secondsEstimated: 0 })).toBe(false);
  });
});

describe("the player summary takes the times", () => {
  it("writes the time columns of player_summary.csv exactly as the C++ app does", () => {
    const stats = sortedByNet(aggregate(SCENARIO_GAMES, SCENARIO_RULES));
    const text = playerSummaryCSV(stats, collect(SCENARIO_GAMES, pairedLogs(), SCENARIO_RULES));
    expect(text).toBe(
      [
        "rank,display_name,normalized_name,games,buy_ins,total_won,total_lost,adjustments,total_net,avg_per_game,biggest_win,biggest_loss,aliases,hands_dealt,nights_logged,seconds_dealt,seconds_estimated,hours,per_hour",
        "1,Bravo,bravo,2,2,0.00,-200.00,0.00,-200.00,-100.00,-100.00,-100.00,bravo,9,2,845.00,1080.00,0.53,-374.03",
        "2,Charlie,charlie,2,2,0.00,-200.00,0.00,-200.00,-100.00,-100.00,-100.00,charlie,6,2,735.00,1800.00,0.70,-284.02",
        "3,Delta,delta,2,2,0.00,-200.00,0.00,-200.00,-100.00,-100.00,-100.00,delta,1,1,25.00,0.00,0.01,-28800.00",
        "4,Foxtrot,foxtrot,2,2,0.00,-200.00,0.00,-200.00,-100.00,-100.00,-100.00,foxtrot,1,1,36.00,1200.00,0.34,-582.52",
        "5,Alpha,alpha,4,6,0.00,-600.00,0.00,-600.00,-150.00,-100.00,-200.00,alpha | echo,10,3,881.00,1800.00,0.74,-805.67",
        "",
      ].join("\n"),
    );
  });
});
