import { describe, expect, it } from "vitest";

import { parseHandLog, type Hand, type HandLog } from "../src/handlog.ts";
import {
  PLAYSTYLE_CSV_HEADER,
  SizeBucket,
  af,
  afFlop,
  analyze,
  archetype,
  bbPer100,
  bigBlindOf,
  kMinOpportunities,
  newProfile,
  overbetShare,
  playstyleCSV,
  poolAverages,
  positionsFor,
  rateReliable,
  typicalBetSize,
  type HitRunFacts,
  type Profile,
} from "../src/playstyle.ts";
import { PLAYSTYLE_NIGHT } from "./fixtures/playstyle-night.ts";
import { PLAYSTYLE_NIGHT_CSV } from "./fixtures/playstyle-night-golden.ts";

// Made-up data only: every name, id, card and amount here is invented (the FAKE... ids).

// A hand log from entries in time order, written the way PokerNow writes it (a header, then the
// rows newest first, each with its order column), and read back by the handlog parser.
function logOf(entries: readonly string[], gameId = "pglPS01"): HandLog {
  const field = (s: string): string => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const base = Date.UTC(2031, 4, 6, 3, 0, 0);
  const rows = entries.map((e, i) => `${field(e)},${new Date(base + i * 1000).toISOString()},${i + 1}`);
  const text = ["entry,at,order", ...rows.reverse()].join("\n") + "\n";
  const parsed = parseHandLog({ relativePath: `poker_now_log_${gameId}.csv`, text });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.log;
}

function handNumbered(log: HandLog, number: number): Hand {
  const hand = log.hands.find((h) => h.number === number);
  if (hand === undefined) throw new Error(`no hand #${number}`);
  return hand;
}

function rowFor(rows: readonly Profile[], name: string): Profile {
  const row = rows.find((r) => r.normalizedName === name);
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
}

function withFields(over: Partial<Profile>): Profile {
  return { ...newProfile(), ...over };
}

function rate(made: number, opportunities: number): { made: number; opportunities: number } {
  return { made, opportunities };
}

// The fields of one CSV row, keyed by the header's column names.
function csvRow(csv: string, rowIndex: number): Record<string, string> {
  const lines = csv.trimEnd().split("\n");
  const header = (lines[0] ?? "").split(",");
  const cells = (lines[rowIndex] ?? "").split(",");
  const out: Record<string, string> = {};
  header.forEach((name, i) => {
    out[name] = cells[i] ?? "";
  });
  return out;
}

const NIGHT_ROWS = analyze([logOf(PLAYSTYLE_NIGHT)], new Map(), new Map());

describe("playstyleCSV: the playstyle.csv export", () => {
  it("writes the same bytes as the C++ export for the made-up night", () => {
    expect(playstyleCSV(NIGHT_ROWS)).toBe(PLAYSTYLE_NIGHT_CSV);
  });

  it("starts with the C++ header, and every row has as many fields as the header", () => {
    expect(PLAYSTYLE_NIGHT_CSV.startsWith(PLAYSTYLE_CSV_HEADER)).toBe(true);
    const columns = PLAYSTYLE_CSV_HEADER.trimEnd().split(",").length;
    for (const line of PLAYSTYLE_NIGHT_CSV.trimEnd().split("\n")) {
      expect(line.split(",").length).toBe(columns);
    }
  });

  it("leaves the hit & run columns blank, no and empty without hit & run facts", () => {
    const csv = playstyleCSV([withFields({ displayName: "Ada", normalizedName: "ada", hands: 1 })]);
    const row = (csv.trimEnd().split("\n")[1] ?? "");
    expect(row.endsWith(",,no,,ada")).toBe(true);
  });

  it("takes the hit & run columns from the facts it is given, keyed by canonical name", () => {
    const facts = new Map<string, HitRunFacts>([
      ["ada", { hitRun: 42.5, hitRunReliable: true, hitRunTag: "Hit & runner", hitRunLine: "" }],
    ]);
    const csv = playstyleCSV([withFields({ displayName: "Ada", normalizedName: "ada", hands: 1 })], facts);
    expect((csv.trimEnd().split("\n")[1] ?? "").endsWith(",42.50,yes,Hit & runner,ada")).toBe(true);
  });

  it("rounds the way printf does: an exact tie goes to the even digit", () => {
    // 1 in 800 is exactly 0.125 percent (printf writes 0.12) and a net of 1.125 dollars is exact too.
    const csv = playstyleCSV([
      withFields({ displayName: "Ada", normalizedName: "ada", vpip: rate(1, 800), net: 1.125 }),
      withFields({ displayName: "Bo", normalizedName: "bo", net: -1.125 }),
    ]);
    const ada = csvRow(csv, 1);
    expect(ada["vpip_pct"]).toBe("0.12");
    expect(ada["vpip_n"]).toBe("800");
    expect(ada["net"]).toBe("1.12");
    expect(csvRow(csv, 2)["net"]).toBe("-1.12");
  });

  it("quotes a display name that has a comma", () => {
    const entries = PLAYSTYLE_NIGHT.map((e) => e.replaceAll('"Dee @', '"Dee, Jr @'));
    const csv = playstyleCSV(analyze([logOf(entries)], new Map(), new Map()));
    const row = csv.split("\n").find((line) => line.startsWith('"Dee, Jr",'));
    expect(row).toBeDefined();
    expect(row?.endsWith(",deejr")).toBe(true);
  });
});

