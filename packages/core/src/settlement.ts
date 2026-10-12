// Who pays whom (port of src/settlement.hpp/.cpp, without the sheet printer and
// the interactive editor). Pure: text in, data out.
//
// Balances are doubles in dollars, as the C++ keeps them, and every test is against
// the C++ EPSILON (0.009 dollars). The arithmetic runs in the C++ order, so an exact
// tie in cents is broken by the same rounding error on both sides. Payments are
// whole cents: each amount is printed as fixed2 of its double and stored in cents.

import {
  compareBytes,
  dollarsToCents,
  escapeCSV,
  fixed2,
  fixed2Cents,
  lower,
  moneyCents,
  moneySignedCents,
  normalizeName,
  parseCSV,
  trim,
} from "./util.ts";
import type { PaymentPreference, PlayerStats, Settings, SettlementEntry, SettlementReason } from "./models.ts";
import { balanceDollars } from "./players.ts";

// The reason a sheet entry was made, as the settlements.csv tag. "requested" is
// a one-off request for this sheet only.
export type SheetReason = SettlementReason;

export type SheetEntry = SettlementEntry;

// The sheet's balances do not add up to zero. "effect" says what the C++ tells
// the user about it; amountCents is the amount that sentence names.
export type GapEffect = "banker-pays-more" | "banker-holds" | "winners-short" | "debt-unpaid";

export interface SheetWarning {
  totalCents: number; // what the balances add up to (0 when they balance)
  effect: GapEffect;
  amountCents: number;
}

export interface SheetResult {
  entries: SheetEntry[];
  warnings: SheetWarning[];
}

// ---------------- persistence ----------------

// payment_preferences.csv: "payer_normalized,payee_normalized,note". Rows with a
// missing name, or payer = payee, are dropped (as the C++ does).
export function loadPreferencesCSV(text: string): PaymentPreference[] {
  const prefs: PaymentPreference[] = [];
  for (const row of parseCSV(text)) {
    if (row.length < 2) continue;
    const payer = normalizeName(row[0] ?? "");
    const payee = normalizeName(row[1] ?? "");
    const note = row.length > 2 ? trim(row[2] ?? "") : "";
    if (payer !== "" && payee !== "" && payer !== payee) {
      prefs.push({ payerNormalized: payer, payeeNormalized: payee, note, oneOff: false });
    }
  }
  return prefs;
}

// Writes the pinned payments. One-off requests are for one sheet only and are
// never written (the C++ header says so; no C++ code creates one today).
export function savePreferencesCSV(prefs: PaymentPreference[]): string {
  let out = "payer_normalized,payee_normalized,note\n";
  for (const p of prefs) {
    if (p.oneOff) continue;
    out += `${escapeCSV(p.payerNormalized)},${escapeCSV(p.payeeNormalized)},${escapeCSV(p.note)}\n`;
  }
  return out;
}

