// Who pays whom (port of src/settlement.hpp/.cpp, without the sheet printer and
// the interactive editor). Pure: text in, data out.
//
// Balances are doubles in dollars, as the C++ keeps them, and every test is against
// the C++ EPSILON (0.009 dollars). The arithmetic runs in the C++ order, so an exact
// tie in cents is broken by the same rounding error on both sides. Payments are
// whole cents: each amount is printed as fixed2 of its double and stored in cents.

import {
  EPSILON_DOLLARS,
  compareBytes,
  dollarsToCents,
  escapeCSV,
  fixed2,
  fixed2Cents,
  itemAt,
  lower,
  normalizeName,
  parseCSV,
  trim,
} from "./util.ts";
import type {
  PaymentPreference,
  PlayerStats,
  Settings,
  SettlementEntry,
  SettlementReason,
  WarnFn,
} from "./models.ts";
import { balanceDollars } from "./players.ts";
import { libcppSort } from "./libcpp-sort.ts";

// The sheet's balances do not add up to zero. "effect" says what the C++ tells
// the user about it; amountCents is the amount that sentence names.
export type GapEffect = "banker-pays-more" | "banker-holds" | "winners-short" | "debt-unpaid";

export interface SheetWarning {
  totalCents: number; // what the balances add up to (0 when they balance)
  effect: GapEffect;
  amountCents: number;
}

export interface SheetResult {
  entries: SettlementEntry[];
  warnings: SheetWarning[];
}

// ---------------- persistence ----------------

// payment_preferences.csv: "payer_normalized,payee_normalized,note". Rows with a
// missing name, or payer = payee, are dropped (as the C++ does).
export function parsePreferencesCSV(text: string, warn?: WarnFn): PaymentPreference[] {
  const prefs: PaymentPreference[] = [];
  parseCSV(text).forEach((row, k) => {
    const at = { source: "payment_preferences.csv", row: k + 1, field: null };
    if (row.length < 2) {
      warn?.({ code: "short-row", ...at });
      return;
    }
    const payer = normalizeName(row[0] ?? "");
    const payee = normalizeName(row[1] ?? "");
    const note = row.length > 2 ? trim(row[2] ?? "") : "";
    if (payer === "" || payee === "" || payer === payee) {
      warn?.({ code: "dropped-row", ...at });
      return;
    }
    prefs.push({ payerNormalized: payer, payeeNormalized: payee, note, oneOff: false });
  });
  return prefs;
}

// Writes the pinned payments. One-off requests are for one sheet only and are
// never written (the C++ header says so; no C++ code creates one today).
export function serializePreferencesCSV(prefs: readonly PaymentPreference[]): string {
  let out = "payer_normalized,payee_normalized,note\n";
  for (const p of prefs) {
    if (p.oneOff) continue;
    out += `${escapeCSV(p.payerNormalized)},${escapeCSV(p.payeeNormalized)},${escapeCSV(p.note)}\n`;
  }
  return out;
}

// settings.csv: "key,value" rows for me, banker and display. Keys not in the file
// keep their value from `current`, as the C++ loads into the existing settings.
export function parseSettingsCSV(text: string, current: Settings): Settings {
  const settings: Settings = { ...current };
  for (const row of parseCSV(text)) {
    if (row.length < 2) continue;
    const key = lower(trim(row[0] ?? ""));
    const value = trim(row[1] ?? "");
    if (key === "me") settings.me = normalizeName(value);
    else if (key === "banker") settings.banker = normalizeName(value);
    else if (key === "display") settings.simpleDisplay = lower(value) === "simple";
  }
  return settings;
}

export function serializeSettingsCSV(settings: Settings): string {
  return (
    "key,value\n" +
    `me,${escapeCSV(settings.me)}\n` +
    `banker,${escapeCSV(settings.banker)}\n` +
    `display,${settings.simpleDisplay ? "simple" : "fancy"}\n`
  );
}

// The settlement sheet as the C++ exportCSV writes it. The reason is written as
// the raw tag: "preference" (pinned), "requested" (one-off), "banker" or "auto".
// Amounts are two decimals.
export function settlementsCSV(entries: readonly SettlementEntry[]): string {
  let out = "from,to,amount,reason,from_normalized,to_normalized\n";
  for (const e of entries) {
    out +=
      `${escapeCSV(e.fromDisplay)},${escapeCSV(e.toDisplay)},${fixed2Cents(e.amountCents)},` +
      `${e.reason},${escapeCSV(e.fromNormalized)},${escapeCSV(e.toNormalized)}\n`;
  }
  return out;
}

// ---------------- calculation ----------------

// The C++ EPSILON, in dollars: anything under a cent is nothing.
const EPS = EPSILON_DOLLARS;

interface Balance {
  display: string;
  normalized: string;
  amount: number; // dollars; positive = is owed, negative = owes
}

type Pay = (from: Balance, to: Balance, amount: number, reason: SettlementReason) => void;

