import { describe, expect, it } from "vitest";

import type { Adjustment, Game, LedgerRow, PlayTime } from "../src/models.ts";
import {
  addMergeRule,
  aggregate,
  accountsByPerson,
  displayName,
  find,
  flattenMergeRules,
  parseMergeRulesCSV,
  personOf,
  playerDollars,
  playerSummaryCSV,
  removeMergeRule,
  resolveCanonical,
  serializeMergeRulesCSV,
  sortedByName,
  sortedByNet,
  suggestMergesByPlayerId,
} from "../src/players.ts";

// Made-up sit-down time (epoch seconds) for every seat unless a test says otherwise.
const START = 1_700_000_000;

function seat(nickname: string, playerId: string, netCents: number, extra: Partial<LedgerRow> = {}): LedgerRow {
  return {
    nickname,
    playerId,
    start: START,
    end: START + 3600,
    buyInCents: 2000,
    buyOutCents: 2000 + netCents,
    stackCents: 0,
    netCents,
    owner: "",
    ownerReviewed: false,
    ...extra,
  };
}

function game(id: string, start: number | null, rows: LedgerRow[], folder = "night_one"): Game {
  return {
    id,
    path: `${folder}/${id}.csv`,
    folder,
    start,
    end: start === null ? null : start + 7200,
    totalBuyInCents: rows.reduce((sum, r) => sum + r.buyInCents, 0),
    skippedRows: 0,
    rows,
  };
}

function adjustment(playerNormalized: string, amountCents: number, extra: Partial<Adjustment> = {}): Adjustment {
  return {
    group: "debt",
    date: START + 86_400,
    playerNormalized,
    amountCents,
    folder: "",
    note: "paid back",
    ...extra,
  };
}

// Two made-up nights. Totals: ann +3.50, bo -3.50, cy -2.00, dee +2.00.
function twoNights(): Game[] {
  return [
    game("ledger_one", START, [seat("Ann", "acctA", 500), seat("Bo", "acctB", -300), seat("Cy", "acctC", -200)]),
    game("ledger_two", START + 86_400, [seat("ann", "acctA", -150), seat("Bo", "acctB", -50), seat("Dee", "acctD", 200)]),
  ];
}

