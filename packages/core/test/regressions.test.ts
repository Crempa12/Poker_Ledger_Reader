// Regression tests for the behaviour changes made when the malformed-input rules were
// added. Every input is made up (Ann, Bea, Cal; 2031 dates). Each test pins one change:
// the repeated wall-clock rule is in util.test.ts, the -1 instant here.

import { describe, expect, it } from "vitest";

import { parseAdjustments, paymentRows, correctionRow } from "../src/adjustments.ts";
import { aggregate, parseMergeRulesCSV, playerDollars } from "../src/players.ts";
import { parseLedgerFile } from "../src/ledger.ts";
import type { DataWarning, Adjustment, Game, LedgerRow, PlayerStats } from "../src/models.ts";
import { calculateSheet } from "../src/settlement.ts";
import { makeKey, parseSessionBalances, recordPayment } from "../src/sessions.ts";
import { libcppSort } from "../src/libcpp-sort.ts";
import { parseISO8601UTC, parseLocalDate, readISO8601, readNumber, NO_TIME_EPOCH } from "../src/util.ts";

const NEW_YORK = "America/New_York";
const DAY = 86_400;
const START = Date.UTC(2031, 4, 6, 3) / 1000; // 2031-05-06T03:00:00Z
const HOUR = 3600;

const LEDGER_HEADER = "player_nickname,player_id,session_start_at,session_end_at,buy_in,buy_out,stack,net";

// ---------------- the -1 instant ----------------

describe("the instant -1 is an ordinary time, read as no time as in the C++", () => {
  it("reads 1969-12-31T23:59:59Z as no time, but reports that it is a real stamp", () => {
    expect(parseISO8601UTC("1969-12-31T23:59:59Z")).toBeNull();
    expect(readISO8601("1969-12-31T23:59:59Z")).toBe(NO_TIME_EPOCH);
    expect(parseISO8601UTC("1969-12-31T23:59:58Z")).toBe(-2);
  });

  it("skips a $0 seat stamped at that instant as never played, as the C++ does", () => {
    const text = [
      LEDGER_HEADER,
      "Ann,p1,1969-12-31T23:59:59Z,1969-12-31T23:59:59Z,0,0,0,0",
      "Bea,p2,2031-05-06T03:00:00Z,2031-05-06T04:00:00Z,2000,0,0,-2000",
      "Cal,p3,2031-05-06T03:00:00Z,2031-05-06T04:00:00Z,0,2000,0,2000",
    ].join("\n");
    const r = parseLedgerFile({ relativePath: "Oct/ledger_t1.csv", text });
    expect(r.ok && r.game.skippedRows).toBe(1);
    expect(r.ok && r.game.rows.map((x) => x.nickname)).toEqual(["Bea", "Cal"]);
  });
});

// ---------------- non-finite numbers ----------------

