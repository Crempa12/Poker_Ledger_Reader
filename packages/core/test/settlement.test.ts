import { describe, expect, it } from "vitest";

import type { PaymentPreference, PlayerStats, Settings } from "../src/models.ts";
import {
  calculate,
  calculateSheet,
  libcppSort,
  loadPreferencesCSV,
  loadSettingsCSV,
  savePreferencesCSV,
  saveSettingsCSV,
  settlementsCSV,
  warningText,
  type SheetEntry,
} from "../src/settlement.ts";

// Made-up players only. Expected sheets were produced by running the C++ app's
// settlement::calculate, exportCSV and file functions on the same inputs.

const HEADER = "from,to,amount,reason,from_normalized,to_normalized\n";

// A player whose balance is `cents` (poker result plus any adjustment).
function player(norm: string, display: string, cents: number, adjustmentsCents = 0): PlayerStats {
  return {
    displayName: display,
    normalizedName: norm,
    totalNetCents: cents - adjustmentsCents,
    totalWonCents: 0,
    totalLostCents: 0,
    biggestWinCents: 0,
    biggestLossCents: 0,
    adjustmentsCents,
    games: 0,
    buyIns: 0,
    history: [],
    aliases: [],
    playerIds: [],
  };
}

function pin(payer: string, payee: string, oneOff = false, note = ""): PaymentPreference {
  return { payerNormalized: payer, payeeNormalized: payee, note, oneOff };
}

// Net money received minus paid, per normalized name.
function flows(entries: SheetEntry[]): Map<string, number> {
  const net = new Map<string, number>();
  for (const e of entries) {
    net.set(e.fromNormalized, (net.get(e.fromNormalized) ?? 0) - e.amountCents);
    net.set(e.toNormalized, (net.get(e.toNormalized) ?? 0) + e.amountCents);
  }
  return net;
}

// After the sheet, every player's received-minus-paid equals the balance they started with.
function expectSettles(players: PlayerStats[], entries: SheetEntry[]): void {
  const net = flows(entries);
  for (const p of players) {
    const balance = p.totalNetCents + p.adjustmentsCents;
    expect(net.get(p.normalizedName) ?? 0, p.normalizedName).toBe(balance);
  }
}

// A small deterministic generator, so the random cases are the same on every run.
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

// Balances (cents) that sum to exactly zero, the last one closing the sum.
function zeroSumBalances(n: number, seed: number, spread: number): number[] {
  const next = lcg(seed);
  const bal: number[] = [];
  for (let i = 0; i < n - 1; i++) bal.push((next() % (2 * spread + 1)) - spread);
  bal.push(-bal.reduce((x, y) => x + y, 0));
  return bal;
}

function namesFor(n: number): { norm: string; display: string }[] {
  return Array.from({ length: n }, (_, i) => {
    const k = String(i + 1).padStart(2, "0");
    return { norm: `p${k}`, display: `Pat${k}` };
  });
}

describe("EPSILON on whole cents", () => {
  it("the C++ 0.009-dollar test gives the same answer as the whole-cent test", () => {
    // Every balance is a whole number of cents, so the dollar test and the cent test must agree.
    for (let c = -3; c <= 3; c++) {
      const dollars = c / 100;
      expect(dollars > 0.009, `c=${c} >`).toBe(c >= 1);
      expect(dollars < -0.009, `c=${c} <`).toBe(c <= -1);
      expect(dollars > -0.009 && dollars < 0.009, `c=${c} zero`).toBe(c === 0);
    }
  });
});

