// The local server's API: read the console app's data folder, fetch a ledger from
// PokerNow, file new game files into Games/<folder>/ the way the console app's
// "Import from Downloads" (menu 19) does, and rewrite a Saved_Data file (merge rules,
// saved sheets, seat owners ...) the way the console app's menus do. Node only.
//
// Changes come only from this page on this computer: a loopback connection, a Host name
// that is this computer's on this server's port, the page's own Origin (every browser
// sends one with a change), a custom header a plain form cannot send, and no proxy in
// front (writeAllowed). Reads need a Host that names an address (not a DNS name), the
// same origin when one is sent, and no proxy (readAllowed), so a page on another site,
// or a DNS name pointed at this computer, gets nothing. These are headers a browser
// sets; a program running on this computer could send them too (it could also edit
// the files directly), so they keep out other sites, phones and HTTP proxies, not local
// programs. "No proxy" is known only from the headers a proxy adds: a raw TCP tunnel
// to this port (ngrok tcp, ssh -R) adds none, and its peers look like this computer.
// The README says not to run one.
//
// Game files: only PokerNow file names, only inside Games/, never over an existing file, never a
// ledger or hand log that is already filed in any folder, and only over the data the page was built
// from (the basis), in a data folder that is the console app's.
// Saved_Data files: only the six the app keeps, only text the app itself would write (in the line
// ends and byte order mark the file already has), only over the version the page was showing and the
// game data it was built from (the basis), never while the console app is open, one save at a time
// (also across two servers on one folder, by a lock file). The old version is kept first, in a folder
// of local/backups/ for that data folder (the newest 50 of each file). A file whose bytes are not
// valid UTF-8 is never rewritten, since that would change bytes the page cannot show.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, type Dirent } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

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
import { SAVED_DATA_FILES, loadDataRoot } from "../../../tools/load.ts";
import { dataRootReady, notADataFolder } from "./dataroot.ts";
import { SNAPSHOT_NAME, SNAPSHOTS, savedForPage } from "./snapshot.ts";
import { handLogCache, parseHandScope, type HandLogCache } from "./handlogs.ts";

export interface ApiConfig {
  dataRoot: string;
  timeZone: string;
  consoleCheck?: boolean; // false only for a test server on a scratch copy (see vite.config.ts)
  consoleProbe?: () => Promise<ConsoleCheck>; // how the console app is looked for; default: probeConsoleApps
  backupDir?: string; // where old Saved_Data versions go; default: the web project's local/backups/
  snapshotDir?: string; // where snapshot files go; default: the web project's local/snapshots/
  downloadsDir?: string; // where the browser saves downloads; default: Downloads in the home folder (as menu 19)
  lockWaitMs?: number; // how long a save waits for another save's lock file; default: LOCK_WAIT_MS
  handLogs?: HandLogCache; // where the hand-log results are kept; default: the process's one (handlogs.ts)
}

// What the console app check found: how many of its windows are open (0 when this
// computer has no way to look at the processes), or unknown, with why the check failed.
export type ConsoleCheck = { open: number } | { unknown: string };

const GAME_ID = /pgl[A-Za-z0-9_-]{10,40}/;
// PokerNow's names, with an optional browser copy suffix such as " (1)".
// The extension in any case, as menu 19 takes it (it lower-cases the extension); the kind stays lower case.
const FILE_NAME = /^(ledger|poker_now_log)_(pgl[A-Za-z0-9_-]{10,40})(?: \(\d+\))?\.[cC][sS][vV]$/;
const MAX_BYTES = 25 * 1024 * 1024;
const CONSOLE_CHECK_MS = 5_000;
const KEEP_BACKUPS = 50; // old versions kept per Saved_Data file
// A save takes an exclusive lock file in Saved_Data, so two servers on one folder take
// turns. A lock left by a process that died is taken over after LOCK_STALE_MS.
const LOCK_FILE = ".web-save.lock";
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
// PokerNow's answer for one ledger: how long it may take, and how much it may send.
const POKERNOW_LIMITS = { timeoutMs: 20_000, maxBytes: MAX_BYTES };

const NOT_YOURS = "only this page on this computer can do that";
const STALE =
  "Something changed since this page loaded (a game was added, or a saved file changed). Press Refresh and do it again.";

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

// The Host header split into its name and port: "name", "name:port", "[v6]" or "[v6]:port".
function hostParts(req: IncomingMessage): { name: string; port: string | null } | null {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^[\]:]+)(?::(\d{1,5}))?$/.exec(req.headers.host ?? "");
  return m === null ? null : { name: (m[1] ?? "").toLowerCase(), port: m[2] ?? null };
}

const THIS_COMPUTER = new Set(["127.0.0.1", "localhost", "[::1]"]);

// The Host names this computer, and a port that is this server's (when one is given).
function namesThisServer(req: IncomingMessage): boolean {
  const h = hostParts(req);
  if (h === null || !THIS_COMPUTER.has(h.name)) return false;
  const local = req.socket.localPort;
  return h.port === null || local === undefined || Number(h.port) === local;
}

// The Host names an address rather than a DNS name: this computer, or an IP address
// (a phone on the Wi-Fi in PLR_LAN mode). A DNS name a hostile page points at this
// computer (DNS rebinding) is refused.
function namesAnAddress(req: IncomingMessage): boolean {
  const h = hostParts(req);
  if (h === null) return false;
  return THIS_COMPUTER.has(h.name) || isIP(h.name.replace(/^\[(.*)\]$/, "$1")) !== 0;
}

