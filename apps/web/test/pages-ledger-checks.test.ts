// The Checks, Games, one game's results and Settings pages rendered from made-up data (the
// synthetic folders and the edge folders), checked row by row against the console app's
// recorded output: the startup lines and the menu alert counts (startup.txt), the duplicate
// check (menu 16), the saved seat owners (menu 20), the game picker (menu 5), one game's
// results (the single-game settlement) and the pins, banker, me and display (menu 6).
// Made-up data only (fixtures/synthetic, fixtures/synthetic-edge and their reference output).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ledger, loadWorld } from "../../../packages/core/src/index.ts";
import { loadDataRoot } from "../../../tools/load.ts";
import { buildCtx, type Ctx } from "../src/context.ts";
import { EVERYTHING, type Payload } from "../src/data.ts";
import { Check, checkCount } from "../src/pages/Check.tsx";
import { GamePage } from "../src/pages/Game.tsx";
import { Games } from "../src/pages/Games.tsx";
import { Settings } from "../src/pages/Settings.tsx";
import { handWorldFromInputs, snapshotHandLogs } from "../server/handlogs.ts";

const TZ = "America/New_York";
const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
const EDGE = fileURLToPath(new URL("../../../fixtures/synthetic-edge/", import.meta.url));
const REF = fileURLToPath(new URL("../../../fixtures/synthetic-reference/scenarios/", import.meta.url));
const EDGE_REF = fileURLToPath(new URL("../../../fixtures/synthetic-edge-reference/scenarios/", import.meta.url));

// The two made-up folders, each with the console's recorded output for the same data.
const FOLDERS = [
  { name: "synthetic", root: SYNTHETIC, ref: REF },
  { name: "edge", root: EDGE, ref: EDGE_REF },
];

const noop = (): void => {};

// The name a game's Results cell gives for that night: "Della" or the nickname in "Della · as D E L L A".
function nightNameOf(cell: string): string {
  const at = cell.lastIndexOf(" · as ");
  return at < 0 ? cell : cell.slice(at + " · as ".length);
}
const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();
const reference = (path: string): string => readFileSync(path, "utf8");
const show = (el: ReactElement): string => renderToStaticMarkup(el).replace(/<!-- -->/g, "");

// The page context for one made-up folder, the way the site builds it from the files.
// `changed` replaces some of the Saved_Data files, as a run copy of the console's folder does.
async function ctxFor(root: string, changed: Record<string, string> = {}): Promise<Ctx> {
  const data = await loadDataRoot(root);
  const ledgers = data.games.filter((g) => ledger.looksLikeLedger(g.text));
  const saved = { ...data.savedData, ...changed };
  const world = loadWorld({ timeZone: TZ, ledgers, saved });
  const payload: Payload = {
    source: "local",
    dataRoot: "made-up",
    timeZone: TZ,
    loadedAt: 0,
    ledgers,
    logs: [],
    saved,
    canWrite: true,
    consoleOpen: 0,
    basis: "made-up",
  };
  return buildCtx(payload, world, EVERYTHING);
}

// The page context for a snapshot of one made-up folder: its hand-log results come embedded, as a snapshot's do.
async function snapshotCtxFor(root: string): Promise<Ctx> {
  const hw = handWorldFromInputs(await loadDataRoot(root), TZ);
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
  return buildCtx(payload, hw.world, EVERYTHING);
}

// ---- rendered markup as text and rows -------------------------------------------------------

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

function textOf(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/(td|th|span|a|button)>/g, " ")
    .replace(/<\/(p|div|li|tr|h1|h2|h3|dt|dd|summary|section|details|ul|table|nav)>|<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return normalize(text.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m] ?? m));
}

// The HTML of the card (section) that holds the heading text, or null when there is none.
function cardOf(html: string, heading: string): string | null {
  const at = html.indexOf(heading);
  if (at < 0) return null;
  return html.slice(html.lastIndexOf("<section", at), html.indexOf("</section>", at));
}

