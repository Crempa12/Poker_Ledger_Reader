// Parity with the C++ app. Recomputes the ledger side of a reference run
// (reference/run.sh) with the TypeScript core, from the same data root, and
// compares every output with what the C++ app wrote or printed.
//
//   node tools/parity.ts --reference <reference folder> --data <data root>
//
// Prints to the terminal only, and exits 1 on any mismatch. Nothing is written to
// a file, so real data cannot reach a committed file. A mismatch names players by
// normalized name, never by display name, and never shows a file name.
//
// Compared: player_summary.csv (the ledger columns, cell by cell, as exact text),
// settlements.csv and session_balances.csv (byte for byte), each history_<n>.txt
// (every night's date, buy-ins, net and running total) and startup.txt (ledger
// messages, duplicate and warning counts, the Loaded counts and the summary box).
// Not compared: the hand-log columns and exports, and the printed views.

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDataRoot } from "./load.ts";
import type { DataRootInputs } from "./load.ts";
import { filterGames, listFolders } from "../packages/core/src/ledger.ts";
import type { Game, PlayerStats, Scope, SettlementEntry } from "../packages/core/src/models.ts";
import { playerSummaryCSV, suggestMergesByPlayerId } from "../packages/core/src/players.ts";
import { findSuspicious } from "../packages/core/src/seats.ts";
import { settlementsCSV } from "../packages/core/src/settlement.ts";
import { addSettlementBatch, recordPayment, serializeSessionBalances, sortedRows } from "../packages/core/src/sessions.ts";
import type { Balances } from "../packages/core/src/sessions.ts";
import { dollarsToCents, formatLocalDate, moneySignedCents, parseLocalDate } from "../packages/core/src/util.ts";
import { boardFor, loadWorld, sheetFor } from "../packages/core/src/world.ts";
import type { World } from "../packages/core/src/world.ts";

// ---------------- the report ----------------

export interface Check {
  name: string; // the file or step checked, named as the reference names it
  detail: string; // what was compared, for the terminal
  mismatches: string[]; // empty when everything matched
}

export interface ScenarioReport {
  name: string;
  checks: Check[];
  notCompared: string[];
  mismatchCount: number;
}

export interface ParityReport {
  referenceDir: string;
  dataRoot: string;
  scenarios: ScenarioReport[];
  mismatchCount: number;
}

// ---------------- what the reference recorded ----------------

// One step of a scenario, as reference/run.sh writes it into scenario.json.
interface Step {
  kind: string;
  log: string;
  exit: number;
  args: string[];
  menu: string[];
}

interface ScenarioFile {
  name: string;
  tz: string;
  steps: Step[];
}

const ALL_SCOPE: Scope = { folder: "", from: null, to: null };

// ---------------- small helpers ----------------

const ANSI = /\u001b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// The lines of a text file, without the empty string after the last newline.
function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// The raw text of every CSV field. Quotes are kept, so a comparison is of the
// exact bytes the file holds, not of the unquoted values.
function rawFields(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (c === '"') {
      if (quoted && line.charAt(i + 1) === '"') {
        current += '""';
        i++;
      } else {
        quoted = !quoted;
        current += c;
      }
    } else if (c === "," && !quoted) {
      fields.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  fields.push(current);
  return fields;
}

function dateOrThrow(text: string, endOfDay: boolean, timeZone: string): number {
  const epoch = parseLocalDate(text, endOfDay, timeZone);
  if (epoch === null) throw new Error("a date in a step's flags does not parse");
  return epoch;
}

// The scope a step's flags give (--folder, --from, --to), read as main.cpp reads them.
function scopeFromArgs(args: readonly string[], timeZone: string): Scope {
  const scope: Scope = { folder: "", from: null, to: null };
  for (let i = 0; i + 1 < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1] ?? "";
    if (flag === "--folder") scope.folder = value;
    else if (flag === "--from") scope.from = dateOrThrow(value, false, timeZone);
    else if (flag === "--to") scope.to = dateOrThrow(value, true, timeZone);
    else throw new Error(`a step has a flag the parity check does not know: ${flag ?? ""}`);
  }
  return scope;
}