describe("payment_preferences.csv", () => {
  const text = [
    "payer_normalized,payee_normalized,note",
    "ann,bea,Venmo only",
    ",cal,dropped no payer",
    "dee,dee,dropped same person",
    'eve,fay,"Cash, in person"',
    'gus,hal,"says ""hi"""',
    "  ivy , jo ,  trimmed note  ",
    "short",
    "",
  ].join("\n");

  it("loads pins, skipping rows with a missing name, a self-pin or one field", () => {
    expect(loadPreferencesCSV(text)).toEqual([
      pin("ann", "bea", false, "Venmo only"),
      pin("eve", "fay", false, "Cash, in person"),
      pin("gus", "hal", false, 'says "hi"'),
      pin("ivy", "jo", false, "trimmed note"),
    ]);
  });

  it("saves the same bytes the C++ savePreferencesCSV writes", () => {
    const prefs = loadPreferencesCSV(text);
    expect(savePreferencesCSV(prefs)).toBe(
      'payer_normalized,payee_normalized,note\nann,bea,Venmo only\neve,fay,"Cash, in person"\n' +
        'gus,hal,"says ""hi"""\nivy,jo,trimmed note\n',
    );
  });

  it("never writes a one-off request", () => {
    expect(savePreferencesCSV([pin("ann", "bea"), pin("cal", "dee", true)])).toBe(
      "payer_normalized,payee_normalized,note\nann,bea,\n",
    );
  });
});

describe("settings.csv", () => {
  const base: Settings = { me: "keepme", banker: "", simpleDisplay: false };

  it("loads me, banker and display, keeping keys the file leaves out", () => {
    const text = "key,value\r\nme,Ann Lee\r\nbanker,\r\ndisplay,Simple\r\n";
    expect(loadSettingsCSV(text, base)).toEqual({ me: "annlee", banker: "", simpleDisplay: true });
    expect(loadSettingsCSV("key,value\nbanker,Bea\n", base)).toEqual({
      me: "keepme",
      banker: "bea",
      simpleDisplay: false,
    });
  });

  it("saves the same bytes the C++ saveSettingsCSV writes", () => {
    expect(saveSettingsCSV({ me: "annlee", banker: "", simpleDisplay: true })).toBe(
      "key,value\nme,annlee\nbanker,\ndisplay,simple\n",
    );
    expect(saveSettingsCSV({ me: "", banker: "bea", simpleDisplay: false })).toBe(
      "key,value\nme,\nbanker,bea\ndisplay,fancy\n",
    );
  });
});

