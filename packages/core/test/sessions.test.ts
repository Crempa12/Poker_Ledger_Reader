import { describe, expect, it } from "vitest";

import {
  addSettlementBatch,
  makeKey,
  combinedUnpaid,
  parseSessionBalances,
  recordPayment,
  serializeSessionBalances,
  sortedRows,
} from "../src/sessions.ts";
import type { Balances } from "../src/sessions.ts";
import type { SettlementEntry } from "../src/models.ts";

const HEADER =
  "session_id,from_display,from_normalized,to_display,to_normalized,original_amount,remaining_amount,status";

// Made-up sheets: Ada owes Ben 50.00 (open), Cy owes Ben 20.00 with 5.00 left
// (partial), Dee's 10.00 is paid, Ben owes Cy 30.00 (open).
const SHEETS = [
  "game-a,Ada,ada,Ben,ben,50.00,50.00,open",
  "game-a,Cy,cy,Ben,ben,20.00,5.00,partial",
  "game-b,Dee,dee,Eli,eli,10.00,0.00,paid",
  "game-b,Ben,ben,Cy,cy,30.00,30.00,open",
];

function balancesFrom(rows: string[]): Balances {
  return parseSessionBalances([HEADER, ...rows].join("\n"));
}

function settle(fromDisplay: string, fromNormalized: string, toDisplay: string, toNormalized: string, amountCents: number): SettlementEntry {
  return { fromDisplay, fromNormalized, toDisplay, toNormalized, amountCents, reason: "auto" };
}

describe("balance keys", () => {
  it("are session, payer and payee joined the way the C++ joins them", () => {
    expect(makeKey("game-a", "ada", "ben")).toBe("game-a|ada->ben");
  });
});

describe("session_balances.csv text", () => {
  it("reads the rows that can count, and keeps the status as written", () => {
    const balances = balancesFrom([
      ...SHEETS,
      "short,row,only,three", // fewer than eight fields
      ",Empty,,Ben,ben,1,1,open", // no session id
      "game-c,Fay!!,fay,Ben,ben,12.34,12.34,WEIRD",
    ]);
    expect(balances.size).toBe(5);
    expect(balances.get(makeKey("game-a", "ada", "ben"))).toEqual({
      sessionId: "game-a",
      fromDisplay: "Ada",
      fromNormalized: "ada",
      toDisplay: "Ben",
      toNormalized: "ben",
      originalCents: 5000,
      remainingCents: 5000,
      status: "open",
    });
    expect(balances.get(makeKey("game-c", "fay", "ben"))?.status).toBe("WEIRD");
  });

  it("keeps the last row when two rows share a key", () => {
    const balances = balancesFrom([
      "game-a,Ada,ada,Ben,ben,50.00,50.00,open",
      "game-a,Ada2,ada,Ben,ben,60.00,40.00,partial",
    ]);
    expect(balances.get(makeKey("game-a", "ada", "ben"))).toMatchObject({
      fromDisplay: "Ada2",
      originalCents: 6000,
      remainingCents: 4000,
      status: "partial",
    });
  });

  it("writes a sub-cent remaining amount the way printf does", () => {
    const text = serializeSessionBalances(balancesFrom(["game-c,Fay,fay,Ben,ben,10.00,0.005,open"]));
    expect(text).toContain("game-c,Fay,fay,Ben,ben,10.00,0.01,open");
  });

  it("writes the header and the rows in byte order (an emoji session sorts after U+E000)", () => {
    const balances = balancesFrom([
      "\u{1F642}x,Hi,hi,Ben,ben,5.00,5.00,open",
      "\u{E000}x,Lo,lo,Ben,ben,5.00,5.00,open",
      "game-b,Ben,ben,Cy,cy,30.00,30.00,open",
      '"comma, session",Eva,eva,Fox,fox,8.00,8.00,open',
    ]);
    expect(serializeSessionBalances(balances)).toBe(
      [
        HEADER,
        '"comma, session",Eva,eva,Fox,fox,8.00,8.00,open',
        "game-b,Ben,ben,Cy,cy,30.00,30.00,open",
        "\u{E000}x,Lo,lo,Ben,ben,5.00,5.00,open",
        "\u{1F642}x,Hi,hi,Ben,ben,5.00,5.00,open",
        "",
      ].join("\n"),
    );
  });

  it("writes a file the app wrote back unchanged", () => {
    const canonical = [
      HEADER,
      '"comma, session",Eva,eva,Fox,fox,8.00,8.00,open',
      "game-a,Ada,ada,Ben,ben,50.00,50.00,open",
      "game-a,Cy,cy,Ben,ben,20.00,5.00,partial",
      "game-b,Ben,ben,Cy,cy,30.00,30.00,open",
      "game-b,Dee,dee,Eli,eli,10.00,0.00,paid",
      "",
    ].join("\n");
    expect(serializeSessionBalances(parseSessionBalances(canonical))).toBe(canonical);
  });

  it("writes only the header when there are no balances", () => {
    expect(serializeSessionBalances(new Map())).toBe(HEADER + "\n");
  });
});