// ---------------- building the world ----------------

// What the app holds after startup (main.cpp loadData and refresh): the core facade does the
// work, so the parity check exercises the same entry point a website would call.
function buildWorld(inputs: DataRootInputs, timeZone: string): World {
  return loadWorld({ timeZone, ledgers: inputs.games, saved: inputs.savedData });
}

// The first player on the all-data board with the most games: reference/run.sh's
// banker helper, which reads the first row with the highest games count.
function topGamesPlayer(world: World): string {
  let best = "";
  let bestGames = -1;
  const board = boardFor(world, world.games, ALL_SCOPE);
  for (const p of board) {
    if (p.games > bestGames) {
      best = p.normalizedName;
      bestGames = p.games;
    }
  }
  return best;
}

// reference/run.sh changes two things in the run copy: the nopins scenario has no
// pinned payments, and the banker scenario has a banker. The same changes are made here.
function scenarioWorld(base: World, name: string): World {
  if (name === "nopins") return { ...base, prefs: [] };
  if (name === "banker") return { ...base, settings: { ...base.settings, banker: topGamesPlayer(base) } };
  return base;
}

// ---------------- replaying a run's menus ----------------

// The scope main.cpp uses for "one game": its folder and its local day.
function dayScope(game: Game, timeZone: string): Scope {
  const day = formatLocalDate(game.start, timeZone);
  return {
    folder: game.folder,
    from: parseLocalDate(day, false, timeZone),
    to: parseLocalDate(day, true, timeZone),
  };
}

interface SheetRun {
  entries: SettlementEntry[];
  next: number; // where the menu continues, after the sheet's own answers
}

// main.cpp calculateSettlement(): menu 5 picks one game (option 1) or everything in
// the scope (option 3). Then comes the one-off question (not asked in banker mode),
// and the sheet is calculated from the board sorted by net.
function runSettle(menu: readonly string[], world: World, scope: Scope): SheetRun {
  if (menu[0] !== "5") throw new Error("a settle step starts with menu 5");
  let games: Game[];
  let target: Scope;
  let next: number;
  if (menu[1] === "3") {
    games = filterGames(world.games, scope);
    target = scope;
    next = 2;
  } else if (menu[1] === "1") {
    // The list is newest first, and option 1 picks by its number.
    const newestFirst = [...filterGames(world.games, scope)].reverse();
    const game = newestFirst[Number(menu[2]) - 1];
    if (game === undefined) throw new Error("a single-game step picks no game");
    games = [game];
    target = dayScope(game, world.timeZone);
    next = 3;
  } else {
    throw new Error(`menu 5 option ${menu[1] ?? ""} is not supported by the parity check`);
  }
  if (world.settings.banker === "") {
    // Only "n" (no one-off request) is replayed here.
    if (menu[next] !== "n") throw new Error("a one-off request is not supported by the parity check");
    next++;
  }
  const entries = sheetFor(world, games, target).entries;
  return { entries, next };
}

// menu 7: saves the sheet under a session id, after asking before it adds on top of an
// existing one.
function saveSheet(menu: readonly string[], next: number, balances: Balances, entries: SettlementEntry[]): Balances {
  const at = menu.indexOf("7", next);
  if (at === -1) throw new Error("a save step has no menu 7");
  const sessionId = menu[at + 1] ?? "";
  const exists = [...balances.values()].some((b) => b.sessionId === sessionId);
  if (exists) {
    const answer = menu[at + 2];
    if (answer === "n") return balances;
    if (answer !== "y") throw new Error("an existing session needs an answer");
  }
  if (entries.length === 0) return balances;
  return addSettlementBatch(balances, sessionId, entries);
}

// menu 10: the balance is picked by its number in the open list (saved order), then the amount.
function recordPart(menu: readonly string[], balances: Balances): Balances {
  const row = sortedRows(balances, true)[Number(menu[1]) - 1];
  if (row === undefined) throw new Error("a payment step picks no open balance");
  const result = recordPayment(
    balances,
    row.sessionId,
    { fromNormalized: row.fromNormalized, toNormalized: row.toNormalized },
    dollarsToCents(menu[2] ?? ""),
  );
  return result.balances;
}

