import { describe, expect, it } from "vitest";

import type { Game, LedgerRow, SeatOwner } from "../src/models.ts";
import {
  NAME_RIGHT_NOTE,
  apply,
  assignSeats,
  confirmNames,
  findSuspicious,
  groupSharedSeats,
  nicknamePerson,
  parseSeatOwnersCSV,
  pickSeatRows,
  removeSeatOwner,
  seatOwnerFor,
  serializeSeatOwnersCSV,
  usualOwnerForSeats,
  usualOwners,
} from "../src/seats.ts";

// Made-up sit-down time (epoch seconds) and night.
const START = 1_700_000_000;
const HOUR = 3600;

function seat(nickname: string, playerId: string, netCents: number, extra: Partial<LedgerRow> = {}): LedgerRow {
  return {
    nickname,
    playerId,
    start: START,
    end: START + HOUR,
    buyInCents: 2000,
    buyOutCents: 2000 + netCents,
    stackCents: 0,
    netCents,
    owner: "",
    ownerReviewed: false,
    ...extra,
  };
}

function game(id: string, rows: LedgerRow[], start: number | null = START, end: number | null = null): Game {
  return {
    id,
    path: `night_one/${id}.csv`,
    folder: "night_one",
    start,
    end: end ?? (start === null ? null : start + 2 * HOUR),
    totalBuyInCents: 0,
    skippedRows: 0,
    rows,
  };
}

const NO_RULES = new Map<string, string>();

describe("seat_owners.csv", () => {
  it("reads the saved entries and skips rows that cannot name an owner", () => {
    const text =
      "ledger_id,player_id,session_start_at,nickname,owner_normalized,note\n" +
      "ledger_one,acctA,2023-11-14T22:13:20Z,Ann,bo,bought under Ann on account acctA\n" +
      "ledger_one,acctB,,Bo,,\n" +
      "short,row\n" +
      "ledger_two,acctC,,Cy Zed,Cy-Zed,checked: name was right\n";
    expect(parseSeatOwnersCSV(text)).toEqual([
      {
        ledgerId: "ledger_one",
        playerId: "acctA",
        start: START,
        nickname: "Ann",
        owner: "bo",
        note: "bought under Ann on account acctA",
      },
      { ledgerId: "ledger_two", playerId: "acctC", start: null, nickname: "Cy Zed", owner: "cyzed", note: "checked: name was right" },
    ]);
  });

  it("writes the saved entries back in the same shape", () => {
    const list: SeatOwner[] = [
      { ledgerId: "ledger_one", playerId: "acctA", start: START, nickname: "Ann", owner: "bo", note: "bought under Ann on account acctA" },
      { ledgerId: "ledger_two", playerId: "acctC", start: null, nickname: "Cy Zed", owner: "cyzed", note: "checked: name was right" },
    ];
    expect(serializeSeatOwnersCSV(list)).toBe(
      "ledger_id,player_id,session_start_at,nickname,owner_normalized,note\n" +
        "ledger_one,acctA,2023-11-14T22:13:20Z,Ann,bo,bought under Ann on account acctA\n" +
        "ledger_two,acctC,,Cy Zed,cyzed,checked: name was right\n",
    );
    expect(serializeSeatOwnersCSV(parseSeatOwnersCSV(serializeSeatOwnersCSV(list)))).toBe(serializeSeatOwnersCSV(list));
  });
});

describe("apply", () => {
  it("sets the owner on a seat that belongs to someone else, and marks a confirmed seat reviewed", () => {
    const games = [game("ledger_one", [seat("Ann", "acctA", 500), seat("Bo", "acctA", -500)])];
    const list: SeatOwner[] = [
      { ledgerId: "ledger_one", playerId: "acctA", start: START, nickname: "Ann", owner: "bo", note: "bought under Ann" },
      { ledgerId: "ledger_one", playerId: "acctA", start: START, nickname: "Bo", owner: "bo", note: NAME_RIGHT_NOTE },
    ];
    const result = apply(games, list, NO_RULES);
    expect(result.unmatched).toBe(0);
    expect(result.games[0]?.rows.map((r) => [r.owner, r.ownerReviewed])).toEqual([
      ["bo", true],
      ["", true],
    ]);
    // The inputs are not touched.
    expect(games[0]?.rows.map((r) => [r.owner, r.ownerReviewed])).toEqual([
      ["", false],
      ["", false],
    ]);
  });

  it("counts entries for ledgers that are not loaded", () => {
    const games = [game("ledger_one", [seat("Ann", "acctA", 0)])];
    const list: SeatOwner[] = [
      { ledgerId: "ledger_missing", playerId: "acctA", start: START, nickname: "Ann", owner: "ann", note: NAME_RIGHT_NOTE },
    ];
    expect(apply(games, list, NO_RULES).unmatched).toBe(1);
  });
});