describe("sorted balances", () => {
  it("lists by session, payer, then payee, and can leave out the paid ones", () => {
    const balances = balancesFrom(SHEETS);
    const keys = (rows: { sessionId: string; fromNormalized: string; toNormalized: string }[]): string[] =>
      rows.map((r) => makeKey(r.sessionId, r.fromNormalized, r.toNormalized));
    expect(keys(sortedRows(balances, false))).toEqual([
      "game-a|ada->ben",
      "game-a|cy->ben",
      "game-b|ben->cy",
      "game-b|dee->eli",
    ]);
    expect(keys(sortedRows(balances, true))).toEqual(["game-a|ada->ben", "game-a|cy->ben", "game-b|ben->cy"]);
  });
});

describe("adding a settlement sheet", () => {
  it("starts new pairs open and adds to existing ones", () => {
    const before = balancesFrom(SHEETS);
    const after = addSettlementBatch(before, "game-a", [
      settle("Ada", "ada", "Ben", "ben", 2500), // open 50.00 -> 75.00, still open
      settle("Cy", "cy", "Ben", "ben", 1000), // partial 20.00 (5.00 left) -> 30.00 (15.00 left)
      settle("Dee", "dee", "Ben", "ben", 400), // new
    ]);
    expect(after.get(makeKey("game-a", "ada", "ben"))).toMatchObject({
      originalCents: 7500,
      remainingCents: 7500,
      status: "open",
    });
    expect(after.get(makeKey("game-a", "cy", "ben"))).toMatchObject({
      originalCents: 3000,
      remainingCents: 1500,
      status: "partial",
    });
    expect(after.get(makeKey("game-a", "dee", "ben"))).toMatchObject({
      fromDisplay: "Dee",
      originalCents: 400,
      remainingCents: 400,
      status: "open",
    });
  });

  it("makes a paid pair partial again when more is added to it", () => {
    const after = addSettlementBatch(balancesFrom(SHEETS), "game-b", [settle("Dee", "dee", "Eli", "eli", 400)]);
    expect(after.get(makeKey("game-b", "dee", "eli"))).toMatchObject({
      originalCents: 1400,
      remainingCents: 400,
      status: "partial",
    });
  });

  it("keeps the names an existing pair already has", () => {
    const after = addSettlementBatch(balancesFrom(SHEETS), "game-a", [settle("ADA", "ada", "BEN", "ben", 100)]);
    expect(after.get(makeKey("game-a", "ada", "ben"))).toMatchObject({ fromDisplay: "Ada", toDisplay: "Ben" });
  });

  it("does not change the balances it was given", () => {
    const before = balancesFrom(SHEETS);
    addSettlementBatch(before, "game-a", [settle("Cy", "cy", "Ben", "ben", 1000)]);
    expect(before.get(makeKey("game-a", "cy", "ben"))).toMatchObject({ originalCents: 2000, remainingCents: 500 });
  });
});