// ---------------- comparing ----------------

interface Column {
  name: string;
  sensitive: boolean; // values are never printed: display names, ids and free text
}

const SUMMARY_COLUMNS: Column[] = [
  { name: "rank", sensitive: false },
  { name: "display_name", sensitive: true },
  { name: "normalized_name", sensitive: false },
  { name: "games", sensitive: false },
  { name: "buy_ins", sensitive: false },
  { name: "total_won", sensitive: false },
  { name: "total_lost", sensitive: false },
  { name: "adjustments", sensitive: false },
  { name: "total_net", sensitive: false },
  { name: "avg_per_game", sensitive: false },
  { name: "biggest_win", sensitive: false },
  { name: "biggest_loss", sensitive: false },
  { name: "aliases", sensitive: false },
];

const SETTLEMENT_COLUMNS: Column[] = [
  { name: "from", sensitive: true },
  { name: "to", sensitive: true },
  { name: "amount", sensitive: false },
  { name: "reason", sensitive: false },
  { name: "from_normalized", sensitive: false },
  { name: "to_normalized", sensitive: false },
];

const SESSION_COLUMNS: Column[] = [
  { name: "session_id", sensitive: true },
  { name: "from_display", sensitive: true },
  { name: "from_normalized", sensitive: false },
  { name: "to_display", sensitive: true },
  { name: "to_normalized", sensitive: false },
  { name: "original_amount", sensitive: false },
  { name: "remaining_amount", sensitive: false },
  { name: "status", sensitive: false },
];

const HISTORY_COLUMNS: Column[] = [
  { name: "night", sensitive: false },
  { name: "date", sensitive: false },
  { name: "buy-ins", sensitive: false },
  { name: "net", sensitive: false },
  { name: "running total", sensitive: false },
  { name: "game", sensitive: true },
];

// One night in a player's history table: number, date, folder or note, buy-ins, net,
// running total, game. The folder or note is not compared.
const HISTORY_ROW =
  /^\s*(\d+)\s+(\d{4}-\d{2}-\d{2}|unknown)\s+(.*?)\s+(-|\d+)\s+([+-]?\$[\d,]+\.\d{2})\s+([+-]?\$[\d,]+\.\d{2})\s+(\S.*?)\s*$/;

// Compares rows column by column. `cpp` is what the C++ app wrote, `ts` what the core
// computed. Only the listed columns are compared.
function compareRows(
  cpp: readonly string[][],
  ts: readonly string[][],
  columns: readonly Column[],
  label: (row: readonly string[]) => string,
): string[] {
  const out: string[] = [];
  if (cpp.length !== ts.length) out.push(`row count: C++ ${cpp.length}, TypeScript ${ts.length}`);
  const shared = Math.min(cpp.length, ts.length);
  for (let k = 0; k < shared; k++) {
    const c = cpp[k] ?? [];
    const t = ts[k] ?? [];
    const named = label(c);
    const where = named === "" ? `row ${k + 1}` : `row ${k + 1} (${named})`;
    columns.forEach((col, i) => {
      const cv = c[i] ?? "";
      const tv = t[i] ?? "";
      if (cv === tv) return;
      out.push(col.sensitive ? `${where}: ${col.name} differs` : `${where}: ${col.name} C++ ${cv}, TypeScript ${tv}`);
    });
  }
  return out;
}

// Compares a whole CSV file: the header line, then the rows by the listed columns.
// With byteExact, any byte difference is a mismatch even when every listed cell matches.
function compareCsv(
  cppText: string,
  tsText: string,
  columns: readonly Column[],
  label: (row: readonly string[]) => string,
  byteExact: boolean,
): string[] {
  if (cppText === tsText) return [];
  const cppLines = linesOf(cppText);
  const tsLines = linesOf(tsText);
  const out: string[] = [];
  if ((cppLines[0] ?? "") !== (tsLines[0] ?? "")) out.push("header line differs");
  out.push(...compareRows(cppLines.slice(1).map(rawFields), tsLines.slice(1).map(rawFields), columns, label));
  if (byteExact && out.length === 0) out.push("bytes differ, but every cell matches (line endings or trailing text)");
  return out;
}

