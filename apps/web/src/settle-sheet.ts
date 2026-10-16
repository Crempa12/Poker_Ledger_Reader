// The settle-up page's wording and order, as menu 5 (calculateSettlement, settlement::print,
// settlement::warnGap) shows them: the balances table, the transfers in print order with each payer's
// total, who receives what, the warning when the balances do not add up, and the summary line under the sheet. Pure: the page passes the
// board and the sheet in and renders what comes back.
import { money, moneyCents, moneySigned, moneySignedCents, players, settlement, util, type PlayerStats, type SettlementEntry } from "@plr/core";

import type { ScopeChoice } from "./data.ts";
import { plural } from "./format.ts";

// One line of the balances table: Player, Poker net, Payments, Settles as.
export interface BalanceRow {
  p: PlayerStats;
  owes: boolean; // the balance is under a cent below zero: owes money on this sheet
  owed: boolean; // the balance is over a cent above zero: is owed money on this sheet
  tone: "up" | "down" | "even";
  poker: string; // the poker result: "+$91.47", "-$3.15", "$0.00"
  payments: string; // the payments and corrections: "+$12.50", "-$7.00", or "-" when there are none
  settles: string; // "is owed $91.47", "owes $1.61", or "even"
}

// Every player on the board, as menu 5 lists them: the poker-result order (sortedByNet), then the
// highest balance first. The sort is stable, so equal balances keep the poker-result order, as the
// console's stable_sort does. Players who are even are listed too.
export function balanceRows(board: readonly PlayerStats[]): BalanceRow[] {
  const eps = util.EPSILON_DOLLARS;
  const keyed = board.map((p) => {
    const dollars = players.playerDollars(p);
    return { p, net: dollars.totalNet, adjustments: dollars.adjustments, balance: players.balanceDollars(p) };
  });
  keyed.sort((a, b) => (a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0));
  return keyed.map(({ p, net, adjustments, balance }) => {
    const owes = balance < -eps;
    const owed = balance > eps;
    const paid = adjustments > eps || adjustments < -eps;
    return {
      p,
      owes,
      owed,
      tone: owed ? "up" : owes ? "down" : "even",
      poker: moneySigned(net),
      payments: paid ? moneySigned(adjustments) : "-",
      settles: owed ? `is owed ${money(balance)}` : owes ? `owes ${money(-balance)}` : "even",
    };
  });
}

// The transfers in the order menu 5 prints them (settlement::print): grouped by payer, the payers with
// the most to pay first (a stable sort, so equal totals keep the sheet's order), each payer's lines in
// the sheet's order. The sheet itself (and the CSV) keep the order the calculation makes.
export function printOrder(entries: readonly SettlementEntry[]): SettlementEntry[] {
  const payers = new Map<string, { total: number; lines: SettlementEntry[] }>();
  for (const e of entries) {
    const payer = payers.get(e.fromNormalized) ?? { total: 0, lines: [] };
    payer.total += e.amountCents;
    payer.lines.push(e);
    payers.set(e.fromNormalized, payer);
  }
  return [...payers.values()].sort((a, b) => b.total - a.total).flatMap((payer) => payer.lines);
}

// One line of the sheet as menu 5 prints it: a transfer, or the payer's total under their last transfer.
export type SheetRow = { kind: "transfer"; entry: SettlementEntry } | { kind: "total"; text: string };

// The sheet's lines in the order menu 5 prints them (printOrder). Under a payer's last transfer comes their
// total when they pay more than one person: "sends $46.85 in all, to 2 people" (settlement::print).
export function sheetRows(entries: readonly SettlementEntry[]): SheetRow[] {
  const ordered = printOrder(entries);
  const totals = new Map<string, { cents: number; count: number }>();
  for (const e of entries) {
    const total = totals.get(e.fromNormalized) ?? { cents: 0, count: 0 };
    total.cents += e.amountCents;
    total.count += 1;
    totals.set(e.fromNormalized, total);
  }
  return ordered.flatMap((e, i): SheetRow[] => {
    const row: SheetRow = { kind: "transfer", entry: e };
    const total = totals.get(e.fromNormalized);
    const lastOfPayer = ordered[i + 1]?.fromNormalized !== e.fromNormalized;
    if (!lastOfPayer || total === undefined || total.count < 2) return [row];
    return [row, { kind: "total", text: `sends ${moneyCents(total.cents)} in all, to ${plural(total.count, "person", "people")}` }];
  });
}

