import { describe, expect, it } from "vitest";

import {
  cleanStem,
  compareBytes,
  dollarsToCents,
  escapeCSV,
  escapeHTML,
  fixed2,
  fixed2Cents,
  formatLocalDate,
  formatLocalDateTime,
  formatShortDate,
  isExcludedDir,
  lower,
  money,
  moneyCents,
  moneySigned,
  moneySignedCents,
  normalizeName,
  parseCents,
  parseCSV,
  parseISO8601UTC,
  parseLocalDate,
  parseNumbers,
  splitCSVLine,
  sumCentsAsDollars,
  toDoubleSafe,
  trim,
  zonedTimeToEpoch,
} from "../src/util.ts";
import { averagePerGameDollars } from "../src/models.ts";

const NEW_YORK = "America/New_York";
const SANTIAGO = "America/Santiago";

describe("CSV text", () => {
  it("keeps commas inside quotes and reads a doubled quote as one quote", () => {
    expect(splitCSVLine('a,"b, c","say ""hi"""')).toEqual(["a", "b, c", 'say "hi"']);
  });

  it("drops carriage returns and keeps empty fields", () => {
    expect(splitCSVLine("x,y\r")).toEqual(["x", "y"]);
    expect(splitCSVLine(",,")).toEqual(["", "", ""]);
  });

  it("skips the header and blank rows, and does not trim the rows", () => {
    const text = "\n  \nplayer_nickname,net\n\nAlice,100\r\n   \nBob,-100\n";
    expect(parseCSV(text)).toEqual([
      ["Alice", "100"],
      ["Bob", "-100"],
    ]);
  });

  it("quotes only the fields that need it", () => {
    expect(escapeCSV("plain")).toBe("plain");
    expect(escapeCSV("a,b")).toBe('"a,b"');
    expect(escapeCSV('say "hi"')).toBe('"say ""hi"""');
  });

  it("escapes HTML special characters", () => {
    expect(escapeHTML(`<b>&'"`)).toBe("&lt;b&gt;&amp;&#39;&quot;");
  });
});

describe("names and text", () => {
  it("normalizes a name to lower-case letters", () => {
    expect(normalizeName("Quinn ):")).toBe("quinn");
    expect(normalizeName("  Ana-Maria 2 ")).toBe("anamaria");
  });

  it("keeps the digits of a name with no letters", () => {
    expect(normalizeName("13131313131313")).toBe("13131313131313");
  });

  it("drops accented letters and emoji, as the C locale does", () => {
    expect(normalizeName('Zoë "Z" O\'Neil')).toBe("zozoneil");
    expect(normalizeName("🙂🙂")).toBe("");
  });

  it("lower-cases ASCII only and trims the six C white-space characters only", () => {
    expect(lower("ÀBc")).toBe("Àbc");
    expect(trim("\t x \v")).toBe("x");
    expect(trim(" x ")).toBe(" x ");
  });

  it("removes a browser copy suffix from a file stem", () => {
    expect(cleanStem("ledger_pglX (1)")).toBe("ledger_pglX");
    expect(cleanStem("ledger_pglX")).toBe("ledger_pglX");
  });

  it("excludes the folders the app never searches", () => {
    for (const name of ["Saved_Data", ".git", ".idea", "build", "reports", "cmake-build-debug"]) {
      expect(isExcludedDir(name)).toBe(true);
    }
    for (const name of ["cmake", "Saved_Data_old", "data"]) {
      expect(isExcludedDir(name)).toBe(false);
    }
  });
});