describe("sheet against the C++ calculate", () => {
  it("banker: every loser pays the banker and the banker pays every winner", () => {
    const players = [player("ann", "Ann", 3000), player("ben", "Ben", -1000), player("cal", "Cal", -2000)];
    const sheet = calculateSheet(players, [], "ann");
    expect(settlementsCSV(sheet.entries)).toBe(
      HEADER + "Ben,Ann,10.00,banker,ben,ann\nCal,Ann,20.00,banker,cal,ann\n",
    );
    expect(sheet.warnings).toEqual([]);
  });

  it("banker with a gap: the banker pays out more than their own result covers", () => {
    const players = [player("ann", "Ann", 3000), player("ben", "Ben", -1000), player("cal", "Cal", -1000)];
    const sheet = calculateSheet(players, [], "ann");
    expect(settlementsCSV(sheet.entries)).toBe(
      HEADER + "Ben,Ann,10.00,banker,ben,ann\nCal,Ann,10.00,banker,cal,ann\n",
    );
    expect(sheet.warnings).toEqual([{ totalCents: 1000, effect: "banker-pays-more", amountCents: 1000 }]);
    expect(warningText(sheet.warnings[0]!)).toEqual([
      "This sheet does not balance: its totals add up to +$10.00 instead of $0.00.",
      "The banker pays out $10.00 more than their own result covers.",
      "The cause is a one-sided correction or a ledger that does not balance.",
    ]);
  });

  it("banker holding money nobody is owed", () => {
    const players = [player("ann", "Ann", 1000), player("ben", "Ben", -3000), player("cal", "Cal", -1000)];
    const sheet = calculateSheet(players, [], "ann");
    expect(settlementsCSV(sheet.entries)).toBe(
      HEADER + "Ben,Ann,30.00,banker,ben,ann\nCal,Ann,10.00,banker,cal,ann\n",
    );
    expect(sheet.warnings).toEqual([{ totalCents: -3000, effect: "banker-holds", amountCents: 3000 }]);
    expect(warningText(sheet.warnings[0]!)[1]).toBe("The banker is left holding $30.00 that nobody is owed.");
  });

  it("a pin with partial room pays only what both sides have, then the rest is matched", () => {
    // Ann owes 30, Bea is owed 10 (pinned), Cal is owed 20.
    const players = [player("ann", "Ann", -3000), player("bea", "Bea", 1000), player("cal", "Cal", 2000)];
    const sheet = calculateSheet(players, [pin("ann", "bea")], "");
    expect(settlementsCSV(sheet.entries)).toBe(
      HEADER + "Ann,Bea,10.00,preference,ann,bea\nAnn,Cal,20.00,auto,ann,cal\n",
    );
    expect(sheet.warnings).toEqual([]);
  });

  it("a one-off request is tagged requested and goes first when listed first", () => {
    const players = [player("ann", "Ann", -3000), player("bea", "Bea", 1000), player("cal", "Cal", 2000)];
    const sheet = calculateSheet(players, [pin("ann", "cal", true)], "");
    expect(settlementsCSV(sheet.entries)).toBe(
      HEADER + "Ann,Cal,20.00,requested,ann,cal\nAnn,Bea,10.00,auto,ann,bea\n",
    );
  });

  it("a pin that has no room on one side is skipped, and the automatic pass settles the rest", () => {
    // Ann is owed, so "Ann always pays Bea" has no room. Bea pays Ann by the automatic pass.
    const players = [player("ann", "Ann", 1000), player("bea", "Bea", -1000)];
    expect(calculate(players, [pin("ann", "bea")], "")).toEqual([
      { fromDisplay: "Bea", fromNormalized: "bea", toDisplay: "Ann", toNormalized: "ann", amountCents: 1000, reason: "auto" },
    ]);
    // A pin to someone with no balance (or no ledger line) does nothing.
    expect(calculate(players, [pin("bea", "ghost")], "")).toEqual(
      calculate(players, [], ""),
    );
  });

  it("balances that split into several zero-sum groups need one payment per pair", () => {
    const players = [
      player("a1", "A1", 500),
      player("b1", "B1", -500),
      player("c1", "C1", 300),
      player("d1", "D1", -300),
      player("e1", "E1", 700),
      player("f1", "F1", -700),
    ];
    const sheet = calculateSheet(players, [], "");
    expect(settlementsCSV(sheet.entries)).toBe(
      HEADER + "B1,A1,5.00,auto,b1,a1\nD1,C1,3.00,auto,d1,c1\nF1,E1,7.00,auto,f1,e1\n",
    );
    expectSettles(players, sheet.entries);
  });

  it("a debt too big for any one credit is split, smallest covering credit first", () => {
    // Losers -40 and -60; winners +30, +50, +20. The biggest loser pays first.
    const players = [
      player("w1", "W1", 3000),
      player("w2", "W2", 5000),
      player("w3", "W3", 2000),
      player("l1", "L1", -4000),
      player("l2", "L2", -6000),
    ];
    const sheet = calculateSheet(players, [], "");
    expect(settlementsCSV(sheet.entries)).toBe(
      HEADER +
        "L2,W2,50.00,auto,l2,w2\nL2,W3,10.00,auto,l2,w3\nL1,W1,30.00,auto,l1,w1\nL1,W3,10.00,auto,l1,w3\n",
    );
    expectSettles(players, sheet.entries);
  });

  it("one payer with a single credit that covers the debt", () => {
    const players = [player("ann", "Ann", 3000), player("ben", "Ben", -4000), player("cal", "Cal", 1000)];
    const sheet = calculateSheet(players, [], "");
    expect(settlementsCSV(sheet.entries)).toBe(
      HEADER + "Ben,Ann,30.00,auto,ben,ann\nBen,Cal,10.00,auto,ben,cal\n",
    );
  });

  it("nobody owes anything: no payments and no warning", () => {
    const players = [player("a", "Ann", 0), player("b", "Ben", 0, 0), player("c", "Cal", 0, 500)];
    const sheet = calculateSheet(players, [pin("a", "b")], "");
    expect(sheet.entries).toEqual([]);
    expect(sheet.warnings).toEqual([]);
    expect(settlementsCSV(sheet.entries)).toBe(HEADER);
  });

  it("one-cent remainders are settled to the cent", () => {
    const players = [player("a", "Ann", 1), player("b", "Ben", -2), player("c", "Cal", 1)];
    const sheet = calculateSheet(players, [], "");
    expect(settlementsCSV(sheet.entries)).toBe(
      HEADER + "Ben,Ann,0.01,auto,b,a\nBen,Cal,0.01,auto,b,c\n",
    );
    expect(sheet.warnings).toEqual([]);
  });

  it("a one-cent gap is reported as winners short", () => {
    const sheet = calculateSheet([player("a", "Ann", 1)], [], "");
    expect(sheet.entries).toEqual([]);
    expect(sheet.warnings).toEqual([{ totalCents: 1, effect: "winners-short", amountCents: 1 }]);
    expect(warningText(sheet.warnings[0]!)[1]).toBe("Some winners get $0.01 less than the table above shows.");
  });

  it("exact ties: the first loser in sort order pays the first creditor", () => {
    const players = [
      player("a", "Ann", -1000),
      player("b", "Ben", -1000),
      player("c", "Cal", 1000),
      player("d", "Dee", 1000),
    ];
    const sheet = calculateSheet(players, [], "");
    expect(settlementsCSV(sheet.entries)).toBe(HEADER + "Ann,Cal,10.00,auto,a,c\nBen,Dee,10.00,auto,b,d\n");
  });

  it("a display name with a comma is quoted in the CSV", () => {
    const players = [player("a", "Ann,Jr", -1000), player("b", "Ben", 1000)];
    expect(settlementsCSV(calculate(players, [], ""))).toBe(HEADER + '"Ann,Jr",Ben,10.00,auto,a,b\n');
  });

  it("pins are ignored in banker mode", () => {
    const players = [player("ann", "Ann", -1000), player("bea", "Bea", 3000), player("cal", "Cal", -2000)];
    expect(settlementsCSV(calculate(players, [pin("ann", "bea")], "ann"))).toBe(
      HEADER + "Cal,Ann,20.00,banker,cal,ann\nAnn,Bea,30.00,banker,ann,bea\n",
    );
  });

  it("a 21-player game takes the peel path and matches the C++ sheet", () => {
    const bal = [
      50000, -30000, 30000, -12000, -18000, 7500, -9000, 2505, -1002, -1503, 4000, -6000, 9990, -4990, -5000, 1235,
      -1235, 1000, -2000, 700,
    ];
    bal.push(-bal.reduce((x, y) => x + y, 0));
    expect(bal).toHaveLength(21);
    const names = namesFor(21);
    const players = bal.map((c, i) => player(names[i]!.norm, names[i]!.display, c));
    const sheet = calculateSheet(players, [], "");
    expect(settlementsCSV(sheet.entries)).toBe(
      HEADER +
        [
          "Pat02,Pat03,300.00,auto,p02,p03",
          "Pat17,Pat16,12.35,auto,p17,p16",
          "Pat10,Pat08,15.03,auto,p10,p08",
          "Pat09,Pat08,10.02,auto,p09,p08",
          "Pat15,Pat11,40.00,auto,p15,p11",
          "Pat15,Pat18,10.00,auto,p15,p18",
          "Pat05,Pat01,180.00,auto,p05,p01",
          "Pat21,Pat01,162.00,auto,p21,p01",
          "Pat04,Pat01,120.00,auto,p04,p01",
          "Pat07,Pat13,90.00,auto,p07,p13",
          "Pat12,Pat06,60.00,auto,p12,p06",
          "Pat14,Pat01,38.00,auto,p14,p01",
          "Pat14,Pat06,11.90,auto,p14,p06",
          "Pat19,Pat13,9.90,auto,p19,p13",
          "Pat19,Pat20,7.00,auto,p19,p20",
          "Pat19,Pat06,3.10,auto,p19,p06",
        ].join("\n") +
        "\n",
    );
    expect(sheet.warnings).toEqual([]);
    expectSettles(players, sheet.entries);
  });
});