// One line of "Who receives what" (menu 5): what a receiver is sent in all, and by whom.
export interface Receiver {
  name: string; // the receiver's display name
  cents: number;
  from: string[]; // the senders' display names, in the order the sheet calculates them (the console's order)
}

// The receivers, by display name in byte order (the console's map order), each with their total and senders.
export function receiversOf(entries: readonly SettlementEntry[]): Receiver[] {
  const byName = new Map<string, Receiver>();
  for (const e of entries) {
    const receiver = byName.get(e.toDisplay) ?? { name: e.toDisplay, cents: 0, from: [] };
    receiver.cents += e.amountCents;
    receiver.from.push(e.fromDisplay);
    byName.set(e.toDisplay, receiver);
  }
  return [...byName.values()].sort((a, b) => util.compareBytes(a.name, b.name));
}

// The line under the sheet, as menu 5 prints it: "37 payments, 21 senders, 23 receivers". Receivers
// are counted by their display name, as the console counts them.
export function sheetSummary(entries: readonly SettlementEntry[]): string {
  const senders = new Set(entries.map((e) => e.fromNormalized)).size;
  const receivers = new Set(entries.map((e) => e.toDisplay)).size;
  return `${plural(entries.length, "payment")}, ${plural(senders, "sender")}, ${plural(receivers, "receiver")}`;
}

// The warning when the balances do not add up to $0.00 (settlement.cpp warnGap): what they add up to,
// what that means for this sheet, and the cause. The effect comes from the core, which knows whether the
// sheet settles through a banker and which way the gap runs.
export function offByLines(w: settlement.SheetWarning): string[] {
  const amount = moneyCents(w.amountCents);
  const effect =
    w.effect === "banker-pays-more"
      ? `The banker pays out ${amount} more than their own result covers.`
      : w.effect === "banker-holds"
        ? `The banker is left holding ${amount} that nobody is owed.`
        : w.effect === "winners-short"
          ? `Some winners get ${amount} less than the table above shows.`
          : `${amount} of debt has nobody to be paid to.`;
  return [
    `This sheet does not balance: its totals add up to ${moneySignedCents(w.totalCents)} instead of $0.00.`,
    effect,
    "The cause is a one-sided correction (menu 17) or a ledger that does not balance.",
  ];
}

// The text "Copy for the group chat" puts on the clipboard: the title, then one line per transfer in the
// order the sheet shows them.
export function copyText(title: string, entries: readonly SettlementEntry[]): string {
  return [
    `Poker settle-up: ${title}`,
    ...printOrder(entries).map((e) => `${e.fromDisplay} → ${e.toDisplay}: ${moneyCents(e.amountCents)}`),
  ].join("\n");
}

// The CSV "Download CSV" saves: the entries in the order the console exports them (menu 13).
export function sheetCsv(entries: readonly SettlementEntry[]): string {
  return settlement.settlementsCSV(entries);
}

// The scope as the console names it (models.hpp Scope::describe): "all folders" or folder "May games",
// with the dates after it when the scope has them ("start" and "now" for an open end).
export function scopeWords(choice: ScopeChoice): string {
  const place = choice.folder === "" ? "all folders" : `folder "${choice.folder}"`;
  if (choice.from === "" && choice.to === "") return place;
  return `${place}, ${choice.from === "" ? "start" : choice.from} to ${choice.to === "" ? "now" : choice.to}`;
}