describe("inf, nan and overflowing numbers are refused with a warning, not read as 0", () => {
  it("drops the ledger rows with a non-finite money cell and warns about each", () => {
    const text = [
      LEDGER_HEADER,
      "Ann,p1,2031-05-06T03:00:00Z,2031-05-06T04:00:00Z,inf,0,0,500",
      "Bea,p2,2031-05-06T03:00:00Z,2031-05-06T04:00:00Z,2000,0,0,nan",
      "Cal,p3,2031-05-06T03:00:00Z,2031-05-06T04:00:00Z,2000,0,0,1e400",
      "Dee,p4,2031-05-06T03:00:00Z,2031-05-06T04:00:00Z,2000,0,0,-2000",
      "Eve,p5,not-a-time,2031-05-06T04:00:00Z,2000,x,0,junk",
    ].join("\n");
    const warnings: DataWarning[] = [];
    const r = parseLedgerFile({ relativePath: "Oct/ledger_t2.csv", text }, (w) => warnings.push(w));
    expect(r.ok && r.game.rows.map((x) => x.nickname)).toEqual(["Dee"]);
    expect(warnings).toEqual([
      { code: "non-finite-number", source: "Oct/ledger_t2.csv", row: 1, field: "buy_in" },
      { code: "non-finite-number", source: "Oct/ledger_t2.csv", row: 2, field: "net" },
      { code: "non-finite-number", source: "Oct/ledger_t2.csv", row: 3, field: "net" },
      { code: "bad-date", source: "Oct/ledger_t2.csv", row: 5, field: "session_start_at" },
      { code: "bad-number", source: "Oct/ledger_t2.csv", row: 5, field: "net" },
      { code: "bad-number", source: "Oct/ledger_t2.csv", row: 5, field: "buy_out" },
    ]);
  });

  it("drops adjustments with a non-finite amount and warns; junk is left out with a warning too", () => {
    const text = [
      "group,date,player_normalized,amount,folder,note",
      "g1,2031-05-06,ann,inf,,",
      "g2,2031-05-06,bea,nan,,",
      "g3,2031-05-06,cal,1e400,,",
      "g4,2031-05-06,dee,x,,",
      "g5,2031-05-06,,5,,",
      "g6,garbage,eve,5,,",
      "g7,2031-05-06,fay,5,,",
      "short,row",
    ].join("\n");
    const warnings: DataWarning[] = [];
    const list = parseAdjustments(text, NEW_YORK, (w) => warnings.push(w));
    expect(list.map((a) => [a.group, a.playerNormalized, a.amountCents, a.date])).toEqual([
      ["g6", "eve", 500, null],
      ["g7", "fay", 500, parseLocalDate("2031-05-06", false, NEW_YORK)],
    ]);
    expect(warnings.map((w) => [w.code, w.row, w.field])).toEqual([
      ["non-finite-number", 1, "amount"],
      ["non-finite-number", 2, "amount"],
      ["non-finite-number", 3, "amount"],
      ["bad-number", 4, "amount"],
      ["dropped-row", 5, "player_normalized"],
      ["bad-date", 6, "date"],
      ["short-row", 8, null],
    ]);
  });

  it("refuses a session balance with a non-finite amount, and reads junk as 0 with a warning", () => {
    const text = [
      "session_id,from_display,from_normalized,to_display,to_normalized,original_amount,remaining_amount,status",
      "s1,Ann,ann,Bea,bea,nan,5,open",
      "s1,Ann,ann,Cal,cal,10,inf,open",
      "s1,Ann,ann,Dee,dee,50.00,fifty,banana",
      "s1,Ann,ann,Eve,eve,20,5",
    ].join("\n");
    const warnings: DataWarning[] = [];
    const balances = parseSessionBalances(text, (w) => warnings.push(w));
    expect([...balances.keys()]).toEqual([makeKey("s1", "ann", "dee")]);
    expect(balances.get(makeKey("s1", "ann", "dee"))).toEqual({
      sessionId: "s1",
      fromDisplay: "Ann",
      fromNormalized: "ann",
      toDisplay: "Dee",
      toNormalized: "dee",
      originalCents: 5000,
      remainingCents: 0,
      status: "banana",
    });
    expect(warnings.map((w) => [w.code, w.row, w.field])).toEqual([
      ["non-finite-number", 1, "original_amount"],
      ["non-finite-number", 2, "remaining_amount"],
      ["bad-number", 3, "remaining_amount"],
      ["unknown-status", 3, "status"],
      ["short-row", 4, null],
    ]);
  });

  it("reads the readNumber categories the warnings are built on", () => {
    expect(readNumber("")).toBe("blank");
    expect(readNumber("12.5")).toBe("number");
    expect(readNumber("junk")).toBe("junk");
    expect(readNumber("inf")).toBe("non-finite");
    expect(readNumber("-nan")).toBe("non-finite");
    expect(readNumber("1e400")).toBe("non-finite");
    expect(readNumber("1e-400")).toBe("junk"); // underflow reads as 0 in the C++
  });
});

// ---------------- money entry points ----------------

describe("entries are refused unless the amount is a whole number of cents", () => {
  const base = {
    group: "g1",
    date: parseLocalDate("2031-05-06", false, NEW_YORK),
    folder: "",
    note: "",
    creditor: "bea",
    creditorName: "Bea",
    debtor: "ann",
    debtorName: "Ann",
  };

  it("paymentRows refuses NaN, infinity and a fraction of a cent", () => {
    for (const amountCents of [Number.NaN, Number.POSITIVE_INFINITY, 12.5]) {
      expect(paymentRows({ ...base, amountCents })).toEqual({
        ok: false,
        error: "Amount must be a whole number of cents.",
      });
    }
  });

  it("correctionRow refuses NaN and infinity", () => {
    const input = { group: "g1", date: parseLocalDate("2031-05-06", false, NEW_YORK), folder: "", note: "", player: "ann" };
    expect(correctionRow({ ...input, amountCents: Number.NaN }).ok).toBe(false);
    expect(correctionRow({ ...input, amountCents: Number.NEGATIVE_INFINITY }).ok).toBe(false);
    expect(correctionRow({ ...input, amountCents: 1000 }).ok).toBe(true);
  });

  it("recordPayment refuses a bad amount and changes nothing", () => {
    const balances = parseSessionBalances(
      "session_id,from_display,from_normalized,to_display,to_normalized,original_amount,remaining_amount,status\n" +
        "s1,Ann,ann,Bea,bea,10.00,10.00,open\n",
    );
    const pair = { fromNormalized: "ann", toNormalized: "bea" };
    for (const amountCents of [Number.NaN, 12.5]) {
      const result = recordPayment(balances, "s1", pair, amountCents);
      expect(result.refused).toBe("Amount must be a whole number of cents.");
      expect(result.balances).toBe(balances);
      expect(result.balance).toBeNull();
    }
    expect(recordPayment(balances, "s1", pair, 400).balance?.remainingCents).toBe(600);
  });
});