function countMismatch(out: string[], what: string, cppText: string, tsValue: number): void {
  if (Number(cppText) !== tsValue) out.push(`${what}: C++ ${cppText}, TypeScript ${tsValue}`);
}

// ---------------- the checks ----------------

async function checkSummary(dir: string, world: World, scope: Scope): Promise<Check> {
  const name = "player_summary.csv";
  const cpp = await readText(join(dir, name));
  if (cpp === null) return { name, detail: "", mismatches: ["missing from the reference"] };
  const board = boardFor(world, filterGames(world.games, scope), scope);
  return {
    name,
    detail: `${board.length} players; ledger columns only, the hand-log columns are not compared`,
    mismatches: compareCsv(cpp, playerSummaryCSV(board), SUMMARY_COLUMNS, (r) => r[2] ?? "", false),
  };
}

async function checkSettlementsFile(dir: string, entries: SettlementEntry[]): Promise<Check> {
  const name = "settlements.csv";
  const cpp = await readText(join(dir, name));
  if (cpp === null) return { name, detail: "", mismatches: ["missing from the reference"] };
  return {
    name,
    detail: `${entries.length} payments, byte for byte`,
    mismatches: compareCsv(cpp, settlementsCSV(entries), SETTLEMENT_COLUMNS, (r) => `${r[4] ?? ""} to ${r[5] ?? ""}`, true),
  };
}

async function checkSessionsFile(dir: string, balances: Balances): Promise<Check> {
  const name = "session_balances.csv";
  const cpp = await readText(join(dir, name));
  if (cpp === null) return { name, detail: "", mismatches: ["missing from the reference"] };
  return {
    name,
    detail: `${balances.size} balances, byte for byte`,
    mismatches: compareCsv(cpp, serializeSessionBalances(balances), SESSION_COLUMNS, (r) => `${r[2] ?? ""} to ${r[4] ?? ""}`, true),
  };
}

// The rows the core expects in a player's history table, as the C++ prints them.
function expectedHistory(player: PlayerStats, timeZone: string): string[][] {
  let running = 0; // poker only, like the leaderboard
  return player.history.map((h, k) => {
    if (!h.adjustment) running += h.netCents;
    return [
      String(k + 1),
      formatLocalDate(h.date, timeZone),
      h.adjustment ? "-" : String(h.buyIns),
      moneySignedCents(h.netCents),
      moneySignedCents(running),
      h.adjustment ? "adjustment" : h.gameId.startsWith("ledger_") ? h.gameId.slice(7) : h.gameId,
    ];
  });
}

async function checkHistory(dir: string, step: Step, world: World): Promise<Check> {
  const name = step.log;
  const text = await readText(join(dir, step.log));
  if (text === null) return { name, detail: "", mismatches: ["missing from the reference"] };
  const number = Number(step.menu[1]);
  const board = boardFor(world, world.games, ALL_SCOPE);
  const player = board[number - 1];
  if (player === undefined) return { name, detail: "", mismatches: [`no player ${number} on the all-data board`] };

  const lines = linesOf(stripAnsi(text));
  const header = `-- ${player.displayName}, night by night`;
  const start = lines.findIndex((l) => l.startsWith(header));
  if (start === -1) {
    return { name, detail: "", mismatches: [`player ${player.normalizedName}: the history header is missing`] };
  }
  const cpp: string[][] = [];
  for (const line of lines.slice(start)) {
    const m = HISTORY_ROW.exec(line);
    if (m) cpp.push([m[1] ?? "", m[2] ?? "", m[4] ?? "", m[5] ?? "", m[6] ?? "", m[7] ?? ""]);
  }
  const ts = expectedHistory(player, world.timeZone);
  return {
    name,
    detail: `${player.normalizedName}, ${ts.length} nights`,
    mismatches: compareRows(cpp, ts, HISTORY_COLUMNS, () => player.normalizedName),
  };
}