function needCard(html: string, heading: string): string {
  const card = cardOf(html, heading);
  expect(card, `the card "${heading}"`).not.toBeNull();
  return card ?? "";
}

// The text of each list item.
const itemsOf = (html: string): string[] => [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => textOf(m[1] ?? ""));

// The cells of each data row of each table (header rows left out).
function rowsOf(html: string): string[][] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .filter((m) => !(m[1] ?? "").includes("<th"))
    .map((m) => [...(m[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => textOf(c[1] ?? "")));
}

// The selected option of a select, as its label.
const selectedLabel = (card: string): string => /<option[^>]*selected=""[^>]*>([^<]*)<\/option>/.exec(card)?.[1] ?? "";

// Seat rows in a card: each one is an item of the "plain small" list that SharedSeats draws.
function seatRowCount(card: string): number {
  return [...card.matchAll(/<ul class="plain small">([\s\S]*?)<\/ul>/g)].reduce((n, m) => n + [...(m[1] ?? "").matchAll(/<li>/g)].length, 0);
}

// ---- the console's recorded output ----------------------------------------------------------

// The rows of a recorded table: the lines after its header and rule, up to the rule that ends it.
function tableRows(text: string, header: RegExp): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => header.test(line));
  expect(at, `the console table ${header}`).toBeGreaterThanOrEqual(0);
  const rows: string[] = [];
  for (let i = at + 2; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^-{10,}/.test(line)) break;
    if (line.trim() !== "") rows.push(line);
  }
  return rows;
}

// The lines of one recorded block: after its heading, up to the first blank line.
function blockRows(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith(heading));
  expect(at, `the console block ${heading}`).toBeGreaterThanOrEqual(0);
  const rows: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") break;
    rows.push(line);
  }
  return rows;
}

// The number a menu line flags with "*" in the console's box (0 when it flags none).
function alertOf(text: string, label: string): number {
  const line = text.split("\n").find((l) => l.includes(label)) ?? "";
  return Number(/\*\s+(\d+)\s/.exec(line)?.[1] ?? 0);
}

// A ledger path below the Games folder, as the page holds it ("Synthetic Spring/ledger_x.csv"):
// the console prints it after its work folder and its Games/ folder.
function tailOf(path: string): string {
  const at = path.indexOf("Games/");
  return at < 0 ? path : path.slice(at + "Games/".length);
}

interface DuplicateLine {
  label: string; // the words the page puts before the other file
  path: string;
  other: string;
  counted: boolean;
}

// Menu 16's entries, in the order the console prints them.
function duplicateBlock(text: string): DuplicateLine[] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("-- Duplicate ledger check"));
  expect(at, "the duplicate ledger check").toBeGreaterThanOrEqual(0);
  const out: DuplicateLine[] = [];
  let current: DuplicateLine | null = null;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("=====")) break;
    const head = /^\d+\. (.*)$/.exec(line);
    if (head !== null) {
      const h = head[1] ?? "";
      const overlap = /^OVERLAP: (\d+) sit-downs?/.exec(h);
      const label = h.startsWith("SAME LEDGER ID")
        ? "is an earlier export of"
        : overlap !== null
          ? `shares ${overlap[1]} ${overlap[1] === "1" ? "sit-down" : "sit-downs"} with`
          : "is a copy of";
      current = { label, path: "", other: "", counted: false };
      out.push(current);
      continue;
    }
    if (current === null) continue;
    const side = /^\s+(skipped|kept): +(.*)$/.exec(line);
    if (side !== null) {
      current.path = tailOf(side[2] ?? "");
      current.counted = side[1] === "kept";
    }
    const match = /^\s+matches: (.*)$/.exec(line);
    if (match !== null) current.other = tailOf(match[1] ?? "");
  }
  return out;
}

// The display width of one character, as the console counts it (util.cpp columnsOf): combining and
// zero-width characters take none, East Asian wide characters and emoji take two, the rest one.
function columnsOf(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x20d0 && cp <= 0x20ff)) {
    return 0;
  }
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd);
  return wide ? 2 : 1;
}