// The Origin header is this same server and no other. A browser sends it with every change,
// so a change without one is refused; a read without one (a plain page load) is allowed.
function isOwnOrigin(req: IncomingMessage): boolean {
  return req.headers.origin === `http://${req.headers.host ?? ""}`;
}

// A browser that says where a request came from must say it came from this site.
function fromThisSite(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

// Headers a proxy or tunnel adds (tailscale serve, Cloudflare, ngrok, a reverse proxy):
// then the request came from someone else, however it looks on this computer.
const PROXY_HEADER = /^(x-forwarded-|cf-|tailscale-)|^(forwarded|x-real-ip|true-client-ip)$/;
function throughProxy(req: IncomingMessage): boolean {
  return Object.keys(req.headers).some((h) => PROXY_HEADER.test(h) && req.headers[h] !== undefined);
}

// Reads: a Host that names an address, the same origin when one is sent, no proxy.
function readAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin === undefined || isOwnOrigin(req);
  return namesAnAddress(req) && origin && fromThisSite(req) && !throughProxy(req);
}

// Changes: this computer's connection and name, the custom header a plain form or
// another site's script cannot send without asking first, the page's own Origin, no proxy.
function writeAllowed(req: IncomingMessage): boolean {
  return (
    isLoopback(req) &&
    req.headers["x-plr"] === "1" &&
    namesThisServer(req) &&
    isOwnOrigin(req) &&
    fromThisSite(req) &&
    !throughProxy(req)
  );
}

// The page shows its write buttons only to this computer.
function canWriteHere(req: IncomingMessage): boolean {
  return isLoopback(req) && namesThisServer(req) && !throughProxy(req);
}

// The JSON body as an object. Anything else reads as an empty object, which each route refuses.
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BYTES) throw new Error("file too large");
    chunks.push(b);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function gamesDir(dataRoot: string): string {
  const g = join(dataRoot, "Games");
  return existsSync(g) ? g : dataRoot;
}


// The folder inside the backups folder that holds one data folder's old versions: a short code made
// from its full path. Data folders that share a backups folder (a test copy, say) then never count,
// or remove, each other's versions.
export function backupFolderOf(backupsRoot: string, dataRoot: string): string {
  return join(backupsRoot, createHash("sha256").update(resolve(dataRoot)).digest("hex").slice(0, 12));
}

// The text a file is written with: CRLF where the file has CRLF (the console writes its files as
// text, so on Windows they do), and the byte order mark the file starts with, if it has one. A new
// file (nothing before it) is LF with no mark.
function likeBefore(before: string, text: string): string {
  const body = before.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
  return (before.startsWith("\uFEFF") ? "\uFEFF" : "") + body;
}

// A folder name the user typed or picked: one plain name, nothing that climbs out.
// The names Windows keeps for devices, with or without an extension: a folder cannot be called that there.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;

// A folder under Games: one name, or a few joined by "/" for a folder inside a folder ("Nov/Week 1"), as
// the console app reads them and menu 19 files into them. Each name is checked on its own: not empty, not
// starting with a dot, not ending in a dot or space (Windows drops those, so "Games." would be "Games"),
// none of the characters Windows refuses in a name, not a Windows device name, and not a folder the console
// app skips, in any case (a Mac's and Windows' usual file systems ignore case, so "saved_data" would be the
// Saved_Data folder, where the console app never reads a game).
export function safeFolder(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const parts = name.trim().split("/");
  if (parts.length > 4) return null;
  for (const part of parts) {
    if (part === "" || part.length > 60 || part !== part.trim() || part.startsWith(".") || part.endsWith(".")) return null;
    if (/[\\:<>"|?*\u0000-\u001f]/.test(part) || WINDOWS_DEVICE.test(part)) return null;
    const lower = part.toLowerCase();
    if (isExcludedDir(part) || isExcludedDir(lower) || lower === "saved_data") return null;
  }
  return parts.join("/");
}

// Calls visit for every .csv under dir, with its path relative to dir ("/" separators) and its
// full path, walked the way tools/load.ts walks them (excluded folders skipped, symlinked folders not
// entered). Nothing is read here.
async function eachGameCsv(dir: string, visit: (relativePath: string, full: string) => Promise<void>, prefix = ""): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      const target = await stat(full).catch(() => null);
      isDirectory = target?.isDirectory() ?? false;
      isFile = target?.isFile() ?? false;
      if (isDirectory) continue; // symlinked folders are not entered
    }
    if (isDirectory) {
      if (!isExcludedDir(entry.name)) await eachGameCsv(full, visit, relativePath);
    } else if (isFile && /\.csv$/i.test(entry.name)) {
      await visit(relativePath, full);
    }
  }
}

// The game files as "path, size, time" lines. The contents are not read: the hand logs are large.
async function statGames(dir: string, out: string[]): Promise<void> {
  await eachGameCsv(dir, async (relativePath, full) => {
    const s = await stat(full).catch(() => null);
    if (s !== null) out.push(JSON.stringify([relativePath, s.size, s.mtimeMs]));
  });
}

// The relative path of every game file, for the check that a game is not filed twice.
async function gameFileNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  await eachGameCsv(dir, async (relativePath) => {
    names.push(relativePath);
  });
  return names;
}