describe("numbers from text", () => {
  it("reads integer cents, with blanks and junk as 0", () => {
    expect(parseCents("2500")).toBe(2500);
    expect(parseCents(" 2500 ")).toBe(2500);
    expect(parseCents("-2500")).toBe(-2500);
    expect(parseCents("")).toBe(0);
    expect(parseCents("   ")).toBe(0);
    expect(parseCents("abc")).toBe(0);
    expect(parseCents("$5")).toBe(0);
  });

  it("reads the numeric prefix of a value, as stod does", () => {
    expect(parseCents("2500abc")).toBe(2500);
    expect(parseCents("1,234")).toBe(1);
    expect(parseCents("0x1A")).toBe(26);
  });

  it("gives 0 for overflow, underflow and non-finite values", () => {
    expect(parseCents("1e400")).toBe(0);
    expect(parseCents("1e-400")).toBe(0);
    expect(parseCents("inf")).toBe(0);
    expect(toDoubleSafe("1e-310")).toBe(0);
    expect(toDoubleSafe("12.5")).toBe(12.5);
  });

  it("reads dollars as integer cents", () => {
    expect(dollarsToCents("12.34")).toBe(1234);
    expect(dollarsToCents("-0.5")).toBe(-50);
    expect(dollarsToCents("junk")).toBe(0);
  });

  it("reads numbers the way stoi does, with commas as separators", () => {
    expect(parseNumbers("3")).toEqual([3]);
    expect(parseNumbers("2,5 7")).toEqual([2, 5, 7]);
    expect(parseNumbers("2.5")).toEqual([2]);
    expect(parseNumbers("3abc")).toEqual([3]);
    expect(parseNumbers("1 x 2")).toEqual([]);
    expect(parseNumbers("")).toEqual([]);
    expect(parseNumbers("2147483648")).toEqual([]);
    expect(parseNumbers("-5")).toEqual([-5]);
  });
});

describe("fixed2 and money match C printf on macOS", () => {
  // Expected values come from the C++ app's printf on this machine, including the
  // exact half-cent ties (printf rounds the exact binary value, ties to even).
  it.each([
    [0.125, "0.12"],
    [0.375, "0.38"],
    [2.675, "2.67"],
    [1.005, "1.00"],
    [0.005, "0.01"],
    [0.015, "0.01"],
    [0.025, "0.03"],
    [0.035, "0.04"],
    [1.125, "1.12"],
    [1.375, "1.38"],
    [2.625, "2.62"],
    [2.875, "2.88"],
    [0.5, "0.50"],
    [1234.5, "1234.50"],
    [-0.001, "-0.00"],
    [-0.0054, "-0.01"],
    [1e21, "1000000000000000000000.00"],
  ])("fixed2(%s) is %s", (value, text) => {
    expect(fixed2(value)).toBe(text);
  });

  it("formats integer cents exactly", () => {
    expect(fixed2Cents(123456)).toBe("1234.56");
    expect(fixed2Cents(-5)).toBe("-0.05");
    expect(fixed2Cents(0)).toBe("0.00");
    expect(fixed2Cents(10000000)).toBe("100000.00");
  });

  it.each([
    [1234.5, "$1,234.50"],
    [-1234.56, "-$1,234.56"],
    [-0.001, "$0.00"],
    [1000000, "$1,000,000.00"],
    [0.125, "$0.12"],
    [-0.0054, "-$0.01"],
  ])("money(%s) is %s", (value, text) => {
    expect(money(value)).toBe(text);
  });

  it.each([
    [5, "+$5.00"],
    [-5, "-$5.00"],
    [0.004, "$0.00"],
    [-1234.5, "-$1,234.50"],
  ])("moneySigned(%s) is %s", (value, text) => {
    expect(moneySigned(value)).toBe(text);
  });

  it("formats integer cents for the screen", () => {
    expect(moneyCents(-123456)).toBe("-$1,234.56");
    expect(moneySignedCents(250)).toBe("+$2.50");
  });
});

describe("money totals and averages", () => {
  it("adds dollar amounts as doubles, one at a time", () => {
    expect(sumCentsAsDollars([1000, 250, -125])).toBeCloseTo(11.25, 12);
  });

  it("averages like the C++ app, which divides the double sum (not the exact cents)", () => {
    // The C++ app prints 16.05, 11.07 and 8.59 for these; exact cents would give 16.06, 11.08 and 8.58.
    expect(fixed2(averagePerGameDollars([1254, 1957], 2))).toBe("16.05");
    expect(fixed2(averagePerGameDollars([756, 1459], 2))).toBe("11.07");
    expect(fixed2(averagePerGameDollars([507, 1210], 2))).toBe("8.59");
  });

  it("averages to 0 with no games", () => {
    expect(averagePerGameDollars([], 0)).toBe(0);
  });
});