// The text of a console line that starts in its display columns [from, to).
function columnText(line: string, from: number, to: number): string {
  let col = 0;
  let out = "";
  for (const ch of line) {
    if (col >= from && col < to) out += ch;
    col += columnsOf(ch);
  }
  return out.trim();
}

// One saved seat owner row of menu 20, read by the console's columns (seats.cpp:340-348), each padded to
// its width in display columns: the number (4), the game's date or "(not loaded)" (12), the nickname (16),
// the account (12), the net (11, right-aligned), two spaces, the counted-for name (14), then the note (the
// console cuts the note short). The gaps between words cannot tell the counted-for name from the note: a
// 13-character name leaves one space before its note.
function seatOwnerRow(line: string): string[] {
  expect(columnText(line, 0, 4), line).toMatch(/^\d+$/);
  return [
    columnText(line, 4, 16),
    columnText(line, 16, 32),
    columnText(line, 32, 44),
    columnText(line, 44, 55),
    columnText(line, 57, 71),
    columnText(line, 71, Number.POSITIVE_INFINITY),
  ];
}

interface PickerRow {
  id: string; // the ledger id without its "ledger_" prefix
  folder: string;
  players: number;
  buyIns: string;
  date: string;
  time: string;
}

// The game picker (menu 5): newest first, with the date and time, folder, players, buy-ins and id.
function pickerRows(text: string): PickerRow[] {
  return tableRows(text, /^\s+#\s+Date\s+Folder/).map((line) => {
    const m = /^\s*\d+\s+(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\s+(.+?)\s+(\d+)\s+(\$[\d,]+\.\d{2})\s+(\S+)\s*$/.exec(line);
    expect(m, line).not.toBeNull();
    return {
      date: m?.[1] ?? "",
      time: m?.[2] ?? "",
      folder: m?.[3] ?? "",
      players: Number(m?.[4] ?? 0),
      buyIns: m?.[5] ?? "",
      id: m?.[6] ?? "",
    };
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A console date and 24-hour time ("2026-11-01", "01:20") as the page writes them: "Nov 1, 2026" and "1:20 AM".
function pageDateTime(date: string, time: string): string[] {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const [hh = 0, mm = 0] = time.split(":").map(Number);
  const clock = `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
  return [`${MONTHS[m - 1] ?? ""} ${d}, ${y}`, clock];
}

interface SettingLine {
  value: string;
  note: string;
}

// The pins and the three settings lines of menu 6, as the console prints them.
function menu6Block(text: string): { pins: string[][]; banker: SettingLine; me: SettingLine; display: SettingLine } {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("-- Pins, banker, me & display"));
  expect(at, "the pins, banker, me and display block").toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^-{10,}/.test(line)) break;
    body.push(line);
  }
  const blank = body.findIndex((l) => l.trim() === "");
  const pins = body.slice(0, blank).map((l) => {
    const m = /^\s*\d+\. (.+?) always pays (.+?)(?:\s{2,}(.*?))?\s*$/.exec(l);
    expect(m, l).not.toBeNull();
    return [m?.[1] ?? "", m?.[2] ?? "", m?.[3] ?? ""];
  });
  // A settings line: its name, its value, then (two or more spaces on) its words.
  const setting = (name: string): SettingLine => {
    const line = body.find((l) => new RegExp(`^\\s+${name}\\s`).test(l)) ?? "";
    const m = new RegExp(`^\\s+${name}\\s+(.+?)\\s{2,}(.*)$`).exec(line);
    expect(m, `the ${name} line`).not.toBeNull();
    return { value: m?.[1] ?? "", note: m?.[2] ?? "" };
  };
  return { pins, banker: setting("Banker"), me: setting("Me"), display: setting("Display") };
}

// ---- the Checks page ------------------------------------------------------------------------

describe("the Checks page against the console's startup, menu 16 and menu 20 (made-up data)", () => {
  for (const f of FOLDERS) {
    it(`${f.name}: the ledger notes are the startup's skipped and unbalanced lines, in the console's order`, async () => {
      const html = show(createElement(Check, { ctx: await ctxFor(f.root), onSaved: noop }));
      const recorded = reference(`${f.ref}startup/startup.txt`)
        .split("\n")
        .filter((l) => /^(Skipped: |WARNING: ledger_)/.test(l))
        .map(normalize);
      expect(recorded.length).toBeGreaterThan(0);
      expect(itemsOf(needCard(html, "Ledger notes"))).toEqual(recorded);
    });

    it(`${f.name}: the counts the menus alert are the Checks page's rows, and the check count adds them up`, async () => {
      const ctx = await ctxFor(f.root);
      const html = show(createElement(Check, { ctx, onSaved: noop }));
      const startup = reference(`${f.ref}startup/startup.txt`);
      const names = alertOf(startup, "Player names");
      const seats = alertOf(startup, "Shared accounts");
      const dups = alertOf(startup, "Duplicate check");
      const books = startup.split("\n").filter((l) => /^WARNING: ledger_.* does not balance/.test(l)).length;
      // The menu's "new" alert counts the accounts with a name never seen before; menu 4 asks one
      // question for each such name on each account (main.cpp reviewNewNames), one row each.
      const questions = ctx.view.mergeSuggestions.reduce((n, s) => n + s.newNames.length, 0);
      expect(ctx.view.mergeSuggestions.length).toBe(names);
      expect(itemsOf(needCard(html, "New names to check")).length).toBe(questions);
      expect(seatRowCount(needCard(html, "Seats that look shared"))).toBe(seats);
      expect(itemsOf(cardOf(html, "Duplicate ledgers") ?? "").length).toBe(dups);
      // The check count on the navigation is the menu alerts (names, seats, duplicates found) and the books that are off.
      expect(checkCount(ctx)).toBe(names + seats + dups + books);
    });

    it(`${f.name}: the duplicate ledgers are menu 16's pairs, in its order, with the same skipped and kept sides`, async () => {
      const html = show(createElement(Check, { ctx: await ctxFor(f.root), onSaved: noop }));
      const recorded = duplicateBlock(reference(`${f.ref}views/views.txt`));
      // Menu 16 found 3 in the synthetic folders and none in the edge folders (its header says so).
      expect(recorded).toHaveLength(f.name === "synthetic" ? 3 : 0);
      const page = [...(cardOf(html, "Duplicate ledgers") ?? "").matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => {
        const li = m[1] ?? "";
        const codes = [...li.matchAll(/<code>([^<]*)<\/code>/g)].map((c) => c[1] ?? "");
        return {
          label: /<span class="muted">([^<]*)<\/span>/.exec(li)?.[1] ?? "",
          path: tailOf(codes[0] ?? ""),
          other: tailOf(codes[1] ?? ""),
          counted: li.includes("counted twice?"),
        };
      });
      expect(page).toEqual(recorded);
      // The console's advice under an overlap, word for word, is on the page too.
      const advice = normalize(reference(`${f.ref}views/views.txt`)).match(/Both files are still counted\. If they are the same game, delete the older export\./)?.[0];
      if (f.name === "synthetic") expect(textOf(cardOf(html, "Duplicate ledgers") ?? "")).toContain(advice ?? "(missing)");
    });

    it(`${f.name}: the saved seat owners are menu 20's list, row by row, with its summary`, async () => {
      const ctx = await ctxFor(f.root);
      const html = show(createElement(Check, { ctx, onSaved: noop }));
      const views = reference(`${f.ref}views/views.txt`);
      const recorded = tableRows(views, /^#\s+Game\s+Nickname/).map(seatOwnerRow);
      expect(recorded).toHaveLength(3);
      const seatOwners = needCard(html, "Saved seat owners");
      const rows = rowsOf(seatOwners).map((cells) => cells.slice(0, 6));
      // The counted-for name is compared without case: the console prints a name that has no ledger row
      // in lower case (its People list is the ledger rows only), and the page prints the name the boards use.
      const shape = (r: string[]): string[] => [r[0] ?? "", r[1] ?? "", r[2] ?? "", r[3] ?? "", (r[4] ?? "").toLowerCase()];
      expect(rows.map((r) => shape(r))).toEqual(recorded.map((r) => shape(r)));
      // The console cuts a note short, so the page's full note starts with the console's text.
      rows.forEach((r, i) => expect(r[5]?.startsWith((recorded[i]?.[5] ?? "").replace(/\.$/, ""))).toBe(true));
      const summary = /List saved seat owners[^(]*\(([^)]*)\)/.exec(views)?.[1] ?? "";
      expect(summary).not.toBe("");
      expect(textOf(seatOwners)).toContain(`Saved seat owners (${summary})`);
    });

    it(`${f.name}: the shared seats say that they count for the name on them until they are answered`, async () => {
      const html = show(createElement(Check, { ctx: await ctxFor(f.root), onSaved: noop }));
      const shared = needCard(html, "Seats that look shared");
      // The startup's second line for the seats: they count for the name on the seat until they are checked.
      expect(textOf(shared)).toContain("Until you answer, each seat counts for the name on it.");
    });
  }
});

