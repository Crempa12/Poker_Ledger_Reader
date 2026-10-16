// The helpers behind the Saved_Data pages: a select saves only a choice that is still on
// its list, a pin that now pays the same person is left out of payment_preferences.csv,
// and menu 5's "Not on this sheet" count. Made-up names only.
import { describe, expect, it } from "vitest";

import { loadWorld, parseLocalDate, settlement, type Adjustment, type Scope } from "../../../packages/core/src/index.ts";
import { chosenOption, leftOutNote, notOnThisSheet, pinsToWrite } from "../src/saved.ts";

const TZ = "America/New_York";
const day = (s: string, end: boolean): number | null => parseLocalDate(s, end, TZ);
const adj = (folder: string, date: number | null): Adjustment => ({
  group: `adj-${folder}-${date ?? "none"}`,
  date,
  playerNormalized: "della",
  amountCents: 100,
  folder,
  note: "",
});

describe("a select saves only a choice that is still on its list", () => {
  const people = [{ normalizedName: "della" }, { normalizedName: "ozzie" }];

  it("keeps a choice that is still an option", () => {
    expect(chosenOption("ozzie", people)).toBe("ozzie");
  });

  it("shows the placeholder, not the old choice, once the choice has dropped out", () => {
    expect(chosenOption("quinn", people)).toBe("");
    expect(chosenOption("", people)).toBe("");
  });
});

describe("pins written to payment_preferences.csv", () => {
  it("leaves out a pin whose payer and payee are one person after a merge, and says how many", () => {
    const world = loadWorld({
      timeZone: TZ,
      ledgers: [],
      saved: {
        "merge_rules.csv": "alias_normalized,canonical_normalized\nozzie,della\n",
        "payment_preferences.csv": "payer_normalized,payee_normalized,note\nozzie,della,\ndella,ozzie,\nozzie,quinn,\n",
      },
    });
    const pairs = (list: readonly { payerNormalized: string; payeeNormalized: string }[]) => list.map((p) => `${p.payerNormalized}->${p.payeeNormalized}`);
    expect(pairs(world.prefs)).toEqual(["della->della", "della->della", "della->quinn"]);

    const { keep, left } = pinsToWrite(world.prefs);
    expect(pairs(keep)).toEqual(["della->quinn"]);
    expect(left).toBe(2);
    expect(leftOutNote(left)).toBe("2 pins that now pay the same person were left out of the file.");

    // What is written reads back without a dropped row, so the next save is not refused.
    const text = settlement.serializePreferencesCSV(keep);
    expect(settlement.parsePreferencesCSV(text)).toEqual(keep);
  });

  it("writes every pin, and no note, when none pays the same person", () => {
    const prefs = [{ payerNormalized: "ozzie", payeeNormalized: "della", note: "Venmo only", oneOff: false }];
    expect(pinsToWrite(prefs)).toEqual({ keep: prefs, left: 0 });
    expect(leftOutNote(0)).toBe("");
    expect(leftOutNote(1)).toBe("One pin that now pays the same person was left out of the file.");
  });
});

describe("menu 5's 'Not on this sheet' count", () => {
  const list = [adj("", day("2031-05-10", false)), adj("", day("2031-05-10", false)), adj("May games", day("2031-05-10", false)), adj("", day("2031-06-02", false))];
  const may: Scope = { folder: "May games", from: day("2031-05-01", false), to: day("2031-05-31", true) };

  it("counts nothing when every folder is the sheet's scope", () => {
    expect(notOnThisSheet(list, { ...may, folder: "" })).toBe(0);
  });

  it("counts the entries under all folders whose date falls in the sheet's dates, each side of a payment", () => {
    expect(notOnThisSheet(list, may)).toBe(2);
  });

  it("counts every entry under all folders when the sheet has no dates", () => {
    expect(notOnThisSheet(list, { folder: "May games", from: null, to: null })).toBe(3);
  });
});