describe("dates and times", () => {
  it("reads ISO UTC stamps, including the rollover of impossible days", () => {
    expect(parseISO8601UTC("2031-05-06T03:34:31.484Z")).toBe(1935804871);
    expect(parseISO8601UTC("1970-01-01T00:00:00Z")).toBe(0);
    expect(parseISO8601UTC("2026-02-31T00:00:00Z")).toBe(1772496000);
    expect(parseISO8601UTC("2031-05-06 03:34:31")).toBeNull();
    expect(parseISO8601UTC("2026-5-6T3:4:5")).toBeNull();
  });

  it("reads local dates as midnight and end of day in New York", () => {
    expect(parseLocalDate("2031-05-06", false, NEW_YORK)).toBe(1935806400); // 04:00Z, EDT
    expect(parseLocalDate("2031-05-06", true, NEW_YORK)).toBe(1935892799); // 23:59:59 EDT
    expect(parseLocalDate("5/6/31", false, NEW_YORK)).toBe(1935806400);
    expect(parseLocalDate("2026-02-31", false, NEW_YORK)).toBe(1772514000); // March 3, EST
    expect(parseLocalDate("2026-13-01", false, NEW_YORK)).toBeNull();
    expect(parseLocalDate("2031-05-00", false, NEW_YORK)).toBeNull();
    expect(parseLocalDate("bad", false, NEW_YORK)).toBeNull();
  });

  it("handles the 2026-11-01 change to standard time in New York (a 25-hour day)", () => {
    // Midnight is still EDT (UTC-4); the last second of the day is EST (UTC-5).
    expect(parseLocalDate("2026-11-01", false, NEW_YORK)).toBe(1793505600);
    expect(parseLocalDate("2026-11-01", true, NEW_YORK)).toBe(1793595599);
    expect(new Date(1793595599 * 1000).toISOString()).toBe("2026-11-02T04:59:59.000Z");
  });

  it("handles the 2026-03-08 change to daylight time in New York (a 23-hour day)", () => {
    expect(parseLocalDate("2026-03-08", false, NEW_YORK)).toBe(1772946000); // 05:00Z, EST
    expect(parseLocalDate("2026-03-08", true, NEW_YORK)).toBe(1773028799); // 23:59:59 EDT
  });

  it("gives the moment of the change for a midnight the clocks skip (Santiago, 2026-09-06)", () => {
    expect(parseLocalDate("2026-09-06", false, SANTIAGO)).toBe(1788667200); // 04:00Z, the change itself
  });

  it("resolves a repeated wall time to its earlier instant", () => {
    // 2026-11-01 01:30 happens twice in New York: EDT (05:30Z) comes first.
    expect(zonedTimeToEpoch(2026, 11, 1, 1, 30, 0, NEW_YORK)).toBe(1793511000);
  });

  it("formats in the zone it is given, never the machine's", () => {
    expect(formatLocalDate(1793595599, NEW_YORK)).toBe("2026-11-01");
    expect(formatLocalDateTime(1793595599, NEW_YORK)).toBe("2026-11-01 23:59");
    expect(formatLocalDateTime(0, NEW_YORK)).toBe("1969-12-31 19:00");
    expect(formatLocalDateTime(0, "UTC")).toBe("1970-01-01 00:00");
    expect(formatLocalDateTime(0, "Asia/Tokyo")).toBe("1970-01-01 09:00");
    expect(formatShortDate(0, NEW_YORK)).toBe("Dec 31");
    expect(formatLocalDate(null, NEW_YORK)).toBe("unknown");
    expect(formatLocalDateTime(null, NEW_YORK)).toBe("unknown");
    expect(formatShortDate(null, NEW_YORK)).toBe("?");
  });
});

describe("byte order", () => {
  it("orders by UTF-8 bytes, which differs from JavaScript's order for emoji", () => {
    // U+1F600 (emoji) is after U+FF01 in UTF-8 bytes, but "<" compares UTF-16 units
    // and puts it first.
    expect(compareBytes("\u{1F600}", "！")).toBeGreaterThan(0);
    expect("\u{1F600}" < "！").toBe(true);
  });

  it("puts capitals before lower case, as C++ does", () => {
    expect(compareBytes("Z", "a")).toBeLessThan(0);
    expect(compareBytes("a", "a")).toBe(0);
    expect(compareBytes("a", "a b")).toBeLessThan(0);
  });
});
