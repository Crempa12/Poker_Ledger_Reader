// The results pages rendered from the made-up data and checked against the console app's recorded
// output: the leaderboard row by row (menu 2) for every scope the reference holds, the overview's box
// facts (startup.txt), the payments & corrections list with its verdict line, and each player's page:
// the tiles, the header line, and every night row against that player's history_<n>.txt (menu 3).
// Made-up data only (fixtures/synthetic and fixtures/synthetic-edge).
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ledger, loadWorld, moneySigned, util, type World } from "../../../packages/core/src/index.ts";
import type { HandWorld } from "../../../packages/core/src/handworld.ts";
import { loadDataRoot } from "../../../tools/load.ts";
import { handWorldFromInputs, snapshotHandLogs } from "../server/handlogs.ts";
import { buildCtx, type Ctx } from "../src/context.ts";
import { EVERYTHING, type Payload, type ScopeChoice } from "../src/data.ts";
import { Overview } from "../src/pages/Overview.tsx";
import { PlayerPage } from "../src/pages/Player.tsx";

const TZ = "America/New_York";
const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
const EDGE = fileURLToPath(new URL("../../../fixtures/synthetic-edge/", import.meta.url));
const REF = fileURLToPath(new URL("../../../fixtures/synthetic-reference/scenarios/", import.meta.url));
const EDGE_REF = fileURLToPath(new URL("../../../fixtures/synthetic-edge-reference/scenarios/", import.meta.url));

const ALL: ScopeChoice = EVERYTHING;
const AUTUMN: ScopeChoice = { folder: "Synthetic Autumn", from: "", to: "" };
const SPRING: ScopeChoice = { folder: "Synthetic Spring", from: "", to: "" };
const RANGE: ScopeChoice = { folder: "", from: "2026-03-14", to: "2026-05-02" };
const EDGE_ALL: ScopeChoice = EVERYTHING;
const EDGE_A: ScopeChoice = { folder: "Synthetic Edge A", from: "", to: "" };
const EDGE_B: ScopeChoice = { folder: "Synthetic Edge B", from: "", to: "" };
const EDGE_C: ScopeChoice = { folder: "Synthetic Edge C", from: "", to: "" };
const EDGE_RANGE: ScopeChoice = { folder: "", from: "2026-10-06", to: "2026-10-07" };

// ---- the made-up data, the way the local server builds the page context (api.ts) -----------

async function pageCtx(root: string, choice: ScopeChoice, saved: Record<string, string> = {}): Promise<Ctx> {
  const data = await loadDataRoot(root);
  const ledgers = data.games.filter((g) => ledger.looksLikeLedger(g.text));
  const files = { ...data.savedData, ...saved };
  const world: World = loadWorld({ timeZone: TZ, ledgers, saved: files });
  // The hand-log paths the server lists; the box counts the games whose id one of them carries.
  const logs = data.games.filter((g) => /(^|\/)poker_now_log_[^/]*\.csv$/i.test(g.relativePath)).map((g) => g.relativePath);
  const payload: Payload = {
    source: "local",
    dataRoot: root,
    timeZone: TZ,
    loadedAt: 0,
    ledgers,
    logs,
    saved: files,
    canWrite: true,
    consoleOpen: 0,
    basis: "made-up",
  };
  return buildCtx(payload, world, choice);
}

// The hand logs of the made-up data, read the way the server reads them (handlogs.ts), once per root.
const handWorlds = new Map<string, Promise<HandWorld>>();
function handWorldOf(root: string): Promise<HandWorld> {
  let found = handWorlds.get(root);
  if (found === undefined) {
    found = loadDataRoot(root).then((inputs) => handWorldFromInputs(inputs, TZ));
    handWorlds.set(root, found);
  }
  return found;
}

// The page context of a snapshot of the made-up data. A snapshot carries the hand-log results for every
// folder, so the box's hand-log count is there when the page is rendered (no fetch to wait for).
async function snapshotCtx(root: string, choice: ScopeChoice): Promise<Ctx> {
  const hw = await handWorldOf(root);
  const payload: Payload = {
    source: "snapshot",
    dataRoot: "",
    timeZone: TZ,
    loadedAt: 0,
    ledgers: [],
    logs: [],
    saved: {},
    canWrite: false,
    consoleOpen: 0,
    basis: "",
    handlogs: JSON.parse(JSON.stringify(snapshotHandLogs(hw))) as Payload["handlogs"],
  };
  return buildCtx(payload, hw.world, choice);
}