describe("analyze: the made-up night", () => {
  it("orders the rows by hands dealt in, then by display name", () => {
    expect(NIGHT_ROWS.map((p) => p.normalizedName)).toEqual(["ada", "bo", "cy", "dee"]);
    expect(analyze([], new Map(), new Map())).toEqual([]);
  });

  it("counts preflop chances against the unopened pot, and leaves the bomb pot out", () => {
    const ada = rowFor(NIGHT_ROWS, "ada");
    expect(ada.hands).toBe(7);
    expect(ada.handsVoluntary).toBe(6); // hand 2 is a bomb pot
    expect(ada.vpip).toEqual(rate(5, 6));
    expect(ada.pfr).toEqual(rate(2, 6));
    expect(ada.limp).toEqual(rate(2, 3));
    expect(ada.openRaise).toEqual(rate(1, 3));
    expect(ada.steal).toEqual(rate(1, 3));
    expect(ada.threeBet).toEqual(rate(1, 4));
    expect(ada.foldToOpen).toEqual(rate(1, 4));
    expect(ada.blindDefend).toEqual(rate(2, 2));
    expect(ada.vpipLate).toEqual(rate(3, 4));
    expect(ada.vpipBlinds).toEqual(rate(2, 2));
    expect(ada.vpipEarly).toEqual(rate(0, 0));
  });

  it("counts the steal, the defence and the fold to a three-bet from each seat", () => {
    const bo = rowFor(NIGHT_ROWS, "bo");
    expect(bo.steal).toEqual(rate(2, 2));
    expect(bo.blindDefend).toEqual(rate(2, 2));
    expect(bo.threeBet).toEqual(rate(0, 2));
    expect(bo.foldToThreeBet).toEqual(rate(1, 1));
    const cy = rowFor(NIGHT_ROWS, "cy");
    expect(cy.vpip).toEqual(rate(0, 5));
    expect(cy.foldToOpen).toEqual(rate(4, 4));
    expect(cy.blindDefend).toEqual(rate(0, 2));
    const dee = rowFor(NIGHT_ROWS, "dee");
    expect(dee.steal).toEqual(rate(1, 1));
    expect(dee.blindDefend).toEqual(rate(0, 1));
  });

  it("counts continuation bets, folds to them, check-raise and donk chances after the flop", () => {
    const ada = rowFor(NIGHT_ROWS, "ada");
    expect(ada.cbet).toEqual(rate(1, 1));
    expect(ada.foldToCbet).toEqual(rate(2, 2));
    expect(ada.checkRaise).toEqual(rate(0, 2));
    expect(ada.donkBet).toEqual(rate(0, 2));
    const bo = rowFor(NIGHT_ROWS, "bo");
    expect(bo.cbet).toEqual(rate(2, 2));
    expect(bo.foldToCbet).toEqual(rate(1, 2));
    expect(bo.checkRaise).toEqual(rate(0, 2));
    expect(bo.donkBet).toEqual(rate(0, 2));
    const dee = rowFor(NIGHT_ROWS, "dee");
    expect(dee.cbet).toEqual(rate(1, 1));
    expect(dee.foldToCbet).toEqual(rate(0, 1));
    expect(dee.checkRaise).toEqual(rate(1, 2));
    expect(dee.donkBet).toEqual(rate(0, 1));
  });

  it("counts aggression by street, the bet-size bands and the typical band", () => {
    const bo = rowFor(NIGHT_ROWS, "bo");
    expect(afFlop(bo)).toBe(1); // two bets, two calls on the flop
    expect(bo.betSize).toEqual([0, 2, 2, 0, 1, 0]);
    expect(bo.betSize[SizeBucket.From33To50]).toBe(2);
    expect(bo.betSizeSamples).toBe(5);
    expect(typicalBetSize(bo)).toBe("1/3-1/2 (40% of bets)");
    expect(overbetShare(bo)).toBeCloseTo(20, 9);
    const dee = rowFor(NIGHT_ROWS, "dee");
    expect(dee.betSize).toEqual([1, 1, 0, 0, 0, 0]);
    expect(typicalBetSize(dee)).toBe("<1/3 pot (50% of bets)");
    // Ada's bomb-pot bet has no pot to size against, so it is not a sample.
    expect(rowFor(NIGHT_ROWS, "ada").betSize).toEqual([0, 0, 1, 0, 1, 0]);
  });

  it("counts the money, the biggest pot and the showdown", () => {
    expect(rowFor(NIGHT_ROWS, "ada").net).toBeCloseTo(-13.5, 9);
    expect(rowFor(NIGHT_ROWS, "bo").net).toBeCloseTo(-16.5, 9);
    expect(rowFor(NIGHT_ROWS, "cy").net).toBeCloseTo(2, 9);
    const dee = rowFor(NIGHT_ROWS, "dee");
    expect(dee.net).toBeCloseTo(28, 9);
    expect(bbPer100(dee)).toBeCloseTo(933.3333, 3);
    expect(rowFor(NIGHT_ROWS, "ada").biggestPot).toBe(6.5);
    expect(rowFor(NIGHT_ROWS, "bo").biggestPot).toBe(14);
    expect(rowFor(NIGHT_ROWS, "cy").courtesyReveals).toBe(1); // flashed one card at showdown
    const bo = rowFor(NIGHT_ROWS, "bo");
    expect(bo.showdownsTabled).toBe(1);
    expect(bo.wtsd).toEqual(rate(1, 5));
    expect(bo.wsd).toEqual(rate(1, 1));
    expect(bo.showdownHandClass.get("Pair, Aces")).toBe(1);
    expect(rowFor(NIGHT_ROWS, "ada").wtsd).toEqual(rate(0, 4));
  });

  it("reads the hit & run fields as unset (-1, not reliable, empty)", () => {
    const ada = rowFor(NIGHT_ROWS, "ada");
    expect(ada.hitRun).toBe(-1);
    expect(ada.hitRunReliable).toBe(false);
    expect(ada.hitRunTag).toBe("");
  });
});