// The loader's messages that the startup prints in the same words.
const UNBALANCED = /^WARNING: .+ does not balance: its nets sum to /;
const DUPLICATES = /^WARNING: (\d+) duplicate\/overlapping ledgers? found \((\d+) skipped/;
const NAMES = /^WARNING: (\d+) accounts? (?:has|have) a name never seen before/;
const BUY_INS = /^WARNING: (\d+) buy-ins? look like/;
const LOADED =
  /^Loaded (\d+) games? \((\d+) folders?\), (\d+) hand logs, (\d+) merged names, (\d+) seat checks, (\d+) payments & corrections\.$/;
const BOX_GAMES = /POKER LEDGER\s+(\d+) games/;
const BOX_PLAYERS = /(\d+) players/;
const BOX_PINNED = /pinned payments (\d+)/;

async function checkStartup(dir: string, step: Step, world: World): Promise<Check> {
  const name = step.log;
  const text = await readText(join(dir, step.log));
  if (text === null) return { name, detail: "", mismatches: ["missing from the reference"] };
  const lines = linesOf(stripAnsi(text));
  const mismatches: string[] = [];
  const first = (re: RegExp): RegExpExecArray | null => {
    for (const line of lines) {
      const m = re.exec(line);
      if (m) return m;
    }
    return null;
  };

  // 1. The loader's messages, in order: skipped files, then unbalanced ledgers.
  const cppMessages = lines.filter((l) => l.startsWith("Skipped: ") || UNBALANCED.test(l));
  if (cppMessages.length !== world.messages.length) {
    mismatches.push(`ledger messages: C++ ${cppMessages.length}, TypeScript ${world.messages.length}`);
  }
  world.messages.forEach((message, k) => {
    if (cppMessages[k] !== message) {
      const kind = message.startsWith("Skipped") ? "skipped file" : "unbalanced ledger";
      mismatches.push(`ledger message ${k + 1} (${kind}) differs; text not shown`);
    }
  });

  // 2. Duplicate notes: whether there are any, and how many were skipped.
  const dup = first(DUPLICATES);
  const skipped = world.duplicates.filter((d) => d.skipped).length;
  if (world.duplicates.length === 0) {
    if (dup !== null) mismatches.push("C++ reports duplicate ledgers, TypeScript finds none");
  } else if (dup === null) {
    mismatches.push("TypeScript finds duplicate ledgers, C++ reports none");
  } else {
    countMismatch(mismatches, "duplicate ledgers", dup[1] ?? "", world.duplicates.length);
    countMismatch(mismatches, "skipped duplicates", dup[2] ?? "", skipped);
  }

  // 3. The Loaded line: counts of what the app holds (the hand-log count is not compared).
  const loaded = first(LOADED);
  if (loaded === null) {
    mismatches.push('the "Loaded" line is missing or not in the expected form');
  } else {
    countMismatch(mismatches, "games", loaded[1] ?? "", world.games.length);
    countMismatch(mismatches, "folders", loaded[2] ?? "", listFolders(world.games).length);
    countMismatch(mismatches, "merged names", loaded[4] ?? "", world.rules.size);
    countMismatch(mismatches, "seat checks", loaded[5] ?? "", world.seatOwners.length);
    countMismatch(mismatches, "payments and corrections", loaded[6] ?? "", world.adjustments.length);
  }

  // 4. The two warnings after it: accounts with a new name, and buy-ins to check.
  countMismatch(
    mismatches,
    "accounts with a name never seen before",
    first(NAMES)?.[1] ?? "0",
    suggestMergesByPlayerId(world.games, world.rules).length,
  );
  countMismatch(mismatches, "buy-ins to check", first(BUY_INS)?.[1] ?? "0", findSuspicious(world.games, world.rules).length);

  // 5. The summary box: games, players, pinned payments, and whether banker mode is on.
  const boxGames = first(BOX_GAMES);
  const boxPlayers = first(BOX_PLAYERS);
  const boxPinned = first(BOX_PINNED);
  if (boxGames === null || boxPlayers === null || boxPinned === null) {
    mismatches.push("the summary box is not in the expected form");
  } else {
    const players = boardFor(world, world.games, ALL_SCOPE).length;
    countMismatch(mismatches, "box games", boxGames[1] ?? "", world.games.length);
    countMismatch(mismatches, "box players", boxPlayers[1] ?? "", players);
    countMismatch(mismatches, "box pinned payments", boxPinned[1] ?? "", world.prefs.length);
  }
  const bankerOff = lines.some((l) => l.includes("banker off"));
  if (bankerOff !== (world.settings.banker === "")) mismatches.push("banker mode: the box and TypeScript disagree");

  const otherWarnings = lines.filter(
    (l) =>
      l.startsWith("WARNING:") &&
      !UNBALANCED.test(l) &&
      !DUPLICATES.test(l) &&
      !NAMES.test(l) &&
      !BUY_INS.test(l),
  ).length;
  const extra = otherWarnings > 0 ? `; ${otherWarnings} other warning line(s) not compared` : "";
  return {
    name,
    detail: `ledger messages, duplicates, the Loaded counts, the two warnings and the box${extra}`,
    mismatches,
  };
}

// ---------------- scenarios and the whole run ----------------

async function checkScenario(dir: string, scenario: ScenarioFile, base: World): Promise<ScenarioReport> {
  const checks: Check[] = [];
  const notCompared: string[] = [];
  let world = scenarioWorld(base, scenario.name);
  let sheet: SettlementEntry[] | null = null;
  let summaryChecked = false;

  for (const step of scenario.steps) {
    if (step.exit !== 0) {
      checks.push({ name: `${step.kind} step`, detail: "", mismatches: [`the C++ app exited with ${step.exit}`] });
    }
    const scope = scopeFromArgs(step.args, base.timeZone);
    switch (step.kind) {
      case "summary":
        summaryChecked = true;
        checks.push(await checkSummary(dir, world, scope));
        break;
      case "settle":
        sheet = runSettle(step.menu, world, scope).entries;
        break;
      case "save": {
        const run = runSettle(step.menu, world, scope);
        sheet = run.entries;
        world = { ...world, balances: saveSheet(step.menu, run.next, world.balances, run.entries) };
        break;
      }
      case "part-pay":
        world = { ...world, balances: recordPart(step.menu, world.balances) };
        break;
      case "history":
        checks.push(await checkHistory(dir, step, world));
        break;
      case "startup":
        checks.push(await checkStartup(dir, step, world));
        break;
      case "views":
        notCompared.push(`printed views (menus ${step.menu.filter((m) => m !== "").join(" ")})`);
        break;
      case "handlog":
        notCompared.push("hand-log outputs (hand logs are not ported yet)");
        break;
      default:
        checks.push({ name: step.kind, detail: "", mismatches: [`unknown step kind "${step.kind}"`] });
    }
  }

  // Files the run wrote in the scenario folder itself.
  if ((await readText(join(dir, "player_summary.csv"))) !== null && !summaryChecked) {
    checks.push({ name: "player_summary.csv", detail: "", mismatches: ["the file has no summary step to recompute it"] });
  }
  if ((await readText(join(dir, "settlements.csv"))) !== null) {
    if (sheet === null) {
      checks.push({ name: "settlements.csv", detail: "", mismatches: ["the file has no settle step to recompute it"] });
    } else {
      checks.push(await checkSettlementsFile(dir, sheet));
    }
  }
  if ((await readText(join(dir, "session_balances.csv"))) !== null) {
    checks.push(await checkSessionsFile(dir, world.balances));
  }

  const handled = new Set([
    "scenario.json",
    "player_summary.csv",
    "settlements.csv",
    "session_balances.csv",
    ...scenario.steps.map((s) => s.log),
  ]);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && !handled.has(entry.name)) notCompared.push(`${entry.name} (not part of the ledger side)`);
  }

  const mismatchCount = checks.reduce((n, c) => n + c.mismatches.length, 0);
  return { name: scenario.name, checks, notCompared, mismatchCount };
}