// Balances in the order the C++ std::map visits them: by normalized name, bytes.
function sortedBalances(balances: Map<string, Balance>): Balance[] {
  return [...balances.entries()].sort((a, b) => compareBytes(a[0], b[0])).map((e) => e[1]);
}

// A dollar amount in whole cents, rounded half away from zero as C llround does.
// The zero-sum search works on these, as the C++ does.
function llroundCents(dollars: number): number {
  const x = dollars * 100;
  return Math.sign(x) * Math.round(Math.abs(x));
}

// Settles one self-contained group (its balances sum to zero) with the fewest
// payments, pairing each debt with the smallest credit that can absorb it in
// full. That way a payer sends to a single person whenever one exists, and only
// the biggest debts get split across several recipients.
function settleGroup(members: Balance[], pay: Pay): void {
  const losers: Balance[] = [];
  const winners: Balance[] = [];
  for (const b of members) {
    if (b.amount < -EPS) losers.push(b);
    else if (b.amount > EPS) winners.push(b);
  }
  // Equal debts are ordered by the C++ std::sort, which is not stable, so the sort is
  // ported step for step (libcppSort below).
  libcppSort(losers, 0, losers.length, (a, b) => a.amount < b.amount);

  for (const loser of losers) {
    while (loser.amount < -EPS) {
      const debt = -loser.amount;
      let best: Balance | null = null; // smallest credit that covers the whole debt
      let largest: Balance | null = null; // fallback: biggest credit available
      for (const w of winners) {
        if (w.amount <= EPS) continue;
        if (largest === null || w.amount > largest.amount) largest = w;
        if (w.amount + EPS >= debt && (best === null || w.amount < best.amount)) best = w;
      }
      const target = best ?? largest;
      if (target === null) break; // nothing left to receive (rounding leftovers)
      pay(loser, target, Math.min(debt, target.amount), "auto");
    }
  }
}

// Depth-first search for a zero-sum subset of exactly `size` unused people.
function findZeroSubset(
  cents: number[],
  used: boolean[],
  size: number,
  start: number,
  running: number,
  picked: number[],
): boolean {
  if (picked.length === size) return running === 0;
  const n = cents.length;
  for (let i = start; i < n; i++) {
    if (used[i]) continue;
    if (n - i < size - picked.length) break;
    picked.push(i);
    if (findZeroSubset(cents, used, size, i + 1, running + itemAt(cents, i), picked)) return true;
    picked.pop();
  }
  return false;
}

// Up to this many people, the exact bitmask search runs (2^20 masks at most).
const DP_LIMIT = 20;

// Splits the remaining balances into as many zero-sum groups as possible. Every
// group of m people needs m-1 payments, so more groups means fewer payments.
// Exact search up to DP_LIMIT people; above that, peel off the smallest zero-sum
// subsets first and settle what is left as one group.
function splitIntoGroups(people: Balance[]): Balance[][] {
  const groups: Balance[][] = [];
  const n = people.length;
  if (n === 0) return groups;

  const cents = people.map((p) => llroundCents(p.amount));

  if (n <= DP_LIMIT) {
    const full = (1 << n) - 1;
    // Typed arrays: a 20-person game touches a million masks.
    const sum = new Float64Array(full + 1); // exact: whole cents, far below 2^53
    const best = new Int32Array(full + 1);
    const removed = new Int32Array(full + 1).fill(-1);
    for (let mask = 1; mask <= full; mask++) {
      let low = 0;
      while (!(mask & (1 << low))) low++;
      sum[mask] = itemAt(sum, mask & (mask - 1)) + itemAt(cents, low);
      let bestSub = -1;
      let bestVal = -1;
      for (let i = 0; i < n; i++) {
        if (!(mask & (1 << i))) continue;
        const v = itemAt(best, mask ^ (1 << i));
        if (v > bestVal) {
          bestVal = v;
          bestSub = i;
        }
      }
      best[mask] = bestVal + (sum[mask] === 0 ? 1 : 0);
      removed[mask] = bestSub;
    }
    // Walk back from the full set; every zero-sum mask on the way closes a group.
    let group: Balance[] = [];
    let cur = full;
    while (cur) {
      const i = itemAt(removed, cur);
      group.push(itemAt(people, i));
      cur ^= 1 << i;
      if (sum[cur] === 0 && group.length > 0) {
        groups.push(group);
        group = [];
      }
    }
    if (group.length > 0) groups.push(group);
    return groups;
  }

  // Peel off the smallest zero-sum subsets first (pairs, then triples, ...). The
  // subset size is capped so the search stays quick for big games.
  const maxSize = n <= 40 ? 7 : n <= 60 ? 5 : 4;
  const used: boolean[] = new Array<boolean>(n).fill(false);
  for (let size = 2; size <= maxSize; size++) {
    const picked: number[] = [];
    while (findZeroSubset(cents, used, size, 0, 0, picked)) {
      const g: Balance[] = [];
      for (const i of picked) {
        g.push(itemAt(people, i));
        used[i] = true;
      }
      groups.push(g);
      picked.length = 0;
    }
  }
  const rest: Balance[] = [];
  for (let i = 0; i < n; i++) if (!used[i]) rest.push(itemAt(people, i));
  if (rest.length > 0) groups.push(rest);
  return groups;
}