describe("the Checks page's hand-log notes against the startup's hand-log lines (made-up data)", () => {
  // The lines the startup prints about hand logs: a skipped log, or a duplicate one that was ignored.
  const handLines = (text: string): string[] =>
    text
      .split("\n")
      .filter((l) => /^(Skipped hand log|Duplicate hand log ignored)/.test(l))
      .map(normalize);
  // The kind of line and its file name: the folder the console prints before a file differs by its work folder.
  const short = (line: string): string[] => [line.split(":")[0] ?? "", line.split("/").pop() ?? ""];

  it("synthetic: the startup prints no hand-log line, and the page shows no notes", async () => {
    const html = show(createElement(Check, { ctx: await snapshotCtxFor(SYNTHETIC), onSaved: noop }));
    expect(handLines(reference(`${REF}startup/startup.txt`))).toHaveLength(0);
    expect(cardOf(html, "Hand logs · Play style")).toBeNull();
  });

  it("edge: the startup's two hand-log lines are the page's, in the console's order", async () => {
    const html = show(createElement(Check, { ctx: await snapshotCtxFor(EDGE), onSaved: noop }));
    const recorded = handLines(reference(`${EDGE_REF}startup/startup.txt`));
    expect(recorded).toHaveLength(2);
    const shown = itemsOf(needCard(html, "Hand logs · Play style"));
    expect(shown.map(short)).toEqual(recorded.map(short));
    expect(textOf(needCard(html, "Hand logs · Play style"))).toContain("Notes from the hand logs (2)");
  });
});

