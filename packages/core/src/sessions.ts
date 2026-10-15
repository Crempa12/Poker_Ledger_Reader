// Saved settlement sheets ("sessions") and the payments made against them (port
// of src/sessions.cpp, without the prompts and the printing).
//
// Pure: the caller reads and writes session_balances.csv. Every function returns
// new balances and leaves its input alone.

import type { SessionBalance, SettlementEntry, WarnFn } from "./models.ts";
import { libcppSort } from "./libcpp-sort.ts";
import {
  EPSILON_CENTS,
  centsOfDollars,
  compareBytes,
  escapeCSV,
  fixed2Cents,
  normalizeName,
  parseCSV,
  readNumber,
  toDoubleSafe,
  trim,
} from "./util.ts";

// Keyed by sessionId|fromNormalized->toNormalized, the key the C++ uses. The map's
// own order means nothing; sortedRows gives the order for printing and files.
export type Balances = Map<string, SessionBalance>;

export const SESSION_BALANCES_HEADER =
  "session_id,from_display,from_normalized,to_display,to_normalized,original_amount,remaining_amount,status";

// The statuses the app writes. Any other word in a saved file is kept as written.
export const SESSION_STATUSES: readonly string[] = ["open", "partial", "paid"];

export function makeKey(sessionId: string, fromNormalized: string, toNormalized: string): string {
  return `${sessionId}|${fromNormalized}->${toNormalized}`;
}

// Session, then payer, then payee, in UTF-8 byte order (as the C++ std::string compares).
function byKey(a: SessionBalance, b: SessionBalance): number {
  if (a.sessionId !== b.sessionId) return compareBytes(a.sessionId, b.sessionId);
  if (a.fromNormalized !== b.fromNormalized) return compareBytes(a.fromNormalized, b.fromNormalized);
  return compareBytes(a.toNormalized, b.toNormalized);
}

// The status a balance has for its remaining amount (the C++ updateStatus). Under
// a cent it is paid and the remainder is cleared; short of the original it is
// partial; otherwise open.
function updateStatus(b: SessionBalance): SessionBalance {
  if (b.remainingCents <= EPSILON_CENTS) return { ...b, remainingCents: 0, status: "paid" };
  if (b.remainingCents < b.originalCents - EPSILON_CENTS) return { ...b, status: "partial" };
  return { ...b, status: "open" };
}

// Reads session_balances.csv text. A row needs eight fields, and a row with no
// session or no names is left out. A repeated key keeps its last row, as the C++
// load does. The status is kept as written, so the file round-trips even if a
// hand edit put in another word; the app itself writes only open, partial, paid.
// Malformed rows are reported to warn: a short row, a money cell that is junk (read
// as 0) or not finite (the row is refused), an unknown status, a row with no names.
export function parseSessionBalances(text: string, warn?: WarnFn): Balances {
  const balances: Balances = new Map();
  parseCSV(text).forEach((row, k) => {
    const at = { source: "session_balances.csv", row: k + 1 };
    if (row.length < 8) {
      warn?.({ ...at, code: "short-row", field: null });
      return;
    }
    const cell = (i: number): string => row[i] ?? "";
    const money = (i: number, field: string): number | null => {
      const reading = readNumber(cell(i));
      if (reading === "non-finite") {
        warn?.({ ...at, code: "non-finite-number", field });
        return null;
      }
      if (reading === "junk") warn?.({ ...at, code: "bad-number", field });
      return centsOfDollars(toDoubleSafe(cell(i)));
    };
    const originalCents = money(5, "original_amount");
    const remainingCents = money(6, "remaining_amount");
    if (originalCents === null || remainingCents === null) return;
    const status = trim(cell(7));
    if (!SESSION_STATUSES.includes(status)) warn?.({ ...at, code: "unknown-status", field: "status" });
    const bal: SessionBalance = {
      sessionId: trim(cell(0)),
      fromDisplay: trim(cell(1)),
      fromNormalized: normalizeName(cell(2)),
      toDisplay: trim(cell(3)),
      toNormalized: normalizeName(cell(4)),
      originalCents,
      remainingCents,
      status,
    };
    if (bal.sessionId === "" || bal.fromNormalized === "" || bal.toNormalized === "") {
      warn?.({ ...at, code: "dropped-row", field: null });
      return;
    }
    balances.set(makeKey(bal.sessionId, bal.fromNormalized, bal.toNormalized), bal);
  });
  return balances;
}

// The session_balances.csv text: header, then one line per balance in the sorted order.
export function serializeSessionBalances(balances: Balances): string {
  let out = SESSION_BALANCES_HEADER + "\n";
  for (const b of [...balances.values()].sort(byKey)) {
    out +=
      [
        escapeCSV(b.sessionId),
        escapeCSV(b.fromDisplay),
        escapeCSV(b.fromNormalized),
        escapeCSV(b.toDisplay),
        escapeCSV(b.toNormalized),
        fixed2Cents(b.originalCents),
        fixed2Cents(b.remainingCents),
        escapeCSV(b.status),
      ].join(",") + "\n";
  }
  return out;
}