describe("continuation bets and donk bets", () => {
  // Ada raises from the button, Bo folds, Cy calls from the big blind. Cy, who did not raise, bets
  // first on the flop (a donk bet), and Ada calls: Ada had no continuation-bet chance behind it.
  const entries = [
    `-- starting hand #1 (id: FAKEh01) (dealer: "Ada @ FAKEp01")`,
    `Player stacks: #1 "Ada @ FAKEp01" (100.00) | #2 "Bo @ FAKEp02" (100.00) | #3 "Cy @ FAKEp03" (100.00)`,
    `"Bo @ FAKEp02" posts a small blind of 0.50`,
    `"Cy @ FAKEp03" posts a big blind of 1.00`,
    `"Ada @ FAKEp01" raises to 3.00`,
    `"Bo @ FAKEp02" folds`,
    `"Cy @ FAKEp03" calls 2.00`,
    `Flop: [2♠, 7♦, 9♣]`,
    `"Cy @ FAKEp03" bets 2.00`,
    `"Ada @ FAKEp01" calls 2.00`,
    `Turn: 2♠, 7♦, 9♣ [4♥]`,
    `"Cy @ FAKEp03" bets 4.00`,
    `"Ada @ FAKEp01" folds`,
    `Uncalled bet of 4.00 returned to "Cy @ FAKEp03"`,
    `"Cy @ FAKEp03" collected 10.50 from pot`,
    `-- ending hand #1 --`,
  ];

  it("counts Cy's donk bet and gives Ada no continuation-bet chance", () => {
    const rows = analyze([logOf(entries)], new Map(), new Map());
    const cy = rowFor(rows, "cy");
    expect(cy.donkBet).toEqual(rate(1, 1));
    expect(cy.betsFlop).toBe(1);
    const ada = rowFor(rows, "ada");
    expect(ada.cbet).toEqual(rate(0, 0));
    expect(ada.callsFlop).toBe(1);
  });
});

