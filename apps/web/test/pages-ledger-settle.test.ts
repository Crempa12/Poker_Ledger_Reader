// The settle-up pages rendered from the made-up data and checked against the console app's recorded
// output: menu 5's sheet for every settle scenario (the transfers in print order with their tags, the
// balances table, the summary line, the warning, the banker and "Not on this sheet" lines, the title,
// the copy text and the CSV), Who owes against menus 8 and 11, Payments & corrections against menu 17,
// and the saves against the session files the console wrote. Made-up data only (fixtures/synthetic and
// fixtures/synthetic-edge, with their recorded output).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { boardFor, ledger, loadWorld, sessions, settlement, type SettlementEntry, type World } from "../../../packages/core/src/index.ts";
import { loadDataRoot } from "../../../tools/load.ts";
import { buildCtx, dayScope, type Ctx } from "../src/context.ts";
import { EVERYTHING, type Payload, type ScopeChoice } from "../src/data.ts";
import { Adjust } from "../src/pages/Adjust.tsx";
import { Owed } from "../src/pages/Owed.tsx";
import { Settle } from "../src/pages/Settle.tsx";
import { balanceRows, copyText, offByLines, printOrder, receiversOf, scopeWords, sheetCsv, sheetRows, sheetSummary } from "../src/settle-sheet.ts";

const TZ = "America/New_York";
const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
const EDGE = fileURLToPath(new URL("../../../fixtures/synthetic-edge/", import.meta.url));
const REF = fileURLToPath(new URL("../../../fixtures/synthetic-reference/scenarios/", import.meta.url));
const EDGE_REF = fileURLToPath(new URL("../../../fixtures/synthetic-edge-reference/scenarios/", import.meta.url));

const AUTUMN: ScopeChoice = { folder: "Synthetic Autumn", from: "", to: "" };
const SPRING: ScopeChoice = { folder: "Synthetic Spring", from: "", to: "" };
const WINTER: ScopeChoice = { folder: "Synthetic Winter", from: "", to: "" };
const RANGE: ScopeChoice = { folder: "", from: "2026-03-14", to: "2026-05-02" };
const EDGE_A: ScopeChoice = { folder: "Synthetic Edge A", from: "", to: "" };
const EDGE_B: ScopeChoice = { folder: "Synthetic Edge B", from: "", to: "" };
const EDGE_C: ScopeChoice = { folder: "Synthetic Edge C", from: "", to: "" };
const EDGE_RANGE: ScopeChoice = { folder: "", from: "2026-10-06", to: "2026-10-07" };

// ---- the page context the local server builds (api.ts) for a data root ---------------------

async function pageCtx(root: string, choice: ScopeChoice, saved: Record<string, string> = {}): Promise<Ctx> {
  const data = await loadDataRoot(root);
  const ledgers = data.games.filter((g) => ledger.looksLikeLedger(g.text));
  const files = { ...data.savedData, ...saved };
  const world: World = loadWorld({ timeZone: TZ, ledgers, saved: files });
  const payload: Payload = {
    source: "local",
    dataRoot: root,
    timeZone: TZ,
    loadedAt: 0,
    ledgers,
    logs: [],
    saved: files,
    canWrite: true,
    consoleOpen: 0,
    basis: "made-up",
  };
  return buildCtx(payload, world, choice);
}

// The sheet as the page calculates it for the context's scope (menu 5, option 3) or one game.
function calcEntries(ctx: Ctx, gameId = ""): SettlementEntry[] {
  const game = gameId === "" ? undefined : ctx.world.games.find((g) => g.id === gameId);
  const games = game !== undefined ? [game] : ctx.view.games;
  const target = game !== undefined ? dayScope(game, ctx.tz) : ctx.scope;
  return settlement.calculateSheet(boardFor(ctx.world, games, target), ctx.world.prefs, ctx.world.settings.banker).entries;
}

// ---- the console's recorded output ---------------------------------------------------------

