import { describe, expect, it } from "vitest";

import { loadAllLogs, logIdOf, pairWithLedger } from "../src/handlog.ts";
import type { HandLog } from "../src/handlog.ts";
import { aggregate } from "../src/players.ts";
import {
  compute,
  showdownRivalsCSV,
  showdownSummary,
  SHOWDOWN_RIVALS_HEADER,
  TOP_RIVALS,
} from "../src/showdowns.ts";
import type { Rival, ShowdownRecord } from "../src/showdowns.ts";
import { SCENARIO_GAMES, SCENARIO_LOGS, SCENARIO_RULES } from "./playtime-scenario.ts";

// Made-up data only (see playtime-scenario.ts). The expected numbers were produced by the C++ reader
// (showdowns::compute and exportCSV) on the same made-up input, and the port reproduces them.
//
// What the scenario holds at showdown (A = game A, B = game B):
//   A hand 2: Charlie wins with a set of nines; Alpha and Bravo (who mucked) each lose 3.00 to him.
//   A hand 3: a chop. Alpha and Charlie both collect, so neither beats the other.
//   A hand 4: Bravo wins against Alpha. A hand 5: Delta wins against Charlie, who loses 1.00.
//   B hand 3: Bravo wins against Alpha, whose two accounts (Alpha and Echo) lose together.
//   B hand 4: Alpha wins against Bravo, who loses 1.50.
//   B hand 6: run it twice. Alpha and Bravo each collect half the pot from Charlie, whose 7-2 bounty
//             (1.00) is not part of his loss, so he loses 0.50, split 0.25 to each.
// Alpha's losses to Bravo in A hand 4 and B hand 3 add up to 12.50 (the C++ export gives the total).

function pairedLogs(): HandLog[] {
  const logs = loadAllLogs(SCENARIO_LOGS).logs;
  const inScope: HandLog[] = [];
  for (const g of SCENARIO_GAMES) {
    const log = logs.get(logIdOf(g));
    if (log === undefined) continue;
    pairWithLedger(log, g, SCENARIO_RULES);
    inScope.push(log);
  }
  return inScope;
}

function scenarioRecords(): Map<string, ShowdownRecord> {
  return compute(pairedLogs(), SCENARIO_RULES, aggregate(SCENARIO_GAMES, SCENARIO_RULES));
}

function recordOf(records: ReadonlyMap<string, ShowdownRecord>, person: string): ShowdownRecord {
  const r = records.get(person);
  if (r === undefined) throw new Error(`no showdown record for ${person}`);
  return r;
}

function rivalOf(r: ShowdownRecord, person: string): Rival | undefined {
  return r.beatenBy.find((v) => v.person === person);
}

describe("who reached showdown, and who won and lost there", () => {
  it("counts every showdown once per person, with the wins and losses as played", () => {
    const records = scenarioRecords();
    expect(recordOf(records, "alpha")).toMatchObject({
      displayName: "Alpha",
      showdowns: 6,
      won: 3,
      lost: 3,
      lostAmount: 15.5,
    });
    expect(recordOf(records, "bravo")).toMatchObject({ showdowns: 5, won: 3, lost: 2, lostAmount: 4.5 });
    expect(recordOf(records, "charlie")).toMatchObject({ showdowns: 4, won: 2, lost: 2, lostAmount: 1.5 });
    expect(recordOf(records, "delta")).toMatchObject({ showdowns: 1, won: 1, lost: 0, lostAmount: 0 });
  });

  it("keys the records by normalized name, in byte order, and gives no record to a player who never reached showdown", () => {
    const records = scenarioRecords();
    expect([...records.keys()]).toEqual(["alpha", "bravo", "charlie", "delta"]);
  });

  it("counts a shared account's two seats in one hand as one person at showdown", () => {
    // Game B hand 3: Alpha and Echo (Alpha's second account) both lost to Bravo. Alpha is one loser,
    // beaten once in that hand, and the loss is what the two accounts lost together.
    const alpha = recordOf(scenarioRecords(), "alpha");
    expect(rivalOf(alpha, "bravo")).toEqual({ person: "bravo", displayName: "Bravo", times: 2, amount: 12.5 });
  });
});