describe("bet-size bands", () => {
  // Heads-up: Ada on the button and small blind, Bo in the big blind. The pot is 2.00 when Bo bets
  // on the flop and Ada folds. Six hands, one bet in each band.
  const bets = ["0.50", "0.80", "1.20", "1.60", "2.40", "3.20"];
  const entries = bets.flatMap((bet, i) => [
    `-- starting hand #${i + 1} (id: FAKEb${i + 1}) (dealer: "Ada @ FAKEp01")`,
    `Player stacks: #1 "Ada @ FAKEp01" (100.00) | #2 "Bo @ FAKEp02" (100.00)`,
    `"Ada @ FAKEp01" posts a small blind of 0.50`,
    `"Bo @ FAKEp02" posts a big blind of 1.00`,
    `"Ada @ FAKEp01" calls 1.00`,
    `"Bo @ FAKEp02" checks`,
    `Flop: [2♠, 7♦, 9♣]`,
    `"Bo @ FAKEp02" bets ${bet}`,
    `"Ada @ FAKEp01" folds`,
    `Uncalled bet of ${bet} returned to "Bo @ FAKEp02"`,
    `"Bo @ FAKEp02" collected 2.00 from pot`,
    `-- ending hand #${i + 1} --`,
  ]);

  it("puts one bet of each size into its band: under a third to over one and a half pots", () => {
    const bo = rowFor(analyze([logOf(entries)], new Map(), new Map()), "bo");
    expect(bo.betSize).toEqual([1, 1, 1, 1, 1, 1]);
    expect(bo.betSizeSamples).toBe(6);
    expect(overbetShare(bo)).toBeCloseTo(100 / 3, 9);
    expect(typicalBetSize(bo)).toBe("<1/3 pot (17% of bets)");
  });
});

describe("positionsFor", () => {
  const log = logOf(PLAYSTYLE_NIGHT);

  it("labels a four-handed hand from the dealer marker", () => {
    const pos = positionsFor(handNumbered(log, 1)); // Ada dealer, Bo small blind, Cy big blind, Dee cutoff
    expect(pos.get("FAKEp01")).toBe("BTN");
    expect(pos.get("FAKEp02")).toBe("SB");
    expect(pos.get("FAKEp03")).toBe("BB");
    expect(pos.get("FAKEp04")).toBe("CO");
  });

  it("labels a heads-up hand: the button is the small blind", () => {
    const pos = positionsFor(handNumbered(log, 4));
    expect(pos.get("FAKEp01")).toBe("BTN");
    expect(pos.get("FAKEp02")).toBe("BB");
  });

  it("falls back to the live blinds when there is no dealer marker", () => {
    const noDealer = logOf([
      `-- starting hand #1 (id: FAKEh01)`,
      `Player stacks: #1 "Ada @ FAKEp01" (100.00) | #2 "Bo @ FAKEp02" (100.00) | #3 "Cy @ FAKEp03" (100.00)`,
      `"Bo @ FAKEp02" posts a small blind of 0.50`,
      `"Cy @ FAKEp03" posts a big blind of 1.00`,
      `-- ending hand #1 --`,
    ]);
    const pos = positionsFor(handNumbered(noDealer, 1));
    expect(pos.get("FAKEp01")).toBe("BTN");
    expect(pos.get("FAKEp02")).toBe("SB");
    expect(pos.get("FAKEp03")).toBe("BB");
  });

  it("gives no positions when neither a dealer nor a live blind can anchor the seats", () => {
    const anonymous = logOf([
      `-- starting hand #1 (id: FAKEh01)`,
      `Player stacks: #1 "Ada @ FAKEp01" (100.00) | #2 "Bo @ FAKEp02" (100.00)`,
      `"Ada @ FAKEp01" calls 1.00`,
      `-- ending hand #1 --`,
    ]);
    expect(positionsFor(handNumbered(anonymous, 1)).size).toBe(0);
  });

  it("reads the big blind in force, and none for a bomb pot", () => {
    expect(bigBlindOf(handNumbered(log, 1))).toBe(1);
    expect(bigBlindOf(handNumbered(log, 2))).toBe(0);
  });
});

