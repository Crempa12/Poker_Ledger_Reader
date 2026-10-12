// Finding and parsing ledger CSV files, and the duplicate and overlap checks
// (port of src/ledger.hpp/.cpp, without printing).
//
// The caller passes the text of every candidate file (path relative to the data
// root, plus its text), so nothing here touches the disk. tools/load.ts reads
// the files from a data root.

import type { Game, LedgerRow, Scope } from "./models.ts";
import { scopeContains } from "./models.ts";
import {
  cleanStem,
  compareBytes,
  isExcludedDir,
  lower,
  moneySignedCents,
  parseCents,
  parseISO8601UTC,
  splitCSVLine,
  trim,
} from "./util.ts";

// One file under the data root. relativePath uses "/" between folders.
export interface LedgerInput {
  relativePath: string;
  text: string;
}

// A ledger that duplicates (or overlaps) another one.
export type DuplicateKind = "identical" | "same-id" | "overlap";

export interface DuplicateNote {
  kind: DuplicateKind;
  path: string; // the file in question (relative to the data root)
  folder: string;
  otherPath: string; // the file it matches
  otherFolder: string;
  sameFolder: boolean;
  skipped: boolean; // true = not counted in any total
  sharedRows: number; // for "overlap": sit-downs both files contain
}

export interface LoadResult {
  games: Game[]; // de-duplicated, sorted by start time, then id
  messages: string[]; // unreadable files, unbalanced ledgers
  duplicates: DuplicateNote[];
}

export type ParseResult = { ok: true; game: Game } | { ok: false; error: string };

// The last path element.
function fileNameOf(relativePath: string): string {
  const parts = relativePath.split("/");
  return parts[parts.length - 1] ?? relativePath;
}

// The extension as std::filesystem reports it: from the last dot, but a name
// that starts with the dot ("x.csv" has one, ".csv" does not).
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

// The name without its extension.
function stemOf(name: string): string {
  const ext = extensionOf(name);
  return ext === "" ? name : name.slice(0, name.length - ext.length);
}

// The folder a file is listed under: its folder relative to the data root, or
// "(root)" for a file directly in the root.
export function ledgerFolder(relativePath: string): string {
  const parts = relativePath.split("/");
  parts.pop();
  return parts.length === 0 ? "(root)" : parts.join("/");
}

// Is this file a candidate at all? A .csv whose folders are none of the excluded ones.
function isCandidatePath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  const name = parts.pop() ?? "";
  if (parts.some((folder) => isExcludedDir(folder))) return false;
  return lower(extensionOf(name)) === ".csv";
}

// The first line names a player_nickname column.
export function looksLikeLedger(text: string): boolean {
  const newline = text.indexOf("\n");
  const firstLine = newline === -1 ? text : text.slice(0, newline);
  return firstLine.includes("player_nickname");
}

// The order std::filesystem::path uses: element by element (each folder, then
// the file name), each element in byte order. So "a/x.csv" sorts before "a b/x.csv".
function comparePaths(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const c = compareBytes(pa[i] ?? "", pb[i] ?? "");
    if (c !== 0) return c;
  }
  if (pa.length === pb.length) return 0;
  return pa.length < pb.length ? -1 : 1;
}

// Every ledger among the files: a .csv outside the excluded folders whose first
// line has player_nickname. Sorted by path.
export function discoverLedgerFiles(files: LedgerInput[]): LedgerInput[] {
  return files
    .filter((f) => isCandidatePath(f.relativePath) && looksLikeLedger(f.text))
    .sort((a, b) => comparePaths(a.relativePath, b.relativePath));
}

// One sit-down = one (account, start time) pair. Two files that share one were
// exported from the same game.
function sitDownKey(row: LedgerRow): string {
  return row.playerId + "|" + (row.start === null ? "none" : String(row.start));
}

// Content fingerprint: every row's account, start, buy-in and net, sorted, so
// row order and file name do not matter.
function fingerprint(game: Game): string {
  const parts = game.rows.map((r) => `${sitDownKey(r)}|${r.buyInCents}|${r.netCents}`);
  parts.sort(compareBytes);
  return parts.map((p) => p + "\n").join("");
}