// Whether a game file (its relative path) is the same kind of file for the same game: a ledger or a
// hand log with this id, a browser copy's " (1)" included. The console checks the two kinds apart too.
function isSameGameFile(path: string, kind: string, id: string): boolean {
  const m = /^(ledger|poker_now_log)_(pgl[A-Za-z0-9_-]{10,40})(?: \(\d+\))?\.csv$/i.exec(path.split("/").pop() ?? "");
  return m !== null && m[1]?.toLowerCase() === kind && m[2] === id;
}

// What the page was built from, as one short text: the game files' paths, sizes and times,
// and the hash of each of the six Saved_Data files the app keeps (a file that is missing
// counts as missing). It changes when a game file is added, removed or changed, or one of
// those six is. Other files in Saved_Data (a .DS_Store, say) do not count. The server works
// it out again on every save and refuses a save whose basis is not the same.
export async function dataBasis(dataRoot: string): Promise<string> {
  return (await basisParts(dataRoot)).basis;
}

// The three Saved_Data files the hand-log results read: merge_rules.csv (names), seat_owners.csv
// (whose seat each game's money was) and adjustments.csv (the money in the stats). Nothing else in
// Saved_Data reaches them (checked against packages/core: the hand-log results read no settings,
// pinned payments or session balances).
const HAND_LOG_SAVED = ["merge_rules.csv", "seat_owners.csv", "adjustments.csv"] as const;

// The whole basis, and the part of it the hand-log results depend on (the games and HAND_LOG_SAVED).
// A save of any other Saved_Data file changes the whole basis and not the second part, so the hand
// logs are not read again for it (server/handlogs.ts keys its results by the second part).
export async function basisParts(dataRoot: string): Promise<{ basis: string; handLogs: string }> {
  const games: string[] = [];
  await statGames(gamesDir(dataRoot), games);
  games.sort();
  const savedDir = join(dataRoot, "Saved_Data");
  const digests = new Map<string, string | null>();
  for (const name of SAVED_DATA_FILES) {
    const bytes = await readFile(join(savedDir, name)).catch(() => null);
    digests.set(name, bytes === null ? null : createHash("sha256").update(bytes).digest("hex"));
  }
  const over = (saved: readonly string[]): string => {
    const hash = createHash("sha256");
    hash.update(JSON.stringify(["games-folder", gamesDir(dataRoot) !== dataRoot]) + "\n");
    for (const g of games) hash.update(g + "\n");
    for (const name of saved) hash.update(JSON.stringify(["saved", name, digests.get(name) ?? null]) + "\n");
    return hash.digest("hex");
  };
  return { basis: over(SAVED_DATA_FILES), handLogs: over(HAND_LOG_SAVED) };
}

export async function handleData(cfg: ApiConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!readAllowed(req)) return send(res, 403, { error: "this page may not read the data from here" });
  // The basis is worked out before the data is read: a change in between then makes the
  // next save refuse, and can never let a save through against data the page does not hold.
  const basis = await dataBasis(cfg.dataRoot);
  // The hand logs' text is not read here: the page gets their names only (below).
  const inputs = await loadDataRoot(cfg.dataRoot, { handLogText: false });
  // Hand logs are large and not used by the pages yet; only ledgers go to the page,
  // plus the names of the logs so the page can tell which games have one.
  const ledgers = inputs.games.filter((g) => looksLikeLedger(g.text));
  const logs = inputs.games.filter((g) => /(^|\/)poker_now_log_[^/]*\.csv$/i.test(g.relativePath)).map((g) => g.relativePath);
  const check = await consoleCheckForPage(cfg);
  const canWrite = canWriteHere(req);
  send(res, 200, {
    source: "local",
    // The full path (it holds the computer's user name) only to this computer; a phone on
    // the Wi-Fi gets the folder's name, as a snapshot does.
    dataRoot: canWrite ? cfg.dataRoot : basename(cfg.dataRoot),
    timeZone: cfg.timeZone,
    loadedAt: Date.now(),
    ledgers,
    logs,
    saved: savedForPage(inputs.savedData),
    canWrite,
    consoleOpen: "open" in check ? check.open : -1,
    // Whether the data has a Games folder: a new game is filed there, or at the top of the data folder.
    gamesFolder: existsSync(join(cfg.dataRoot, "Games")),
    basis,
  });
}

// GET /api/handlogs?folder=&from=&to=: the hand-log results for one scope (handlogs.ts). It is
// read the way /api/data is read: this computer, a phone on the Wi-Fi, never through a proxy.
export async function handleHandLogs(cfg: ApiConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!readAllowed(req)) return send(res, 403, { error: "this page may not read the data from here" });
  const url = req.url ?? "";
  const at = url.indexOf("?");
  const parsed = parseHandScope(at === -1 ? "" : url.slice(at + 1));
  if ("error" in parsed) return send(res, 400, { error: parsed.error });
  const cache = cfg.handLogs ?? handLogCache;
  // The basis is worked out before the hand logs are read, and again after. When the data changed
  // in between, the answer is worked out again under the new basis, so the basis an answer carries
  // always names the data it holds. The results are kept under the hand-log part of the basis (only
  // the data they read), and the answer names the whole basis.
  let parts = await basisParts(cfg.dataRoot);
  for (let attempt = 1; ; attempt++) {
    const payload = await cache.payloadFor(cfg.dataRoot, cfg.timeZone, parts.handLogs, parsed.scope);
    const after = await basisParts(cfg.dataRoot);
    if (after.basis === parts.basis) return sendLarge(req, res, 200, { ...payload, basis: parts.basis });
    if (attempt === 3) return send(res, 503, { error: "the data changed while the hand logs were read; try again" });
    parts = after;
  }
}