// The whole sheet: the entries in order, and any warning when the balances do not
// add up to zero. Order of operations, as the C++ header describes:
//   1. banker mode (if set): every loser pays the banker, the banker pays every winner.
//   2. preferences, in order: payer sends to payee as long as both have room
//      (pinned first, then one-off requests, as the caller lists them).
//   3. fewest payments for what is left: zero-sum groups, then best-fit pairing.
export function calculateSheet(
  players: readonly PlayerStats[],
  prefs: readonly PaymentPreference[],
  bankerNormalized: string,
): SheetResult {
  // Balance = poker result + adjustments, in dollars as the C++ holds it. Players
  // with no balance are left out.
  const balances = new Map<string, Balance>();
  for (const p of players) {
    const amount = balanceDollars(p);
    // Balances are sums of whole cents, so a value that is not finite is a caller's bug.
    // A NaN would fail both tests below and drop the player with no warning, so refuse it.
    if (!Number.isFinite(amount)) throw new RangeError("a player's balance is not a finite number");
    if (amount > EPS || amount < -EPS) {
      balances.set(p.normalizedName, { display: p.displayName, normalized: p.normalizedName, amount });
    }
  }

  const entries: SettlementEntry[] = [];
  const pay: Pay = (from, to, amount, reason) => {
    if (amount <= EPS) return;
    entries.push({
      fromDisplay: from.display,
      fromNormalized: from.normalized,
      toDisplay: to.display,
      toNormalized: to.normalized,
      amountCents: dollarsToCents(fixed2(amount)),
      reason,
    });
    from.amount += amount; // debtor's negative balance moves toward zero
    to.amount -= amount; // creditor's positive balance moves toward zero
  };

  // Poker is zero-sum and every payment has two sides, so the balances should add up
  // to $0.00. A one-sided correction or an unbalanced ledger breaks that. The gap is
  // summed in map order, as the C++ does.
  let gap = 0;
  for (const b of sortedBalances(balances)) gap += b.amount;
  const warnings: SheetWarning[] = [];
  const warn = (effect: GapEffect, amount: number): void => {
    if (gap > -EPS && gap < EPS) return;
    warnings.push({ totalCents: dollarsToCents(fixed2(gap)), effect, amountCents: dollarsToCents(fixed2(amount)) });
  };

  // 1. Banker: everyone settles through one person.
  if (bankerNormalized !== "") {
    let bankerDisplay = bankerNormalized;
    for (const p of players) {
      if (p.normalizedName === bankerNormalized) bankerDisplay = p.displayName;
    }
    let banker = balances.get(bankerNormalized);
    if (banker === undefined) {
      banker = { display: bankerDisplay, normalized: bankerNormalized, amount: 0 };
      balances.set(bankerNormalized, banker);
    }

    const order = sortedBalances(balances);
    for (const b of order) {
      if (b.normalized === bankerNormalized) continue;
      if (b.amount < -EPS) pay(b, banker, -b.amount, "banker");
    }
    for (const b of order) {
      if (b.normalized === bankerNormalized) continue;
      if (b.amount > EPS) pay(banker, b, b.amount, "banker");
    }
    // The banker's own result is settled by paying out more (or less) than comes in;
    // any gap lands on them too.
    if (gap > 0) warn("banker-pays-more", gap);
    else warn("banker-holds", -gap);
    return { entries, warnings };
  }

  // 2. Pinned preferences and one-off requests, in order.
  for (const pref of prefs) {
    const payer = balances.get(pref.payerNormalized);
    const payee = balances.get(pref.payeeNormalized);
    if (payer === undefined || payee === undefined) continue;
    if (payer.amount >= -EPS || payee.amount <= EPS) continue;
    const amount = Math.min(-payer.amount, payee.amount);
    pay(payer, payee, amount, pref.oneOff ? "requested" : "preference");
  }

  // 3. Fewest payments for whatever is left: split into zero-sum groups, then
  //    settle each group with best-fit pairing.
  const remaining = sortedBalances(balances).filter((b) => b.amount < -EPS || b.amount > EPS);
  for (const group of splitIntoGroups(remaining)) settleGroup(group, pay);

  // Reconciliation. settleGroup gives up when no credit is left to pay a debt into,
  // which happens only when the balances do not sum to zero. Payments never change
  // that sum, so what is left unpaired is exactly the gap.
  let unpaidDebt = 0;
  let unpaidCredit = 0;
  for (const b of sortedBalances(balances)) {
    if (b.amount < -EPS) unpaidDebt += -b.amount;
    else if (b.amount > EPS) unpaidCredit += b.amount;
  }
  if (unpaidCredit > EPS) warn("winners-short", unpaidCredit);
  else warn("debt-unpaid", unpaidDebt);
  return { entries, warnings };
}
