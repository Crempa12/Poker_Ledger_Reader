// The local server's API: read the console app's data folder, fetch a ledger from
// PokerNow, file new game files into Games/<folder>/ the way the console app's
// "Import from Downloads" (menu 19) does, and rewrite a Saved_Data file (merge rules,
// saved sheets, seat owners ...) the way the console app's menus do. Node only.
//
// Writes are allowed only from this page on this computer (same-origin, custom
// header, loopback address). Game files: only PokerNow file names, only inside Games/,
// never over an existing file. Saved_Data files: only the six the app keeps, only text
// the app itself would write, only over the version the page was showing, never while
// the console app is open, and the old version is kept in local/backups/ first.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { WarnFn } from "../../../packages/core/src/models.ts";
import { parseAdjustments, serializeAdjustments } from "../../../packages/core/src/adjustments.ts";
import { looksLikeLedger } from "../../../packages/core/src/ledger.ts";
import { parseMergeRulesCSV, serializeMergeRulesCSV } from "../../../packages/core/src/players.ts";
import { parseSeatOwnersCSV, serializeSeatOwnersCSV } from "../../../packages/core/src/seats.ts";
import { parseSessionBalances, serializeSessionBalances } from "../../../packages/core/src/sessions.ts";
import {
  parsePreferencesCSV,
  parseSettingsCSV,
  serializePreferencesCSV,
  serializeSettingsCSV,
} from "../../../packages/core/src/settlement.ts";
import { isExcludedDir } from "../../../packages/core/src/util.ts";
import { loadDataRoot } from "../../../tools/load.ts";
import { SNAPSHOT_NAME, SNAPSHOTS } from "./snapshot.ts";

export interface ApiConfig {
  dataRoot: string;
  timeZone: string;
  consoleCheck?: boolean; // false only for a test server on a scratch copy (see vite.config.ts)
  backupDir?: string; // where old Saved_Data versions go; default: the web project's local/backups/
  snapshotDir?: string; // where snapshot files go; default: the web project's local/snapshots/
}

const GAME_ID = /pgl[A-Za-z0-9_-]{10,40}/;
// PokerNow's names, with an optional browser copy suffix such as " (1)".
const FILE_NAME = /^(ledger|poker_now_log)_(pgl[A-Za-z0-9_-]{10,40})(?: \(\d+\))?\.csv$/;
const MAX_BYTES = 25 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

// Only this page may write: same origin as the server, and a header a plain form or
// another site's script cannot send without the browser asking first.
function writeAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  const origin = req.headers.origin ?? "";
  return isLoopback(req) && req.headers["x-plr"] === "1" && (origin === `http://${host}` || origin === "");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BYTES) throw new Error("file too large");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function gamesDir(dataRoot: string): string {
  const g = join(dataRoot, "Games");
  return existsSync(g) ? g : dataRoot;
}

// A folder name the user typed or picked: one plain name, nothing that climbs out.
function safeFolder(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const n = name.trim();
  if (n === "" || n.length > 60 || n.startsWith(".") || /[/\\:]/.test(n) || n.includes("..") || isExcludedDir(n)) return null;
  return n;
}

export async function handleData(cfg: ApiConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const inputs = await loadDataRoot(cfg.dataRoot);
  // Hand logs are large and not used by the pages yet; only ledgers go to the page,
  // plus the names of the logs so the page can tell which games have one.
  const ledgers = inputs.games.filter((g) => looksLikeLedger(g.text));
  const logs = inputs.games.filter((g) => /(^|\/)poker_now_log_[^/]*\.csv$/i.test(g.relativePath)).map((g) => g.relativePath);
  const consoleOpen = cfg.consoleCheck === false ? 0 : await consoleAppsOpen();
  send(res, 200, { source: "local", dataRoot: cfg.dataRoot, timeZone: cfg.timeZone, loadedAt: Date.now(), ledgers, logs, saved: inputs.savedData, canWrite: isLoopback(req), consoleOpen });
}

// The console app reads Saved_Data once at startup, keeps its own copy, and writes
// every one of these files again when it quits (menu 0) and after several menus. A
// change made here while it is open would be undone, so saving waits until it is
// closed. Its process is named after the CMake target (CLion's run and the terminal
// alike). Where ps is missing (Windows) this finds none.
function consoleAppsOpen(): Promise<number> {
  return new Promise((done) => {
    execFile("ps", ["-axo", "comm="], { timeout: 3000 }, (err, stdout) => done(err !== null ? 0 : countConsoleApps(stdout)));
  });
}

// The console app windows in `ps -axo comm=` output: one executable path per line.
export function countConsoleApps(psOutput: string): number {
  return psOutput.split("\n").filter((line) => /(^|[/\\])Poker_Ledger_Reader(\.exe)?$/i.test(line.trim())).length;
}