// ---------------- merge rules ----------------

describe("merge rules that point round in a circle are reported", () => {
  it("warns about a cycle, and only then", () => {
    const warnings: DataWarning[] = [];
    parseMergeRulesCSV("alias_normalized,canonical_normalized\nann,bea\nbea,cal\ncal,ann\n", (w) => warnings.push(w));
    expect(warnings).toEqual([{ code: "merge-cycle", source: "merge_rules.csv", row: 0, field: null }]);

    const chain: DataWarning[] = [];
    parseMergeRulesCSV("alias_normalized,canonical_normalized\nann,bea\nbea,cal\n", (w) => chain.push(w));
    expect(chain).toEqual([]);
  });

  it("reports a short row and a row with no name, by row number", () => {
    const warnings: DataWarning[] = [];
    parseMergeRulesCSV("alias_normalized,canonical_normalized\nann\n,bea\n", (w) => warnings.push(w));
    expect(warnings).toEqual([
      { code: "short-row", source: "merge_rules.csv", row: 1, field: null },
      { code: "dropped-row", source: "merge_rules.csv", row: 2, field: null },
    ]);
  });
});

// ---------------- history order with tied dates ----------------

describe("a history with tied dates is in libc++ std::sort order", () => {
  it("orders seven entries on three days the way libc++ does (oracle run)", () => {
    // Keys 3 1 2 1 3 2 1 (days). The libc++ oracle sorts the indexes to 1 3 6 2 5 0 4.
    const keys = [3, 1, 2, 1, 3, 2, 1];
    const adjustments: Adjustment[] = keys.map((day, i) => ({
      group: `g${i}`,
      date: day * DAY,
      playerNormalized: "ann",
      amountCents: i + 1,
      folder: "",
      note: `n${i}`,
    }));
    const stats = aggregate([], new Map(), adjustments).get("ann");
    expect(stats?.history.map((h) => h.note)).toEqual(["n1", "n3", "n6", "n2", "n5", "n0", "n4"]);
  });

  it("sorts with the ported libc++ routine, which leaves equal keys in the libc++ order", () => {
    const items = [3, 1, 2, 1, 3, 2, 1].map((key, id) => ({ key, id }));
    libcppSort(items, 0, items.length, (a, b) => a.key < b.key);
    expect(items.map((x) => x.id)).toEqual([1, 3, 6, 2, 5, 0, 4]);
  });
});

// ---------------- identity of money results ----------------

function row(nickname: string, playerId: string, netCents: number, start = START): LedgerRow {
  return {
    nickname,
    playerId,
    start,
    end: start + HOUR,
    buyInCents: 2000,
    buyOutCents: 2000 + netCents,
    stackCents: 0,
    netCents,
    owner: "",
    ownerReviewed: false,
  };
}

function game(id: string, rows: LedgerRow[]): Game {
  return {
    id,
    path: `Oct/${id}.csv`,
    folder: "Oct",
    start: START,
    end: START + HOUR,
    totalBuyInCents: rows.length * 2000,
    skippedRows: 0,
    rows,
  };
}

describe("money results come from the data, not from object identity", () => {
  // Cents that do not add up exactly as doubles, so a replay in a different order would show.
  const games = [
    game("ledger_a", [row("Ann", "p1", 1010), row("Bea", "p2", -330), row("Cal", "p3", -680)]),
    game("ledger_b", [row("Ann", "p1", -770), row("Bea", "p2", 2230), row("Cal", "p3", -1460)]),
  ];

  it("playerDollars of a JSON round trip equals playerDollars of the original", () => {
    const board = [...aggregate(games, new Map()).values()];
    const copies = JSON.parse(JSON.stringify(board)) as PlayerStats[];
    expect(copies.map((p) => playerDollars(p))).toEqual(board.map((p) => playerDollars(p)));
  });

  it("the settlement sheet is the same after a JSON round trip of the board", () => {
    const board = [...aggregate(games, new Map()).values()];
    const copies = JSON.parse(JSON.stringify(board)) as PlayerStats[];
    expect(calculateSheet(copies, [], "")).toEqual(calculateSheet(board, [], ""));
  });

  it("refuses a balance that is not a finite number instead of dropping the player", () => {
    const broken = aggregate([game("ledger_c", [row("Ann", "p1", 100), row("Bea", "p2", -100)])], new Map());
    const ann = broken.get("ann");
    expect(ann).toBeDefined();
    if (ann === undefined) return;
    const bad: PlayerStats = { ...ann, replay: { gameRowNetsCents: [[Number.NaN]], adjustmentCents: [] } };
    expect(() => calculateSheet([bad], [], "")).toThrow(RangeError);
  });
});