describe("the saved seat owners' columns, as menu 20 prints them (made-up rows)", () => {
  it("a counted-for name of 13 characters leaves one space before its note, and the note stays in its own cell", () => {
    // seats.cpp:340-348: the number (4 columns), the date (12), the nickname (16), the account (12), the net (11,
    // right-aligned), two spaces, the counted-for name (14), then the note.
    const row = `1   2026-10-01  ${"Nick".padEnd(16)}${"acct01".padEnd(12)}${"+$5.00".padStart(11)}  ${"Abcdefghijklm".padEnd(14)}a short note`;
    expect(seatOwnerRow(row)).toEqual(["2026-10-01", "Nick", "acct01", "+$5.00", "Abcdefghijklm", "a short note"]);
  });

  it("a row with no note, and a game that was not loaded, read as their columns", () => {
    const row = `2   (not loaded)${"Nick".padEnd(16)}${"acct02".padEnd(12)}${"$0.00".padStart(11)}  ${"Abc".padEnd(14)}`;
    expect(seatOwnerRow(row)).toEqual(["(not loaded)", "Nick", "acct02", "$0.00", "Abc", ""]);
  });

  it("a nickname with an emoji is as wide as the console counts it, so the columns after it still line up", () => {
    // "🎲Brask" is two columns for the emoji and five for the letters: seven columns, so nine spaces fill its 16.
    const nick = "🎲Brask";
    const row = `3   2026-10-02  ${nick}${" ".repeat(9)}${"acctX".padEnd(12)}${"-$1.00".padStart(11)}  ${"Harlo".padEnd(14)}`;
    expect(seatOwnerRow(row)).toEqual(["2026-10-02", nick, "acctX", "-$1.00", "Harlo", ""]);
  });
});