// The balances in print order. With openOnly, only the ones still owed.
export function sortedRows(balances: Balances, openOnly: boolean): SessionBalance[] {
  return [...balances.values()].filter((b) => !openOnly || b.remainingCents > EPSILON_CENTS).sort(byKey);
}

// Saves a settlement sheet under a session id. Each entry adds to the balance for
// its payer and payee: a new pair starts open, and an existing one keeps its
// names and gets the amount added to both its original and remaining figures.
export function addSettlementBatch(
  balances: Balances,
  sessionId: string,
  entries: readonly SettlementEntry[],
): Balances {
  const next: Balances = new Map(balances);
  for (const e of entries) {
    // Sheet entries are whole cents by construction (calculateSheet), so anything else is a caller's bug.
    if (!Number.isSafeInteger(e.amountCents)) throw new RangeError("a settlement entry is not a whole number of cents");
    const key = makeKey(sessionId, e.fromNormalized, e.toNormalized);
    const existing = next.get(key);
    if (existing === undefined) {
      next.set(key, {
        sessionId,
        fromDisplay: e.fromDisplay,
        fromNormalized: e.fromNormalized,
        toDisplay: e.toDisplay,
        toNormalized: e.toNormalized,
        originalCents: e.amountCents,
        remainingCents: e.amountCents,
        status: "open",
      });
    } else {
      next.set(
        key,
        updateStatus({
          ...existing,
          originalCents: existing.originalCents + e.amountCents,
          remainingCents: existing.remainingCents + e.amountCents,
        }),
      );
    }
  }
  return next;
}

export interface PaymentPair {
  fromNormalized: string; // the one who owes
  toNormalized: string; // the one who is owed
}

export interface PaymentResult {
  balances: Balances; // a new map, or the same map when nothing was recorded
  balance: SessionBalance | null; // the updated balance, or null when nothing was recorded
  appliedCents: number; // the part that counted against what was still owed
  overpaidCents: number; // the part above what was owed. Not recorded, as the C++ does
  refused: string | null; // why an amount was refused (not a whole number of cents), else null
}

// Records a payment against one balance. A payment of nothing, or against a
// balance that is not there, changes nothing. A payment above what is owed
// clears the balance, and the excess is reported but not kept. An amount that is
// not a whole number of cents (NaN, inf, 12.5) is refused and changes nothing.
export function recordPayment(
  balances: Balances,
  sessionId: string,
  pair: PaymentPair,
  amountCents: number,
): PaymentResult {
  if (!Number.isSafeInteger(amountCents)) {
    return { balances, balance: null, appliedCents: 0, overpaidCents: 0, refused: "Amount must be a whole number of cents." };
  }
  const key = makeKey(sessionId, pair.fromNormalized, pair.toNormalized);
  const current = balances.get(key);
  if (current === undefined || !(amountCents > 0)) {
    return { balances, balance: null, appliedCents: 0, overpaidCents: 0, refused: null };
  }
  const owed = Math.max(current.remainingCents, 0);
  const applied = Math.min(amountCents, owed);
  const updated = updateStatus({ ...current, remainingCents: current.remainingCents - applied });
  const next: Balances = new Map(balances);
  next.set(key, updated);
  return { balances: next, balance: updated, appliedCents: applied, overpaidCents: amountCents - applied, refused: null };
}

export interface CombinedDebt {
  fromDisplay: string;
  fromNormalized: string;
  toDisplay: string;
  toNormalized: string;
  totalCents: number; // what is still owed across every saved sheet
}

// What each pair still owes across every saved sheet, biggest first. Pairs with the
// same total keep their payer-then-payee byte order. The display names come from
// the first sheet (in print order) that has the pair.
export function combinedUnpaid(balances: Balances): CombinedDebt[] {
  const byPair = new Map<string, CombinedDebt>();
  for (const b of sortedRows(balances, false)) {
    if (b.remainingCents <= EPSILON_CENTS) continue;
    const pairKey = `${b.fromNormalized}->${b.toNormalized}`;
    const debt = byPair.get(pairKey);
    if (debt === undefined) {
      byPair.set(pairKey, {
        fromDisplay: b.fromDisplay,
        fromNormalized: b.fromNormalized,
        toDisplay: b.toDisplay,
        toNormalized: b.toNormalized,
        totalCents: b.remainingCents,
      });
    } else {
      debt.totalCents += b.remainingCents;
    }
  }
  const debts = [...byPair.entries()].sort(([a], [b]) => compareBytes(a, b)).map(([, debt]) => debt);
  // The C++ sorts these by total with std::sort, which is not stable: two equal totals
  // keep the order libc++ leaves them in, so that sort is ported (libcppSort).
  libcppSort(debts, 0, debts.length, (a, b) => a.totalCents > b.totalCents);
  return debts;
}
