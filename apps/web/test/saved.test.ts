// The page-side helpers for changing Saved_Data: typed amounts, the sheet names the
// console app suggests, and "a different person" for a new name (made-up data only).
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ledger, loadWorld, parseISO8601UTC, parseLocalDate, seats, viewOf, type Game, type Scope } from "../../../packages/core/src/index.ts";
import { loadDataRoot } from "../../../tools/load.ts";
import { confirmNames, defaultSessionId, gameSessionId, typedCents } from "../src/saved.ts";

const TZ = "America/New_York";
const EVERYTHING: Scope = { folder: "", from: null, to: null };
const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));

describe("typed payment amounts", () => {
  it("reads dollars the way people type them, in whole cents", () => {
    expect(typedCents("20")).toBe(2000);
    expect(typedCents(" 7 ")).toBe(700);
    expect(typedCents("12.5")).toBe(1250);
    expect(typedCents("12.05")).toBe(1205);
    expect(typedCents("$1,234.50")).toBe(123450);
    expect(typedCents(".5")).toBe(50);
    expect(typedCents("3.")).toBe(300);
  });

  it("refuses anything that is not an amount above zero", () => {
    for (const t of ["", "0", "0.00", "-5", "12.345", "abc", "1e3", "$", ".", "12..5", "Infinity"]) {
      expect(typedCents(t), t).toBeNull();
    }
  });
});

describe("the sheet name the console app suggests (menu 7)", () => {
  const now = parseISO8601UTC("2031-06-10T15:00:00Z") ?? 0;
  const day = (s: string, end: boolean) => parseLocalDate(s, end, TZ);

  it("is the folder when one is chosen", () => {
    expect(defaultSessionId({ folder: "May games", from: day("2031-05-01", false), to: null }, TZ, now)).toBe("May games");
  });

  it("is the date range, with start and today for open ends", () => {
    expect(defaultSessionId({ folder: "", from: day("2031-05-01", false), to: day("2031-05-31", true) }, TZ, now)).toBe("2031-05-01_to_2031-05-31");
    expect(defaultSessionId({ folder: "", from: day("2031-05-01", false), to: null }, TZ, now)).toBe("2031-05-01_to_2031-06-10");
    expect(defaultSessionId({ folder: "", from: null, to: day("2031-05-31", true) }, TZ, now)).toBe("start_to_2031-05-31");
  });

  it("is everything as of today otherwise, in the data's time zone", () => {
    expect(defaultSessionId(EVERYTHING, TZ, now)).toBe("all_games_as_of_2031-06-10");
    const lateEvening = parseISO8601UTC("2031-06-11T02:30:00Z") ?? 0; // still the 10th in New York
    expect(defaultSessionId(EVERYTHING, TZ, lateEvening)).toBe("all_games_as_of_2031-06-10");
  });

  it("names one game by its local day and ledger id", () => {
    const game = { id: "ledger_pglEX9_made-up-game", start: parseISO8601UTC("2031-05-02T01:30:00Z") } as Game;
    expect(gameSessionId(game, TZ)).toBe("game_2031-05-01_ledger_pglEX9_made-up-game");
  });
});

describe("a new name that is a different person (menu 4, answer d)", () => {
  it("saves that name's unchecked seats on the account as checked, so it is not asked again", async () => {
    const data = await loadDataRoot(SYNTHETIC);
    const input = { timeZone: TZ, ledgers: data.games.filter((g) => ledger.looksLikeLedger(g.text)), saved: data.savedData };
    const world = loadWorld(input);
    const question = viewOf(world, EVERYTHING).mergeSuggestions[0];
    expect(question, "the made-up data has a new name to ask about").toBeDefined();
    if (question === undefined) return;
    const name = question.newNames[0] ?? "";

    const list = confirmNames(world, question.playerId, [name]);
    expect(list.slice(0, world.seatOwners.length)).toEqual(world.seatOwners);
    const added = list.slice(world.seatOwners.length);
    expect(added.length).toBeGreaterThan(0);
    for (const entry of added) {
      expect(entry.playerId).toBe(question.playerId);
      expect(entry.owner).toBe(name);
      expect(entry.note).toBe(seats.NAME_RIGHT_NOTE);
    }

    const again = loadWorld({ ...input, saved: { ...data.savedData, "seat_owners.csv": seats.serializeSeatOwnersCSV(list) } });
    expect(viewOf(again, EVERYTHING).mergeSuggestions.flatMap((s) => s.newNames)).not.toContain(name);
    expect(confirmNames(again, question.playerId, [name])).toHaveLength(list.length);
  });
});