// ---- the Games page -------------------------------------------------------------------------

describe("the Games page against the console's game picker, menu 5 (made-up data)", () => {
  for (const f of FOLDERS) {
    it(`${f.name}: the games are the picker's rows, newest first, with its folder, players, buy-ins and id`, async () => {
      const html = show(createElement(Games, { ctx: await ctxFor(f.root) }));
      const recorded = pickerRows(reference(`${f.ref}single-game/logs/settle.txt`));
      // The picker lists every game in the folders: 14 in the synthetic data, 8 in the edge data.
      expect(recorded).toHaveLength(f.name === "synthetic" ? 14 : 8);
      const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1] ?? "");
      // Each night links to its game by the picker's id (the list does not print the id; the night's page does).
      const ids = items.map((li) => decodeURIComponent(/href="[^"]*\/game\/([^"]*)"/.exec(li)?.[1] ?? "").replace(/^ledger_/, ""));
      expect(ids).toEqual(recorded.map((r) => r.id));
      items.forEach((li, i) => {
        const r = recorded[i];
        if (r === undefined) return;
        const text = textOf(li);
        expect(text).toContain(r.folder);
        expect(text).toContain(r.players === 1 ? "1 player" : `${r.players} players`);
        expect(text).toContain(`${r.buyIns} bought in`);
        const [day, clock] = pageDateTime(r.date, r.time);
        expect(text).toContain(day);
        expect(text).toContain(clock);
      });
    });
  }
});

// ---- one game's results ---------------------------------------------------------------------

// The net of each row of the console's results table: the name, then its poker net.
function nets(lines: string[]): string[][] {
  return lines.map((l) => {
    const m = /^ {2}(.+?)\s+([+-]?\$[\d,]+\.\d{2})\s/.exec(l);
    expect(m, l).not.toBeNull();
    return [m?.[1] ?? "", m?.[2] ?? ""];
  });
}