const ANSI = /\u001b\[[0-9;]*m/g;
const recorded = (path: string): string => readFileSync(path, "utf8").replace(ANSI, "");

// The lines of a printed block: from the line after the one that starts it, up to the first line that
// starts with stop.
function between(text: string, start: string, stop: string): string {
  const from = text.indexOf(start);
  if (from === -1) return "";
  const rest = text.slice(from);
  const to = rest.indexOf(stop, start.length);
  return to === -1 ? rest : rest.slice(0, to);
}

// A transfer line of settlement::print: the payer's name on the first line only, then the receiver,
// the amount and the tag. Later lines of one payer have no payer name.
const TRANSFER = /^  (.{0,20}?)\s*--->\s+(.+?)\s+(\$[\d,]+\.\d{2})(?:\s+(pinned|requested|banker))?\s*$/;
// A balances-table row (menu 5): name, poker net, payments, settles as.
const BALANCE = /^  (.+?)\s+(\+\$[\d,.]+|-\$[\d,.]+|\$0\.00)\s+(-|\+\$[\d,.]+|-\$[\d,.]+)\s+(is owed \$[\d,.]+|owes \$[\d,.]+|even)\s*$/;

interface Transfer {
  from: string;
  to: string;
  amount: string;
  tag: string;
}

// The sheet's transfer lines in the order they print (the sheet block, up to "Who receives what").
function consoleTransfers(text: string): Transfer[] {
  const out: Transfer[] = [];
  let payer = "";
  for (const line of between(text, "-- Settlement sheet", "-- Who receives what").split("\n")) {
    const m = TRANSFER.exec(line);
    if (m === null) continue;
    if ((m[1] ?? "") !== "") payer = m[1] ?? "";
    out.push({ from: payer, to: m[2] ?? "", amount: m[3] ?? "", tag: m[4] ?? "" });
  }
  return out;
}

interface Balance {
  name: string;
  poker: string;
  payments: string;
  settles: string;
}

// The balances table under the title, one row per player (all of them, the even ones too).
function consoleBalances(text: string): Balance[] {
  const lines = text.split("\n");
  const header = lines.findIndex((l) => /^  Player\s+Poker net\s+Payments\s+Settles as$/.test(l));
  const out: Balance[] = [];
  for (const line of lines.slice(header + 1)) {
    const m = BALANCE.exec(line);
    if (m === null) break;
    out.push({ name: m[1] ?? "", poker: m[2] ?? "", payments: m[3] ?? "", settles: m[4] ?? "" });
  }
  return out;
}

// The pins that apply here, as "A always pays B" (none when the console prints no such block).
function consolePins(text: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l === "Pinned payments that apply here:");
  const out: string[] = [];
  for (const line of at === -1 ? [] : lines.slice(at + 1)) {
    const m = /^  (.+ always pays .+)$/.exec(line);
    if (m === null) break;
    out.push(m[1] ?? "");
  }
  return out;
}

// The warning block under the question: the head, the effect and the cause, without the console's marks.
function consoleOffBy(text: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.includes("!! This sheet does not balance"));
  if (at === -1) return [];
  return [lines[at]?.replace(/^  !! /, "") ?? "", lines[at + 1]?.trim() ?? "", lines[at + 2]?.trim() ?? ""];
}

// The title of the sheet: "Everything in all folders, 14 games".
function consoleTitle(text: string): string | null {
  return /^-- (Everything in .+?) -{3,}$/m.exec(text)?.[1] ?? null;
}

// Settle-page checks, rendered once per case.
interface SheetCase {
  name: string;
  root: string;
  dir: string; // the recorded scenario folder (logs/settle.txt, settlements.csv)
  choice: ScopeChoice;
  saved?: Record<string, string>;
  gameId?: string;
}

const NO_PINS = "payer_normalized,payee_normalized,note\n";
const BANKER_CAVLORN = "key,value\nme,zaqvin\nbanker,cavlorn\ndisplay,fancy\n";
const BANKER_QUILL = "key,value\nme,zaqvin\nbanker,quill\ndisplay,fancy\n";
const SYNTHETIC_CASES: SheetCase[] = [
  { name: "all", root: SYNTHETIC, dir: REF + "all", choice: EVERYTHING },
  { name: "banker", root: SYNTHETIC, dir: REF + "banker", choice: EVERYTHING, saved: { "settings.csv": BANKER_CAVLORN } },
  { name: "nopins", root: SYNTHETIC, dir: REF + "nopins", choice: EVERYTHING, saved: { "payment_preferences.csv": NO_PINS } },
  { name: "range", root: SYNTHETIC, dir: REF + "range", choice: RANGE },
  { name: "single-game", root: SYNTHETIC, dir: REF + "single-game", choice: EVERYTHING, gameId: "ledger_pglFAKE0012" },
  { name: "folder-synthetic-autumn", root: SYNTHETIC, dir: REF + "folder-synthetic-autumn", choice: AUTUMN },
  { name: "folder-synthetic-spring", root: SYNTHETIC, dir: REF + "folder-synthetic-spring", choice: SPRING },
  { name: "folder-synthetic-winter", root: SYNTHETIC, dir: REF + "folder-synthetic-winter", choice: WINTER },
];
const EDGE_CASES: SheetCase[] = [
  { name: "edge all", root: EDGE, dir: EDGE_REF + "all", choice: EVERYTHING },
  { name: "edge banker", root: EDGE, dir: EDGE_REF + "banker", choice: EVERYTHING, saved: { "settings.csv": BANKER_QUILL } },
  { name: "edge nopins", root: EDGE, dir: EDGE_REF + "nopins", choice: EVERYTHING, saved: { "payment_preferences.csv": NO_PINS } },
  { name: "edge range", root: EDGE, dir: EDGE_REF + "range", choice: EDGE_RANGE },
  { name: "edge single-game", root: EDGE, dir: EDGE_REF + "single-game", choice: EVERYTHING, gameId: "ledger_pglEDGE0002" },
  { name: "edge folder a", root: EDGE, dir: EDGE_REF + "folder-synthetic-edge-a", choice: EDGE_A },
  { name: "edge folder b", root: EDGE, dir: EDGE_REF + "folder-synthetic-edge-b", choice: EDGE_B },
  { name: "edge folder c", root: EDGE, dir: EDGE_REF + "folder-synthetic-edge-c", choice: EDGE_C },
];