// settings.csv: "key,value" rows for me, banker and display. Keys not in the file
// keep their value from `current`, as the C++ loads into the existing settings.
export function loadSettingsCSV(text: string, current: Settings): Settings {
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

export function saveSettingsCSV(settings: Settings): string {
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
export function settlementsCSV(entries: SheetEntry[]): string {
  let out = "from,to,amount,reason,from_normalized,to_normalized\n";
  for (const e of entries) {
    out +=
      `${escapeCSV(e.fromDisplay)},${escapeCSV(e.toDisplay)},${fixed2Cents(e.amountCents)},` +
      `${e.reason},${escapeCSV(e.fromNormalized)},${escapeCSV(e.toNormalized)}\n`;
  }
  return out;
}

// The sentences the C++ prints when the sheet does not balance, without colors
// and without the menu reference.
export function warningText(w: SheetWarning): string[] {
  const lines = [`This sheet does not balance: its totals add up to ${moneySignedCents(w.totalCents)} instead of $0.00.`];
  switch (w.effect) {
    case "banker-pays-more":
      lines.push(`The banker pays out ${moneyCents(w.amountCents)} more than their own result covers.`);
      break;
    case "banker-holds":
      lines.push(`The banker is left holding ${moneyCents(w.amountCents)} that nobody is owed.`);
      break;
    case "winners-short":
      lines.push(`Some winners get ${moneyCents(w.amountCents)} less than the table above shows.`);
      break;
    case "debt-unpaid":
      lines.push(`${moneyCents(w.amountCents)} of debt has nobody to be paid to.`);
      break;
  }
  lines.push("The cause is a one-sided correction or a ledger that does not balance.");
  return lines;
}

// ---------------- calculation ----------------

// The C++ EPSILON, in dollars: anything under a cent is nothing.
const EPS = 0.009;

interface Balance {
  display: string;
  normalized: string;
  amount: number; // dollars; positive = is owed, negative = owes
}

type Pay = (from: Balance, to: Balance, amount: number, reason: SheetReason) => void;

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
    if (findZeroSubset(cents, used, size, i + 1, running + (cents[i] ?? 0), picked)) return true;
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
      sum[mask] = sum[mask & (mask - 1)]! + cents[low]!;
      let bestSub = -1;
      let bestVal = -1;
      for (let i = 0; i < n; i++) {
        if (!(mask & (1 << i))) continue;
        const v = best[mask ^ (1 << i)]!;
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
      const i = removed[cur]!;
      group.push(people[i]!);
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
        g.push(people[i]!);
        used[i] = true;
      }
      groups.push(g);
      picked.length = 0;
    }
  }
  const rest: Balance[] = [];
  for (let i = 0; i < n; i++) if (!used[i]) rest.push(people[i]!);
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
  players: PlayerStats[],
  prefs: PaymentPreference[],
  bankerNormalized: string,
): SheetResult {
  // Balance = poker result + adjustments, in dollars as the C++ holds it. Players
  // with no balance are left out.
  const balances = new Map<string, Balance>();
  for (const p of players) {
    const amount = balanceDollars(p);
    if (amount > EPS || amount < -EPS) {
      balances.set(p.normalizedName, { display: p.displayName, normalized: p.normalizedName, amount });
    }
  }

  const entries: SheetEntry[] = [];
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

// The entries alone, as the C++ calculate returns them.
export function calculate(
  players: PlayerStats[],
  prefs: PaymentPreference[],
  bankerNormalized: string,
): SheetEntry[] {
  return calculateSheet(players, prefs, bankerNormalized).entries;
}

// ---------------- libc++ std::sort ----------------
//
// The C++ sorts the losers with std::sort. Equal keys can come out in a different
// order from a different sort routine, and that order decides who pays whom. So
// this is a step-for-step port of the libc++ introsort that Apple clang uses for
// pointers with a lambda comparator (the non-branchless path): sorting networks
// for up to 5 items, insertion sort below 24, a pattern-defeating quicksort above
// that, and heap sort when the depth limit runs out.

type Less<T> = (a: T, b: T) => boolean;

function at<T>(a: T[], i: number): T {
  return a[i] as T;
}

function swapAt<T>(a: T[], i: number, j: number): void {
  const t = at(a, i);
  a[i] = at(a, j);
  a[j] = t;
}

function sort3<T>(a: T[], x: number, y: number, z: number, c: Less<T>): void {
  if (!c(at(a, y), at(a, x))) {
    // x <= y
    if (!c(at(a, z), at(a, y))) return; // x <= y <= z
    swapAt(a, y, z);
    if (c(at(a, y), at(a, x))) swapAt(a, x, y);
    return;
  }
  // x > y
  if (c(at(a, z), at(a, y))) {
    swapAt(a, x, z);
    return;
  }
  swapAt(a, x, y);
  if (c(at(a, z), at(a, y))) swapAt(a, y, z);
}

function sort4<T>(a: T[], x1: number, x2: number, x3: number, x4: number, c: Less<T>): void {
  sort3(a, x1, x2, x3, c);
  if (c(at(a, x4), at(a, x3))) {
    swapAt(a, x3, x4);
    if (c(at(a, x3), at(a, x2))) {
      swapAt(a, x2, x3);
      if (c(at(a, x2), at(a, x1))) swapAt(a, x1, x2);
    }
  }
}

function sort5<T>(a: T[], x1: number, x2: number, x3: number, x4: number, x5: number, c: Less<T>): void {
  sort4(a, x1, x2, x3, x4, c);
  if (c(at(a, x5), at(a, x4))) {
    swapAt(a, x4, x5);
    if (c(at(a, x4), at(a, x3))) {
      swapAt(a, x3, x4);
      if (c(at(a, x3), at(a, x2))) {
        swapAt(a, x2, x3);
        if (c(at(a, x2), at(a, x1))) swapAt(a, x1, x2);
      }
    }
  }
}

// Insertion sort of [first, last). The inner loop stops at `first`, so it needs no
// sentinel before the range (the guarded version).
function insertionSort<T>(a: T[], first: number, last: number, c: Less<T>): void {
  for (let i = first + 1; i !== last; i++) {
    let j = i - 1;
    if (c(at(a, i), at(a, j))) {
      const t = at(a, i);
      let k = j;
      j = i;
      do {
        a[j] = at(a, k);
        j = k;
      } while (j !== first && c(t, at(a, --k)));
      a[j] = t;
    }
  }
}

// The same insertion sort for a range with an element before `first` that is no
// larger than anything in the range, so the inner loop needs no bounds check.
function insertionSortUnguarded<T>(a: T[], first: number, last: number, c: Less<T>): void {
  for (let i = first + 1; i !== last; i++) {
    let j = i - 1;
    if (c(at(a, i), at(a, j))) {
      const t = at(a, i);
      let k = j;
      j = i;
      do {
        a[j] = at(a, k);
        j = k;
      } while (c(t, at(a, --k)));
      a[j] = t;
    }
  }
}

// Insertion sort that gives up after 8 moves (returns false). Used on the two
// halves after a partition that already split them cleanly.
function insertionSortIncomplete<T>(a: T[], first: number, last: number, c: Less<T>): boolean {
  switch (last - first) {
    case 0:
    case 1:
      return true;
    case 2:
      if (c(at(a, last - 1), at(a, first))) swapAt(a, first, last - 1);
      return true;
    case 3:
      sort3(a, first, first + 1, last - 1, c);
      return true;
    case 4:
      sort4(a, first, first + 1, first + 2, last - 1, c);
      return true;
    case 5:
      sort5(a, first, first + 1, first + 2, first + 3, last - 1, c);
      return true;
  }
  let j = first + 2;
  sort3(a, first, first + 1, j, c);
  const limit = 8;
  let count = 0;
  for (let i = j + 1; i !== last; i++) {
    if (c(at(a, i), at(a, j))) {
      const t = at(a, i);
      let k = j;
      j = i;
      do {
        a[j] = at(a, k);
        j = k;
      } while (j !== first && c(t, at(a, --k)));
      a[j] = t;
      if (++count === limit) {
        i++;
        return i === last;
      }
    }
    j = i;
  }
  return true;
}

// Partition with the pivot's equals on the right. Returns the pivot's final
// position and whether the range was already partitioned.
function partitionWithEqualsOnRight<T>(
  a: T[],
  first0: number,
  last0: number,
  c: Less<T>,
): { pos: number; already: boolean } {
  const begin = first0;
  let first = first0;
  let last = last0;
  const pivot = at(a, begin);
  do {
    first++;
  } while (c(at(a, first), pivot));
  if (begin === first - 1) {
    while (first < last) {
      last--;
      if (c(at(a, last), pivot)) break;
    }
  } else {
    do {
      last--;
    } while (!c(at(a, last), pivot));
  }
  const already = first >= last;
  while (first < last) {
    swapAt(a, first, last);
    do {
      first++;
    } while (c(at(a, first), pivot));
    do {
      last--;
    } while (!c(at(a, last), pivot));
  }
  const pivotPos = first - 1;
  if (begin !== pivotPos) a[begin] = at(a, pivotPos);
  a[pivotPos] = pivot;
  return { pos: pivotPos, already };
}

// Partition with the pivot's equals on the left (used when the element before the
// range equals the pivot). Returns the start of the right-hand part.
function partitionWithEqualsOnLeft<T>(a: T[], first0: number, last0: number, c: Less<T>): number {
  const begin = first0;
  let first = first0;
  let last = last0;
  const pivot = at(a, begin);
  if (c(pivot, at(a, last - 1))) {
    do {
      first++;
    } while (!c(pivot, at(a, first)));
  } else {
    first++;
    while (first < last && !c(pivot, at(a, first))) first++;
  }
  if (first < last) {
    do {
      last--;
    } while (c(pivot, at(a, last)));
  }
  while (first < last) {
    swapAt(a, first, last);
    do {
      first++;
    } while (!c(pivot, at(a, first)));
    do {
      last--;
    } while (c(pivot, at(a, last)));
  }
  const pivotPos = first - 1;
  if (begin !== pivotPos) a[begin] = at(a, pivotPos);
  a[pivotPos] = pivot;
  return first;
}

function siftDown<T>(a: T[], first: number, len: number, start0: number, c: Less<T>): void {
  let start = start0;
  let child = start - first;
  if (len < 2 || Math.floor((len - 2) / 2) < child) return;
  child = 2 * child + 1;
  let childI = first + child;
  if (child + 1 < len && c(at(a, childI), at(a, childI + 1))) {
    childI++;
    child++;
  }
  if (c(at(a, childI), at(a, start))) return;
  const top = at(a, start);
  do {
    a[start] = at(a, childI);
    start = childI;
    if (Math.floor((len - 2) / 2) < child) break;
    child = 2 * child + 1;
    childI = first + child;
    if (child + 1 < len && c(at(a, childI), at(a, childI + 1))) {
      childI++;
      child++;
    }
  } while (!c(at(a, childI), top));
  a[start] = top;
}

// Sinks the top of a heap to the bottom along the larger children, then floats the
// element that was last back up (the libc++ "floyd" pop). Returns the hole.
function floydSiftDown<T>(a: T[], first: number, len: number, c: Less<T>): number {
  let hole = first;
  let childI = first;
  let child = 0;
  for (;;) {
    childI += child + 1;
    child = 2 * child + 1;
    if (child + 1 < len && c(at(a, childI), at(a, childI + 1))) {
      childI++;
      child++;
    }
    a[hole] = at(a, childI);
    hole = childI;
    if (child > Math.floor((len - 2) / 2)) return hole;
  }
}

function siftUp<T>(a: T[], first: number, last0: number, c: Less<T>, len0: number): void {
  let last = last0;
  let len = len0;
  if (len > 1) {
    len = Math.floor((len - 2) / 2);
    let ptr = first + len;
    last--;
    if (c(at(a, ptr), at(a, last))) {
      const t = at(a, last);
      do {
        a[last] = at(a, ptr);
        last = ptr;
        if (len === 0) break;
        len = Math.floor((len - 1) / 2);
        ptr = first + len;
      } while (c(at(a, ptr), t));
      a[last] = t;
    }
  }
}

function popHeap<T>(a: T[], first: number, last0: number, c: Less<T>, len: number): void {
  let last = last0;
  if (len > 1) {
    const top = at(a, first);
    let hole = floydSiftDown(a, first, len, c);
    last--;
    if (hole === last) {
      a[hole] = top;
    } else {
      a[hole] = at(a, last);
      hole++;
      a[last] = top;
      siftUp(a, first, hole, c, hole - first);
    }
  }
}

function makeHeap<T>(a: T[], first: number, last: number, c: Less<T>): void {
  const n = last - first;
  if (n > 1) {
    for (let start = Math.floor((n - 2) / 2); start >= 0; start--) siftDown(a, first, n, first + start, c);
  }
}

function sortHeap<T>(a: T[], first: number, last0: number, c: Less<T>): void {
  let last = last0;
  for (let n = last - first; n > 1; last--, n--) popHeap(a, first, last, c, n);
}

function introsort<T>(
  a: T[],
  first0: number,
  last0: number,
  c: Less<T>,
  depth0: number,
  leftmost0: boolean,
): void {
  let first = first0;
  let last = last0;
  let depth = depth0;
  let leftmost = leftmost0;
  const limit = 24; // insertion sort below this length
  const ninther = 128; // median of nine pivots above this length
  for (;;) {
    const len = last - first;
    switch (len) {
      case 0:
      case 1:
        return;
      case 2:
        if (c(at(a, last - 1), at(a, first))) swapAt(a, first, last - 1);
        return;
      case 3:
        sort3(a, first, first + 1, last - 1, c);
        return;
      case 4:
        sort4(a, first, first + 1, first + 2, last - 1, c);
        return;
      case 5:
        sort5(a, first, first + 1, first + 2, first + 3, last - 1, c);
        return;
    }
    if (len < limit) {
      if (leftmost) insertionSort(a, first, last, c);
      else insertionSortUnguarded(a, first, last, c);
      return;
    }
    if (depth === 0) {
      // Too many bad splits: heap sort guarantees n log n.
      makeHeap(a, first, last, c);
      sortHeap(a, first, last, c);
      return;
    }
    depth--;
    {
      const half = Math.floor(len / 2);
      if (len > ninther) {
        sort3(a, first, first + half, last - 1, c);
        sort3(a, first + 1, first + (half - 1), last - 2, c);
        sort3(a, first + 2, first + (half + 1), last - 3, c);
        sort3(a, first + (half - 1), first + half, first + (half + 1), c);
        swapAt(a, first, first + half);
      } else {
        sort3(a, first + half, first, last - 1, c);
      }
    }
    // When the element before this range equals the pivot, the equals go left and
    // the left side is already in place.
    if (!leftmost && !c(at(a, first - 1), at(a, first))) {
      first = partitionWithEqualsOnLeft(a, first, last, c);
      continue;
    }
    const part = partitionWithEqualsOnRight(a, first, last, c);
    let i = part.pos;
    if (part.already) {
      const fs = insertionSortIncomplete(a, first, i, c);
      if (insertionSortIncomplete(a, i + 1, last, c)) {
        if (fs) return;
        last = i;
        continue;
      } else if (fs) {
        i++;
        first = i;
        continue;
      }
    }
    introsort(a, first, i, c, depth, leftmost);
    leftmost = false;
    first = i + 1;
  }
}

// std::sort(first, last, comp) on the range [lo, hi) of `a`, in place.
export function libcppSort<T>(a: T[], lo: number, hi: number, c: Less<T>): void {
  const len = hi - lo;
  if (len <= 0) return;
  const depth = 2 * (31 - Math.clz32(len)); // 2 * floor(log2(len))
  introsort(a, lo, hi, c, depth, true);
}