describe("beaten at showdown by", () => {
  it("shares a loss between the winners by what each collected, and leaves a bounty out of it", () => {
    const charlie = recordOf(scenarioRecords(), "charlie");
    // Hand B6 is run twice: Alpha and Bravo collect 1.50 each, so each takes half of Charlie's 0.50 loss.
    // The 1.00 7-2 bounty he paid is not part of that loss.
    expect(rivalOf(charlie, "alpha")).toEqual({ person: "alpha", displayName: "Alpha", times: 1, amount: 0.25 });
    expect(rivalOf(charlie, "bravo")).toEqual({ person: "bravo", displayName: "Bravo", times: 1, amount: 0.25 });
    expect(rivalOf(charlie, "delta")).toEqual({ person: "delta", displayName: "Delta", times: 1, amount: 1 });
  });

  it("gives no rival to a chop: the two players who chopped do not beat each other", () => {
    // A hand 3 is a chop between Alpha and Charlie; the only Alpha-Charlie rivalry is B6's, once.
    const charlie = recordOf(scenarioRecords(), "charlie");
    expect(rivalOf(charlie, "alpha")?.times).toBe(1);
  });

  it("counts a player who mucked their cards at showdown as beaten", () => {
    // Bravo mucked in A hand 2 and lost 3.00 to Charlie.
    const bravo = recordOf(scenarioRecords(), "bravo");
    expect(rivalOf(bravo, "charlie")).toEqual({ person: "charlie", displayName: "Charlie", times: 1, amount: 3 });
  });

  it("ranks the rivals by times, then by money, then by name", () => {
    const records = scenarioRecords();
    expect(recordOf(records, "alpha").beatenBy.map((v) => v.person)).toEqual(["bravo", "charlie"]);
    expect(recordOf(records, "bravo").beatenBy.map((v) => v.person)).toEqual(["charlie", "alpha"]);
    // Alpha and Bravo tie at 0.25 for Charlie: the name decides.
    expect(recordOf(records, "charlie").beatenBy.map((v) => v.person)).toEqual(["delta", "alpha", "bravo"]);
  });

  it("never lists a person as beating themselves", () => {
    for (const [key, r] of scenarioRecords()) {
      expect(r.beatenBy.some((v) => v.person === key)).toBe(false);
    }
  });
});

describe("showdown_rivals.csv", () => {
  it("writes one row per pair, losers in byte order, then the most times, then the winner's name", () => {
    const text = showdownRivalsCSV(scenarioRecords());
    expect(text).toBe(
      SHOWDOWN_RIVALS_HEADER +
        [
          "Alpha,alpha,Bravo,bravo,2,12.50",
          "Alpha,alpha,Charlie,charlie,1,3.00",
          "Bravo,bravo,Alpha,alpha,1,1.50",
          "Bravo,bravo,Charlie,charlie,1,3.00",
          "Charlie,charlie,Alpha,alpha,1,0.25",
          "Charlie,charlie,Bravo,bravo,1,0.25",
          "Charlie,charlie,Delta,delta,1,1.00",
          "",
        ].join("\n"),
    );
  });

  it("has the header the C++ export writes", () => {
    expect(SHOWDOWN_RIVALS_HEADER).toBe("loser,loser_normalized,winner,winner_normalized,times,amount\n");
  });
});

describe("the player's showdown summary", () => {
  it("says how many games have a hand log, and the showdowns won and lost with the top rivals", () => {
    const summary = showdownSummary(recordOf(scenarioRecords(), "alpha"), 3, 4);
    expect(summary).toMatchObject({
      coverText: "3 of 4 games in scope have a hand log",
      noLogs: false,
      reached: true,
      showdowns: 6,
      won: 3,
      lost: 3,
      wonPercent: 50,
      lostAmount: 15.5,
      moreRivals: 0,
    });
    expect(summary.beatenBy.map((v) => v.person)).toEqual(["bravo", "charlie"]);
  });

  it("reports a player with no showdown in the logs as having reached none", () => {
    const summary = showdownSummary(undefined, 3, 4);
    expect(summary).toMatchObject({ reached: false, noLogs: false, showdowns: 0, won: 0, lost: 0, beatenBy: [] });
  });

  it("reports when none of the games in scope has a hand log", () => {
    expect(showdownSummary(undefined, 0, 1).coverText).toBe("none of the 1 game in scope has a hand log");
    expect(showdownSummary(undefined, 0, 3).coverText).toBe("none of the 3 games in scope have a hand log");
    expect(showdownSummary(undefined, 0, 1).noLogs).toBe(true);
  });

  it("shows the first five rivals and counts the rest", () => {
    expect(TOP_RIVALS).toBe(5);
    const rivals: Rival[] = Array.from({ length: 7 }, (_, i) => ({
      person: `p${i}`,
      displayName: `P${i}`,
      times: 7 - i,
      amount: 1,
    }));
    const record: ShowdownRecord = {
      person: "x",
      displayName: "X",
      showdowns: 9,
      won: 2,
      lost: 7,
      lostAmount: 7,
      beatenBy: rivals,
    };
    const summary = showdownSummary(record, 1, 1);
    expect(summary.beatenBy).toHaveLength(5);
    expect(summary.moreRivals).toBe(2);
    expect(summary.wonPercent).toBe(22); // 2 of 9 is 22.2%
  });

  it("rounds the percentage half up", () => {
    const base = { person: "x", displayName: "X", lost: 0, lostAmount: 0, beatenBy: [] };
    expect(showdownSummary({ ...base, showdowns: 3, won: 2 }, 1, 1).wonPercent).toBe(67);
    expect(showdownSummary({ ...base, showdowns: 3, won: 1 }, 1, 1).wonPercent).toBe(33);
  });
});