// Parses one ledger file. A seat with no start time and no money moved was never
// played, so it is counted in skippedRows and left out. Every other row is kept,
// whatever its name: dropping one unbalances the books.
export function parseLedgerFile(file: LedgerInput): ParseResult {
  const name = fileNameOf(file.relativePath);
  if (file.text === "") return { ok: false, error: `empty file ${name}` };

  const lines = file.text.split("\n");
  const col = new Map<string, number>();
  splitCSVLine(lines[0] ?? "").forEach((header, i) => col.set(trim(header), i));
  if (!col.has("player_nickname") || !col.has("net")) {
    return { ok: false, error: `missing player_nickname/net columns in ${name}` };
  }

  const cell = (row: string[], key: string): string => {
    const i = col.get(key);
    if (i === undefined || i >= row.length) return "";
    return row[i] ?? "";
  };

  // A second download "ledger_x (1).csv" is still ledger_x.
  const game: Game = {
    id: cleanStem(stemOf(name)),
    path: file.relativePath,
    folder: ledgerFolder(file.relativePath),
    start: null,
    end: null,
    totalBuyInCents: 0,
    skippedRows: 0,
    rows: [],
  };

  for (let k = 1; k < lines.length; k++) {
    const line = lines[k] ?? "";
    if (trim(line) === "") continue;
    const cells = splitCSVLine(line);

    const start = parseISO8601UTC(cell(cells, "session_start_at"));
    const end = parseISO8601UTC(cell(cells, "session_end_at"));
    const netCents = parseCents(cell(cells, "net"));
    if (start === null && netCents === 0) {
      game.skippedRows++;
      continue;
    }

    const row: LedgerRow = {
      nickname: trim(cell(cells, "player_nickname")),
      playerId: trim(cell(cells, "player_id")),
      start,
      end,
      buyInCents: parseCents(cell(cells, "buy_in")),
      buyOutCents: parseCents(cell(cells, "buy_out")),
      stackCents: parseCents(cell(cells, "stack")),
      netCents,
      owner: "",
      ownerReviewed: false,
    };

    game.totalBuyInCents += row.buyInCents;
    if (start !== null && (game.start === null || start < game.start)) game.start = start;
    const last = end !== null ? end : start;
    if (last !== null && (game.end === null || last > game.end)) game.end = last;
    game.rows.push(row);
  }

  if (game.rows.length === 0) {
    return {
      ok: false,
      error:
        (game.skippedRows > 0 ? "only never-played seats (no start time, $0 net) in " : "no player rows in ") + name,
    };
  }
  return { ok: true, game };
}

// The "more complete" export has more sit-downs, or the same count with a later last cash-out.
function moreComplete(a: Game, b: Game): boolean {
  if (a.rows.length !== b.rows.length) return a.rows.length > b.rows.length;
  return (a.end ?? -1) > (b.end ?? -1);
}

