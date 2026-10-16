import { describe, expect, it } from "vitest";

import {
  asciiCards,
  atShowdown,
  computeStyle,
  discoverHandLogFiles,
  gameIdFromPath,
  loadAllLogs,
  logIdOf,
  newStyleStats,
  nightSeries,
  pairWithLedger,
  parseHandLog,
  personAt,
  shownCardCount,
  styleLabel,
  styleStatsCSV,
  STYLE_CSV_HEADER,
  type HandLog,
} from "../src/handlog.ts";
import type { Game, LedgerRow } from "../src/models.ts";
import type { MergeRules } from "../src/players.ts";

// Made-up data only: every name and id here is invented (FAKE...), and every amount is made up.
// The night below is the one the C++ app's reader was run on (its style export is copied into
// the golden test), so the expected values come from that run, not from this port.

// A PokerNow-style log: entries in time order. The file lists them newest first with an
// order column, as PokerNow writes it.
function csv(field: string): string {
  return /[",\n]/.test(field) ? '"' + field.replace(/"/g, '""') + '"' : field;
}

function logText(entries: readonly string[]): string {
  const rows = entries.map((entry, i) => {
    const at = new Date(Date.UTC(2031, 4, 6, 3, 0, 0) + i * 7000).toISOString();
    return `${csv(entry)},${at},${i + 1}`;
  });
  return ["entry,at,order", ...rows.reverse()].join("\n") + "\n";
}

const NIGHT: string[] = [
  '-- starting hand #1 (id: FAKEh01) (dealer: "Alpha @ FAKEp1")',
  'Player stacks: #1 "Alpha @ FAKEp1" (100.00) | #2 "Bravo @ FAKEp2" (100.00) | #3 "Charlie @ FAKEp3" (50.00)',
  '"Alpha @ FAKEp1" posts a small blind of 0.50',
  '"Bravo @ FAKEp2" posts a big blind of 1.00',
  "Your hand is K♦, 9♠",
  '"Charlie @ FAKEp3" raises to 3.00',
  '"Alpha @ FAKEp1" folds',
  '"Bravo @ FAKEp2" calls 2.00',
  "Flop: [K♥, 7♣, 2♦]",
  '"Bravo @ FAKEp2" bets 2.00',
  '"Charlie @ FAKEp3" raises to 6.00 and go all in',
  '"Bravo @ FAKEp2" folds',
  'Uncalled bet of 4.00 returned to "Charlie @ FAKEp3"',
  '"Charlie @ FAKEp3" collected 9.50 from pot',
  '"Charlie @ FAKEp3" shows a K♠.',
  "-- ending hand #1 --",
  '"Alpha @ FAKEp1" shows a A♣.',
  '"Alpha @ FAKEp1" paid 1.00 for the 7-2 bounty to "Bravo @ FAKEp2"',
  '-- starting hand #2 (id: FAKEh02) (dealer: "Bravo @ FAKEp2")',
  'Player stacks: #1 "Alpha @ FAKEp1" (97.00) | #2 "Bravo @ FAKEp2" (97.00) | #3 "Charlie @ FAKEp3" (59.50)',
  '"Alpha @ FAKEp1" posts a small blind of 0.50',
  '"Bravo @ FAKEp2" posts a big blind of 1.00',
  '"Charlie @ FAKEp3" posts a missing small blind of 0.50',
  '"Alpha @ FAKEp1" posts a missed big blind of 1.00',
  '"Charlie @ FAKEp3" calls 1.00',
  '"Bravo @ FAKEp2" checks',
  '"Alpha @ FAKEp1" checks',
  "Flop: [9♠, 9♦, 3♣]",
  '"Alpha @ FAKEp1" bets 1.00',
  '"Bravo @ FAKEp2" folds',
  '"Alpha @ FAKEp1" shows a 9♥, 9♣.',
  '"Charlie @ FAKEp3" shows a 2♠.',
  "\"Alpha @ FAKEp1\" collected 4.50 from pot with Full House, 9's over 3's (combination: 9♠, 9♦, 9♥, 3♣, 3♠)",
  "-- ending hand #2 --",
  '-- starting hand #3 (id: FAKEh03) (dealer: "Charlie @ FAKEp3")',
  'Player stacks: #1 "Alpha @ FAKEp1" (100.00) | #2 "Bravo @ FAKEp2" (98.00) | #3 "Charlie @ FAKEp3" (100.00)',
  '"Alpha @ FAKEp1" bets 1.00 (bomb pot bet)',
  '"Bravo @ FAKEp2" calls 1.00 (bomb pot bet)',
  '"Charlie @ FAKEp3" calls 1.00 (bomb pot bet)',
  "Flop: [A♠, 4♦, 5♣]",
  '"Alpha @ FAKEp1" bets 3.00',
  '"Bravo @ FAKEp2" calls 3.00',
  '"Charlie @ FAKEp3" raises to 9.00',
  '"Alpha @ FAKEp1" folds',
  '"Bravo @ FAKEp2" folds',
  '"Charlie @ FAKEp3" collected 6.00 from pot',
  "-- ending hand #3 --",
  '-- starting hand #4 (id: FAKEh04) (dealer: "Alpha @ FAKEp1")',
  'Player stacks: #1 "Alpha @ FAKEp1" (100.00) | #2 "Bravo @ FAKEp2" (100.00)',
  '"Bravo @ FAKEp2" posts a small blind of 0.50',
  '"Alpha @ FAKEp1" posts a big blind of 1.00',
  '"Bravo @ FAKEp2" raises to 3.00',
  '"Alpha @ FAKEp1" calls 2.00',
  "Flop: [Q♠, J♠, 10♠]",
  "Turn: Q♠, J♠, 10♠ [K♠]",
  "River: Q♠, J♠, 10♠, K♠ [2♣]",
  "All players in hand choose to run it twice",
  '"Alpha @ FAKEp1" shows a A♠, 3♥.',
  '"Bravo @ FAKEp2" shows a K♣.',
  '"Bravo @ FAKEp2" shows a K♥.',
  '"Bravo @ FAKEp2" collected 50.00 from pot with Straight (combination: K♠, K♣)',
  '"Alpha @ FAKEp1" collected 50.00 from pot with Straight (combination: A♠, 3♥)',
  "-- ending hand #4 --",
  'The player "Delta @ FAKEp4" requested a rebuy of 40.00',
  'The player "Delta @ FAKEp4" rebought. New stack 40.00.',
  'The admin updated the player "Alpha @ FAKEp1" stack from 1.27 to 51.27.',
  'The admin updated the player "Bravo @ FAKEp2" stack from 60.00 to 20.00.',
  'The admin "Alpha @ FAKEp1" forced the player "Charlie @ FAKEp3" to away mode in the next hand.',
  'The admin "Alpha @ FAKEp1" enqueued the removal of the player "Delta @ FAKEp4".',
  'The player "Echo @ FAKEp5" joined the game with a stack of 100.00.',
  '-- starting hand #5 (id: FAKEh05) (dealer: "Charlie @ FAKEp3")',
  'Player stacks: #1 "Alpha @ FAKEp1" (51.27) | #2 "Bravo @ FAKEp2" (20.00) | #3 "Charlie @ FAKEp3" (50.00) | #4 "Echo @ FAKEp5" (100.00)',
  '"Alpha @ FAKEp1" posts a small blind of 0.50',
  '"Bravo @ FAKEp2" posts a big blind of 1.00',
  '"Echo @ FAKEp5" paid 1.00 for the 7-2 bounty to "Alpha @ FAKEp1"',
  '"Charlie @ FAKEp3" folds',
  '"Echo @ FAKEp5" folds',
  '"Alpha @ FAKEp1" folds',
  'Uncalled bet of 0.50 returned to "Bravo @ FAKEp2"',
  '"Bravo @ FAKEp2" collected 1.50 from pot',
  "-- ending hand #5 --",
  '-- starting hand #6 (id: FAKEh06) (dealer: "Echo @ FAKEp5")',
  'Player stacks: #1 "Echo @ FAKEp5" (100.00) | #2 "Alpha @ FAKEp1" (51.27)',
  '"Alpha @ FAKEp1" posts a small blind of 0.50',
  '"Echo @ FAKEp5" posts a big blind of 1.00',
  '"Alpha @ FAKEp1" calls 0.50',
];

// The style export the C++ app wrote for NIGHT (menu 18, no ledger, no merge rules).
const NIGHT_STYLE_CSV = [
  STYLE_CSV_HEADER,
  "Alpha,alpha,1,6,40.00,0.00,40.00,100.00,100.00,50.00,99.00,2,50.00,45.00,0.00,0,(few hands),,no,,2,2,2,2,1",
  "Bravo,bravo,1,5,50.00,25.00,75.00,33.33,100.00,0.00,1.00,2,50.00,40.00,1.00,0,(few hands),,no,,3,1,1,1,0",
  "Charlie,charlie,1,4,66.67,33.33,66.67,50.00,0.00,0.00,99.00,2,9.50,-1.00,0.00,1,(few hands),,no,,2,1,1,0,2",
  "Echo,echo,1,2,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0,0.00,-2.00,-1.00,0,(few hands),,no,,0,0,0,0,0",
  "",
].join("\n");

// The raw fields of one CSV line: a quoted field keeps its quotes, so a comma inside it does not split.
function rawFields(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    if (c === "," && !quoted) {
      out.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

function parseOk(relativePath: string, text: string): HandLog {
  const parsed = parseHandLog({ relativePath, text });
  if (!parsed.ok) throw new Error(`expected a log, got: ${parsed.error}`);
  return parsed.log;
}

function night(): HandLog {
  return parseOk("poker_now_log_pglFAKEA.csv", logText(NIGHT));
}

describe("reading a made-up night", () => {
  it("reads the hands, their order and the folder of a file at the top of the root", () => {
    const log = night();
    expect(log.gameId).toBe("pglFAKEA");
    expect(log.folder).toBe("(root)");
    expect(log.hands.map((h) => h.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(log.hands[0]?.id).toBe("FAKEh01");
    expect(log.hands[0]?.myCards).toBe("K♦, 9♠");
    expect(log.hands[0]?.board).toEqual(["K♥", "7♣", "2♦"]);
  });

  it("keeps the cut-short last hand, and reads the hand-ended marker as the end of a hand", () => {
    const log = night();
    const last = log.hands[5];
    expect(last?.number).toBe(6);
    expect(last?.seats.map((s) => s.playerId)).toEqual(["FAKEp5", "FAKEp1"]);
  });

  it("works out each hand's money in dollars and cents, with the 7-2 bounty in that hand's net", () => {
    const h1 = night().hands[0];
    expect(h1).toBeDefined();
    if (h1 === undefined) return;
    expect(Object.fromEntries(h1.netCents)).toEqual({ FAKEp1: -150, FAKEp2: -300, FAKEp3: 450 });
    expect(Object.fromEntries(h1.bountyCents)).toEqual({ FAKEp1: -100, FAKEp2: 100 });
    const sum = [...h1.netCents.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(0);
    expect(h1.potCents).toBe(950);
    expect(Object.fromEntries(h1.collectedCents)).toEqual({ FAKEp3: 950 });
    expect(h1.showdown).toBe(false);
    expect([...h1.folded].sort()).toEqual(["FAKEp1", "FAKEp2"]);
    // The double-dollar replay the C++ keeps: the same values, exact.
    expect(h1.net.get("FAKEp1")).toBe(-1.5);
    expect(h1.net.get("FAKEp2")).toBe(-3);
    expect(h1.net.get("FAKEp3")).toBe(4.5);
  });

  it("names the blinds, the all-in raise and the uncalled bet", () => {
    const h1 = night().hands[0];
    expect(h1?.actions[0]).toMatchObject({ kind: "post", post: "smallBlind", amountCents: 50, street: "preflop" });
    expect(h1?.actions[1]).toMatchObject({ kind: "post", post: "bigBlind", amountCents: 100 });
    const allIn = h1?.actions.find((a) => a.allIn);
    expect(allIn).toMatchObject({ playerId: "FAKEp3", kind: "raise", amountCents: 600, street: "flop" });
  });

  it("reads dead and missed blinds as their own kinds, and a showdown with one flashed card", () => {
    const h2 = night().hands[1];
    expect(h2?.actions.map((a) => a.post)).toContain("deadSmallBlind");
    expect(h2?.actions.map((a) => a.post)).toContain("missedBigBlind");
    expect(h2?.showdown).toBe(true);
    expect(h2?.rank.get("FAKEp1")).toBe("Full House, 9's over 3's");
    expect(h2?.shown.get("FAKEp1")).toBe("9♥, 9♣");
    expect(h2?.shown.get("FAKEp3")).toBe("2♠");
    expect(h2 && atShowdown(h2)).toEqual(["FAKEp1", "FAKEp3"]);
    expect(h2?.potCents).toBe(450);
  });

  it("flags bomb pots and run-it-twice hands, and keeps the bomb money out of the action kinds", () => {
    const log = night();
    expect(log.hands[2]?.bombPot).toBe(true);
    expect(log.hands[2]?.actions[0]).toMatchObject({ kind: "bet", bombPot: true });
    expect(log.hands[3]?.runItTwice).toBe(true);
    expect(log.hands[3]?.board).toHaveLength(5);
  });

  it("reads a hand-time bounty into the hand it was paid in", () => {
    const h5 = night().hands[4];
    expect(Object.fromEntries(h5?.bountyCents ?? new Map())).toEqual({ FAKEp5: -100, FAKEp1: 100 });
  });

  it("reads the chip events between hands with the hand they apply to, and the admin's away and kick", () => {
    const log = night();
    expect(log.events.map((e) => [e.kind, e.hand, e.playerId, e.amountCents])).toEqual([
      ["rebuy", 4, "FAKEp4", 4000],
      ["topup", 4, "FAKEp1", 5000],
      ["remove", 4, "FAKEp2", 4000],
      ["away", 4, "FAKEp3", 0],
      ["kick", 4, "FAKEp4", 0],
    ]);
  });

  it("finds the biggest pot and counts the hands whose money does not carry to the next stacks", () => {
    const log = night();
    expect(log.biggestPot).toBe(100);
    expect(log.biggestPotHand).toBe(4);
    expect(log.biggestPotWinner).toBe("FAKEp1");
    expect(log.stackMismatches).toBe(3);
  });
});

describe("reading a cents night", () => {
  const CENTS = [
    'The player "Foxtrot @ FAKEp6" requested a rebuy of 4000',
    'The player "Foxtrot @ FAKEp6" rebought. New stack 4000.',
    "Cents Mode: off » on",
    'The player "Golf @ FAKEp7" requested a rebuy of 25.00',
    'The player "Golf @ FAKEp7" rebought. New stack 25.00.',
    '-- starting hand #1 (id: FAKEb01) (dealer: "Foxtrot @ FAKEp6")',
    'Player stacks: #1 "Foxtrot @ FAKEp6" (40.00) | #2 "Golf @ FAKEp7" (25.00)',
    '"Golf @ FAKEp7" posts a small blind of 0.50',
    '"Foxtrot @ FAKEp6" posts a big blind of 1.00',
    '"Golf @ FAKEp7" folds',
    'Uncalled bet of 0.50 returned to "Foxtrot @ FAKEp6"',
    '"Foxtrot @ FAKEp6" collected 1.00 from pot',
    "-- ending hand #1 --",
    'The player "Golf @ FAKEp7" requested a rebuy of 2500',
    'The player "Golf @ FAKEp7" rebought. New stack 2500.',
    '-- starting hand #2 (id: FAKEb02) (dealer: "Golf @ FAKEp7")',
    'Player stacks: #1 "Foxtrot @ FAKEp6" (40.00) | #2 "Golf @ FAKEp7" (25.00)',
    '"Foxtrot @ FAKEp6" posts a small blind of 0.50',
    '"Golf @ FAKEp7" posts a big blind of 1.00',
    '"Foxtrot @ FAKEp6" calls 0.50',
    '"Golf @ FAKEp7" checks',
    "Flop: [2♣, 5♦, 8♥]",
    '"Golf @ FAKEp7" checks',
    '"Foxtrot @ FAKEp6" checks',
    "Turn: 2♣, 5♦, 8♥ [Q♠]",
    '"Golf @ FAKEp7" bets 2.00',
    '"Foxtrot @ FAKEp6" folds',
    '"Golf @ FAKEp7" collected 3.00 from pot',
    "-- ending hand #2 --",
    "Cents Mode: on » off",
    'The player "Golf @ FAKEp7" requested a rebuy of 1000',
    'The player "Golf @ FAKEp7" rebought. New stack 1000.',
  ];

  it("reads requests in cents before the switch, dollars after it, and cents again after the switch back", () => {
    const log = parseOk("poker_now_log_pglFAKEB.csv", logText(CENTS));
    expect(log.events.map((e) => [e.playerId, e.hand, e.amount])).toEqual([
      ["FAKEp6", 0, 40],
      ["FAKEp7", 0, 25],
      ["FAKEp7", 1, 2500],
      ["FAKEp7", 2, 10],
    ]);
    expect(log.hands.map((h) => h.number)).toEqual([1, 2]);
    expect(log.stackMismatches).toBe(1);
  });
});

describe("reading the file", () => {
  it("refuses an empty file, a file with no entries, and a file with no hands", () => {
    expect(parseHandLog({ relativePath: "x.csv", text: "" })).toEqual({ ok: false, error: "could not read x.csv" });
    expect(parseHandLog({ relativePath: "x.csv", text: "entry,at,order\n" })).toEqual({
      ok: false,
      error: "no log entries in x.csv",
    });
    const noHands = parseHandLog({ relativePath: "x.csv", text: logText(['"Hotel @ FAKEp8" joined the game']) });
    expect(noHands).toEqual({ ok: false, error: "no hands in x.csv" });
  });

  it("reads quoted commas and newlines, carriage returns and a CRLF file", () => {
    const entries = [
      '-- starting hand #1 (id: FAKEq1) (dealer: "Gol,f @ FAKEp7")',
      'Player stacks: #1 "Gol,f @ FAKEp7" (10.00) | #2 "Hot el @ FAKEp9" (10.00)',
      '"Gol,f @ FAKEp7" says "hi\nthere"',
      '"Gol,f @ FAKEp7" posts a small blind of 0.50',
      '"Hot el @ FAKEp9" posts a big blind of 1.00',
      '"Gol,f @ FAKEp7" folds',
      '"Hot el @ FAKEp9" collected 1.50 from pot',
      "-- ending hand #1 --",
    ];
    // The whole file uses CRLF line ends: the carriage returns outside quotes are dropped.
    const text = logText(entries).replace(/\n/g, "\r\n");
    const log = parseOk("poker_now_log_pglFAKEQ.csv", text);
    expect(log.hands).toHaveLength(1);
    expect(log.hands[0]?.seats.map((s) => s.nickname)).toEqual(["Gol,f", "Hot el"]);
    expect(log.names.get("FAKEp7")).toBe("Gol,f");
    expect(Object.fromEntries(log.hands[0]?.netCents ?? new Map())).toEqual({ FAKEp7: -50, FAKEp9: 50 });
  });

  it("finds hand-log files by name, skipping excluded folders, other names and the non-csv", () => {
    const files = [
      { relativePath: "poker_now_log_pglA.csv", text: "" },
      { relativePath: "Sept/poker_now_log_pglB.csv", text: "" },
      { relativePath: "Saved_Data/poker_now_log_pglX.csv", text: "" },
      { relativePath: "build/poker_now_log_pglY.csv", text: "" },
      { relativePath: "cmake-build-debug/poker_now_log_pglW.csv", text: "" },
      { relativePath: "notes.txt", text: "" },
      { relativePath: "poker_now_log_.csv", text: "" },
      { relativePath: "Sept/ledger_pglC.csv", text: "" },
      { relativePath: "poker_now_log_pglU.CSV", text: "" },
    ];
    expect(discoverHandLogFiles(files).map((f) => f.relativePath)).toEqual([
      "Sept/poker_now_log_pglB.csv",
      "poker_now_log_pglA.csv",
      "poker_now_log_pglU.CSV",
    ]);
    expect(gameIdFromPath("Sept/poker_now_log_pglX (1).csv")).toBe("pglX");
    expect(gameIdFromPath("ledger_pglX.csv")).toBe("");
  });

  it("keeps the fuller of two logs for one game, and says which one it ignored", () => {
    const short = logText(NIGHT.slice(0, 16));
    const loaded = loadAllLogs([
      { relativePath: "poker_now_log_pglFAKEA.csv", text: logText(NIGHT) },
      { relativePath: "copies/poker_now_log_pglFAKEA (1).csv", text: short },
    ]);
    expect(loaded.logs.size).toBe(1);
    expect(loaded.logs.get("pglFAKEA")?.hands).toHaveLength(6);
    expect(loaded.messages).toEqual(["Duplicate hand log ignored: copies/poker_now_log_pglFAKEA (1).csv"]);
  });

  it("reports a file it cannot use and carries on with the rest", () => {
    const loaded = loadAllLogs([
      { relativePath: "poker_now_log_pglBAD.csv", text: "entry,at,order\n" },
      { relativePath: "poker_now_log_pglFAKEA.csv", text: logText(NIGHT) },
    ]);
    expect([...loaded.logs.keys()]).toEqual(["pglFAKEA"]);
    expect(loaded.messages).toEqual(["Skipped hand log: no log entries in poker_now_log_pglBAD.csv"]);
  });
});

describe("pairing with the ledger and the names", () => {
  const T0 = Date.UTC(2031, 4, 6, 19, 0, 0) / 1000;
  const row = (over: Partial<LedgerRow>): LedgerRow => ({
    nickname: "Alpha",
    playerId: "FAKEp1",
    start: T0,
    end: T0 + 3600,
    buyInCents: 10000,
    buyOutCents: 0,
    stackCents: 0,
    netCents: 0,
    owner: "",
    ownerReviewed: false,
    ...over,
  });
  const game: Game = {
    id: "ledger_pglFAKEA",
    path: "poker_now_ledger.csv",
    folder: "(root)",
    start: T0,
    end: T0 + 10000,
    totalBuyInCents: 0,
    skippedRows: 0,
    rows: [
      row({}),
      row({ nickname: "Zed", start: T0 + 7200, end: null, owner: "bravo" }),
      row({ nickname: "Zedd", playerId: "FAKEp2", start: T0 }),
    ],
  };
  // An alias: the nickname "Zedd" is filed under alpha.
  const rules: MergeRules = new Map([["zedd", "alpha"]]);

  it("gives an account's seat to the person who held it, and folds aliases through the merge rules", () => {
    const log = night();
    expect(logIdOf(game)).toBe("pglFAKEA"); // the log of this game is poker_now_log_pglFAKEA.csv
    pairWithLedger(log, game, rules);
    expect(personAt(log, "FAKEp1", T0 + 100, rules)).toBe("alpha");
    expect(personAt(log, "FAKEp1", T0 + 7300, rules)).toBe("bravo");
    expect(personAt(log, "FAKEp1", T0 - 5000, rules)).toBe("alpha");
    expect(personAt(log, "FAKEp2", T0 + 100, rules)).toBe("alpha");
  });

  it("falls back to the log's nickname when no ledger seat is paired", () => {
    const log = night();
    expect(personAt(log, "FAKEp2", T0, rules)).toBe("bravo");
    expect(personAt(log, "FAKEp3", T0, rules)).toBe("charlie");
  });
});

describe("the playing-style stats", () => {
  it("writes the same rows the C++ export wrote for the made-up night", () => {
    const rows = computeStyle([night()], new Map(), new Map());
    expect(styleStatsCSV(rows)).toBe(NIGHT_STYLE_CSV);
  });

  it("does not count bomb-pot money as voluntary, and leaves those hands out of the VPIP denominator", () => {
    const rows = computeStyle([night()], new Map(), new Map());
    const alpha = rows.find((r) => r.normalizedName === "alpha");
    expect(alpha).toMatchObject({ hands: 6, handsVoluntary: 5, vpip: 2, showdowns: 2, showdownsVoluntary: 2 });
  });

  it("labels a style from VPIP and aggression, with at least 30 hands", () => {
    const base = newStyleStats();
    expect(styleLabel({ ...base, hands: 29, handsVoluntary: 29, vpip: 1 })).toBe("(few hands)");
    const tightAggro = { ...base, hands: 40, handsVoluntary: 40, vpip: 8, bets: 6, raises: 6, calls: 2 };
    expect(styleLabel(tightAggro)).toBe("Tight-aggressive");
    const loosePassive = { ...base, hands: 100, handsVoluntary: 100, vpip: 36, bets: 2, raises: 1, calls: 10 };
    expect(styleLabel(loosePassive)).toBe("Loose-passive (calls a lot)");
    const aggressive = { ...base, hands: 50, handsVoluntary: 50, vpip: 13, bets: 1 }; // 26%: neither tight nor loose
    expect(styleLabel(aggressive)).toBe("Aggressive");
  });

  it("writes names with commas quoted, a tiny negative as -0.00 (printf), a tie at 0.125 to even, and the hit & run columns", () => {
    const base = newStyleStats();
    const text = styleStatsCSV([
      {
        ...base,
        displayName: 'Doe, "J"',
        normalizedName: "doe",
        hands: 1,
        netFromLog: -1e-13,
        biggestPotWon: 0.125,
        hitRun: 42.5,
        hitRunReliable: true,
        hitRunTag: "Hit & runner",
      },
    ]);
    const [header, line] = text.split("\n");
    expect(header).toBe(STYLE_CSV_HEADER);
    const fields = rawFields(line ?? "");
    expect(fields[0]).toBe('"Doe, ""J"""');
    expect(fields[12]).toBe("0.12"); // biggest_pot_won: 0.125 ties to the even cent
    expect(fields[13]).toBe("-0.00"); // net_from_log: a tiny negative keeps its sign, as printf does
    expect(fields[17]).toBe("42.50"); // hit_run
    expect(fields[18]).toBe("yes"); // hit_run_reliable
  });

  it("tells the seats of each night apart, with a running net by hand and NaN for a hand the person was not seated for", () => {
    const series = nightSeries(night(), new Map(), new Map());
    expect(series.map((s) => s.person).sort()).toEqual(["alpha", "bravo", "charlie", "echo"]);
    const finals = series.map((s) => s.finalNet);
    expect(finals).toEqual([...finals].sort((a, b) => b - a)); // richest first
    const echo = series.find((s) => s.person === "echo");
    expect(echo?.netByHand.slice(0, 4).every((v) => Number.isNaN(v))).toBe(true);
    expect(Number.isNaN(echo?.netByHand[4] ?? Number.NaN)).toBe(false);
    expect(series.find((s) => s.person === "alpha")?.accounts).toEqual(["Alpha"]);
  });

  it("reads one card and two cards, and prints the suit symbols as letters", () => {
    expect(shownCardCount("9♥, 9♣")).toBe(2);
    expect(shownCardCount("2♠")).toBe(1);
    expect(shownCardCount("")).toBe(0);
    expect(asciiCards("K♦, 9♠, A♣, 7♥, 2♣")).toBe("Kd, 9s, Ac, 7h, 2c");
  });
});