describe("findSuspicious", () => {
  it("flags a seat on an account that usually belongs to someone else", () => {
    // Dee sits on acctU in three nights; Fay sits there once, and plays elsewhere too.
    const games = [
      game("g1", [seat("Dee", "acctU", 0)], START),
      game("g2", [seat("Dee", "acctU", 0)], START + 86_400),
      game("g3", [seat("Dee", "acctU", 0)], START + 2 * 86_400),
      game("g4", [seat("Fay", "acctU", 0)], START + 3 * 86_400),
      game("g5", [seat("Fay", "acctF", 0)], START + 4 * 86_400),
    ];
    expect(usualOwners(games, NO_RULES).get("acctU")).toBe("dee");
    expect(findSuspicious(games, NO_RULES)).toEqual([
      { gameId: "g4", row: 0, usualOwner: "dee", overlapAccounts: [] },
    ]);
  });

  it("flags one person seated on two accounts at the same time, and not after one ends", () => {
    const overlapping = game("g1", [
      seat("Gus", "acctG1", -100, { end: START + HOUR }),
      seat("Gus", "acctG2", 100, { start: START + HOUR / 2, end: START + (3 * HOUR) / 2 }),
    ]);
    expect(findSuspicious([overlapping], NO_RULES)).toEqual([
      { gameId: "g1", row: 0, usualOwner: "", overlapAccounts: ["acctG2"] },
      { gameId: "g1", row: 1, usualOwner: "", overlapAccounts: ["acctG1"] },
    ]);

    const afterwards = game("g1", [
      seat("Gus", "acctG1", -100, { end: START + HOUR }),
      seat("Gus", "acctG2", 100, { start: START + 2 * HOUR, end: START + 3 * HOUR }),
    ]);
    expect(findSuspicious([afterwards], NO_RULES)).toEqual([]);
  });

  it("uses the game's end for a seat still open at the end of the night", () => {
    // The first seat has no end, so it runs to the end of the game (two hours in).
    const open = game("g1", [
      seat("Gus", "acctG1", 0, { end: null }),
      seat("Gus", "acctG2", 0, { start: START + HOUR + HOUR / 2, end: START + 3 * HOUR }),
    ]);
    expect(findSuspicious([open], NO_RULES).map((f) => f.overlapAccounts)).toEqual([["acctG2"], ["acctG1"]]);
  });

  it("leaves out seats already reviewed", () => {
    const overlapping = game("g1", [
      seat("Gus", "acctG1", -100, { ownerReviewed: true }),
      seat("Gus", "acctG2", 100, { start: START + HOUR / 2, end: START + HOUR }),
    ]);
    expect(findSuspicious([overlapping], NO_RULES)).toEqual([
      { gameId: "g1", row: 1, usualOwner: "", overlapAccounts: ["acctG1"] },
    ]);
  });
});