// ---- the console's recorded output ---------------------------------------------------------

const read = (path: string): string => readFileSync(path, "utf8");
const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();
const at = (m: RegExpExecArray | null, i: number): string => m?.[i] ?? "";
const MONEY = String.raw`[+-]?\$[\d,]+\.\d{2}`;

// A leaderboard row as the console prints it (players.cpp printLeaderboard).
const CONSOLE_ROW = new RegExp(
  String.raw`^\s*(\d+)\s+(.+?)\s+(\d+)\s+(\d+-\d+)\s+(${MONEY})\s+(${MONEY})\s+(${MONEY})\s+(${MONEY})\s+(\S+)\s*$`,
);
// A night of the player history, as the console prints it (players.cpp printPlayerHistory).
const CONSOLE_NIGHT = new RegExp(
  String.raw`^\s*(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s+(-|\d+)\s+(${MONEY})\s+(${MONEY})\s+(\S+)\s*$`,
);
const CONSOLE_PAYMENT = new RegExp(String.raw`^\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s+(${MONEY})\s+(.*?)\s*$`);

// Figures every page shows for a player, as text.
interface Figures {
  name: string;
  nights: string;
  net: string;
  avg: string;
  best: string;
  worst: string;
}
interface Board extends Figures {
  rank: string;
  updown: string;
  signs: string[]; // the sign of each of the last ten nights: up, down or even
}
const figuresOf = (b: Board): Figures => ({ name: b.name, nights: b.nights, net: b.net, avg: b.avg, best: b.best, worst: b.worst });

// The leaderboard table of the recorded menu 2 output, in the console's order.
function consoleBoard(text: string): Board[] {
  const lines = text.split("\n");
  const heading = lines.findIndex((line) => line.startsWith("-- Leaderboard"));
  expect(heading, "the leaderboard heading").toBeGreaterThanOrEqual(0);
  const rules = lines.map((line, i) => (/^-{40,}$/.test(line) && i > heading ? i : -1)).filter((i) => i >= 0);
  const first = rules[0] ?? -1;
  const end = rules[1] ?? -1;
  expect(first, "the rule under the leaderboard header").toBeGreaterThanOrEqual(0);
  return lines
    .slice(first + 1, end)
    .map((line) => CONSOLE_ROW.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      rank: at(m, 1),
      name: at(m, 2),
      nights: at(m, 3),
      updown: at(m, 4),
      net: at(m, 5),
      avg: at(m, 6),
      best: at(m, 7),
      worst: at(m, 8),
      signs: [...at(m, 9)].map((c) => (c === "+" ? "up" : c === "-" ? "down" : "even")),
    }));
}

// The total of the payments & corrections list (menu 2) and its verdict line.
interface Payment {
  date: string;
  name: string;
  amount: string;
  note: string;
}
function consolePayments(text: string): { rows: Payment[]; verdict: string } {
  const lines = text.split("\n");
  const heading = lines.findIndex((line) => line.includes("not in the table; settlement sheets count them"));
  expect(heading, "the payments list under the leaderboard").toBeGreaterThanOrEqual(0);
  const rows: Payment[] = [];
  let verdict = "";
  for (const line of lines.slice(heading + 1)) {
    const m = CONSOLE_PAYMENT.exec(line);
    if (m !== null) {
      rows.push({ date: at(m, 1), name: at(m, 2), amount: at(m, 3), note: at(m, 4) });
    } else if (/^\s+(One-sided|They cancel out)/.test(line)) {
      verdict = normalize(line);
      break;
    }
  }
  return { rows, verdict };
}