// Loads every ledger among the files. The rules, in order:
//   identical content (any file name, any folder)  -> later copy skipped
//   same ledger id, different content              -> the less complete export skipped
//   different ids that share sit-down rows         -> both kept, flagged as "overlap"
// Then the games are sorted by start time (no start first), then by id.
export function loadAllGames(files: LedgerInput[]): LoadResult {
  const result: LoadResult = { games: [], messages: [], duplicates: [] };

  const parsed: Game[] = []; // every parsed ledger, in path order
  for (const file of discoverLedgerFiles(files)) {
    const r = parseLedgerFile(file);
    if (r.ok) parsed.push(r.game);
    else result.messages.push("Skipped: " + r.error);
  }

  const at = (k: number): Game => parsed[k] as Game;
  const n = parsed.length;
  const fps = parsed.map(fingerprint);
  const sitDowns = parsed.map((g) => new Set(g.rows.map(sitDownKey)));
  const kept: boolean[] = parsed.map(() => false);
  const keptById = new Map<string, number>(); // ledger id -> index of the kept file

  const note = (kind: DuplicateKind, idx: number, otherIdx: number, skipped: boolean, shared: number): void => {
    const a = at(idx);
    const b = at(otherIdx);
    result.duplicates.push({
      kind,
      path: a.path,
      folder: a.folder,
      otherPath: b.path,
      otherFolder: b.folder,
      sameFolder: a.folder === b.folder,
      skipped,
      sharedRows: shared,
    });
  };

  // Among candidate matches, the one in the same folder if there is one.
  const pickMatch = (idx: number, matches: number[]): number => {
    const folder = at(idx).folder;
    for (const m of matches) if (at(m).folder === folder) return m;
    return matches[0] ?? idx;
  };

  for (let i = 0; i < n; i++) {
    const current = at(i);

    // 1. Identical content to any earlier file (kept or not).
    const same: number[] = [];
    for (let j = 0; j < i; j++) if (fps[j] === fps[i]) same.push(j);
    if (same.length > 0) {
      note("identical", i, pickMatch(i, same), true, current.rows.length);
      continue;
    }

    // 2. Same ledger id as a kept file but different content: keep the fuller export.
    const k = keptById.get(current.id);
    if (k !== undefined) {
      if (moreComplete(current, at(k))) {
        note("same-id", k, i, true, 0);
        kept[k] = false;
        kept[i] = true;
        keptById.set(current.id, i);
      } else {
        note("same-id", i, k, true, 0);
      }
      continue;
    }

    // 3. Different id but shares sit-downs with an earlier file: probably the same game.
    const overlapping: number[] = [];
    let bestShared = 0;
    for (let j = 0; j < i; j++) {
      if (at(j).id === current.id) continue;
      let shared = 0;
      for (const key of sitDowns[i] ?? []) if (sitDowns[j]?.has(key)) shared++;
      if (shared > 0) {
        overlapping.push(j);
        bestShared = Math.max(bestShared, shared);
      }
    }
    if (overlapping.length > 0) note("overlap", i, pickMatch(i, overlapping), false, bestShared);

    kept[i] = true;
    keptById.set(current.id, i);
  }

  const games: Game[] = [];
  for (let i = 0; i < n; i++) if (kept[i]) games.push(at(i));

  // Poker is zero-sum: every game's nets must add up to $0.00. PokerNow's own
  // files always do, so a gap means a damaged or hand-edited ledger, and every
  // total built on it is off.
  for (const g of games) {
    const sum = g.rows.reduce((acc, r) => acc + r.netCents, 0);
    if (sum !== 0) {
      result.messages.push(
        `WARNING: ${fileNameOf(g.path)} does not balance: its nets sum to ${moneySignedCents(sum)} instead of $0.00.`,
      );
    }
  }

  games.sort((a, b) => {
    const sa = a.start ?? -1;
    const sb = b.start ?? -1;
    if (sa !== sb) return sa < sb ? -1 : 1;
    return compareBytes(a.id, b.id);
  });
  result.games = games;
  return result;
}

// Every folder that has games, sorted.
export function listFolders(games: Game[]): string[] {
  return [...new Set(games.map((g) => g.folder))].sort(compareBytes);
}

// The games that match the folder and date-range scope, in the order given.
export function filterGames(games: Game[], scope: Scope): Game[] {
  return games.filter((g) => scopeContains(scope, g.folder, g.start));
}

// The id its hand log is filed under: "ledger_pglX" -> "pglX".
export function logId(game: Game): string {
  return game.id.startsWith("ledger_") ? game.id.slice(7) : game.id;
}

export const DUPLICATE_CHECK_TITLE = "Duplicate ledger check";
export const NO_DUPLICATES_MESSAGE = "No duplicate or overlapping ledgers found.";

// One entry of the duplicate check, as data: the text the console app prints.
export interface DuplicateEntry {
  number: number; // 1-based, in the order the notes were made
  headline: string;
  skipped: boolean; // false = kept
  path: string;
  matchPath: string;
  hint: string | null; // the advice for an overlap, else null
}

function headlineOf(d: DuplicateNote): string {
  const where = d.sameFolder ? " in the same folder" : " across folders";
  if (d.kind === "identical") return "IDENTICAL CONTENT" + where;
  if (d.kind === "same-id") {
    return "SAME LEDGER ID, DIFFERENT CONTENT" + where + " (probably an earlier export of the same game)";
  }
  const sits = d.sharedRows === 1 ? "sit-down" : "sit-downs";
  return `OVERLAP: ${d.sharedRows} ${sits} also appear in another ledger with a different id${where}`;
}

export function describeDuplicates(notes: DuplicateNote[]): DuplicateEntry[] {
  return notes.map((d, i) => ({
    number: i + 1,
    headline: headlineOf(d),
    skipped: d.skipped,
    path: d.path,
    matchPath: d.otherPath,
    hint:
      d.kind === "overlap"
        ? "Both files are still counted. If they are the same game, delete the older export."
        : null,
  }));
}