const decode = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
// The visible text of a markup fragment, with the entities read back and the spaces collapsed.
const textOfHtml = (html: string): string =>
  decode(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

// The cells of every row of every table in the markup, as text.
function tableRows(html: string): string[][] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((tr) =>
    [...(tr[1] ?? "").matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => textOfHtml(c[1] ?? "")),
  );
}

// The payer total menu 5 prints under a payer's last transfer ("sends $46.85 in all, to 2 people"), with how
// many transfers are printed before it.
interface Subtotal {
  after: number;
  text: string;
}
const SUBTOTAL = /^\s+(sends \$[\d,]+\.\d{2} in all, to \d+ people)\s*$/;

function consoleSubtotals(text: string): Subtotal[] {
  const out: Subtotal[] = [];
  let transfers = 0;
  for (const line of between(text, "-- Settlement sheet", "-- Who receives what").split("\n")) {
    if (TRANSFER.test(line)) transfers++;
    const m = SUBTOTAL.exec(line);
    if (m !== null) out.push({ after: transfers, text: m[1] ?? "" });
  }
  return out;
}

// The same totals in the page's transfer list: its items that are not transfers (no links, no amount).
function pageSubtotals(html: string): Subtotal[] {
  const list = /<ul class="payments">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "";
  const out: Subtotal[] = [];
  let transfers = 0;
  for (const m of list.matchAll(/<li( class="[^"]*")?>([\s\S]*?)<\/li>/g)) {
    if (m[1] === undefined) transfers++;
    else out.push({ after: transfers, text: textOfHtml(m[2] ?? "") });
  }
  return out;
}

// One line of "Who receives what" (menu 5): the receiver, what they get, and who sends it. The console wraps a
// long sender list onto the lines under it (indented to the "from" column), so those lines are joined back on.
interface Receiver {
  name: string;
  amount: string;
  from: string;
}
const RECEIVER = /^  (.{0,20}?)\s+(\$[\d,]+\.\d{2})\s+from (.*)$/;

function consoleReceivers(text: string): Receiver[] {
  const out: Receiver[] = [];
  for (const line of between(text, "-- Who receives what", "  Next:").split("\n").slice(1)) {
    const head = RECEIVER.exec(line);
    if (head !== null) {
      out.push({ name: (head[1] ?? "").trim(), amount: head[2] ?? "", from: (head[3] ?? "").trim() });
      continue;
    }
    const last = out.at(-1);
    if (last !== undefined && /^\s{20,}\S/.test(line)) last.from = `${last.from} ${line.trim()}`;
  }
  return out;
}

// The "Who receives what" table under the sheet, one row per receiver.
function pageReceivers(html: string): Receiver[] {
  const start = html.indexOf("<h3>Who receives what</h3>");
  if (start === -1) return [];
  const table = html.slice(start, html.indexOf("</table>", start));
  return tableRows(table)
    .filter((cells) => cells.length === 3 && cells[0] !== "Receiver")
    .map((cells) => ({ name: cells[0] ?? "", amount: cells[1] ?? "", from: cells[2] ?? "" }));
}

// The senders the console prints for one receiver, against the page's list (the same names, in the same order).
// The console cuts a wrapped line that runs one character over its width: the line's last character and its comma
// become "." (the banker sheet's "Quelzit," prints as "Quelzi."). So a printed "." that ends a name stands for the
// rest of that name and its comma, and every other character must match.
function sendersAsPrinted(printed: string, page: string): boolean {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = printed.split(/\.(?= )/).map(escape).join("[^,]*,?");
  return new RegExp(`^${pattern}$`).test(page);
}

// The transfers in a payments list (the sheet, or who owes whom).
function pageTransfers(html: string): Transfer[] {
  const list = /<ul class="payments">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "";
  return [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => {
    const li = m[1] ?? "";
    const links = [...li.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((a) => textOfHtml(a[1] ?? ""));
    return {
      from: links[0] ?? "",
      to: links[1] ?? "",
      amount: textOfHtml(/<strong class="amount">([\s\S]*?)<\/strong>/.exec(li)?.[1] ?? ""),
      tag: textOfHtml(/<span class="tag">([\s\S]*?)<\/span>/.exec(li)?.[1] ?? ""),
    };
  });
}

// The transfer lines the console prints for who owes whom (menu 11): "Name  --->  Name  $X".
const OWED_LINE = /^\s*\d+\s+(.+?)\s+--->\s+(.+?)\s+(\$[\d,]+\.\d{2})\s*$/;

// The saved sheets (menu 8): sheet, from, to, owed, still owed, status.
interface SavedRow {
  sheet: string;
  from: string;
  to: string;
  owed: string;
  still: string;
  status: string;
}
const SAVED_LINE = /^\s*\d+\s+(.*?)\s+(\$[\d,]+\.\d{2})\s+(\$[\d,]+\.\d{2})\s+(open|partial|paid)\s*$/;

function consoleSaved(text: string): SavedRow[] {
  return between(text, "-- Saved sheets: all", "(press Enter").split("\n").flatMap((line) => {
    const m = SAVED_LINE.exec(line);
    if (m === null) return [];
    const [sheet = "", from = "", to = ""] = (m[1] ?? "").split(/\s{2,}/);
    return [{ sheet, from, to, owed: m[2] ?? "", still: m[3] ?? "", status: m[4] ?? "" }];
  });
}

function pageSaved(html: string): SavedRow[] {
  const out: SavedRow[] = [];
  for (const chunk of html.split('<div class="sheet">').slice(1)) {
    const sheet = textOfHtml(/<h3>([\s\S]*?)<span/.exec(chunk)?.[1] ?? "");
    for (const cells of tableRows(chunk)) {
      if (cells.length < 5 || cells[0] === "From") continue;
      out.push({ sheet, from: cells[0] ?? "", to: cells[1] ?? "", owed: cells[2] ?? "", still: cells[3] ?? "", status: cells[4] ?? "" });
    }
  }
  return out;
}

// The payments & corrections (menu 17): date, player, amount, folder ("" for all folders), note.
interface AdjustRow {
  date: string;
  player: string;
  amount: string;
  folder: string;
  note: string;
}
const ADJUST_LINE = /^\s*\d+\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s+([+-]\$[\d,]+\.\d{2})\s+(.+?)\s{2,}(.*?)\s*$/;

function consoleAdjust(text: string): AdjustRow[] {
  return between(text, "-- Payments & corrections (every folder and date)", "New entries go under").split("\n").flatMap((line) => {
    const m = ADJUST_LINE.exec(line);
    if (m === null) return [];
    const folder = m[4] ?? "";
    return [{ date: m[1] ?? "", player: m[2] ?? "", amount: m[3] ?? "", folder: folder === "(all folders)" ? "" : folder, note: m[5] ?? "" }];
  });
}

function pageAdjust(html: string): AdjustRow[] {
  return tableRows(html)
    .filter((cells) => /^\d{4}-\d{2}-\d{2}$/.test(cells[0] ?? "") || cells[0] === "?")
    .map((cells) => ({
      date: cells[0] ?? "",
      player: cells[1] ?? "",
      amount: cells[2] ?? "",
      folder: (cells[3] ?? "") === "(all folders)" ? "" : (cells[3] ?? ""),
      note: cells[4] ?? "",
    }));
}

// ---- menu 5: the sheet, against each recorded settle scenario ------------------------------

describe.each([...SYNTHETIC_CASES, ...EDGE_CASES])("menu 5 $name, against the recorded sheet", (c) => {
  it("lists the transfers in the console's print order, with the same names, amounts and tags", async () => {
    const ctx = await pageCtx(c.root, c.choice, c.saved);
    const html = renderToStaticMarkup(createElement(Settle, { ctx, gameId: c.gameId ?? "", onSaved: () => {} }));
    const printed = consoleTransfers(recorded(c.dir + "/logs/settle.txt"));
    expect(printed.length, "the recorded sheet has transfers").toBeGreaterThan(0);
    expect(pageTransfers(html)).toEqual(printed);
  });

  it("shows the balances table row by row: poker net, payments and settles, every player in the console's order", async () => {
    const ctx = await pageCtx(c.root, c.choice, c.saved);
    const html = renderToStaticMarkup(createElement(Settle, { ctx, gameId: c.gameId ?? "", onSaved: () => {} }));
    const printed = consoleBalances(recorded(c.dir + "/logs/settle.txt"));
    const shown = tableRows(html)
      .filter((cells) => cells.length === 4 && cells[0] !== "Player")
      .map((cells) => ({ name: cells[0] ?? "", poker: cells[1] ?? "", payments: cells[2] ?? "", settles: cells[3] ?? "" }));
    expect(printed.length, "the recorded table has rows").toBeGreaterThan(0);
    expect(shown).toEqual(printed);
  });

  it("states the summary line, the warning, the banker and pins lines and the hint, as the console prints them", async () => {
    const ctx = await pageCtx(c.root, c.choice, c.saved);
    const html = renderToStaticMarkup(createElement(Settle, { ctx, gameId: c.gameId ?? "", onSaved: () => {} }));
    const text = textOfHtml(html);
    const printed = recorded(c.dir + "/logs/settle.txt");

    const summary = /^  (\d+ payments?, \d+ senders?, \d+ receivers?)$/m.exec(printed)?.[1];
    expect(summary, "the recorded summary line").toBeDefined();
    expect(text).toContain(summary ?? "");

    const off = consoleOffBy(printed);
    if (off.length === 0) {
      expect(text).not.toContain("This sheet does not balance");
    } else {
      for (const line of off) expect(text).toContain(line);
    }

    const hint = /Not on this sheet: (\d+) (payments?)\/(corrections?)/.exec(printed);
    const shownHint = /Not on this sheet: (\d+) (payments?)\/(corrections?)/.exec(text);
    expect(shownHint?.[1] ?? "").toBe(hint?.[1] ?? "");

    const banker = /^Banker mode is on: everyone settles through (.+)\.$/m.exec(printed)?.[1];
    if (banker === undefined) {
      expect(text).not.toContain("Banker mode is on");
    } else {
      expect(text).toContain(`Banker mode is on: everyone settles through ${banker}.`);
      expect(text).toContain("Pins and one-off requests are skipped.");
    }

    const pins = consolePins(printed);
    if (pins.length === 0) {
      expect(text).not.toContain("Pinned payments that apply here");
    } else {
      expect(text).toContain(`Pinned payments that apply here: ${pins.join(", ")}`);
    }
  });

  it("titles the sheet as the console does, for every scope but one game", async () => {
    const ctx = await pageCtx(c.root, c.choice, c.saved);
    const html = renderToStaticMarkup(createElement(Settle, { ctx, gameId: c.gameId ?? "", onSaved: () => {} }));
    const printed = recorded(c.dir + "/logs/settle.txt");
    const title = consoleTitle(printed);
    if (c.gameId === undefined) expect(title).not.toBeNull();
    if (title !== null) expect(textOfHtml(html)).toContain(title);
  });

  it("saves the same CSV the console exports (menu 13), byte for byte", async () => {
    const ctx = await pageCtx(c.root, c.choice, c.saved);
    expect(sheetCsv(calcEntries(ctx, c.gameId ?? ""))).toBe(recorded(c.dir + "/settlements.csv"));
  });

  it("copies the sheet for the group chat in the order the sheet shows", async () => {
    const ctx = await pageCtx(c.root, c.choice, c.saved);
    const printed = consoleTransfers(recorded(c.dir + "/logs/settle.txt"));
    const lines = copyText("title", calcEntries(ctx, c.gameId ?? "")).split("\n");
    expect(lines[0]).toBe("Poker settle-up: title");
    expect(lines.slice(1)).toEqual(printed.map((t) => `${t.from} → ${t.to}: ${t.amount}`));
  });

  it("prints each payer's total under their last transfer, and who receives what, as the console prints them", async () => {
    const ctx = await pageCtx(c.root, c.choice, c.saved);
    const html = renderToStaticMarkup(createElement(Settle, { ctx, gameId: c.gameId ?? "", onSaved: () => {} }));
    const printed = recorded(c.dir + "/logs/settle.txt");
    const printedReceivers = consoleReceivers(printed);
    const shown = pageReceivers(html);
    expect(printedReceivers.length, "the recorded receivers").toBeGreaterThan(0);
    expect(shown.map(({ name, amount }) => ({ name, amount }))).toEqual(printedReceivers.map(({ name, amount }) => ({ name, amount })));
    printedReceivers.forEach((r, i) => expect(sendersAsPrinted(r.from, shown[i]?.from ?? ""), r.name).toBe(true));
    expect(pageSubtotals(html)).toEqual(consoleSubtotals(printed));
  });
});

describe("menu 5's sheet: the rules the cases above rely on", () => {
  const line = (from: string, to: string, cents: number): SettlementEntry => ({
    fromDisplay: from,
    fromNormalized: from.toLowerCase(),
    toDisplay: to,
    toNormalized: to.toLowerCase(),
    amountCents: cents,
    reason: "auto",
  });

  it("groups the transfers by payer, the biggest totals first, and keeps each payer's lines in order", () => {
    const sheet = [line("Ondine", "Wick", 3351), line("Marisol", "Wick", 700), line("Thorn", "Rune", 394), line("Quorin", "Brask", 2500), line("Zaqvin", "Vex", 1250)];
    expect(printOrder(sheet).map((e) => e.fromDisplay)).toEqual(["Ondine", "Quorin", "Zaqvin", "Marisol", "Thorn"]);
    // A payer with two lines whose total is the biggest comes first, both lines together.
    const split = [line("A", "X", 1000), line("B", "Y", 3000), line("A", "Z", 2500)];
    expect(printOrder(split).map((e) => `${e.fromDisplay}>${e.toDisplay}`)).toEqual(["A>X", "A>Z", "B>Y"]);
    // Equal totals keep the sheet's order.
    const tie = [line("C", "W", 500), line("D", "V", 500)];
    expect(printOrder(tie).map((e) => e.fromDisplay)).toEqual(["C", "D"]);
  });

  it("reads the console's cut sender name as the page's full name, and nothing else", () => {
    expect(sendersAsPrinted("707070, Quelzi. Quinn Varn", "707070, Quelzit, Quinn Varn")).toBe(true);
    expect(sendersAsPrinted("707070, Quelzi. Quinn Varn", "707070, Ysolde, Quinn Varn")).toBe(false);
    expect(sendersAsPrinted("Harlo, Dromm, Wexlorn", "Harlo, Dromm, Wexlorn")).toBe(true);
    expect(sendersAsPrinted("Harlo, Dromm, Wexlorn", "Harlo, Wexlorn, Dromm")).toBe(false);
  });

  it("puts a payer's total under their last transfer when they pay more than one, and lists each receiver's senders", () => {
    const sheet = [line("Ondine", "Wick", 3351), line("Marisol", "Wick", 700), line("Thorn", "Rune", 394), line("Ondine", "Vex", 1000)];
    expect(sheetRows(sheet).map((r) => (r.kind === "total" ? r.text : `${r.entry.fromDisplay}>${r.entry.toDisplay}`))).toEqual([
      "Ondine>Wick",
      "Ondine>Vex",
      "sends $43.51 in all, to 2 people",
      "Marisol>Wick",
      "Thorn>Rune",
    ]);
    expect(receiversOf(sheet)).toEqual([
      { name: "Rune", cents: 394, from: ["Thorn"] },
      { name: "Vex", cents: 1000, from: ["Ondine"] },
      { name: "Wick", cents: 4051, from: ["Ondine", "Marisol"] },
    ]);
  });

  it("counts the summary line the way the console does, singular and plural", () => {
    expect(sheetSummary([line("A", "X", 100)])).toBe("1 payment, 1 sender, 1 receiver");
    expect(sheetSummary([line("A", "X", 100), line("A", "Y", 100), line("B", "X", 100)])).toBe("3 payments, 2 senders, 2 receivers");
  });

  it("words each warning as the console words it, for all four ways the balances can be off", () => {
    expect(offByLines({ totalCents: -200, effect: "debt-unpaid", amountCents: 200 })).toEqual([
      "This sheet does not balance: its totals add up to -$2.00 instead of $0.00.",
      "$2.00 of debt has nobody to be paid to.",
      "The cause is a one-sided correction (menu 17) or a ledger that does not balance.",
    ]);
    expect(offByLines({ totalCents: 500, effect: "winners-short", amountCents: 500 })[1]).toBe(
      "Some winners get $5.00 less than the table above shows.",
    );
    expect(offByLines({ totalCents: 31120, effect: "banker-pays-more", amountCents: 31120 })[1]).toBe(
      "The banker pays out $311.20 more than their own result covers.",
    );
    expect(offByLines({ totalCents: -200, effect: "banker-holds", amountCents: 200 })[1]).toBe(
      "The banker is left holding $2.00 that nobody is owed.",
    );
  });

  it("gives each player's balance in the console's order, and every player is listed", async () => {
    const ctx = await pageCtx(SYNTHETIC, EVERYTHING);
    const rows = balanceRows(boardFor(ctx.world, ctx.view.games, ctx.scope));
    expect(rows.length).toBe(ctx.view.board.length);
    const owing = rows.filter((r) => r.owes).map((r) => r.p.displayName);
    expect(owing.at(-1)).toBe("Zaqvin");
    expect(rows.find((r) => r.p.displayName === "Quillan")?.settles).toBe("even");
  });

  it("names the scope as the console does", () => {
    expect(scopeWords(EVERYTHING)).toBe("all folders");
    expect(scopeWords(AUTUMN)).toBe('folder "Synthetic Autumn"');
    expect(scopeWords(RANGE)).toBe("all folders, 2026-03-14 to 2026-05-02");
  });
});

// ---- Who owes: menus 8 and 11, against the recorded saved sheets --------------------------

describe("Who owes, against the saved sheets the console prints", () => {
  // Every saved row (menu 8) and every combined line (menu 11) the console printed must be on the page,
  // in the same order; the counts are checked so that an empty parse cannot pass.
  function expectAsPrinted(html: string, printed: string, saved: number, owed: number): void {
    expect(consoleSaved(printed).length, "the saved rows the console printed").toBe(saved);
    expect(consoleOwed(printed).length, "the combined lines the console printed").toBe(owed);
    expect(pageSaved(html)).toEqual(consoleSaved(printed));
    expect(pageTransfers(html).map((t) => ({ from: t.from, to: t.to, amount: t.amount, tag: "" }))).toEqual(consoleOwed(printed));
  }

  it("names the columns as the console does: Owed, Still owed", async () => {
    const ctx = await pageCtx(SYNTHETIC, EVERYTHING);
    const html = renderToStaticMarkup(createElement(Owed, { ctx, onSaved: () => {} }));
    expect(html).toContain(">Owed</th>");
    expect(html).toContain(">Still owed</th>");
  });

  it("with no saved sheet owing anything, says so as the console does (menu 11, sessions.cpp:175)", async () => {
    // A saved balances file with no rows: nothing is owed on any saved sheet.
    const ctx = await pageCtx(SYNTHETIC, EVERYTHING, { "session_balances.csv": "" });
    const text = textOfHtml(renderToStaticMarkup(createElement(Owed, { ctx, onSaved: () => {} })));
    expect(text).toContain("Nobody. Every saved sheet is paid.");
  });

  it("the made-up views (menus 8 and 11): every saved row in order, and the combined list", async () => {
    const ctx = await pageCtx(SYNTHETIC, EVERYTHING);
    const html = renderToStaticMarkup(createElement(Owed, { ctx, onSaved: () => {} }));
    expectAsPrinted(html, recorded(REF + "views/views.txt"), 3, 2);
  });

  it("after the all-data sheet is saved and part paid (menus 8 and 11): every row, paid or open, in order", async () => {
    const ctx = await pageCtx(SYNTHETIC, EVERYTHING, { "session_balances.csv": recorded(REF + "sessions/session_balances.csv") });
    const html = renderToStaticMarkup(createElement(Owed, { ctx, onSaved: () => {} }));
    expectAsPrinted(html, recorded(REF + "sessions/logs/views.txt"), 40, 39);
  });

  it("the edge data after the save and a part payment (menus 8 and 11)", async () => {
    const ctx = await pageCtx(EDGE, EVERYTHING, { "session_balances.csv": recorded(EDGE_REF + "sessions/session_balances.csv") });
    const html = renderToStaticMarkup(createElement(Owed, { ctx, onSaved: () => {} }));
    expectAsPrinted(html, recorded(EDGE_REF + "sessions/logs/views.txt"), 8, 7);
  });

  it("the edge data before any save (menus 8 and 11, the views run)", async () => {
    const ctx = await pageCtx(EDGE, EVERYTHING);
    const html = renderToStaticMarkup(createElement(Owed, { ctx, onSaved: () => {} }));
    expectAsPrinted(html, recorded(EDGE_REF + "views/views.txt"), 3, 2);
  });
});

// The combined list (menu 11): the transfer lines, in order.
function consoleOwed(text: string): { from: string; to: string; amount: string; tag: string }[] {
  return between(text, "-- Who still owes whom", "(press Enter").split("\n").flatMap((line) => {
    const m = OWED_LINE.exec(line);
    return m === null ? [] : [{ from: m[1] ?? "", to: m[2] ?? "", amount: m[3] ?? "", tag: "" }];
  });
}

// ---- the request pickers: the players in the order the balances table shows them ----------

describe("the request pickers, against the balances table", () => {
  // The first select lists who owes, the second who is owed: both in menu 5's balance order.
  it.each([
    ["all", SYNTHETIC, REF + "all/logs/settle.txt"],
    ["edge all", EDGE, EDGE_REF + "all/logs/settle.txt"],
  ])("%s: who is sending, and who is sent to, as the table lists them", async (_name, root, file) => {
    const ctx = await pageCtx(root, EVERYTHING);
    const html = renderToStaticMarkup(createElement(Settle, { ctx, gameId: "", onSaved: () => {} }));
    const rows = consoleBalances(recorded(file));
    // The page's selects are "What to settle" and the two pickers; the pickers are the ones with a placeholder.
    const [sending = "", sentTo = ""] = [...html.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/g)]
      .map((m) => m[1] ?? "")
      .filter((s) => s.includes("Pick a player"));
    const names = (select: string): string[] =>
      [...select.matchAll(/<option value="[^"]+">([\s\S]*?)<\/option>/g)].map((o) => textOfHtml(o[1] ?? ""));
    expect(names(sending)).toEqual(rows.filter((r) => r.settles.startsWith("owes")).map((r) => r.name));
    expect(names(sentTo)).toEqual(rows.filter((r) => r.settles.startsWith("is owed")).map((r) => r.name));
  });
});

// ---- Payments & corrections: menu 17, against the recorded list ----------------------------

describe("Payments & corrections, against menu 17", () => {
  it("lists every entry in the file's order, with its date, player, amount, folder and note", async () => {
    const ctx = await pageCtx(SYNTHETIC, EVERYTHING);
    const html = renderToStaticMarkup(createElement(Adjust, { ctx, onSaved: () => {} }));
    const printed = consoleAdjust(recorded(REF + "views/views.txt"));
    expect(printed.length).toBe(5);
    expect(pageAdjust(html)).toEqual(printed);
  });

  it("the edge data's list, with the names the page shows", async () => {
    const ctx = await pageCtx(EDGE, EVERYTHING);
    const html = renderToStaticMarkup(createElement(Adjust, { ctx, onSaved: () => {} }));
    const printed = consoleAdjust(recorded(EDGE_REF + "views/views.txt"));
    expect(printed.length).toBe(5);
    expect(pageAdjust(html)).toEqual(printed);
  });

  it("says where new entries go, as the console does", async () => {
    const ctx = await pageCtx(SYNTHETIC, EVERYTHING);
    const text = textOfHtml(renderToStaticMarkup(createElement(Adjust, { ctx, onSaved: () => {} })));
    // The console's line under the list (menu 17, adjustments.cpp:100-101), read from the recorded output; the page's sentence ends with a dot.
    const line = recorded(REF + "views/views.txt")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("New entries go under:"));
    expect(line).toBe("New entries go under: all folders (they count only when settling everything)");
    expect(text).toContain(`${line}.`);
  });
});

// ---- the saves: the files the page writes equal the console's ------------------------------

describe("the saves write the files the console wrote", () => {
  it("made-up data: saving the all-data sheet, then the part payment, gives the console's session file", async () => {
    const ctx = await pageCtx(SYNTHETIC, EVERYTHING);
    const saved = sessions.addSettlementBatch(ctx.world.balances, "reference-all", calcEntries(ctx));
    const paid = sessions.recordPayment(saved, "reference-all", { fromNormalized: "707070", toNormalized: "marisolquenby" }, 141);
    expect(paid.refused).toBeNull();
    expect(paid.balance?.status).toBe("partial");
    expect(sessions.serializeSessionBalances(paid.balances)).toBe(recorded(REF + "sessions/session_balances.csv"));
  });

  it("edge data: the same save and the 3.50 part payment give the console's session file", async () => {
    const ctx = await pageCtx(EDGE, EVERYTHING);
    const saved = sessions.addSettlementBatch(ctx.world.balances, "reference-all", calcEntries(ctx));
    const paid = sessions.recordPayment(saved, "reference-all", { fromNormalized: "marisolquenby", toNormalized: "wick" }, 350);
    expect(sessions.serializeSessionBalances(paid.balances)).toBe(recorded(EDGE_REF + "sessions/session_balances.csv"));
  });
});