// The Saved_Data files the page may rewrite, each with its reader and writer. New
// text is accepted only when reading it and writing it again gives the same bytes
// with nothing dropped: then it is exactly what the console app would have written.
const SAVED_FILES: Record<string, (text: string, timeZone: string, warn: WarnFn) => string> = {
  "merge_rules.csv": (t, _tz, w) => serializeMergeRulesCSV(parseMergeRulesCSV(t, w)),
  "session_balances.csv": (t, _tz, w) => serializeSessionBalances(parseSessionBalances(t, w)),
  "payment_preferences.csv": (t, _tz, w) => serializePreferencesCSV(parsePreferencesCSV(t, w)),
  "settings.csv": (t) => serializeSettingsCSV(parseSettingsCSV(t, { me: "", banker: "", simpleDisplay: false })),
  "seat_owners.csv": (t, _tz, w) => serializeSeatOwnersCSV(parseSeatOwnersCSV(t, w)),
  "adjustments.csv": (t, tz, w) => serializeAdjustments(parseAdjustments(t, tz, w), tz),
};

// apps/web/server -> the web project's own local/ folder (gitignored).
const BACKUPS = fileURLToPath(new URL("../../../local/backups/", import.meta.url));

// Rewrites one Saved_Data file with text the page worked out with @plr/core.
export async function handleSavedFile(cfg: ApiConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!writeAllowed(req)) return send(res, 403, { error: "only this page on this computer can do that" });
  const body = (await readBody(req)) as { file?: unknown; before?: unknown; text?: unknown };
  const file = typeof body.file === "string" && Object.hasOwn(SAVED_FILES, body.file) ? body.file : "";
  const roundTrip = SAVED_FILES[file];
  if (roundTrip === undefined) return send(res, 400, { error: "only the console app's Saved_Data files can be saved here" });
  if (typeof body.before !== "string" || typeof body.text !== "string" || body.text === "") {
    return send(res, 400, { error: "the new file text is missing" });
  }
  let dropped = 0;
  if (roundTrip(body.text, cfg.timeZone, () => dropped++) !== body.text || dropped > 0) {
    return send(res, 400, { error: `that is not text the console app would write for ${file}` });
  }
  const open = cfg.consoleCheck === false ? 0 : await consoleAppsOpen();
  if (open > 0) {
    return send(res, 423, {
      error:
        `The console app is open (${open === 1 ? "1 window" : `${open} windows`}). Quit it first (0. Save and exit): ` +
        "when it quits it writes its own copy of this file, which would undo this change.",
      consoleOpen: open,
    });
  }

  const dir = join(cfg.dataRoot, "Saved_Data");
  const target = join(dir, file);
  const current = existsSync(target) ? await readFile(target, "utf8") : "";
  if (current !== body.before) {
    return send(res, 409, { error: `${file} changed since this page read it. Press Refresh and do it again.` });
  }
  if (current === body.text) return send(res, 200, { saved: file, backup: null });
  let backup: string | null = null;
  if (current !== "") {
    const backups = cfg.backupDir ?? BACKUPS;
    await mkdir(backups, { recursive: true });
    backup = join(backups, `${new Date().toISOString().replace(/[:.]/g, "-")}_${file}`);
    await writeFile(backup, current, { encoding: "utf8", flag: "wx" });
  }
  await mkdir(dir, { recursive: true });
  // Written next to the file, then renamed over it, so a crash never leaves half a file.
  const temp = `${target}.web-tmp`;
  await writeFile(temp, body.text, "utf8");
  await rename(temp, target);
  send(res, 200, { saved: file, backup });
}

// Fetches one game's ledger from PokerNow by its link or id. PokerNow serves the
// ledger without a login; the hand log needs a captcha, so it is never fetched here.
export async function handlePokerNow(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!writeAllowed(req)) return send(res, 403, { error: "only this page on this computer can do that" });
  const body = (await readBody(req)) as { link?: unknown };
  const id = typeof body.link === "string" ? GAME_ID.exec(body.link)?.[0] : undefined;
  if (id === undefined) return send(res, 400, { error: "that does not look like a PokerNow game link" });
  const url = `https://www.pokernow.com/games/${id}/ledger_${id}.csv`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (poker ledger reader)" }, redirect: "follow" });
  if (!r.ok) return send(res, 502, { error: `PokerNow answered ${r.status} for that game` });
  const text = await r.text();
  if (!looksLikeLedger(text)) return send(res, 502, { error: "PokerNow did not send a ledger for that game" });
  send(res, 200, { gameId: id, fileName: `ledger_${id}.csv`, text });
}