function isStep(value: unknown): value is Step {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string" &&
    "log" in value &&
    typeof value.log === "string" &&
    "exit" in value &&
    typeof value.exit === "number" &&
    "args" in value &&
    Array.isArray(value.args) &&
    "menu" in value &&
    Array.isArray(value.menu)
  );
}

// Reads a scenario.json, checking the shape reference/run.sh writes. A damaged file fails
// here, named by its folder, rather than later with an unrelated TypeError.
function parseScenario(text: string, folder: string): ScenarioFile {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("tz" in value) ||
    typeof value.tz !== "string" ||
    !("steps" in value) ||
    !Array.isArray(value.steps) ||
    !value.steps.every(isStep)
  ) {
    throw new Error(`${folder}: scenario.json does not have the shape the reference writes`);
  }
  return { name: value.name, tz: value.tz, steps: value.steps };
}

// Recomputes and compares every scenario under <referenceDir>/scenarios with the data root.
export async function runParity(referenceDir: string, dataRoot: string): Promise<ParityReport> {
  const scenariosDir = join(referenceDir, "scenarios");
  const folders = (await readdir(scenariosDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const inputs = await loadDataRoot(dataRoot);
  if (inputs.games.length === 0) throw new Error("the data root has no .csv files in its game folder");
  const worlds = new Map<string, World>();
  const scenarios: ScenarioReport[] = [];
  for (const folder of folders) {
    const dir = join(scenariosDir, folder);
    const text = await readText(join(dir, "scenario.json"));
    if (text === null) continue;
    const scenario = parseScenario(text, folder);
    let base = worlds.get(scenario.tz);
    if (base === undefined) {
      base = buildWorld(inputs, scenario.tz);
      worlds.set(scenario.tz, base);
    }
    scenarios.push(await checkScenario(dir, scenario, base));
  }
  if (scenarios.length === 0) throw new Error(`no scenarios under ${scenariosDir}`);
  return {
    referenceDir,
    dataRoot,
    scenarios,
    mismatchCount: scenarios.reduce((n, s) => n + s.mismatchCount, 0),
  };
}

const MAX_SHOWN = 20;

// The terminal text of a report.
export function formatParityReport(report: ParityReport): string {
  const out: string[] = ["Parity with the C++ app", `  reference: ${report.referenceDir}`, `  data root: ${report.dataRoot}`];
  for (const s of report.scenarios) {
    out.push("", `scenario ${s.name}: ${s.mismatchCount === 0 ? "ok" : `${s.mismatchCount} mismatch(es)`}`);
    for (const c of s.checks) {
      const status = c.mismatches.length === 0 ? "ok      " : "MISMATCH";
      out.push(`  ${status} ${c.name}${c.detail === "" ? "" : ` (${c.detail})`}`);
      for (const m of c.mismatches.slice(0, MAX_SHOWN)) out.push(`      - ${m}`);
      if (c.mismatches.length > MAX_SHOWN) out.push(`      ... ${c.mismatches.length - MAX_SHOWN} more`);
    }
    for (const n of s.notCompared) out.push(`  not compared: ${n}`);
  }
  const checks = report.scenarios.reduce((n, s) => n + s.checks.length, 0);
  out.push(
    "",
    `${report.mismatchCount === 0 ? "PASS" : "FAIL"}: ${report.mismatchCount} mismatch(es) in ${report.scenarios.length} scenarios, ${checks} checks`,
  );
  return out.join("\n");
}

// ---------------- command line ----------------

const USAGE = "usage: node tools/parity.ts --reference <reference folder> --data <data root>";

async function main(argv: readonly string[]): Promise<number> {
  let reference = "";
  let data = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--reference") reference = argv[++i] ?? "";
    else if (argv[i] === "--data") data = argv[++i] ?? "";
    else {
      console.error(USAGE);
      return 2;
    }
  }
  if (reference === "" || data === "") {
    console.error(USAGE);
    return 2;
  }
  const report = await runParity(resolve(reference), resolve(data));
  console.log(formatParityReport(report));
  return report.mismatchCount === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    },
  );
}