// The console app keeps its own copy of Saved_Data: it reads the files once at startup
// and writes every one of them again when it quits (menu 0) and after several menus. A
// change made here while it is open would be undone, so saving waits until it is closed.
export type ConsoleRunner = (file: string, args: string[]) => Promise<string>;

function runCommand(file: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile(file, args, { timeout: CONSOLE_CHECK_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      err === null ? done(stdout) : fail(err),
    );
  });
}

// Whether the console app is open. The process is named after its CMake target. A
// missing ps (or tasklist) means nothing can be seen on this computer, so nothing counts
// as open. Any other failure, or a check that takes longer than CONSOLE_CHECK_MS, is
// unknown, and a save then waits for a clear answer.
export async function probeConsoleApps(
  platform: NodeJS.Platform = process.platform,
  run: ConsoleRunner = runCommand,
): Promise<ConsoleCheck> {
  const windows = platform === "win32";
  try {
    const out = windows ? await run("tasklist", ["/FO", "CSV", "/NH"]) : await run("ps", ["-axo", "comm="]);
    return { open: windows ? countTasklistApps(out) : countConsoleApps(out) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean };
    if (e.code === "ENOENT") return { open: 0 };
    if (e.killed === true) return { unknown: `the check took longer than ${CONSOLE_CHECK_MS / 1000} seconds` };
    const why = (err instanceof Error ? err.message : String(err)).split("\n")[0]?.trim() ?? "";
    return { unknown: why === "" ? "the check failed" : why };
  }
}

async function consoleCheckOf(cfg: ApiConfig): Promise<ConsoleCheck> {
  if (cfg.consoleCheck === false) return { open: 0 };
  return (cfg.consoleProbe ?? probeConsoleApps)();
}

// The page's own check is kept for a few seconds: a page load, a Refresh and the refresh after a save
// each ask, and each one lists the computer's processes. A save never uses this (it checks at once).
const PAGE_CHECK_MS = 5_000;
const pageChecks = new WeakMap<ApiConfig, { at: number; check: ConsoleCheck }>();

async function consoleCheckForPage(cfg: ApiConfig): Promise<ConsoleCheck> {
  const kept = pageChecks.get(cfg);
  if (kept !== undefined && Date.now() - kept.at < PAGE_CHECK_MS) return kept.check;
  const check = await consoleCheckOf(cfg);
  pageChecks.set(cfg, { at: Date.now(), check });
  return check;
}

// Whether an Accept-Encoding header takes gzip: listed as gzip or x-gzip, without q=0 (which says no).
export function acceptsGzip(header: string): boolean {
  return header.split(",").some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(";");
    if (coding?.trim() !== "gzip" && coding?.trim() !== "x-gzip") return false;
    const q = params.map((x) => x.trim()).find((x) => x.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

// A large answer goes out gzipped when the browser takes gzip (the hand-log results repeat their text,
// and are about five times smaller that way). Any other browser gets the same JSON as send() gives.
function sendLarge(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  if (!acceptsGzip(String(req.headers["accept-encoding"] ?? ""))) return send(res, status, body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Encoding", "gzip");
  res.setHeader("Vary", "Accept-Encoding");
  res.setHeader("Cache-Control", "no-store");
  res.end(gzipSync(JSON.stringify(body)));
}

// The console app windows in `ps -axo comm=` output: one executable path per line. Linux
// cuts a command name to 15 characters, so "Poker_Ledger_Re" counts too.
export function countConsoleApps(psOutput: string): number {
  return psOutput.split("\n").filter((line) => /(^|[/\\])(Poker_Ledger_Reader(\.exe)?|Poker_Ledger_Re)$/i.test(line.trim())).length;
}

// The console app windows in `tasklist /FO CSV /NH` output: the image name is the first field.
export function countTasklistApps(output: string): number {
  return output.split("\n").filter((line) => /^"Poker_Ledger_Reader\.exe"/i.test(line.trim())).length;
}

// The Saved_Data files the page may rewrite, each with its reader and writer. New text is
// accepted only when reading it and writing it again gives the same bytes: then it is
// exactly what the console app would have written. A file the console wrote itself (a
// "unknown" date, a status word it keeps) passes; a row the reader would drop does not.
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

// Every save in this server runs one after another, whatever file it writes. The basis
// check, the backup and the write then run in order, so two saves that read the same
// version cannot both pass the check, even for different files. Another server on the same
// folder is held off by the lock file (acquireSaveLock).
let saveQueue: Promise<void> = Promise.resolve();

function inSaveQueue(job: () => Promise<void>): Promise<void> {
  const run = saveQueue.then(job);
  saveQueue = run.catch(() => undefined);
  return run;
}

// Takes the folder's lock file (created with wx, so only one process can hold it). It waits
// up to waitMs for a lock that is held, and takes over one that is older than LOCK_STALE_MS
// (a process that died holding it). Returns how to let go, or null when the wait ran out.
async function acquireSaveLock(dir: string, waitMs: number): Promise<(() => Promise<void>) | null> {
  const lock = join(dir, LOCK_FILE);
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      await writeFile(lock, `${process.pid}\n`, { flag: "wx" });
      return async () => {
        // A lock that cannot be removed is logged, not thrown: the save's own answer is what counts. Windows
        // can hold a file just made (a virus scanner, the indexer), so the remove is tried a few times
        // (Node retries only with recursive set, which a single file does not mind).
        await rm(lock, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }).catch((err: unknown) =>
          console.error("could not remove the save lock:", err),
        );
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    // A lock older than LOCK_STALE_MS was left by a save that never finished. Two servers that both find
    // the same old lock at once could both take it over; that needs two sites on one data folder and a
    // crashed save, and the basis check still refuses the second of two saves made from the same data.
    const made = (await stat(lock).catch(() => null))?.mtimeMs;
    if (made !== undefined && Math.abs(Date.now() - made) > LOCK_STALE_MS) {
      await rm(lock, { force: true });
      continue;
    }
    if (Date.now() >= until) return null;
    await new Promise((done) => setTimeout(done, 50));
  }
}

// The backups of one Saved_Data file, oldest first. A backup's name starts with the time
// it was kept, in a form whose text sorts in date order.
async function backupNames(dir: string, file: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[]))
    .filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n) && n.endsWith(`_${file}`))
    .sort();
}