// Files one PokerNow file into Games/<folder>/, like menu 19: the browser copy suffix
// is dropped from the name, and an existing file is left alone.
export async function handleSave(cfg: ApiConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!writeAllowed(req)) return send(res, 403, { error: "only this page on this computer can do that" });
  const body = (await readBody(req)) as { fileName?: unknown; folder?: unknown; text?: unknown };
  const m = typeof body.fileName === "string" ? FILE_NAME.exec(body.fileName) : null;
  const folder = safeFolder(body.folder);
  if (m === null) return send(res, 400, { error: "only PokerNow ledger_… or poker_now_log_… files can be saved" });
  if (folder === null) return send(res, 400, { error: "pick a folder name without slashes or dots at the start" });
  if (typeof body.text !== "string" || body.text.length === 0) return send(res, 400, { error: "the file is empty" });
  const [, kind, id] = m;
  if (kind === "ledger" && !looksLikeLedger(body.text)) return send(res, 400, { error: "that file is not a PokerNow ledger" });
  if (kind === "poker_now_log" && !body.text.startsWith("entry,at,order")) return send(res, 400, { error: "that file is not a PokerNow hand log" });

  const base = resolve(gamesDir(cfg.dataRoot));
  const dir = resolve(base, folder);
  if (!dir.startsWith(base + sep)) return send(res, 400, { error: "that folder is outside Games/" });
  const target = join(dir, `${kind}_${id}.csv`);
  if (existsSync(target)) return send(res, 409, { error: "that file is already there", path: `${folder}/${kind}_${id}.csv` });
  await mkdir(dir, { recursive: true });
  await writeFile(target, body.text, { encoding: "utf8", flag: "wx" });
  send(res, 200, { saved: `${folder}/${kind}_${id}.csv` });
}

const SNAPSHOT_SCRIPT = fileURLToPath(new URL("./snapshot.ts", import.meta.url));

// Makes a snapshot file of the data as it is now (server/snapshot.ts). It is built in
// a process of its own, in production mode: the dev server's own settings (a
// development build of React, among them) must not reach the file people are sent.
export async function handleSnapshot(cfg: ApiConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!writeAllowed(req)) return send(res, 403, { error: "only this page on this computer can do that" });
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PLR_DATA_ROOT: cfg.dataRoot,
    PLR_TZ: cfg.timeZone,
    PLR_SNAPSHOT_DIR: cfg.snapshotDir ?? SNAPSHOTS,
  };
  const out = await new Promise<string>((done, fail) => {
    execFile(process.execPath, [SNAPSHOT_SCRIPT, "--json"], { env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      err !== null ? fail(new Error(`could not make the snapshot: ${(stderr || err.message).trim().split("\n").pop() ?? ""}`)) : done(stdout),
    );
  });
  const r = JSON.parse(out.trim().split("\n").pop() ?? "{}") as { name: string; bytes: number; games: number; file: string };
  send(res, 200, { name: r.name, bytes: r.bytes, games: r.games, file: r.file });
}

// Hands a snapshot file to the browser as a download, to this computer only.
export async function handleSnapshotFile(cfg: ApiConfig, req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
  if (!isLoopback(req)) return send(res, 403, { error: "only this computer can do that" });
  const file = join(cfg.snapshotDir ?? SNAPSHOTS, name);
  if (!SNAPSHOT_NAME.test(name) || !existsSync(file)) return send(res, 404, { error: "no such snapshot" });
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Cache-Control", "no-store");
  res.end(await readFile(file));
}

export function apiMiddleware(cfg: ApiConfig) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    const snapshotFile = req.method === "GET" ? /^\/api\/snapshot\/([^/]+)$/.exec(url)?.[1] : undefined;
    const route =
      req.method === "GET" && url === "/api/data"
        ? handleData(cfg, req, res)
        : req.method === "POST" && url === "/api/pokernow"
          ? handlePokerNow(req, res)
          : req.method === "POST" && url === "/api/save"
            ? handleSave(cfg, req, res)
            : req.method === "POST" && url === "/api/saved-file"
              ? handleSavedFile(cfg, req, res)
              : req.method === "POST" && url === "/api/snapshot"
                ? handleSnapshot(cfg, req, res)
                : snapshotFile !== undefined
                  ? handleSnapshotFile(cfg, req, res, decodeURIComponent(snapshotFile))
                  : null;
    if (route === null) {
      if (url?.startsWith("/api/") === true) send(res, 404, { error: "no such endpoint" });
      else next();
      return;
    }
    route.catch((err: unknown) => {
      // A body that is not JSON (or too big) is the caller's mistake, not the server's.
      const bad = err instanceof SyntaxError || err instanceof URIError || (err instanceof Error && err.message === "file too large");
      send(res, bad ? 400 : 500, { error: err instanceof Error ? err.message : String(err) });
    });
  };
}
