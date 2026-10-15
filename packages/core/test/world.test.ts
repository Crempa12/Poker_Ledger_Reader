// The facade (world.ts): raw texts in, everything the app computes out. Made-up data only.
// The same order of operations is checked against the C++ app by tools/parity.ts; these
// tests pin the facade's own promises: the outputs, the warnings, and the zone check.

import { describe, expect, it } from "vitest";

import type { Scope } from "../src/models.ts";
import { boardFor, loadWorld, sheetFor, viewOf } from "../src/world.ts";

const ALL: Scope = { folder: "", from: null, to: null };
const NO_FOLDER_SCOPE: Scope = { folder: "Nov", from: null, to: null };

const LEDGER = [
  "player_nickname,player_id,session_start_at,session_end_at,buy_in,buy_out,stack,net",
  "Ann,p1,2031-05-06T03:00:00.000Z,2031-05-06T05:00:00.000Z,2000,3500,0,1500",
  "Bea,p2,2031-05-06T03:00:00.000Z,2031-05-06T05:00:00.000Z,2000,500,0,-1500",
  "",
].join("\n");

describe("loadWorld and viewOf: the whole startup from the raw texts", () => {
  it("loads the games, flags a copy of a ledger, and settles the table", () => {
    const world = loadWorld({
      timeZone: "America/New_York",
      ledgers: [
        { relativePath: "Oct/ledger_a.csv", text: LEDGER },
        { relativePath: "Oct/ledger_b.csv", text: LEDGER },
      ],
      saved: {},
    });
    expect(world.games.map((g) => g.id)).toEqual(["ledger_a"]);
    expect(world.duplicates.map((d) => [d.kind, d.skipped])).toEqual([["identical", true]]);
    expect(world.messages).toEqual([]);
    expect(world.warnings).toEqual([]);

    const view = viewOf(world, ALL);
    expect(view.board.map((p) => [p.normalizedName, p.totalNetCents])).toEqual([
      ["ann", 1500],
      ["bea", -1500],
    ]);
    expect(view.sheet.entries.map((e) => [e.fromNormalized, e.toNormalized, e.amountCents, e.reason])).toEqual([
      ["bea", "ann", 1500, "auto"],
    ]);
    expect(view.sheet.warnings).toEqual([]);
    expect(view.owed).toEqual([]);
    expect(view.mergeSuggestions).toEqual([]);
    expect(view.seatFlags).toEqual([]);
  });

  it("refuses a time zone the runtime does not know, where it is given", () => {
    expect(() => loadWorld({ timeZone: "Not/AZone", ledgers: [], saved: {} })).toThrow(RangeError);
  });

  it("reports malformed cells as warnings on the world, and still computes", () => {
    const junk = LEDGER.replace("Bea,p2,2031-05-06T03:00:00.000Z,2031-05-06T05:00:00.000Z,2000,500,0,-1500", "Bea,p2,2031-05-06T03:00:00.000Z,2031-05-06T05:00:00.000Z,2000,x,0,-1500");
    const world = loadWorld({
      timeZone: "America/New_York",
      ledgers: [{ relativePath: "Oct/ledger_a.csv", text: junk }],
      saved: {},
    });
    expect(world.warnings).toEqual([{ code: "bad-number", source: "Oct/ledger_a.csv", row: 2, field: "buy_out" }]);
    expect(viewOf(world, ALL).board.map((p) => p.totalNetCents)).toEqual([1500, -1500]);
  });

  it("applies the saved adjustments to the board and the sheet", () => {
    const world = loadWorld({
      timeZone: "America/New_York",
      ledgers: [{ relativePath: "Oct/ledger_a.csv", text: LEDGER }],
      saved: {
        "adjustments.csv": "group,date,player_normalized,amount,folder,note\ng1,2031-05-07,ann,-5.00,,\ng1,2031-05-07,bea,5.00,,\n",
      },
    });
    const view = viewOf(world, ALL);
    // The poker result stays; the adjustments change the balance the sheet uses.
    expect(view.board.map((p) => [p.normalizedName, p.totalNetCents, p.adjustmentsCents])).toEqual([
      ["ann", 1500, -500],
      ["bea", -1500, 500],
    ]);
    expect(view.sheet.entries.map((e) => [e.fromNormalized, e.toNormalized, e.amountCents])).toEqual([
      ["bea", "ann", 1000],
    ]);
  });

  it("applies the saved banker and pinned payments to the sheet", () => {
    const world = loadWorld({
      timeZone: "America/New_York",
      ledgers: [{ relativePath: "Oct/ledger_a.csv", text: LEDGER }],
      saved: { "settings.csv": "key,value\nbanker,Bea\n" },
    });
    expect(world.settings.banker).toBe("bea");
    const sheet = sheetFor(world, world.games, ALL);
    expect(sheet.entries.map((e) => [e.fromNormalized, e.toNormalized, e.amountCents, e.reason])).toEqual([
      ["bea", "ann", 1500, "banker"],
    ]);
    // The same sheet with no banker: the caller passes "" to switch banker mode off.
    expect(sheetFor(world, world.games, ALL, "").entries[0]?.reason).toBe("auto");
  });

  it("scopes the games, the board and the sheet by folder", () => {
    const world = loadWorld({
      timeZone: "America/New_York",
      ledgers: [{ relativePath: "Oct/ledger_a.csv", text: LEDGER }],
      saved: {},
    });
    const view = viewOf(world, NO_FOLDER_SCOPE);
    expect(view.games).toEqual([]);
    expect(view.board).toEqual([]);
    expect(view.sheet.entries).toEqual([]);
    expect(boardFor(world, world.games, ALL).map((p) => p.normalizedName)).toEqual(["ann", "bea"]);
  });
});