describe("saving an answer", () => {
  const game1 = game("ledger_one", [seat("Ann", "acctA", 500), seat("Bo", "acctB", -500)]);

  it("records that the name on the seat is right, with the nickname's person as owner", () => {
    expect(seatOwnerFor(NO_RULES, game1, game1.rows[0] ?? seat("", "", 0), { kind: "nickname" })).toEqual({
      ledgerId: "ledger_one",
      playerId: "acctA",
      start: START,
      nickname: "Ann",
      owner: "ann",
      note: NAME_RIGHT_NOTE,
    });
  });

  it("notes a seat bought under another name, and calls it right when the person is the name on it", () => {
    const row = game1.rows[0] ?? seat("", "", 0);
    expect(seatOwnerFor(NO_RULES, game1, row, { kind: "person", person: "bo" })).toMatchObject({
      owner: "bo",
      note: 'bought under "Ann" on account acctA',
    });
    expect(seatOwnerFor(NO_RULES, game1, row, { kind: "person", person: "ann" })).toMatchObject({
      owner: "ann",
      note: NAME_RIGHT_NOTE,
    });
  });

  it("replaces an earlier entry for the same seat, and reports the money that moved", () => {
    const old: SeatOwner = { ledgerId: "ledger_one", playerId: "acctA", start: START, nickname: "Ann", owner: "cy", note: "old" };
    const other: SeatOwner = { ledgerId: "ledger_one", playerId: "acctB", start: START, nickname: "Bo", owner: "bo", note: "other" };
    const result = assignSeats([old, other], game1, [game1.rows[0] ?? seat("", "", 0)], { kind: "person", person: "bo" }, NO_RULES);
    expect(result.list.map((s) => [s.nickname, s.owner, s.note])).toEqual([
      ["Bo", "bo", "other"],
      ["Ann", "bo", 'bought under "Ann" on account acctA'],
    ]);
    expect(result.movedCents).toBe(500);
  });

  it("moves no money when the answer is the name on the seat", () => {
    const result = assignSeats([], game1, game1.rows, { kind: "nickname" }, NO_RULES);
    expect(result.list.map((s) => s.owner)).toEqual(["ann", "bo"]);
    expect(result.movedCents).toBe(0);
  });

  it("leaves the input list as it was", () => {
    const list: SeatOwner[] = [];
    assignSeats(list, game1, game1.rows, { kind: "nickname" }, NO_RULES);
    expect(list).toEqual([]);
  });

  it("confirms every unchecked seat of an account under the people given, and not the rest", () => {
    // The last two seats are not the same sit-down (another start time), so only the first is confirmed.
    const games = [
      game("ledger_one", [
        seat("Ann", "acctA", 100),
        seat("Bo", "acctA", -100),
        seat("Ann", "acctA", 0, { start: START + 1, ownerReviewed: true }),
        seat("Ann", "acctA", 0, { start: START + 1, owner: "bo" }),
      ]),
    ];
    const result = confirmNames(games, [], NO_RULES, "acctA", ["ann"]);
    expect(result.added).toBe(1);
    expect(result.list).toEqual([
      { ledgerId: "ledger_one", playerId: "acctA", start: START, nickname: "Ann", owner: "ann", note: NAME_RIGHT_NOTE },
    ]);
    const applied = apply(games, result.list, NO_RULES);
    expect(applied.games[0]?.rows.map((r) => r.ownerReviewed)).toEqual([true, false, false, false]);
  });

  it("removes one entry by its index", () => {
    const list: SeatOwner[] = [
      { ledgerId: "a", playerId: "p", start: null, nickname: "n", owner: "x", note: "" },
      { ledgerId: "b", playerId: "p", start: null, nickname: "n", owner: "y", note: "" },
    ];
    expect(removeSeatOwner(list, 1).map((s) => s.ledgerId)).toEqual(["a"]);
    expect(list).toHaveLength(2);
  });
});

describe("helpers for the menu", () => {
  it("says who the nickname on a seat is, whatever its reassignment", () => {
    expect(nicknamePerson(NO_RULES, seat("Ann", "acctA", 0, { owner: "bo" }))).toBe("ann");
  });

  it("gives the usual owner of a set of seats that all sit on one account", () => {
    const usual = new Map([["acctU", "dee"]]);
    expect(usualOwnerForSeats(usual, [seat("Fay", "acctU", 0), seat("Fay", "acctU", 0)])).toBe("dee");
    expect(usualOwnerForSeats(usual, [seat("Fay", "acctU", 0), seat("Fay", "acctF", 0)])).toBe("");
    expect(usualOwnerForSeats(usual, [seat("Fay", "acctF", 0)])).toBe("");
  });

  it("turns typed seat numbers into row indexes, once each, and rejects bad input", () => {
    const g = game("g1", [seat("A", "p", 0), seat("B", "p", 0), seat("C", "p", 0)]);
    expect(pickSeatRows(g, [3, 1, 3])).toEqual([2, 0]);
    expect(pickSeatRows(g, [])).toBeNull();
    expect(pickSeatRows(g, [0])).toBeNull();
    expect(pickSeatRows(g, [4])).toBeNull();
  });

  it("groups flagged seats with the same name on the same account in one game, newest game first", () => {
    // Gus has two seats on acctG1 and one on acctG2, all overlapping, so all three are flagged.
    const g1 = game("g1", [
      seat("Gus", "acctG1", -100, { end: START + HOUR }),
      seat("Gus", "acctG1", -100, { start: START + (3 * HOUR) / 2, end: START + (5 * HOUR) / 2 }),
      seat("Gus", "acctG2", 200, { start: START + HOUR / 2, end: START + 2 * HOUR }),
    ]);
    const flags = findSuspicious([g1], NO_RULES);
    expect(flags.map((f) => f.row)).toEqual([0, 1, 2]);
    const groups = groupSharedSeats(flags, [g1]);
    // Newest flag first: the acctG2 seat, then the two acctG1 seats as one answer.
    expect(groups.map((grp) => grp.map((f) => `${f.gameId}:${f.row}`))).toEqual([["g1:2"], ["g1:1", "g1:0"]]);
  });
});