describe("recording a payment", () => {
  const before = balancesFrom(SHEETS);
  const pair = (fromNormalized: string, toNormalized: string) => ({ fromNormalized, toNormalized });

  it("takes a partial payment off the remaining amount", () => {
    const result = recordPayment(before, "game-a", pair("ada", "ben"), 2000);
    expect(result.balance).toMatchObject({ remainingCents: 3000, status: "partial" });
    expect(result.balances.get(makeKey("game-a", "ada", "ben"))).toMatchObject({ remainingCents: 3000 });
    expect(result.appliedCents).toBe(2000);
    expect(result.overpaidCents).toBe(0);
  });

  it("marks a balance paid when the payment covers it exactly", () => {
    const result = recordPayment(before, "game-a", pair("cy", "ben"), 500);
    expect(result.balance).toMatchObject({ remainingCents: 0, status: "paid" });
    expect(result.appliedCents).toBe(500);
  });

  it("clears a balance on an over-payment and reports the excess without keeping it", () => {
    const result = recordPayment(before, "game-a", pair("cy", "ben"), 900);
    expect(result.balance).toMatchObject({ remainingCents: 0, status: "paid", originalCents: 2000 });
    expect(result.appliedCents).toBe(500);
    expect(result.overpaidCents).toBe(400);
  });

  it("records a single cent as a partial payment", () => {
    const result = recordPayment(before, "game-a", pair("ada", "ben"), 1);
    expect(result.balance).toMatchObject({ remainingCents: 4999, status: "partial" });
  });

  it("changes nothing for a zero payment or a balance that is not there", () => {
    const zero = recordPayment(before, "game-a", pair("ada", "ben"), 0);
    expect(zero.balances).toBe(before);
    expect(zero.balance).toBeNull();
    const missing = recordPayment(before, "game-z", pair("ada", "ben"), 500);
    expect(missing.balances).toBe(before);
    expect(missing.balance).toBeNull();
  });

  it("returns new balances and leaves the ones it was given alone", () => {
    const result = recordPayment(before, "game-a", pair("ada", "ben"), 2000);
    expect(result.balances).not.toBe(before);
    expect(before.get(makeKey("game-a", "ada", "ben"))).toMatchObject({ remainingCents: 5000, status: "open" });
  });
});

describe("what is still owed across every sheet", () => {
  it("adds up each pair over the sheets, biggest first, and leaves out what is paid", () => {
    const balances = balancesFrom([
      "game-a,Ada,ada,Ben,ben,50.00,50.00,open",
      "game-b,Ada,ada,Ben,ben,10.00,4.00,partial",
      "game-a,Cy,cy,Ben,ben,20.00,5.00,partial",
      "game-b,Ben,ben,Cy,cy,30.00,30.00,open",
      "game-b,Dee,dee,Eli,eli,10.00,0.00,paid",
    ]);
    expect(combinedUnpaid(balances)).toEqual([
      { fromDisplay: "Ada", fromNormalized: "ada", toDisplay: "Ben", toNormalized: "ben", totalCents: 5400 },
      { fromDisplay: "Ben", fromNormalized: "ben", toDisplay: "Cy", toNormalized: "cy", totalCents: 3000 },
      { fromDisplay: "Cy", fromNormalized: "cy", toDisplay: "Ben", toNormalized: "ben", totalCents: 500 },
    ]);
  });

  it("keeps equal totals in payer-then-payee byte order", () => {
    const balances = balancesFrom([
      "s1,Cy,cy,Dee,dee,10.00,10.00,open",
      "s1,Ada,ada,Ben,ben,10.00,10.00,open",
      "s1,Eli,eli,Dee,dee,10.00,10.00,open",
      "s1,Fay,fay,Ben,ben,20.00,20.00,open",
    ]);
    expect(combinedUnpaid(balances).map((d) => `${d.fromNormalized}->${d.toNormalized}`)).toEqual([
      "fay->ben",
      "ada->ben",
      "cy->dee",
      "eli->dee",
    ]);
  });

  it("is empty when every sheet is paid", () => {
    expect(combinedUnpaid(balancesFrom(["s1,Dee,dee,Eli,eli,10.00,0.00,paid"]))).toEqual([]);
  });
});