// The time a backup's name starts with, in milliseconds (-Infinity when it has none).
function stampMs(name: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  if (m === null) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

// The name a new backup starts with: now, or a millisecond after the newest backup of this
// file. So a new backup always sorts last, even when the computer's clock was moved back
// after older backups were made (otherwise the newest backup would be the first pruned).
async function newBackupStamp(dir: string, file: string): Promise<string> {
  const newest = Math.max(Number.NEGATIVE_INFINITY, ...(await backupNames(dir, file)).map(stampMs));
  return new Date(Math.max(Date.now(), newest + 1)).toISOString().replace(/[:.]/g, "-");
}

// Keeps the newest KEEP_BACKUPS versions of one Saved_Data file. The backup this save made
// (keep) is never removed, so the path the save reports always exists.
async function pruneBackups(dir: string, file: string, keep: string): Promise<void> {
  const others = (await backupNames(dir, file)).filter((n) => n !== basename(keep));
  for (const old of others.slice(0, Math.max(0, others.length - (KEEP_BACKUPS - 1)))) {
    await rm(join(dir, old), { force: true }).catch((err: unknown) => console.error(`could not remove an old backup: ${old}`, err));
  }
}

// Saved_Data text is read as UTF-8 and must be valid: bytes that are not are never decoded
// to replacement characters and written back. A byte order mark is kept, as Node's own reader
// keeps it, so the page's text and the file's text are the same.
const SAVED_TEXT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Rewrites one Saved_Data file with text the page worked out with @plr/core.
export async function handleSavedFile(cfg: ApiConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!writeAllowed(req)) return send(res, 403, { error: NOT_YOURS });
  const body = await readBody(req);
  const file = typeof body.file === "string" && Object.hasOwn(SAVED_FILES, body.file) ? body.file : "";
  const roundTrip = SAVED_FILES[file];
  if (roundTrip === undefined) return send(res, 400, { error: "only the console app's Saved_Data files can be saved here" });
  if (typeof body.before !== "string" || typeof body.text !== "string" || body.text === "") {
    return send(res, 400, { error: "the new file text is missing" });
  }
  const before = body.before;
  const text = body.text;
  if (roundTrip(text, cfg.timeZone, () => undefined) !== text) {
    return send(res, 400, { error: `that is not text the console app would write for ${file} (a row would be dropped or changed)` });
  }

  const backups = backupFolderOf(cfg.backupDir ?? BACKUPS, cfg.dataRoot);
  const dir = join(cfg.dataRoot, "Saved_Data");
  const target = join(dir, file);
  await inSaveQueue(async () => {
    if (!(await dataRootReady(cfg.dataRoot))) return send(res, 409, { error: notADataFolder(cfg.dataRoot) });
    await mkdir(dir, { recursive: true });
    const unlock = await acquireSaveLock(dir, cfg.lockWaitMs ?? LOCK_WAIT_MS);
    if (unlock === null) {
      return send(res, 423, {
        error:
          "Another save to the console app's data folder is still running, or its lock file (Saved_Data/.web-save.lock) " +
          "was not removed. Try again in a moment; a lock left behind is taken over after a minute.",
      });
    }
    try {
      if (typeof body.basis !== "string" || body.basis !== (await dataBasis(cfg.dataRoot))) {
        return send(res, 409, { error: STALE });
      }
      const check = await consoleCheckOf(cfg);
      if ("unknown" in check) {
        return send(res, 423, {
          error: `Could not tell whether the console app is open (${check.unknown}). Try again in a moment.`,
          consoleOpen: -1,
        });
      }
      if (check.open > 0) {
        return send(res, 423, {
          error:
            `The console app is open (${check.open === 1 ? "1 window" : `${check.open} windows`}). Quit it first (0. Save and exit): ` +
            "when it quits it writes its own copy of this file, which would undo this change.",
          consoleOpen: check.open,
        });
      }
      const bytes = existsSync(target) ? await readFile(target) : null;
      let current = "";
      if (bytes !== null) {
        try {
          current = SAVED_TEXT.decode(bytes);
        } catch {
          return send(res, 409, {
            error: `${file} is not plain UTF-8 text, so this site will not rewrite it (that would change bytes it cannot show). Fix the file by hand, then press Refresh.`,
          });
        }
      }
      if (current !== before) {
        return send(res, 409, { error: `${file} changed since this page read it. Press Refresh and do it again.` });
      }
      // The text in the file's own line ends and byte order mark (see likeBefore).
      const out = likeBefore(current, text);
      if (current === out) return send(res, 200, { saved: file, backup: null });
      // The old version is kept byte for byte, before anything is written.
      let backup: string | null = null;
      if (bytes !== null && current !== "") {
        await mkdir(backups, { recursive: true });
        backup = join(backups, `${await newBackupStamp(backups, file)}-${randomUUID().slice(0, 8)}_${file}`);
        await writeFile(backup, bytes, { flag: "wx" });
      }
      // Written next to the file under a random name, then renamed over it: a crash never
      // leaves half a file, and two writers never share a temporary file.
      const temp = `${target}.${randomUUID()}.web-tmp`;
      let step = "write";
      try {
        await writeFile(temp, out, "utf8");
        step = "replace";
        await rename(temp, target);
      } catch (err) {
        // The file is as it was, so the copy made for this save is not needed.
        await rm(temp, { force: true }).catch(() => undefined);
        if (backup !== null) await rm(backup, { force: true }).catch(() => undefined);
        console.error(`could not write ${file}:`, err);
        // On Windows a file another program has open (Excel, most often) cannot be replaced.
        const code = (err as NodeJS.ErrnoException).code ?? "";
        const inUse = step === "replace" && (code === "EPERM" || code === "EBUSY" || code === "EACCES");
        return send(res, 500, {
          error: inUse
            ? `${file} is open in another program (Excel?), so it could not be replaced and nothing changed. Close it there, then try again.`
            : `${file} could not be written, so nothing changed. Check that the Saved_Data folder can be written to, then try again.`,
        });
      }
      if (backup !== null) await pruneBackups(backups, file, backup);
      send(res, 200, { saved: file, backup });
    } finally {
      await unlock();
    }
  });
}

