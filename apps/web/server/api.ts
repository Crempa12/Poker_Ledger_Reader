// The local server's API: read the console app's data folder, fetch a ledger from
// PokerNow, and file new game files into Games/<folder>/ the way the console app's
// "Import from Downloads" (menu 19) does. Node only.
//
// Writes are allowed only from this page on this computer (same-origin, custom
// header, loopback address), only for PokerNow file names, only inside Games/, and
// never over an existing file.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";

import { looksLikeLedger } from "../../../packages/core/src/ledger.ts";
import { isExcludedDir } from "../../../packages/core/src/util.ts";
import { loadDataRoot } from "../../../tools/load.ts";

export interface ApiConfig {
  dataRoot: string;
  timeZone: string;
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
  send(res, 200, { source: "local", dataRoot: cfg.dataRoot, timeZone: cfg.timeZone, loadedAt: Date.now(), ledgers, logs, saved: inputs.savedData, canWrite: isLoopback(req) });
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

export function apiMiddleware(cfg: ApiConfig) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = (req.url ?? "").split("?")[0];
    const route =
      req.method === "GET" && url === "/api/data"
        ? handleData(cfg, req, res)
        : req.method === "POST" && url === "/api/pokernow"
          ? handlePokerNow(req, res)
          : req.method === "POST" && url === "/api/save"
            ? handleSave(cfg, req, res)
            : null;
    if (route === null) {
      if (url?.startsWith("/api/") === true) send(res, 404, { error: "no such endpoint" });
      else next();
      return;
    }
    route.catch((err: unknown) => {
      // A body that is not JSON (or too big) is the caller's mistake, not the server's.
      const bad = err instanceof SyntaxError || (err instanceof Error && err.message === "file too large");
      send(res, bad ? 400 : 500, { error: err instanceof Error ? err.message : String(err) });
    });
  };
}