// The header line and nights of a recorded history file (menu 3, one player).
interface History {
  name: string;
  nights: string;
  buyIns: string;
  net: string;
  payments: string; // "" when the player has no payments or corrections
  balance: string;
  rows: { date: string; folder: string; buyIns: string; net: string; running: string; game: string }[];
}
function consoleHistory(text: string): History {
  const name = at(/^-- (.+), night by night/m.exec(text), 1);
  const head = /^\s+(\d+) nights?, (\d+) buy-ins, poker net (\S+)(?:\s+payments & corrections (\S+)\s+balance (\S+))?/m.exec(text);
  const rows = text
    .split("\n")
    .map((line) => CONSOLE_NIGHT.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ date: at(m, 2), folder: at(m, 3).trimEnd(), buyIns: at(m, 4), net: at(m, 5), running: at(m, 6), game: at(m, 7) }));
  return {
    name,
    nights: at(head, 1),
    buyIns: at(head, 2),
    net: at(head, 3),
    payments: at(head, 4),
    balance: at(head, 5),
    rows,
  };
}

// ---- rendered markup as text and cells -----------------------------------------------------

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

function textOf(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/(td|th|span|a|button)>/g, " ")
    .replace(/<\/(p|div|li|tr|h1|h2|h3|dt|dd|summary|section|details|ul|table|nav)>|<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return normalize(text.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m] ?? m));
}

// The <tr> elements of a table's body: their opening tag and their inside.
function rowsOf(table: string): { open: string; inner: string }[] {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(table)?.[1] ?? table;
  return [...body.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)].map((m) => ({ open: at(m, 1), inner: at(m, 2) }));
}

// The text of each cell of a row, in order.
const cellsOf = (inner: string): string[] => [...inner.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => textOf(at(m, 1)));

// The leaderboard table as the page shows it: each row's cells, and the sign of each sparkline bar.
function webBoard(html: string): Board[] {
  const table = /<table class="board">([\s\S]*?)<\/table>/.exec(html)?.[1] ?? "";
  return rowsOf(table).map(({ inner }) => {
    const cells = cellsOf(inner);
    return {
      rank: cells[0] ?? "",
      name: cells[1] ?? "",
      nights: cells[2] ?? "",
      updown: cells[3] ?? "",
      net: cells[4] ?? "",
      avg: cells[5] ?? "",
      best: cells[6] ?? "",
      worst: cells[7] ?? "",
      signs: [...inner.matchAll(/<rect[^>]*class="(up|down|even)"/g)].map((m) => at(m, 1)),
    };
  });
}