// Fetches one game's ledger from PokerNow by its link or id. PokerNow serves the
// ledger without a login; the hand log needs a captcha, so it is never fetched here.
export async function handlePokerNow(
  req: IncomingMessage,
  res: ServerResponse,
  limits: { timeoutMs: number; maxBytes: number } = POKERNOW_LIMITS,
): Promise<void> {
  if (!writeAllowed(req)) return send(res, 403, { error: NOT_YOURS });
  const body = await readBody(req);
  const id = typeof body.link === "string" ? GAME_ID.exec(body.link)?.[0] : undefined;
  if (id === undefined) return send(res, 400, { error: "that does not look like a PokerNow game link" });
  const url = `https://${POKERNOW_HOST}/games/${id}/ledger_${id}.csv`;
  let r: Response;
  try {
    r = await fetchFromPokerNow(url, {
      headers: { "User-Agent": "Mozilla/5.0 (poker ledger reader)" },
      signal: AbortSignal.timeout(limits.timeoutMs),
    });
  } catch {
    return send(res, 502, { error: "PokerNow did not answer for that game (or sent it somewhere else). Try again in a moment." });
  }
  if (!r.ok) return send(res, 502, { error: `PokerNow answered ${r.status} for that game` });
  let text: string | null;
  try {
    text = await readCapped(r, limits.maxBytes);
  } catch {
    return send(res, 502, { error: "PokerNow stopped sending that game. Try again in a moment." });
  }
  if (text === null) return send(res, 502, { error: "PokerNow sent more for that game than the site will take" });
  if (!looksLikeLedger(text)) return send(res, 502, { error: "PokerNow did not send a ledger for that game" });
  send(res, 200, { gameId: id, fileName: `ledger_${id}.csv`, text });
}

// PokerNow's own address: the only place a ledger is read from.
const POKERNOW_HOST = "www.pokernow.com";

// Fetches a PokerNow address. A redirect is followed only when it leads to PokerNow's own
// address (https), and only a few times; any other redirect is an error.
async function fetchFromPokerNow(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<Response> {
  let next = url;
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetch(next, { ...init, redirect: "manual" });
    const location = r.headers.get("location");
    if (r.status < 300 || r.status >= 400 || location === null) return r;
    await r.body?.cancel().catch(() => undefined);
    const target = new URL(location, next);
    if (target.protocol !== "https:" || target.hostname !== POKERNOW_HOST) throw new Error("PokerNow redirected somewhere else");
    next = target.href;
  }
  throw new Error("PokerNow redirected too many times");
}