describe("merge rules", () => {
  it("follows a chain to its end and stops on a cycle", () => {
    const chain = new Map([
      ["ann2", "ann"],
      ["ann", "annie"],
    ]);
    expect(resolveCanonical(chain, "ann2")).toBe("annie");
    expect(resolveCanonical(chain, "nobody")).toBe("nobody");

    const cycle = new Map([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(["a", "b"]).toContain(resolveCanonical(cycle, "a"));
  });

  it("flattens every alias to its final canonical name", () => {
    const flat = flattenMergeRules(
      new Map([
        ["x", "y"],
        ["y", "z"],
      ]),
    );
    expect([...flat]).toEqual([
      ["x", "z"],
      ["y", "z"],
    ]);
  });

  it("files a row under its owner, its normalized nickname, or its account when it has no name", () => {
    const rules = new Map([["bo", "bob"]]);
    expect(personOf(rules, seat("Bo!", "acctA", 0))).toBe("bob");
    expect(personOf(rules, seat("Ann", "acctA", 0, { owner: "bo" }))).toBe("bob");
    // Emoji only: no letters or digits, so the account's letters name it.
    expect(personOf(new Map(), seat("\u{1F642}", "acctQ9xz", 0))).toBe("unnamedacctqxz");
    // Digits only keep their digits.
    expect(personOf(new Map(), seat("1313 13", "acctA", 0))).toBe("131313");
  });

  it("adds a rule, re-points earlier aliases, and un-aliases a canonical that was an alias", () => {
    const first = addMergeRule(new Map(), "bo", "ann");
    expect([...first]).toEqual([["bo", "ann"]]);

    const repointed = addMergeRule(first, "ann", "anna");
    expect([...repointed].sort()).toEqual([
      ["ann", "anna"],
      ["bo", "anna"],
    ]);

    const unaliased = addMergeRule(new Map([["bo", "ann"]]), "cy", "bo");
    expect([...unaliased]).toEqual([["cy", "bo"]]);

    const same = addMergeRule(first, "ann", "ann");
    expect([...same]).toEqual([["bo", "ann"]]);

    // The input is untouched.
    expect([...first]).toEqual([["bo", "ann"]]);
  });

  it("removes one alias and leaves the rest alone", () => {
    const rules = new Map([
      ["bo", "ann"],
      ["cy", "ann"],
    ]);
    expect([...removeMergeRule(rules, "bo")]).toEqual([["cy", "ann"]]);
    expect(rules.size).toBe(2);
  });

  it("parses merge_rules.csv, flattening chains and skipping short or self rows", () => {
    const text = "alias_normalized,canonical_normalized\nx,y\ny,z\n\nann,ann\nlonely\n";
    expect([...parseMergeRulesCSV(text)].sort()).toEqual([
      ["x", "z"],
      ["y", "z"],
    ]);
  });

  it("writes merge_rules.csv sorted by canonical name, then alias, with the header", () => {
    expect(serializeMergeRulesCSV(new Map())).toBe("alias_normalized,canonical_normalized\n");
    const rules = new Map([
      ["zed", "ann"],
      ["bo", "cy"],
      ["ann", "ann"],
      ["amy", "ann"],
    ]);
    expect(serializeMergeRulesCSV(rules)).toBe(
      "alias_normalized,canonical_normalized\namy,ann\nzed,ann\nbo,cy\n",
    );
  });

  it("round-trips the saved text", () => {
    const text = "alias_normalized,canonical_normalized\namy,ann\nzed,ann\nbo,cy\n";
    expect(serializeMergeRulesCSV(parseMergeRulesCSV(text))).toBe(text);
  });
});

describe("aggregate", () => {
  it("totals a player's games, wins, losses and biggest result", () => {
    const stats = aggregate(twoNights(), new Map());
    const ann = find(stats, "ann");
    expect(ann).toMatchObject({
      normalizedName: "ann",
      totalNetCents: 350,
      totalWonCents: 500,
      totalLostCents: -150,
      biggestWinCents: 500,
      biggestLossCents: -150,
      games: 2,
      buyIns: 2,
      adjustmentsCents: 0,
      aliases: ["ann"],
      playerIds: ["acctA"],
    });
    expect(find(stats, "bo")).toMatchObject({ totalNetCents: -350, totalLostCents: -350, totalWonCents: 0 });
    expect(find(stats, "bo")).toMatchObject({ biggestWinCents: -50, biggestLossCents: -300 });
    expect(find(stats, "nobody")).toBeUndefined();
  });

  it("keeps the players in byte order of their normalized names", () => {
    const names = [...aggregate(twoNights(), new Map()).keys()];
    expect(names).toEqual(["ann", "bo", "cy", "dee"]);
    expect(sortedByName(aggregate(twoNights(), new Map())).map((p) => p.normalizedName)).toEqual([
      "ann",
      "bo",
      "cy",
      "dee",
    ]);
  });

  it("names a player by the nickname used most often; ties go to the shorter, then the earlier in byte order", () => {
    const most = aggregate(
      [game("g1", START, [seat("Ann!", "acctA", 0), seat("Ann!", "acctA", 0), seat("ANN", "acctA", 0)])],
      new Map(),
    );
    expect(find(most, "ann")?.displayName).toBe("Ann!");

    // "A.nn" sorts before "Ann" in bytes, so the longer name is seen first and the shorter one must replace it.
    const shorter = aggregate([game("g1", START, [seat("A.nn", "acctA", 0), seat("Ann", "acctA", 0)])], new Map());
    expect(find(shorter, "ann")?.displayName).toBe("Ann");

    const byteOrder = aggregate([game("g1", START, [seat("ann", "acctA", 0), seat("Ann", "acctA", 0)])], new Map());
    expect(find(byteOrder, "ann")?.displayName).toBe("Ann");
  });

  it("breaks a display name tie by UTF-8 bytes, not UTF-16 units", () => {
    // Both nicknames normalize to nothing, so they share a row name. Both are 4 bytes:
    // in UTF-8 the private-use "!" comes first, but in UTF-16 the emoji comes first.
    const stats = aggregate(
      [game("g1", START, [seat("\u{1F600}", "acctZq9", 10), seat("!", "acctZq9", 10)])],
      new Map(),
    );
    expect(find(stats, "unnamedacctzq")?.displayName).toBe("!");
  });

  it("uses the normalized name, capitalized, when no seat has a nickname of its own", () => {
    const stats = aggregate(
      [game("g1", START, [seat("Fay", "acctF", 100, { owner: "gus" }), seat("Hal", "acctH", -100)])],
      new Map(),
    );
    const gus = find(stats, "gus");
    expect(gus?.displayName).toBe("Gus");
    expect(find(stats, "fay")).toBeUndefined();
    // A reassigned seat's nickname and account say nothing about the owner.
    expect(gus).toMatchObject({ aliases: ["gus"], playerIds: [], totalNetCents: 100, games: 1, buyIns: 1 });
    expect(displayName(sortedByNet(stats), "gus")).toBe("Gus");
  });

  it("keeps adjustments out of the poker result and adds adjustment-only players", () => {
    const adjustments = [
      adjustment("cy", 100),
      adjustment("zed", -100, { folder: "night_one", note: "debt" }),
    ];
    const stats = aggregate(twoNights(), new Map(), adjustments);
    expect(find(stats, "cy")).toMatchObject({ totalNetCents: -200, adjustmentsCents: 100 });
    expect(find(stats, "zed")).toMatchObject({ displayName: "Zed", games: 0, totalNetCents: 0, adjustmentsCents: -100 });
    const zedHistory = find(stats, "zed")?.history ?? [];
    expect(zedHistory).toEqual([
      {
        gameId: "adjustment",
        folder: "night_one",
        date: START + 86_400,
        netCents: -100,
        buyIns: 0,
        adjustment: true,
        note: "debt",
      },
    ]);
    expect(find(stats, "cy")?.history.at(-1)?.folder).toBe("(all folders)");
  });

  it("sorts each player's history by date, then by game id, with no date first", () => {
    const stats = aggregate(
      [
        game("ledger_b", START, [seat("Ann", "acctA", 0)]),
        game("ledger_a", null, [seat("Ann", "acctA", 0)]),
        game("ledger_c", START - 86_400, [seat("Ann", "acctA", 0)]),
      ],
      new Map(),
    );
    expect(find(stats, "ann")?.history.map((r) => r.gameId)).toEqual(["ledger_a", "ledger_c", "ledger_b"]);
  });

  it("applies merge rules to every row", () => {
    const rules = new Map([["bo", "bob"]]);
    const stats = aggregate(twoNights(), rules);
    expect(find(stats, "bo")).toBeUndefined();
    expect(find(stats, "bob")).toMatchObject({ totalNetCents: -350, aliases: ["bo"], playerIds: ["acctB"] });
  });
});

describe("sorting and names", () => {
  it("sorts by net, highest first, and breaks equal nets by normalized name", () => {
    const stats = aggregate(
      [game("g1", START, [seat("Zed", "acctZ", 0), seat("Amy", "acctA", 0), seat("Cy", "acctC", 500), seat("Bo", "acctB", -500)])],
      new Map(),
    );
    expect(sortedByNet(stats).map((p) => p.normalizedName)).toEqual(["cy", "amy", "zed", "bo"]);
  });

  it("looks up a display name through aliases, and says (none) for an empty name", () => {
    const stats = aggregate(twoNights(), new Map([["bo", "bob"]]));
    const list = sortedByNet(stats);
    expect(displayName(list, "bob")).toBe("Bo");
    expect(displayName(list, "bo")).toBe("Bo");
    expect(displayName(list, "")).toBe("(none)");
    expect(displayName(list, "unknown")).toBe("unknown");
  });

  it("lists accounts by person, leaving out reassigned seats", () => {
    const games = [
      game("g1", START, [seat("Ann", "acctA", 0), seat("Ann", "acctB", 0, { owner: "bo" }), seat("Bo", "acctB", 0)]),
    ];
    const accounts = accountsByPerson(games, new Map());
    expect(accounts.get("ann")).toEqual(["acctA"]);
    expect(accounts.get("bo")).toEqual(["acctB"]);
  });
});

describe("merge suggestions", () => {
  it("asks about a name that appears only on a shared account, while it is unchecked", () => {
    const shared = [game("g1", START, [seat("Ann", "acctX", 100), seat("Bee", "acctX", -100)])];
    expect(suggestMergesByPlayerId(shared, new Map())).toEqual([
      { playerId: "acctX", canonicals: ["ann", "bee"], newNames: ["ann", "bee"] },
    ]);
  });

  it("leaves out names already confirmed, and names seen on another account", () => {
    const games = [
      game("g0", START - 86_400, [seat("Ann", "acctY", 0)]),
      game("g1", START, [seat("Ann", "acctX", 100), seat("Bee", "acctX", -100, { ownerReviewed: true })]),
    ];
    expect(suggestMergesByPlayerId(games, new Map())).toEqual([]);

    const onlyBee = [game("g1", START, [seat("Ann", "acctX", 100), seat("Bee", "acctX", -100)])];
    const withAnnElsewhere = [...onlyBee, game("g0", START - 86_400, [seat("Ann", "acctY", 0)])];
    expect(suggestMergesByPlayerId(withAnnElsewhere, new Map())).toEqual([
      { playerId: "acctX", canonicals: ["ann", "bee"], newNames: ["bee"] },
    ]);
  });

  it("skips an account with one name on it", () => {
    expect(suggestMergesByPlayerId([game("g1", START, [seat("Ann", "acctX", 0)])], new Map())).toEqual([]);
  });
});

describe("playerDollars and the summary CSV", () => {
  it("writes the header and one row per player, with no time columns when there is no time", () => {
    const list = sortedByNet(aggregate(twoNights(), new Map()));
    const csv = playerSummaryCSV(list.filter((p) => p.normalizedName === "ann"));
    expect(csv).toBe(
      "rank,display_name,normalized_name,games,buy_ins,total_won,total_lost,adjustments,total_net,avg_per_game," +
        "biggest_win,biggest_loss,aliases,hands_dealt,nights_logged,seconds_dealt,seconds_estimated,hours,per_hour\n" +
        "1,Ann,ann,2,2,5.00,-1.50,0.00,3.50,1.75,5.00,-1.50,ann,0,0,0.00,0.00,0.00,\n",
    );
  });

  it("fills the time columns and the per-hour rate from the time map", () => {
    const list = sortedByNet(aggregate(twoNights(), new Map()));
    const time = new Map<string, PlayTime>([
      ["ann", { nights: 2, nightsLogged: 1, hands: 40, secondsDealt: 1200.5, secondsEstimated: 599.5 }],
    ]);
    const row = playerSummaryCSV(list, time).split("\n")[1];
    expect(row).toBe("1,Ann,ann,2,2,5.00,-1.50,0.00,3.50,1.75,5.00,-1.50,ann,40,1,1200.50,599.50,0.50,7.00");
  });

  it("averages the exact binary value, so a quarter cent rounds up", () => {
    // 2 cents over 4 nights is 0.005, which the C++ prints as 0.01.
    const games = [
      game("g1", START, [seat("Eve", "acctE", 1)]),
      game("g2", START + 1, [seat("Eve", "acctE", 1)]),
      game("g3", START + 2, [seat("Eve", "acctE", 0)]),
      game("g4", START + 3, [seat("Eve", "acctE", 0)]),
    ];
    const eve = find(aggregate(games, new Map()), "eve");
    expect(eve).toBeDefined();
    if (eve === undefined) return;
    expect(playerDollars(eve).averagePerGame).toBe(0.005);
    expect(playerSummaryCSV([eve]).split("\n")[1]).toContain(",0.01,0.01,");
  });

  it("keeps the sign of a zero that the C++ double sum leaves slightly negative", () => {
    // 0.30 - 0.10 - 0.20 is -2.8e-17 in doubles, which printf shows as -0.00.
    const fay = find(aggregate([game("g1", START, [seat("Fay", "acctF", 30), seat("Fay", "acctF", -10), seat("Fay", "acctF", -20)])], new Map()), "fay");
    expect(fay).toBeDefined();
    if (fay === undefined) return;
    expect(fay.totalNetCents).toBe(0);
    expect(playerSummaryCSV([fay]).split("\n")[1]).toBe("1,Fay,fay,1,3,0.00,0.00,0.00,-0.00,-0.00,-0.00,-0.00,fay,0,0,0.00,0.00,0.00,");
  });
});
