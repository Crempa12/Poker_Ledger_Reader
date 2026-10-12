// Shared helpers for the ledger math (port of src/util.hpp/.cpp, without the
// screen-only parts: colors, padding, dividers and the terminal's clock).
//
// Pure: nothing here reads files, the clock or the machine's time zone. Times
// are whole epoch seconds, and null means "no time" (the C++ NO_TIME). Time
// zones are explicit IANA names. Text follows the C locale the C++ app runs
// in: only ASCII letters and digits count, and only the six C white-space
// characters are trimmed.

export function isSpaceChar(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\v" || c === "\f" || c === "\r";
}

function isDigitChar(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isAsciiLetter(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

// One CSV line into fields. Quotes group commas, a doubled quote is one quote,
// and carriage returns are dropped wherever they appear.
export function splitCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (c === '"') {
      if (inQuotes && line.charAt(i + 1) === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else if (c !== "\r") {
      current += c;
    }
  }
  result.push(current);
  return result;
}

// Every non-blank row after the first non-blank line (the header). The C++
// readCSV reads a file; here the caller passes the text.
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let header = true;
  for (const line of text.split("\n")) {
    if (trim(line) === "") continue;
    if (header) {
      header = false;
      continue;
    }
    rows.push(splitCSVLine(line));
  }
  return rows;
}

// PokerNow file stem without a browser copy suffix: "ledger_pglX (1)" -> "ledger_pglX".
export function cleanStem(stem: string): string {
  const space = stem.indexOf(" "); // PokerNow ids never contain spaces
  return trim(space === -1 ? stem : stem.slice(0, space));
}

// Folders never searched for game files: Saved_Data, reports, build output, .git, .idea.
export function isExcludedDir(name: string): boolean {
  return (
    name === "Saved_Data" ||
    name === ".git" ||
    name === ".idea" ||
    name === "build" ||
    name === "reports" ||
    name.startsWith("cmake-build")
  );
}

export function trim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isSpaceChar(s.charAt(start))) start++;
  while (end > start && isSpaceChar(s.charAt(end - 1))) end--;
  return s.slice(start, end);
}

// ASCII lower-casing only, as tolower does in the C locale.
export function lower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// "Quinn ):" -> "quinn". Only ASCII letters are kept (lower-cased), so accented
// letters and emoji are dropped. A name with no letters keeps its digits
// ("13131313131313"). A name with neither (emoji only) becomes "".
export function normalizeName(name: string): string {
  let letters = "";
  let digits = "";
  for (let i = 0; i < name.length; i++) {
    const c = name.charAt(i);
    if (isAsciiLetter(c)) letters += c.toLowerCase();
    else if (isDigitChar(c)) digits += c;
  }
  return letters === "" ? digits : letters;
}

// The C++ stod rules, used by every number parser below:
//  - the longest numeric prefix counts, so "2500abc" is 2500 and "1,234" is 1;
//  - no number at all (blank, "abc", "$5") is an error;
//  - hex ("0x1A") and "inf"/"nan" are numbers too;
//  - overflow, and underflow to zero or a subnormal, are errors (the C++ catches them).
// Returns null for errors. Non-finite values are returned as they are.
const DECIMAL_PREFIX = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const HEX_PREFIX = /^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?/;
const SPECIAL_PREFIX = /^([+-]?)(inf(?:inity)?|nan(?:\([0-9A-Za-z_]*\))?)/i;
const SMALLEST_NORMAL = 2.2250738585072014e-308;