// The tiles on a page, by label, as text.
function tilesOf(html: string): Map<string, string> {
  const tiles = new Map<string, string>();
  for (const part of html.split('<div class="tile">').slice(1)) {
    const label = textOf(at(/<div class="muted small">([\s\S]*?)<\/div>/.exec(part), 1));
    const value = textOf(at(/<div class="big[^"]*">([\s\S]*?)<\/div>/.exec(part), 1));
    tiles.set(label, value);
  }
  return tiles;
}

// "Fri, Mar 20, 2026" (the page's long date) as the console's 2026-03-20.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function isoOf(longDate: string): string {
  const m = /, ([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/.exec(longDate);
  if (m === null) return longDate;
  const month = String(MONTHS.indexOf(at(m, 1)) + 1).padStart(2, "0");
  return `${at(m, 3)}-${month}-${at(m, 2).padStart(2, "0")}`;
}

// The console prints a note in a 20-column cell and cuts a longer one to 19 characters and a dot.
const cutTo20 = (s: string): string => (s.length > 20 ? `${s.slice(0, 19)}.` : s);

// The nights of a player's page, in the order the page lists them (newest first).
interface NightRow {
  date: string;
  folder: string;
  buyIns: string;
  result: string;
  running: string;
  href: string;
  dim: boolean;
}
function nightRowsOf(html: string): NightRow[] {
  const start = html.indexOf("<h2>Every night</h2>");
  expect(start, "the Every night card").toBeGreaterThanOrEqual(0);
  const table = html.slice(start, html.indexOf("</table>", start));
  return rowsOf(table).map(({ open, inner }) => {
    const cells = cellsOf(inner);
    return {
      date: cells[0] ?? "",
      folder: cells[1] ?? "",
      buyIns: cells[2] ?? "",
      result: cells[3] ?? "",
      running: cells[4] ?? "",
      href: at(/href="([^"]+)"/.exec(inner), 1),
      dim: open.includes('class="dim"'),
    };
  });
}

// ---- the exported player summary (menu 12), which lists every player -------------------------

interface Exported {
  name: string;
  normalized: string;
  games: number;
  buyIns: number;
  adjustments: number; // dollars
  net: number;
  avg: number;
  best: number;
  worst: number;
  aliases: string[];
}
function exportedOf(path: string): Exported[] {
  return util.parseCSV(read(path)).map((r) => ({
    name: r[1] ?? "",
    normalized: r[2] ?? "",
    games: Number(r[3]),
    buyIns: Number(r[4]),
    adjustments: Number(r[7]),
    net: Number(r[8]),
    avg: Number(r[9]),
    best: Number(r[10]),
    worst: Number(r[11]),
    aliases: (r[12] ?? "").split(" | ").filter((a) => a !== ""),
  }));
}

// The leaderboard's rows from the export: the console's table skips the players with no game
// (printLeaderboard), so only those are listed, in the export's order.
function exportedBoard(rows: Exported[]): Figures[] {
  return rows
    .filter((r) => r.games > 0)
    .map((r) => ({ name: r.name, nights: String(r.games), net: moneySigned(r.net), avg: moneySigned(r.avg), best: moneySigned(r.best), worst: moneySigned(r.worst) }));
}

// The books: the sum of every player's poker net, in cents, as the console adds them.
const bookCents = (rows: Exported[]): number => rows.reduce((sum, r) => sum + Math.round(r.net * 100), 0);
function booksTile(cents: number): string {
  return cents === 0 ? "✓ balanced" : `off by ${moneySigned(cents / 100)}`;
}

// The leaderboard, and the export it must match, for one scope.
async function expectMatchesExport(root: string, choice: ScopeChoice, csv: string): Promise<void> {
  const ctx = await pageCtx(root, choice);
  const html = renderToStaticMarkup(createElement(Overview, { ctx }));
  const exported = exportedOf(csv);
  expect(webBoard(html).map(figuresOf), csv).toEqual(exportedBoard(exported));
  webBoard(html).forEach((row, i) => expect(row.rank, `${csv} row ${i + 1}`).toBe(String(i + 1)));
  // The box counts every player, the ones with payments only included.
  expect(tilesOf(html).get("Players"), csv).toBe(String(exported.length));
  expect(tilesOf(html).get("Books"), csv).toBe(booksTile(bookCents(exported)));
}

// ---- tests ---------------------------------------------------------------------------------

describe("the leaderboard (menu 2) with the made-up data, against the console's table", () => {
  it("all folders: every row has the console's rank, name, nights, up-down, money and the signs of the last ten nights, in its order", async () => {
    const html = renderToStaticMarkup(createElement(Overview, { ctx: await pageCtx(SYNTHETIC, ALL) }));
    const printed = consoleBoard(read(REF + "views/views.txt"));
    expect(printed).toHaveLength(47);
    expect(webBoard(html)).toEqual(printed);
  });

  it("the console's table is the same as the all-folders export, figure for figure", () => {
    const exported = exportedOf(REF + "all/player_summary.csv");
    expect(exportedBoard(exported)).toEqual(consoleBoard(read(REF + "views/views.txt")).map(figuresOf));
  });

  it("the Synthetic Autumn folder lists the export's players with a game, in the export's order", async () => {
    await expectMatchesExport(SYNTHETIC, AUTUMN, REF + "folder-synthetic-autumn/player_summary.csv");
  });

  it("the date range 2026-03-14 to 2026-05-02 lists the export's players with a game, in the export's order", async () => {
    await expectMatchesExport(SYNTHETIC, RANGE, REF + "range/player_summary.csv");
  });

  it("the banker and no-pins runs' exports show the same table: a banker or a pin does not change the leaderboard", async () => {
    await expectMatchesExport(SYNTHETIC, ALL, REF + "banker/player_summary.csv");
    await expectMatchesExport(SYNTHETIC, ALL, REF + "nopins/player_summary.csv");
    await expectMatchesExport(EDGE, EDGE_ALL, EDGE_REF + "banker/player_summary.csv");
    await expectMatchesExport(EDGE, EDGE_ALL, EDGE_REF + "nopins/player_summary.csv");
  });

  it("the edge data: all folders, each folder, and its range match their exports", async () => {
    await expectMatchesExport(EDGE, EDGE_ALL, EDGE_REF + "all/player_summary.csv");
    await expectMatchesExport(EDGE, EDGE_A, EDGE_REF + "folder-synthetic-edge-a/player_summary.csv");
    await expectMatchesExport(EDGE, EDGE_B, EDGE_REF + "folder-synthetic-edge-b/player_summary.csv");
    await expectMatchesExport(EDGE, EDGE_C, EDGE_REF + "folder-synthetic-edge-c/player_summary.csv");
    await expectMatchesExport(EDGE, EDGE_RANGE, EDGE_REF + "range/player_summary.csv");
  });

  it("the line under the table says the console's thing: balanced, or the games are off by", async () => {
    const synthetic = renderToStaticMarkup(createElement(Overview, { ctx: await pageCtx(SYNTHETIC, ALL) }));
    expect(textOf(synthetic)).toContain(
      "The games are off by +$5.00: a ledger does not balance (see Checks).",
    );
    expect(textOf(synthetic)).not.toContain("Every net adds up to $0.00.");

    const autumn = renderToStaticMarkup(createElement(Overview, { ctx: await pageCtx(SYNTHETIC, AUTUMN) }));
    const cents = bookCents(exportedOf(REF + "folder-synthetic-autumn/player_summary.csv"));
    expect(textOf(autumn)).toContain(
      cents === 0 ? "Every net adds up to $0.00." : `The games are off by ${moneySigned(cents / 100)}: a ledger does not balance (see Checks).`,
    );
  });
});

describe("the payments & corrections under the leaderboard, against the console's list", () => {
  it("every entry has the console's date, player, amount and note, in its order, with its one-sided verdict", async () => {
    const html = renderToStaticMarkup(createElement(Overview, { ctx: await pageCtx(SYNTHETIC, ALL) }));
    const printed = consolePayments(read(REF + "views/views.txt"));
    expect(printed.rows).toHaveLength(5);
    expect(printed.verdict).toBe("One-sided: they add up to -$7.00, so a settlement sheet will be short by that much.");

    const start = html.indexOf('class="adjusted"');
    expect(start, "the payments block").toBeGreaterThanOrEqual(0);
    const block = html.slice(start, html.indexOf("</table>", start));
    const shown = rowsOf(block).map(({ inner }) => {
      const cells = cellsOf(inner);
      return { date: isoOf(cells[0] ?? ""), name: cells[1] ?? "", amount: cells[2] ?? "", note: cells[3] ?? "" };
    });
    expect(shown).toEqual(printed.rows.map((r) => ({ date: r.date, name: r.name, amount: r.amount, note: r.note })));
    // The verdict is the paragraph straight after the table.
    const after = html.slice(html.indexOf("</table>", start) + "</table>".length);
    expect(textOf(at(/<p[^>]*>([\s\S]*?)<\/p>/.exec(after), 1))).toBe(printed.verdict);
  });

  it("a folder whose payments cancel out says so, as the console does", async () => {
    const html = renderToStaticMarkup(createElement(Overview, { ctx: await pageCtx(SYNTHETIC, SPRING) }));
    expect(textOf(html)).toContain("They cancel out: every payment is on both sides.");
    expect(textOf(html)).not.toContain("One-sided");
  });
});

describe("the overview's box, against the console's startup box", () => {
  it("games, players, books, me, banker, pins and hand logs are the box's", async () => {
    const html = renderToStaticMarkup(createElement(Overview, { ctx: await snapshotCtx(SYNTHETIC, ALL) }));
    const tiles = tilesOf(html);
    expect(tiles.get("Games")).toBe("14");
    expect(tiles.get("Players")).toBe("47");
    expect(tiles.get("Books")).toBe("off by +$5.00");
    // startup.txt: "47 players | hand logs 2/14 | books off by +$5.00" and "me Zaqvin | banker off | pinned payments 2".
    expect(read(REF + "startup/startup.txt")).toContain("hand logs 2/14");
    expect(textOf(html)).toContain("hand logs 2/14 · banker off · pinned payments 2 · me Zaqvin");
  });

  it("the edge data's hand logs count the logs that load and pair with a game: 6 of 8, not the 7 files", async () => {
    // The seventh file (pglEDGE0007) has no hands, so the console skips it and does not count it.
    const html = renderToStaticMarkup(createElement(Overview, { ctx: await snapshotCtx(EDGE, EDGE_ALL) }));
    expect(read(EDGE_REF + "startup/startup.txt")).toContain("hand logs 6/8");
    expect(textOf(html)).toContain("hand logs 6/8 · banker off · pinned payments 2 · me Zaqvin");
  });

  it("the hand-log count is left out until the results are read, not shown as a wrong number", async () => {
    const html = renderToStaticMarkup(createElement(Overview, { ctx: await pageCtx(SYNTHETIC, ALL) }));
    expect(textOf(html)).toContain("banker off · pinned payments 2 · me Zaqvin");
    expect(textOf(html)).not.toContain("hand logs");
  });

  it("a banker and a pin count are named as the box names them", async () => {
    const banker = await pageCtx(SYNTHETIC, ALL, { "settings.csv": "key,value\nme,zaqvin\nbanker,cavlorn\ndisplay,fancy\n" });
    expect(textOf(renderToStaticMarkup(createElement(Overview, { ctx: banker })))).toContain("banker Cavlorn");
    const pins = await pageCtx(SYNTHETIC, ALL, { "payment_preferences.csv": "payer_normalized,payee_normalized,note\n" });
    expect(textOf(renderToStaticMarkup(createElement(Overview, { ctx: pins })))).toContain("pinned payments 0");
    expect(read(REF + "banker/logs/summary.txt")).toContain("| me Zaqvin | banker Cavlorn | pinned payments 2");
  });

  it("the edge data's box counts every player, the ones with payments only included", async () => {
    const html = renderToStaticMarkup(createElement(Overview, { ctx: await pageCtx(EDGE, EDGE_ALL) }));
    expect(tilesOf(html).get("Players")).toBe("13");
  });
});

describe("every player's page, against the console's history (menu 3)", () => {
  it("each player's header and every night match their history_<n>.txt, row by row", async () => {
    const ctx = await pageCtx(SYNTHETIC, ALL);
    const dir = REF + "history/history/";
    const files = readdirSync(dir).filter((f) => /^history_\d+\.txt$/.test(f));
    expect(files).toHaveLength(47);
    for (const file of files) {
      const printed = consoleHistory(read(dir + file));
      const p = ctx.view.board.find((x) => x.displayName === printed.name);
      expect(p, `${file}: ${printed.name}`).toBeDefined();
      if (p === undefined) continue;
      const html = renderToStaticMarkup(createElement(PlayerPage, { ctx, normalized: p.normalizedName }));
      const tiles = tilesOf(html);

      // The header: nights, buy-ins, poker net, and the payments & corrections and the balance when there are some.
      expect(textOf(html), file).toMatch(new RegExp(`${printed.nights} nights? · ${printed.buyIns} buy-ins?`));
      expect(tiles.get("Net"), `${file}: poker net`).toBe(printed.net);
      expect(tiles.get("Payments & corrections") ?? "", `${file}: payments & corrections`).toBe(printed.payments);
      expect(tiles.get("Balance") ?? "", `${file}: balance`).toBe(printed.balance);

      // The nights, oldest first as the console prints them. The page lists them newest first, so it is reversed here.
      const shown = nightRowsOf(html).reverse();
      expect(shown.length, `${file}: rows`).toBe(printed.rows.length);
      printed.rows.forEach((c, i) => {
        const w = shown[i];
        const where = `${file} row ${i + 1} (${c.date})`;
        expect(w, where).toBeDefined();
        if (w === undefined) return;
        expect(isoOf(w.date), where).toBe(c.date);
        if (c.game === "adjustment") {
          // A payment or correction: its note comes after the date (the console prints it in the folder column,
          // cut to 20 columns), its amount is shown, and its row is dimmed with no running total (not in the running total).
          const note = w.date.split(" · ")[1] ?? "";
          expect(cutTo20(note), where).toBe(c.folder);
          expect(w.buyIns, where).toBe(c.buyIns);
          expect(w.result, where).toBe(c.net);
          expect(w.running, where).toBe("");
          expect(w.href, where).toBe("");
          expect(w.dim, where).toBe(true);
        } else {
          expect(w.folder, where).toBe(c.folder);
          expect(w.buyIns, where).toBe(c.buyIns);
          expect(w.result, where).toBe(c.net);
          expect(w.running, where).toBe(c.running);
          expect(w.href, where).toContain(c.game);
          expect(w.dim, where).toBe(false);
        }
      });
    }
  });

  it("each player's tiles are the leaderboard's figures: net, up-down, average, best and worst night", async () => {
    const ctx = await pageCtx(SYNTHETIC, ALL);
    const printed = consoleBoard(read(REF + "views/views.txt"));
    expect(printed).toHaveLength(47);
    for (const row of printed) {
      const p = ctx.view.board.find((x) => x.displayName === row.name);
      expect(p, row.name).toBeDefined();
      if (p === undefined) continue;
      const tiles = tilesOf(renderToStaticMarkup(createElement(PlayerPage, { ctx, normalized: p.normalizedName })));
      expect(
        {
          net: tiles.get("Net"),
          updown: tiles.get("Up–Down")?.replace("–", "-"),
          avg: tiles.get("Avg/night"),
          best: tiles.get("Best night"),
          worst: tiles.get("Worst night"),
        },
        row.name,
      ).toEqual({ net: row.net, updown: row.updown, avg: row.avg, best: row.best, worst: row.worst });
    }
  });

  it("every player's tiles match the export, and 'also plays as' lists the export's other names", async () => {
    // The synthetic data (47 players, two with several names) and the edge data (13, some with payments only).
    const cases: [string, ScopeChoice, string, number][] = [
      [SYNTHETIC, ALL, REF + "all/player_summary.csv", 47],
      [EDGE, EDGE_ALL, EDGE_REF + "all/player_summary.csv", 13],
    ];
    for (const [root, choice, csv, count] of cases) {
      const ctx = await pageCtx(root, choice);
      const exported = exportedOf(csv);
      expect(exported, csv).toHaveLength(count);
      for (const r of exported) {
        const p = ctx.view.board.find((x) => x.normalizedName === r.normalized);
        expect(p, r.name).toBeDefined();
        if (p === undefined) continue;
        const html = renderToStaticMarkup(createElement(PlayerPage, { ctx, normalized: p.normalizedName }));
        const tiles = tilesOf(html);
        const text = textOf(html);
        expect(text, r.name).toMatch(new RegExp(`${r.games} nights? · ${r.buyIns} buy-ins?`));
        expect(tiles.get("Net"), r.name).toBe(moneySigned(r.net));
        expect(tiles.get("Avg/night"), r.name).toBe(moneySigned(r.avg));
        expect(tiles.get("Best night"), r.name).toBe(moneySigned(r.best));
        expect(tiles.get("Worst night"), r.name).toBe(moneySigned(r.worst));
        const adj = Math.round(r.adjustments * 100);
        expect(tiles.get("Payments & corrections") ?? "", r.name).toBe(adj === 0 ? "" : moneySigned(adj / 100));
        expect(tiles.get("Balance") ?? "", r.name).toBe(adj === 0 ? "" : moneySigned((Math.round(r.net * 100) + adj) / 100));
        const others = r.aliases.filter((a) => a !== r.normalized);
        if (others.length > 0) expect(text, r.name).toContain(`also plays as ${others.join(", ")}`);
        else expect(text, r.name).not.toContain("also plays as");
      }
    }
  });
});

describe("the overview's 'me' when the person set as me has no games in the scope", () => {
  it("says that they have no games here, rather than asking for the console's setting", async () => {
    const html = renderToStaticMarkup(createElement(Overview, { ctx: await pageCtx(EDGE, EDGE_A) }));
    expect(textOf(html)).toContain("Zaqvin has no games in this scope");
    expect(textOf(html)).not.toContain('set "me" in the console app');
  });
});