describe("archetype", () => {
  it("reads a loose, aggressive player against the pool", () => {
    const p = withFields({ handsVoluntary: 300, vpip: rate(40, 100), pfr: rate(30, 100) });
    expect(archetype(p, 30, 20)).toBe("Loose-aggressive");
  });

  it("reads a tight, passive player", () => {
    const p = withFields({ handsVoluntary: 300, vpip: rate(15, 100), pfr: rate(3, 100) });
    expect(archetype(p, 30, 20)).toBe("Tight-passive");
  });

  it("reads a player at the pool average as average and balanced", () => {
    const p = withFields({ handsVoluntary: 300, vpip: rate(30, 100), pfr: rate(10, 100) });
    expect(archetype(p, 30, 20)).toBe("Average-balanced");
  });

  it("adds station to a passive player who folds to continuation bets rarely", () => {
    const p = withFields({
      handsVoluntary: 300,
      vpip: rate(30, 100),
      pfr: rate(8, 100),
      foldToCbet: rate(10, 40),
    });
    expect(archetype(p, 30, 20)).toBe("Average-passive (station)");
  });

  it("does not call a player a station on too few continuation-bet chances", () => {
    const p = withFields({
      handsVoluntary: 300,
      vpip: rate(30, 100),
      pfr: rate(8, 100),
      foldToCbet: rate(5, kMinOpportunities - 1),
    });
    expect(archetype(p, 30, 20)).toBe("Average-passive");
  });

  it("adds fires and folds to a player who raises well above the pool and folds to continuation bets", () => {
    const p = withFields({
      handsVoluntary: 300,
      vpip: rate(50, 100),
      pfr: rate(40, 100),
      foldToCbet: rate(25, 40),
    });
    expect(archetype(p, 30, 20)).toBe("Loose-aggressive (fires and folds)");
  });

  it("says too few hands below 200 voluntary hands", () => {
    const p = withFields({ handsVoluntary: 199, vpip: rate(40, 100), pfr: rate(30, 100) });
    expect(archetype(p, 30, 20)).toBe("(too few hands)");
  });
});

describe("pool averages and small rules", () => {
  it("averages VPIP and PFR over the players with 200 or more voluntary hands", () => {
    const pool = poolAverages([
      withFields({ handsVoluntary: 300, vpip: rate(40, 100), pfr: rate(30, 100) }),
      withFields({ handsVoluntary: 199, vpip: rate(90, 100), pfr: rate(10, 100) }),
      withFields({ handsVoluntary: 200, vpip: rate(20, 100), pfr: rate(10, 100) }),
    ]);
    expect(pool.counted).toBe(2);
    expect(pool.poolVpip).toBeCloseTo(30, 9);
    expect(pool.poolPfr).toBeCloseTo(20, 9);
  });

  it("gives aggression 99 with bets and no calls, and 0 with neither", () => {
    expect(af(0, 0, 0)).toBe(0);
    expect(af(2, 1, 0)).toBe(99);
    expect(af(1, 0, 4)).toBe(0.25);
    expect(af(1, 1, 2)).toBe(1);
  });

  it("reads a rate as reliable from the minimum opportunity count", () => {
    expect(kMinOpportunities).toBe(25);
    expect(rateReliable(rate(0, kMinOpportunities - 1))).toBe(false);
    expect(rateReliable(rate(0, kMinOpportunities))).toBe(true);
  });

  it("reports no typical band and a zero overbet share with no bets", () => {
    const p = newProfile();
    expect(typicalBetSize(p)).toBe("-");
    expect(overbetShare(p)).toBe(0);
    expect(bbPer100(p)).toBe(0);
  });

  it("reads the bb per 100 hands from the blind-normalized net", () => {
    expect(bbPer100(withFields({ hands: 200, netBigBlinds: 10 }))).toBeCloseTo(5, 9);
  });
});