describe("random zero-sum sheets settle every player", () => {
  it("each player ends at zero and no more payments than people minus one", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const n = 2 + (seed % 11);
      const bal = zeroSumBalances(n, seed * 7919, 5000);
      const names = namesFor(n);
      const players = bal.map((c, i) => player(names[i]!.norm, names[i]!.display, c));
      const sheet = calculateSheet(players, [], "");
      expect(sheet.warnings).toEqual([]);
      expectSettles(players, sheet.entries);
      const nonZero = bal.filter((c) => c !== 0).length;
      expect(sheet.entries.length).toBeLessThanOrEqual(Math.max(0, nonZero - 1));
      for (const e of sheet.entries) expect(e.amountCents).toBeGreaterThan(0);
    }
  });
});

describe("time for big games", () => {
  it("a 20-person game (the bitmask search at its limit) finishes well under a second", () => {
    const names = namesFor(20);
    const bal = zeroSumBalances(20, 424242, 5_000_000);
    const players = bal.map((c, i) => player(names[i]!.norm, names[i]!.display, c));
    const started = performance.now();
    const sheet = calculateSheet(players, [], "");
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expectSettles(players, sheet.entries);
  });

  it("a 22-person game (the zero-sum subset search) finishes well under a second", () => {
    const names = namesFor(22);
    const bal = zeroSumBalances(22, 987654, 5_000_000);
    const players = bal.map((c, i) => player(names[i]!.norm, names[i]!.display, c));
    const started = performance.now();
    const sheet = calculateSheet(players, [], "");
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(sheet.warnings).toEqual([]);
    expectSettles(players, sheet.entries);
  });
});