function stodPrefix(text: string): number | null {
  const special = SPECIAL_PREFIX.exec(text);
  if (special) {
    const word = (special[2] ?? "").toLowerCase();
    if (word.startsWith("nan")) return Number.NaN;
    return special[1] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  const hex = HEX_PREFIX.exec(text);
  if (hex && ((hex[2] ?? "") !== "" || (hex[3] ?? "") !== "")) {
    const whole = hex[2] ?? "";
    const fraction = hex[3] ?? "";
    let mantissa = 0;
    for (const d of whole + fraction) mantissa = mantissa * 16 + parseInt(d, 16);
    let value = mantissa * Math.pow(16, -fraction.length);
    if (hex[4] !== undefined) value *= Math.pow(2, Number(hex[4]));
    return hex[1] === "-" ? -value : value;
  }
  const decimal = DECIMAL_PREFIX.exec(text);
  if (!decimal) return null;
  const numeral = decimal[0];
  const value = Number(numeral);
  const mantissa = numeral.split(/[eE]/)[0] ?? "";
  if (!Number.isFinite(value)) return null; // overflow
  if (value === 0 && /[1-9]/.test(mantissa)) return null; // underflow to zero
  if (value !== 0 && Math.abs(value) < SMALLEST_NORMAL) return null; // subnormal
  return value;
}

// The C++ toDoubleSafe: the number in the text, or 0 for blanks, junk and any
// value that is not a finite number. The result is in whatever unit the text uses.
export function toDoubleSafe(s: string): number {
  const v = stodPrefix(trim(s));
  return v === null || !Number.isFinite(v) ? 0 : v;
}

// Rounds a value to a whole number of cents, half away from zero, with no -0.
function roundToCents(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const r = Math.sign(v) * Math.round(Math.abs(v));
  return r === 0 ? 0 : r;
}

// A cents field from a ledger: "2500" -> 2500 (integer cents, the C++ centsToDollars
// before its divide by 100). Blanks and junk give 0. A value with a fraction of a
// cent is rounded (PokerNow writes whole cents, so this never happens in practice).
export function parseCents(s: string): number {
  return roundToCents(toDoubleSafe(s));
}

// A dollars field from a file: "12.34" -> 1234 (integer cents). Same blank and
// junk rules as parseCents.
export function dollarsToCents(s: string): number {
  return roundToCents(toDoubleSafe(s) * 100);
}

// Quoted only when the field has a comma, a quote or a newline.
export function escapeCSV(s: string): string {
  if (!/[,"\n]/.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] ?? c);
}

const float64View = new DataView(new ArrayBuffer(8));

// Whole cents of a non-negative finite double, rounded the way C printf("%.2f")
// rounds on macOS: the exact binary value is rounded, and an exact tie goes to
// the even cent. Works on the bits, so there is no floating-point rounding here.
function roundedCents(x: number): bigint {
  float64View.setFloat64(0, x);
  const bits = float64View.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & ((1n << 52n) - 1n);
  let exponent: number;
  if (biased === 0) {
    exponent = -1074; // zero and subnormals
  } else {
    mantissa |= 1n << 52n;
    exponent = biased - 1075;
  }
  const scaled = mantissa * 100n; // x * 100 = scaled * 2^exponent exactly
  if (exponent >= 0) return scaled << BigInt(exponent);
  const shift = BigInt(-exponent);
  const whole = scaled >> shift;
  const remainder = scaled - (whole << shift);
  const half = 1n << (shift - 1n);
  if (remainder > half || (remainder === half && (whole & 1n) === 1n)) return whole + 1n;
  return whole;
}

// C printf("%.2f") of a dollar amount, as the file writers use it: "1234.56",
// "-0.00" for a small negative value (printf keeps the sign), no grouping.
export function fixed2(dollars: number): string {
  if (Number.isNaN(dollars)) return "nan";
  const negative = dollars < 0 || Object.is(dollars, -0);
  const magnitude = Math.abs(dollars);
  if (magnitude === Number.POSITIVE_INFINITY) return negative ? "-inf" : "inf";
  const digits = roundedCents(magnitude).toString().padStart(3, "0");
  return (negative ? "-" : "") + digits.slice(0, -2) + "." + digits.slice(-2);
}

// "12.34" for 1234 cents (integer cents only; no rounding needed).
export function fixed2Cents(cents: number): string {
  if (!Number.isInteger(cents)) return fixed2(cents / 100);
  const abs = Math.abs(cents);
  const frac = String(abs % 100).padStart(2, "0");
  return (cents < 0 ? "-" : "") + String(Math.floor(abs / 100)) + "." + frac;
}

// "1234567.00" -> "1,234,567.00". Takes the output of fixed2 without its sign.
function groupThousands(text: string): string {
  const dot = text.indexOf(".");
  const whole = dot === -1 ? text : text.slice(0, dot);
  const rest = dot === -1 ? "" : text.slice(dot);
  let out = "";
  for (let i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 === 0) out += ",";
    out += whole.charAt(i);
  }
  return out + rest;
}

// Screen format: "$1,234.56" / "-$1,234.56". A value under half a cent below
// zero shows as "$0.00". (The C++ also prints "$-0.00" for negative zero; that
// is a display bug, so it shows "$0.00" here.)
export function money(dollars: number): string {
  let v = dollars;
  if (v < 0 && v > -0.005) v = 0;
  if (Object.is(v, -0)) v = 0;
  return (v < 0 ? "-$" : "$") + groupThousands(fixed2(v < 0 ? -v : v));
}

// Screen format: "+$1,234.56" / "-$1,234.56", and "$0.00" for anything under half a cent.
export function moneySigned(dollars: number): string {
  if (dollars > -0.005 && dollars < 0.005) return "$0.00";
  return (dollars < 0 ? "-$" : "+$") + groupThousands(fixed2(Math.abs(dollars)));
}

// The dollar total of some cents amounts, added one at a time as doubles, in the
// given order, the way the C++ app adds its dollar amounts. Use this (not an
// exact cents total) whenever a money total is divided: the rounding of the
// double sum can change the last printed cent of an average.
export function sumCentsAsDollars(cents: Iterable<number>): number {
  let total = 0;
  for (const c of cents) total += c / 100;
  return total;
}

// money / moneySigned for integer cents (the website's usual input).
export function moneyCents(cents: number): string {
  return money(cents / 100);
}

export function moneySignedCents(cents: number): string {
  return moneySigned(cents / 100);
}

// "3" / "2,5 7" -> [2, 5, 7]. Each token is read like std::stoi: an optional
// sign and leading digits, where anything after the digits is ignored. A token
// with no digits, or a value outside the int range, makes the whole result [].
const INT_PREFIX = /^[+-]?\d+/;

export function parseNumbers(text: string): number[] {
  const tokens = text.replace(/,/g, " ").split(/[ \t\n\v\f\r]+/).filter((t) => t !== "");
  const out: number[] = [];
  for (const token of tokens) {
    const match = INT_PREFIX.exec(token);
    if (!match) return [];
    const value = Number(match[0]);
    if (value > 2147483647 || value < -2147483648) return [];
    out.push(value === 0 ? 0 : value);
  }
  return out;
}

// Milliseconds for a wall-clock reading taken as UTC. Fields out of range roll
// over (day 31 of February becomes early March), as mktime and timegm do.
function utcMs(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

// The C scanf "%d" rule: skip white space, take an optional sign and digits, and
// read at most `width` characters. Returns the value and where it stopped.
function scanInt(s: string, pos: number, width: number): { value: number; next: number } | null {
  let i = pos;
  while (i < s.length && isSpaceChar(s.charAt(i))) i++;
  const limit = Math.min(s.length, i + width);
  let j = i;
  if (j < limit && (s.charAt(j) === "+" || s.charAt(j) === "-")) j++;
  const digitsStart = j;
  while (j < limit && isDigitChar(s.charAt(j))) j++;
  if (j === digitsStart) return null;
  return { value: Number(s.slice(i, j)), next: j };
}

const UNLIMITED = 1_000_000_000;

// "2031-05-06T03:34:31.484Z" -> epoch seconds (UTC). The fraction and the zone
// are not read; the C++ sscanf does the same. Text shorter than 19 characters,
// or without the six numeric fields, gives null.
export function parseISO8601UTC(raw: string): number | null {
  const s = trim(raw);
  if (s.length < 19) return null;
  let pos = 0;
  const field = (width: number): number | null => {
    const got = scanInt(s, pos, width);
    if (got === null) return null;
    pos = got.next;
    return got.value;
  };
  const literal = (ch: string): boolean => {
    if (s.charAt(pos) !== ch) return false;
    pos++;
    return true;
  };
  const year = field(4);
  if (year === null || !literal("-")) return null;
  const month = field(2);
  if (month === null || !literal("-")) return null;
  const day = field(2);
  if (day === null || !literal("T")) return null;
  const hour = field(2);
  if (hour === null || !literal(":")) return null;
  const minute = field(2);
  if (minute === null || !literal(":")) return null;
  const second = field(2);
  if (second === null) return null;
  return Math.floor(utcMs(year, month, day, hour, minute, second) / 1000);
}

// Three integers separated by one character, read like sscanf("%d<sep>%d<sep>%d").
function scanThree(s: string, sep: string): [number, number, number] | null {
  let pos = 0;
  const parts: number[] = [];
  for (let k = 0; k < 3; k++) {
    if (k > 0) {
      if (s.charAt(pos) !== sep) return null;
      pos++;
    }
    const got = scanInt(s, pos, UNLIMITED);
    if (got === null) return null;
    parts.push(got.value);
    pos = got.next;
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

// "2031-05-06" or "5/6/26" -> local midnight (or 23:59:59 when endOfDay) in
// timeZone, as epoch seconds. A two-digit year in the slash form means 20xx.
// Null for anything else, including a month outside 1-12 or a day outside 1-31.
export function parseLocalDate(raw: string, endOfDay: boolean, timeZone: string): number | null {
  const s = trim(raw);
  let year: number;
  let month: number;
  let day: number;
  const dashed = scanThree(s, "-");
  if (dashed) {
    [year, month, day] = dashed;
  } else {
    const slashed = scanThree(s, "/");
    if (!slashed) return null;
    [month, day, year] = slashed;
    if (year < 100) year += 2000;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return endOfDay
    ? zonedTimeToEpoch(year, month, day, 23, 59, 59, timeZone)
    : zonedTimeToEpoch(year, month, day, 0, 0, 0, timeZone);
}

const DAY_MS = 86_400_000;

// The zone's UTC offset in milliseconds at one instant (wall clock minus UTC).
function offsetAt(instantMs: number, timeZone: string): number {
  const seconds = Math.floor(instantMs / 1000);
  const w = wallClock(seconds, timeZone);
  return utcMs(w.year, w.month, w.day, w.hour, w.minute, w.second) - seconds * 1000;
}

// Epoch seconds for a wall-clock reading in timeZone. Handles daylight saving:
//  - a reading that happens once gives its one instant;
//  - a reading that happens twice (clocks set back) gives the earlier instant;
//  - a reading the clocks skip (clocks set forward) gives the moment of the change,
//    using the offset from before it, the same answer mktime gives.
export function zonedTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  const wall = utcMs(year, month, day, hour, minute, second);
  const before = offsetAt(wall - DAY_MS, timeZone);
  const after = offsetAt(wall + DAY_MS, timeZone);
  const offsets = before === after ? [before] : [before, after];
  const found: number[] = [];
  for (const offset of offsets) {
    const instant = wall - offset;
    if (offsetAt(instant, timeZone) === offset) found.push(instant);
  }
  if (found.length > 0) return Math.floor(Math.min(...found) / 1000);
  return Math.floor((wall - before) / 1000);
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23", // hours 0-23; "24" would be a midnight quirk of other cycles
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// The wall-clock reading of an instant (whole seconds) in timeZone.
export function wallClock(epochSeconds: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochSeconds * 1000));
  const field = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
  };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

// "2031-05-06" in timeZone, or "unknown" for null.
export function formatLocalDate(epoch: number | null, timeZone: string): string {
  if (epoch === null) return "unknown";
  const w = wallClock(epoch, timeZone);
  return `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)}`;
}

// "2031-05-06 19:16" in timeZone, or "unknown" for null.
export function formatLocalDateTime(epoch: number | null, timeZone: string): string {
  if (epoch === null) return "unknown";
  const w = wallClock(epoch, timeZone);
  return `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)} ${pad(w.hour, 2)}:${pad(w.minute, 2)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "May 6" in timeZone, or "?" for null.
export function formatShortDate(epoch: number | null, timeZone: string): string {
  if (epoch === null) return "?";
  const w = wallClock(epoch, timeZone);
  return `${MONTHS[w.month - 1] ?? "?"} ${w.day}`;
}

// Orders strings by their UTF-8 bytes, as C++ std::string does. For valid text
// that is code point order, which differs from JavaScript's UTF-16 order for
// characters above U+FFFF (emoji) against U+E000-U+FFFF. A lone surrogate is
// written as U+FFFD, as TextEncoder writes it.
export function compareBytes(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = codePointOrReplacement(a, i);
    const cb = codePointOrReplacement(b, j);
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

function codePointOrReplacement(s: string, i: number): number {
  const cp = s.codePointAt(i) ?? 0xfffd;
  return cp >= 0xd800 && cp <= 0xdfff ? 0xfffd : cp;
}
