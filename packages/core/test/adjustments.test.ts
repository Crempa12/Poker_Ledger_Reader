import { describe, expect, it } from "vitest";

import {
  ADJUSTMENTS_HEADER,
  correctionRow,
  chooseDate,
  filter,
  parseAdjustments,
  paymentRows,
  removeGroup,
  serializeAdjustments,
} from "../src/adjustments.ts";
import type { Adjustment, Scope } from "../src/models.ts";
import { parseLocalDate } from "../src/util.ts";

const NEW_YORK = "America/New_York";

// Local midnight in New York for a calendar date (the form the app stores dates in).
function day(text: string): number {
  const epoch = parseLocalDate(text, false, NEW_YORK);
  if (epoch === null) throw new Error(`bad test date ${text}`);
  return epoch;
}

const ALL_FOLDERS: Scope = { folder: "", from: null, to: null };

describe("adjustments.csv text", () => {
  it("reads only the rows that can count", () => {
    const text = [
      ADJUSTMENTS_HEADER,
      "adj1,2026-05-06,ada,12.5,May,paid (to Ben)",
      "adj1,2026-05-06,ben,-12.5,May,paid (from Ada)",
      "short,2026-06-01,ada", // fewer than four fields
      "adj4,2026-05-09,,4,May,no player", // no player name
      "adj5,2026-05-10,ada,0.005,May,under a cent", // dropped
      "adj6,2026-05-10,ada,abc,May,not a number", // junk reads as 0, dropped
      "adj7,2026-05-10,ada,-0.00,,zero",
    ].join("\n");
    const list = parseAdjustments(text, NEW_YORK);
    expect(list).toEqual([
      {
        group: "adj1",
        date: day("2026-05-06"),
        playerNormalized: "ada",
        amountCents: 1250,
        folder: "May",
        note: "paid (to Ben)",
      },
      {
        group: "adj1",
        date: day("2026-05-06"),
        playerNormalized: "ben",
        amountCents: -1250,
        folder: "May",
        note: "paid (from Ada)",
      },
    ]);
  });

  it("keeps an amount exactly at the threshold, as the C++ does", () => {
    const list = parseAdjustments("h\nadj8,2026-05-10,ada,-0.009,May,at the threshold\n", NEW_YORK);
    expect(list.map((a) => a.amountCents)).toEqual([-1]);
  });

  it("rounds a file amount the way printf does, not half away from zero", () => {
    const text = [
      "h",
      "a,2026-05-06,ada,2.665,May,x",
      "a,2026-05-06,ada,2.675,May,x",
      "a,2026-05-06,ada,2.685,May,x",
      "a,2026-05-06,ada,2.345,May,x",
      "a,2026-05-06,ada,0.0095,May,x",
    ].join("\n");
    expect(parseAdjustments(text, NEW_YORK).map((a) => a.amountCents)).toEqual([267, 267, 269, 235, 1]);
  });

  it("reads a bad date as no date, and an out-of-range day by rolling over", () => {
    const text = ["h", "adj5,bad-date,ada,3,May,bad date", "adj12,2026-02-31,ada,0.015,May,rollover"].join("\n");
    const [bad, rolled] = parseAdjustments(text, NEW_YORK);
    expect(bad?.date).toBeNull();
    expect(rolled?.date).toBe(day("2026-03-03"));
    expect(rolled?.amountCents).toBe(1);
  });

  it("gives empty folder and note when the columns are missing, and trims the rest", () => {
    const text = ["h", "adj9,2026-05-06,ada,4.5", '  adj10 , 2026-06-04 , Dee!! , 2.345 , May ,  "quoted, note"'].join(
      "\n",
    );
    const [short, padded] = parseAdjustments(text, NEW_YORK);
    expect(short).toMatchObject({ folder: "", note: "" });
    expect(padded).toEqual({
      group: "adj10",
      date: day("2026-06-04"),
      playerNormalized: "dee",
      amountCents: 235,
      folder: "May",
      note: "quoted, note",
    });
  });

  it("writes the header and one line per entry, byte for byte", () => {
    const text = [
      "h",
      "adj1,2026-05-06,ada,12.5,May,paid (to Ben)",
      "adj1,2026-05-06,ben,-12.5,May,paid (from Ada)",
      "adj2,5/7/26,cy,-7.255,,fix",
      "adj5,bad-date,ada,3,May,bad date",
      'adj6,2026-06-01,ben,-0.5,"Game, Night",comma folder',
      '  adj10 , 2026-06-04 , Dee!! , 2.345 , May ,  "quoted, note"',
      "adj12,2026-02-31,ada,0.015,May,rollover",
    ].join("\n");
    const out = serializeAdjustments(parseAdjustments(text, NEW_YORK), NEW_YORK);
    expect(out).toBe(
      [
        "group,date,player_normalized,amount,folder,note",
        "adj1,2026-05-06,ada,12.50,May,paid (to Ben)",
        "adj1,2026-05-06,ben,-12.50,May,paid (from Ada)",
        "adj2,2026-05-07,cy,-7.25,,fix",
        "adj5,unknown,ada,3.00,May,bad date",
        'adj6,2026-06-01,ben,-0.50,"Game, Night",comma folder',
        'adj10,2026-06-04,dee,2.35,May,"quoted, note"',
        "adj12,2026-03-03,ada,0.01,May,rollover",
        "",
      ].join("\n"),
    );
  });

  it("reads back what it writes", () => {
    const list = parseAdjustments("h\nadj1,2026-05-06,ada,12.5,May,paid\n", NEW_YORK);
    expect(parseAdjustments(serializeAdjustments(list, NEW_YORK), NEW_YORK)).toEqual(list);
  });

  it("writes only the header for an empty list", () => {
    expect(serializeAdjustments([], NEW_YORK)).toBe("group,date,player_normalized,amount,folder,note\n");
  });
});