describe("one game's results against the console's single-game settlement (made-up data)", () => {
  const CASES = [
    { name: "synthetic newest game", root: SYNTHETIC, ref: REF, id: "ledger_pglFAKE0012", picker: "pglFAKE0012" },
    { name: "edge newest game", root: EDGE, ref: EDGE_REF, id: "ledger_pglEDGE0002", picker: "pglEDGE0002" },
  ];

  for (const c of CASES) {
    it(`${c.name}: the players, their nets and the balance note are the console's`, async () => {
      const ctx = await ctxFor(c.root);
      const html = show(createElement(GamePage, { ctx, id: c.id, onSaved: noop }));
      const text = reference(`${c.ref}single-game/logs/settle.txt`);
      const picked = pickerRows(text).find((p) => p.id === c.picker);
      expect(picked, c.picker).toBeDefined();
      const block = blockRows(text, `-- Game of ${picked?.date ?? ""}, 1 game`).filter((l) => !/^\s+Player\s/.test(l));
      const recorded = nets(block);
      // A name cell is "usual" or "usual · as <that night's nickname>"; the console prints the nickname.
      const results = rowsOf(needCard(html, "Results")).map((cells) => [nightNameOf(cells[0] ?? ""), cells[cells.length - 1] ?? ""]);
      expect(results).toEqual(recorded);

      const shown = textOf(html);
      expect(shown).toContain(`${picked?.id ?? ""}`);
      expect(shown).toContain(`${picked?.players ?? 0} players`);
      expect(shown).toContain(`${picked?.buyIns ?? ""} bought in`);
      // The console's sheet says how far the nets are off; the page's line gives the same amount.
      const consoleOff = /its totals add up to ([+-]?\$[\d,]+\.\d{2}) instead/.exec(text)?.[1] ?? "$0.00";
      expect(/nets add up to ([+-]?\$[\d,]+\.\d{2})/.exec(shown)?.[1]).toBe(consoleOff);
    });
  }

  it("synthetic ledger 0006: the page says its nets are off by the amount the startup warns about", async () => {
    const ctx = await ctxFor(SYNTHETIC);
    const shown = textOf(show(createElement(GamePage, { ctx, id: "ledger_pglFAKE0006", onSaved: noop })));
    const startup = reference(`${REF}startup/startup.txt`);
    const warned = /ledger_pglFAKE0006\.csv does not balance: its nets sum to ([+-]?\$[\d,.]+) instead/.exec(startup)?.[1];
    expect(warned).toBe("+$5.00");
    expect(shown).toContain(`The nets add up to ${warned} instead of $0.00.`);
  });

  it("synthetic ledger 0006: a seat played under another nickname shows the usual name and that night's, as the single-game sheet names it", async () => {
    // One seat of this game was played under "🃏🃏"; the player's name across every game is another nickname ("🎴").
    // The single-game sheet (menu 5, option 1) names the seat by the nickname used in this game.
    const ctx = await ctxFor(SYNTHETIC);
    const html = show(createElement(GamePage, { ctx, id: "ledger_pglFAKE0006", onSaved: noop }));
    const names = rowsOf(needCard(html, "Results")).map((cells) => cells[0] ?? "");
    expect(names).toContain("🎴 · as 🃏🃏");
    expect(names.map(nightNameOf)).toContain("🃏🃏");
  });
});

// ---- Settings -------------------------------------------------------------------------------

describe("Settings against the console's pins, banker, me and display (menu 6, made-up data)", () => {
  for (const f of FOLDERS) {
    it(`${f.name}: the pins, banker, me and display are menu 6's`, async () => {
      const html = show(createElement(Settings, { ctx: await ctxFor(f.root), onSaved: noop }));
      const block = menu6Block(reference(`${f.ref}views/views.txt`));

      expect(block.pins).toHaveLength(2);
      const pins = [
        ...needCard(html, "Pinned payments").matchAll(
          /<strong>([^<]*)<\/strong> always pays <strong>([^<]*)<\/strong>(?:<span class="muted"> · ([^<]*)<\/span>)?/g,
        ),
      ].map((m) => [m[1] ?? "", m[2] ?? "", m[3] ?? ""]);
      expect(pins).toEqual(block.pins);

      // The banker: off, so the select shows the "off" choice with the console's words after it.
      const banker = needCard(html, "<h3>Banker</h3>");
      expect(selectedLabel(banker).toLowerCase()).toBe(`${block.banker.value} (${block.banker.note})`);

      // Me: the same person, as the select shows the chosen name.
      const me = needCard(html, "<h3>Me</h3>");
      expect(selectedLabel(me)).toBe(block.me.value);

      // The display: the same setting, with the console's words in brackets.
      const display = textOf(needCard(html, "<h3>Console display</h3>"));
      expect(display).toContain(`${block.display.value} (${block.display.note})`);
    });
  }

  it("synthetic: with the banker set, the banker select shows the name the console's box names", async () => {
    // The banker run of the console set the banker to the player with the most games; its box says so.
    const boxed = /\| me \S+ \| banker ([^|]+?)\s*\|/.exec(reference(`${REF}banker/logs/summary.txt`))?.[1];
    expect(boxed).toBe("Cavlorn");
    const ctx = await ctxFor(SYNTHETIC, { "settings.csv": "key,value\nme,zaqvin\nbanker,cavlorn\ndisplay,fancy\n" });
    const html = show(createElement(Settings, { ctx, onSaved: noop }));
    expect(selectedLabel(needCard(html, "<h3>Banker</h3>"))).toBe(boxed);
  });
});