// The body of a response as text, or null when it is over the limit (the rest is not read).
async function readCapped(r: Response, limit: number): Promise<string | null> {
  if (r.body === null) return "";
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

// Files one PokerNow file into Games/<folder>/, like menu 19: the browser copy suffix
// is dropped from the name, and an existing file is left alone.
export async function handleSave(cfg: ApiConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!writeAllowed(req)) return send(res, 403, { error: NOT_YOURS });
  const body = await readBody(req);
  const m = typeof body.fileName === "string" ? FILE_NAME.exec(body.fileName) : null;
  const folder = safeFolder(body.folder);
  if (m === null) return send(res, 400, { error: "only PokerNow ledger_… or poker_now_log_… files can be saved" });
  if (folder === null) {
    return send(res, 400, {
      error: 'pick another folder name: no dot at its start or end, none of \\ : < > " | ? *, and not a name Windows keeps (CON, NUL ...) or Saved_Data',
    });
  }
  const text = typeof body.text === "string" ? body.text : "";
  if (text.length === 0) return send(res, 400, { error: "the file is empty" });
  const [, kind = "", id = ""] = m;
  if (kind === "ledger" && !looksLikeLedger(text)) return send(res, 400, { error: "that file is not a PokerNow ledger" });
  if (kind === "poker_now_log" && !text.startsWith("entry,at,order")) {
    return send(res, 400, { error: "that file is not a PokerNow hand log" });
  }

  // A folder named Games here, in a data folder with no Games folder yet, would become the folder the
  // games are read from (and hide the games at the root). So it is refused until there is a Games folder.
  if ((folder.split("/")[0] ?? "").toLowerCase() === "games" && !existsSync(join(cfg.dataRoot, "Games"))) {
    return send(res, 400, { error: "this data has no Games folder, so a folder cannot be named Games here: pick another name" });
  }
  // Like the Saved_Data saves: one at a time, after the data folder and the page's basis are checked.
  await inSaveQueue(async () => {
    if (!(await dataRootReady(cfg.dataRoot))) return send(res, 409, { error: notADataFolder(cfg.dataRoot) });
    if (typeof body.basis !== "string" || body.basis !== (await dataBasis(cfg.dataRoot))) {
      return send(res, 409, { error: STALE });
    }
    const base = resolve(gamesDir(cfg.dataRoot));
    const dir = resolve(base, folder);
    if (!dir.startsWith(base + sep)) return send(res, 400, { error: "that folder is outside Games/" });
    const target = join(dir, `${kind}_${id}.csv`);
    const relative = `${folder}/${kind}_${id}.csv`;
    if (existsSync(target)) return send(res, 409, { error: "that file is already there", path: relative });
    // The same game is not filed twice, in any folder (menu 19 refuses it too).
    const filed = (await gameFileNames(base)).find((path) => isSameGameFile(path, kind, id));
    if (filed !== undefined) return send(res, 409, { error: `that game is already filed (in ${filed})`, path: filed });
    await mkdir(dir, { recursive: true });
    // wx: a file that appeared since the checks above (a second import of the same game at
    // once) is never written over, and is reported the same way.
    try {
      await writeFile(target, text, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return send(res, 409, { error: "that file is already there", path: relative });
      }
      throw err;
    }
    // The new basis goes back, so the page can file the next game of the batch without a reload.
    send(res, 200, { saved: relative, basis: await dataBasis(cfg.dataRoot) });
  });
}

const SNAPSHOT_SCRIPT = fileURLToPath(new URL("./snapshot.ts", import.meta.url));

// Makes a snapshot file of the data as it is now (server/snapshot.ts). It is built in
// a process of its own, in production mode: the dev server's own settings (a
// development build of React, among them) must not reach the file people are sent.
export async function handleSnapshot(cfg: ApiConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!writeAllowed(req)) return send(res, 403, { error: NOT_YOURS });
  // A snapshot of a folder that is not the console app's would be a page with no games in it.
  if (!(await dataRootReady(cfg.dataRoot))) return send(res, 409, { error: notADataFolder(cfg.dataRoot) });
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PLR_DATA_ROOT: cfg.dataRoot,
    PLR_TZ: cfg.timeZone,
    PLR_SNAPSHOT_DIR: cfg.snapshotDir ?? SNAPSHOTS,
  };
  let out: string;
  try {
    out = await new Promise<string>((done, fail) => {
      execFile(process.execPath, [SNAPSHOT_SCRIPT, "--json"], { env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
        err !== null ? fail(new Error(`could not make the snapshot: ${(stderr || err.message).trim().split("\n").pop() ?? ""}`)) : done(stdout),
      );
    });
  } catch (err) {
    // The build's last message says what went wrong, so it is the one detail the page shows.
    console.error(err);
    return send(res, 500, { error: err instanceof Error ? err.message : "could not make the snapshot" });
  }
  const r = JSON.parse(out.trim().split("\n").pop() ?? "{}") as { name: string; bytes: number; games: number; file: string };
  send(res, 200, { name: r.name, bytes: r.bytes, games: r.games, file: r.file });
}

// Hands a snapshot file to the browser as a download, to this computer only. The name
// arrives as the URL has it and is decoded here, where a bad encoding can be answered.
export async function handleSnapshotFile(cfg: ApiConfig, req: IncomingMessage, res: ServerResponse, encodedName: string): Promise<void> {
  if (!isLoopback(req) || !readAllowed(req)) return send(res, 403, { error: "only this computer can do that" });
  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    return send(res, 400, { error: "that snapshot name is not valid" });
  }
  if (!SNAPSHOT_NAME.test(name)) return send(res, 404, { error: "no such snapshot" });
  const file = join(cfg.snapshotDir ?? SNAPSHOTS, name);
  if (!existsSync(file)) return send(res, 404, { error: "no such snapshot" });
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Cache-Control", "no-store");
  res.end(await readFile(file));
}

// ---- the Downloads folder (menu 19) ------------------------------------------------------------

// The folder the browser saves downloads in, found as menu 19 finds it: Downloads in the home folder.
function downloadsDir(cfg: ApiConfig): string {
  return cfg.downloadsDir ?? join(homedir(), "Downloads");
}

// Only this page, on this computer, looks in the Downloads folder: not another site (the custom header
// needs a preflight the server never answers), and not a phone on the Wi-Fi in phone mode.
function fromThisComputer(req: IncomingMessage): boolean {
  return isLoopback(req) && namesThisServer(req) && req.headers["x-plr"] === "1" && readAllowed(req);
}

export interface DownloadedFile {
  name: string; // as it is in Downloads, with a browser copy suffix if it has one ("ledger_pglX (1).csv")
  kind: "ledger" | "poker_now_log";
  gameId: string;
  bytes: number;
  modified: number; // ms since the epoch
}