describe("libcppSort matches std::sort (libc++) order, including ties", () => {
  // Expected orders printed by the C++ std::sort on the same keys.
  const cases: { keys: number[]; order: number[] }[] = [
    { keys: [3, 1, 2, 1, 3, 2, 1], order: [1, 3, 6, 2, 5, 0, 4] },
    { keys: [2, 2, 1, 1], order: [2, 3, 0, 1] },
    { keys: [5, 5, 1, 5, 1, 5, 1, 5], order: [2, 4, 6, 0, 1, 3, 5, 7] },
    {
      keys: Array.from({ length: 38 }, (_, i) => (i % 2 === 0 ? 1 : 0)),
      order: [
        37, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 35, 33, 31, 29, 27, 25, 23, 21, 18, 20, 16, 22, 14, 24, 12, 26, 10,
        28, 8, 30, 6, 32, 4, 34, 2, 36, 0,
      ],
    },
    {
      keys: [
        0, 1, 2, 3, 8, 5, 6, 7, 8, 28, 10, 11, 12, 13, 14, 15, 16, 18, 17, 19,
        20, 21, 22, 23, 24, 25, 26, 27, 9, 29, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20,
        19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 4, 7, 6, 5, 4, 3, 2, 1,
      ],
      order: [
        0, 58, 1, 57, 2, 56, 3, 55, 51, 54, 5, 53, 6, 7, 52, 8, 4, 28, 50, 10,
        49, 11, 48, 12, 47, 13, 46, 14, 45, 44, 15, 43, 16, 18, 42, 17, 41, 40, 19, 39,
        20, 38, 21, 22, 37, 36, 23, 35, 24, 34, 25, 33, 26, 32, 27, 9, 31, 30, 29,
      ],
    },
    {
      keys: [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 26, 16, 17, 18, 19,
        20, 21, 3, 23, 24, 25, 15, 27, 28, 22, 30, 30, 29, 28, 27, 26, 25, 24, 23, 22,
        21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 29, 2,
        1,
      ],
      order: [
        0, 60, 1, 59, 2, 22, 3, 57, 4, 56, 5, 6, 55, 7, 54, 53, 8, 52, 9, 51,
        10, 11, 50, 49, 12, 48, 13, 14, 47, 46, 26, 45, 16, 17, 44, 18, 43, 42, 19, 20,
        41, 40, 21, 39, 29, 38, 23, 24, 37, 25, 36, 15, 35, 27, 34, 33, 28, 32, 58, 31,
        30,
      ],
    },
    {
      keys: Array.from({ length: 61 }, () => 0),
      order: Array.from({ length: 61 }, (_, i) => i),
    },
  ];

  for (const [index, c] of cases.entries()) {
    it(`case ${index + 1} (${c.keys.length} keys)`, () => {
      const items = c.keys.map((amount, id) => ({ amount, id }));
      libcppSort(items, 0, items.length, (a, b) => a.amount < b.amount);
      expect(items.map((x) => x.id)).toEqual(c.order);
    });
  }
});