describe("which entries count in a scope", () => {
  const entries: Adjustment[] = [
    { group: "g1", date: day("2026-05-06"), playerNormalized: "ada", amountCents: 500, folder: "May", note: "" },
    { group: "g2", date: day("2026-05-06"), playerNormalized: "ben", amountCents: -500, folder: "", note: "" },
    { group: "g3", date: null, playerNormalized: "cy", amountCents: 100, folder: "May", note: "" },
    { group: "g4", date: day("2026-06-02"), playerNormalized: "dee", amountCents: 100, folder: "June", note: "" },
  ];
  const groups = (list: Adjustment[]): string[] => list.map((a) => a.group);

  it("counts everything when every folder and every date is in scope", () => {
    expect(groups(filter(entries, ALL_FOLDERS))).toEqual(["g1", "g2", "g3", "g4"]);
  });

  it("matches the folder tag and the date range together", () => {
    const may: Scope = { folder: "May", from: day("2026-05-01"), to: day("2026-05-31") };
    expect(groups(filter(entries, may))).toEqual(["g1"]);
  });

  it("counts an untagged entry only when every folder is in scope", () => {
    const mayUnbounded: Scope = { folder: "May", from: null, to: null };
    expect(groups(filter(entries, mayUnbounded))).toEqual(["g1", "g3"]);
    const allInMay: Scope = { folder: "", from: day("2026-05-01"), to: day("2026-05-31") };
    expect(groups(filter(entries, allInMay))).toEqual(["g1", "g2"]);
  });

  it("never counts an undated entry in a bounded range", () => {
    const bounded: Scope = { folder: "", from: day("2026-01-01"), to: null };
    expect(groups(filter(entries, bounded))).not.toContain("g3");
  });
});

describe("entry date", () => {
  // 2026-05-07 02:30 UTC is 2026-05-06 22:30 in New York: still the 6th there.
  const lateEveningNewYork = Date.UTC(2026, 4, 7, 2, 30) / 1000;

  it("defaults a blank date to local midnight of today in the zone", () => {
    expect(chooseDate("", lateEveningNewYork, NEW_YORK)).toEqual({ ok: true, value: day("2026-05-06") });
    expect(chooseDate("   ", lateEveningNewYork, NEW_YORK)).toEqual({ ok: true, value: day("2026-05-06") });
  });

  it("reads YYYY-MM-DD and M/D/YY as local midnight", () => {
    expect(chooseDate("2026-05-06", 0, NEW_YORK)).toEqual({ ok: true, value: day("2026-05-06") });
    expect(chooseDate("5/6/26", 0, NEW_YORK)).toEqual({ ok: true, value: day("2026-05-06") });
  });

  it("refuses text that is not a date", () => {
    expect(chooseDate("2026-13-01", 0, NEW_YORK)).toEqual({ ok: false, error: "Could not read that date." });
    expect(chooseDate("soon", 0, NEW_YORK).ok).toBe(false);
  });
});