// GET /api/downloads: the PokerNow files at the top of the Downloads folder (where menu 19 looks), newest
// first. Names and sizes only; a file's text is read when the page asks for that file. Nothing in Downloads
// is moved or changed: the page files a copy through /api/save, with that save's checks.
export async function handleDownloads(cfg: ApiConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!fromThisComputer(req)) return send(res, 403, { error: NOT_YOURS });
  const dir = downloadsDir(cfg);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    // No Downloads folder is nothing to say. One the site may not open is: on a Mac, the app that runs
    // the site (Terminal) needs leave to read Downloads.
    if (code === "ENOENT" || code === "ENOTDIR") return send(res, 200, { found: false, files: [] });
    console.error("[plr] could not read the Downloads folder:", err);
    return send(res, 200, { found: false, files: [], unreadable: code || "error" });
  }
  const files: DownloadedFile[] = [];
  for (const e of entries) {
    // A link is not followed (isFile is false for one), so only a file really in Downloads is offered.
    if (!e.isFile()) continue;
    const m = FILE_NAME.exec(e.name);
    if (m === null) continue;
    const kind = m[1] as DownloadedFile["kind"];
    const full = join(dir, e.name);
    const s = await stat(full).catch(() => null);
    // An empty or cut-off download, or another file under a PokerNow name, is left out, so it cannot
    // stand in for a good copy of the same game.
    if (s === null || s.size === 0 || !(await looksLikeItsKind(full, kind))) continue;
    files.push({ name: e.name, kind, gameId: m[2] ?? "", bytes: s.size, modified: s.mtimeMs });
  }
  files.sort((a, b) => b.modified - a.modified || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // The folder's own path is not sent: the page does not need it.
  send(res, 200, { found: true, files });
}

// Whether a file starts the way its kind does, from its first bytes: a ledger's header names
// player_nickname, a hand log's is entry,at,order (the checks /api/save makes on the whole text).
async function looksLikeItsKind(file: string, kind: DownloadedFile["kind"]): Promise<boolean> {
  let head: string;
  try {
    const h = await open(file, "r");
    try {
      const buf = Buffer.alloc(1024);
      const { bytesRead } = await h.read(buf, 0, buf.length, 0);
      head = new TextDecoder().decode(buf.subarray(0, bytesRead));
    } finally {
      await h.close();
    }
  } catch {
    return false;
  }
  return kind === "ledger" ? looksLikeLedger(head) : head.startsWith("entry,at,order");
}

// GET /api/downloads/<name>: one of those files' text, read the way a browser reads a picked file
// (UTF-8, a byte order mark dropped). Only a PokerNow file name is taken, so no other file is reachable.
export async function handleDownloadedFile(cfg: ApiConfig, req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> {
  if (!fromThisComputer(req)) return send(res, 403, { error: NOT_YOURS });
  const name = decodeURIComponent(raw);
  if (FILE_NAME.exec(name) === null) return send(res, 400, { error: "only PokerNow ledger_… or poker_now_log_… files are read" });
  const file = join(downloadsDir(cfg), name);
  const s = await lstat(file).catch(() => null);
  if (s === null || !s.isFile()) return send(res, 404, { error: `${name} is no longer in the Downloads folder` });
  if (s.size > MAX_BYTES) return send(res, 400, { error: "file too large" });
  sendLarge(req, res, 200, { name, text: new TextDecoder().decode(await readFile(file)) });
}

export function apiMiddleware(cfg: ApiConfig) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    const snapshotFile = req.method === "GET" ? /^\/api\/snapshot\/([^/]+)$/.exec(url)?.[1] : undefined;
    const downloaded = req.method === "GET" ? /^\/api\/downloads\/([^/]+)$/.exec(url)?.[1] : undefined;
    const route =
      req.method === "GET" && url === "/api/data"
        ? handleData(cfg, req, res)
        : req.method === "GET" && url === "/api/handlogs"
          ? handleHandLogs(cfg, req, res)
        : req.method === "GET" && url === "/api/downloads"
          ? handleDownloads(cfg, req, res)
        : downloaded !== undefined
          ? handleDownloadedFile(cfg, req, res, downloaded)
        : req.method === "POST" && url === "/api/pokernow"
          ? handlePokerNow(req, res)
          : req.method === "POST" && url === "/api/save"
            ? handleSave(cfg, req, res)
            : req.method === "POST" && url === "/api/saved-file"
              ? handleSavedFile(cfg, req, res)
              : req.method === "POST" && url === "/api/snapshot"
                ? handleSnapshot(cfg, req, res)
                : snapshotFile !== undefined
                  ? handleSnapshotFile(cfg, req, res, snapshotFile)
                  : null;
    if (route === null) {
      if (url?.startsWith("/api/") === true) send(res, 404, { error: "no such endpoint" });
      else next();
      return;
    }
    route.catch((err: unknown) => {
      // A body that is not JSON (or too big) is the caller's mistake, not the server's.
      if (err instanceof SyntaxError || err instanceof URIError || (err instanceof Error && err.message === "file too large")) {
        return send(res, 400, { error: err.message });
      }
      // Anything else is the server's own failure. Its detail can hold a path on this
      // computer, so it goes to the terminal that runs the site, and the page gets a short line.
      console.error("[plr] request failed:", err);
      send(res, 500, { error: "The site could not finish that. The details are in the terminal that runs it." });
    });
  };
}