describe("payment rows", () => {
  const base = {
    group: "adj1000-1",
    date: day("2026-05-06"),
    folder: "May",
    note: "  Venmo  ",
    amountCents: 1250,
    creditor: "ben",
    creditorName: "Ben",
    debtor: "ada",
    debtorName: "Ada",
  };

  it("makes two balanced rows that share a group, folder and date", () => {
    const result = paymentRows(base);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          group: "adj1000-1",
          date: day("2026-05-06"),
          playerNormalized: "ada",
          amountCents: 1250,
          folder: "May",
          note: "Venmo (to Ben)",
        },
        {
          group: "adj1000-1",
          date: day("2026-05-06"),
          playerNormalized: "ben",
          amountCents: -1250,
          folder: "May",
          note: "Venmo (from Ada)",
        },
      ],
    });
    if (!result.ok) throw new Error("expected rows");
    const [debtorRow, creditorRow] = result.value;
    expect(debtorRow.amountCents + creditorRow.amountCents).toBe(0);
  });

  it("uses paid as the note when none is given", () => {
    const result = paymentRows({ ...base, note: "   " });
    expect(result.ok && result.value.map((a) => a.note)).toEqual(["paid (to Ben)", "paid (from Ada)"]);
  });

  it("tags the rows with the folder being viewed, or nothing for all folders", () => {
    const everything = paymentRows({ ...base, folder: ALL_FOLDERS.folder });
    expect(everything.ok && everything.value.map((a) => a.folder)).toEqual(["", ""]);
  });

  it("refuses a missing creditor, the same person twice, a zero amount, and no date", () => {
    expect(paymentRows({ ...base, creditor: "" })).toEqual({
      ok: false,
      error: "Pick who got the money, or let the debt go.",
    });
    expect(paymentRows({ ...base, debtor: "" })).toEqual({ ok: false, error: "Cancelled." });
    expect(paymentRows({ ...base, debtor: "ben" })).toEqual({ ok: false, error: "Cancelled." });
    expect(paymentRows({ ...base, amountCents: 0 })).toEqual({
      ok: false,
      error: "Amount is too small to record.",
    });
    expect(paymentRows({ ...base, date: null })).toEqual({ ok: false, error: "Pick a date." });
  });
});

describe("one-sided corrections", () => {
  it("keeps the sign and marks no other side", () => {
    expect(
      correctionRow({ group: "adj1000-2", date: day("2026-05-07"), folder: "", note: "  fix  ", amountCents: -725, player: "cy" }),
    ).toEqual({
      ok: true,
      value: { group: "adj1000-2", date: day("2026-05-07"), playerNormalized: "cy", amountCents: -725, folder: "", note: "fix" },
    });
  });

  it("refuses an amount under a cent, a missing player, and no date", () => {
    const base = { group: "g", date: day("2026-05-07"), folder: "", note: "", amountCents: 500, player: "cy" };
    expect(correctionRow({ ...base, amountCents: 0 })).toEqual({ ok: false, error: "Amount is too small to record." });
    expect(correctionRow({ ...base, player: "" })).toEqual({ ok: false, error: "Pick a player." });
    expect(correctionRow({ ...base, date: null })).toEqual({ ok: false, error: "Pick a date." });
  });
});

describe("removing a group", () => {
  it("removes both sides of a payment together and leaves the rest", () => {
    const list: Adjustment[] = [
      { group: "g1", date: day("2026-05-06"), playerNormalized: "ada", amountCents: 1250, folder: "May", note: "" },
      { group: "g1", date: day("2026-05-06"), playerNormalized: "ben", amountCents: -1250, folder: "May", note: "" },
      { group: "g2", date: day("2026-05-07"), playerNormalized: "cy", amountCents: -725, folder: "", note: "" },
    ];
    expect(removeGroup(list, "g1")).toEqual({ list: [list[2]], removed: 2 });
  });

  it("removes nothing for a group that is not there", () => {
    const list: Adjustment[] = [
      { group: "g1", date: null, playerNormalized: "ada", amountCents: 1, folder: "", note: "" },
    ];
    expect(removeGroup(list, "nope")).toEqual({ list, removed: 0 });
  });
});
