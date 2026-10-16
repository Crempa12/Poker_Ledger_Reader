// The Downloads folder routes (+ Add game, like menu 19): which files are listed, who may ask, and
// what a file read gives. Made-up files in temporary folders only; the real Downloads folder is never read.
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { handleDownloadedFile, handleDownloads, type ApiConfig } from "../server/api.ts";

const PORT = 5173;
const LEDGER = "player_nickname,player_id,session_start_at,session_end_at,buy_in,buy_out,stack,net\n";
const LOG = "entry,at,order\n";
const ID_A = "pglMadeUpDownloadA1";
const ID_B = "pglMadeUpDownloadB2";

interface Reply {
  status: number;
  json: { [k: string]: unknown };
}

async function reply(run: (res: ServerResponse) => unknown): Promise<Reply> {
  let finish: (r: Reply) => void = () => undefined;
  const done = new Promise<Reply>((resolve) => {
    finish = resolve;
  });
  const res = {
    statusCode: 0,
    setHeader() {},
    end(chunk?: string | Buffer) {
      finish({ status: this.statusCode, json: JSON.parse(String(chunk ?? "{}")) as Reply["json"] });
    },
  };
  await run(res as unknown as ServerResponse);
  return done;
}

// The page's own request: from this computer, to this server, with the custom header.
const PAGE = { host: `127.0.0.1:${PORT}`, "x-plr": "1" };

function request(url: string, headers: Record<string, string> = PAGE, remoteAddress = "127.0.0.1"): IncomingMessage {
  const req = Readable.from([]);
  Object.assign(req, { method: "GET", url, headers, socket: { remoteAddress, localPort: PORT } });
  return req as unknown as IncomingMessage;
}

// A made-up Downloads folder: two PokerNow files (one a second copy), other files, a folder and a link.
function downloads(): string {
  const dir = mkdtempSync(join(tmpdir(), "plr-downloads-"));
  writeFileSync(join(dir, `ledger_${ID_A}.csv`), LEDGER);
  writeFileSync(join(dir, `poker_now_log_${ID_B} (1).csv`), `﻿${LOG}`);
  writeFileSync(join(dir, "report.csv"), "a,b\n");
  writeFileSync(join(dir, `ledger_${ID_B}.txt`), LEDGER);
  mkdirSync(join(dir, `ledger_${ID_B}.csv`)); // a folder with a PokerNow name
  const outside = mkdtempSync(join(tmpdir(), "plr-downloads-outside-"));
  writeFileSync(join(outside, "secret.csv"), "not for the page\n");
  symlinkSync(join(outside, "secret.csv"), join(dir, `poker_now_log_${ID_A}.csv`));
  // The log is the newer download.
  utimesSync(join(dir, `ledger_${ID_A}.csv`), new Date(2030, 0, 1), new Date(2030, 0, 1));
  utimesSync(join(dir, `poker_now_log_${ID_B} (1).csv`), new Date(2030, 0, 2), new Date(2030, 0, 2));
  return dir;
}

function config(downloadsDir: string): ApiConfig {
  return { dataRoot: tmpdir(), timeZone: "America/New_York", downloadsDir };
}

describe("the Downloads folder routes", () => {
  it("list only the PokerNow files at the top of the folder, newest first, not following a link", async () => {
    const r = await reply((res) => handleDownloads(config(downloads()), request("/api/downloads"), res));
    expect(r.status).toBe(200);
    expect(r.json.found).toBe(true);
    const files = r.json.files as { name: string; kind: string; gameId: string }[];
    expect(files.map((f) => [f.name, f.kind, f.gameId])).toEqual([
      [`poker_now_log_${ID_B} (1).csv`, "poker_now_log", ID_B],
      [`ledger_${ID_A}.csv`, "ledger", ID_A],
    ]);
  });

  it("say when there is no Downloads folder", async () => {
    const r = await reply((res) => handleDownloads(config(join(tmpdir(), "plr-no-such-downloads")), request("/api/downloads"), res));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ found: false, files: [] });
  });

  it("answer only this page on this computer", async () => {
    const cfg = config(downloads());
    const status = async (req: IncomingMessage) => (await reply((res) => handleDownloads(cfg, req, res))).status;
    expect(await status(request("/api/downloads"))).toBe(200);
    expect(await status(request("/api/downloads", { host: `127.0.0.1:${PORT}` }))).toBe(403); // no custom header
    expect(await status(request("/api/downloads", { ...PAGE, host: `192.168.1.20:${PORT}` }, "192.168.1.30"))).toBe(403); // a phone
    expect(await status(request("/api/downloads", { ...PAGE, host: `evil.example:${PORT}` }))).toBe(403);
    expect(await status(request("/api/downloads", { ...PAGE, "x-forwarded-for": "203.0.113.9" }))).toBe(403);
    expect(await status(request("/api/downloads", { ...PAGE, "sec-fetch-site": "cross-site" }))).toBe(403);
    expect(await status(request("/api/downloads", { ...PAGE, origin: "https://evil.example" }))).toBe(403);
    const file = async (req: IncomingMessage) => (await reply((res) => handleDownloadedFile(cfg, req, res, `ledger_${ID_A}.csv`))).status;
    expect(await file(request(`/api/downloads/ledger_${ID_A}.csv`))).toBe(200);
    expect(await file(request(`/api/downloads/ledger_${ID_A}.csv`, { ...PAGE, host: `192.168.1.20:${PORT}` }, "192.168.1.30"))).toBe(403);
  });

  it("read a file as a picked file reads (UTF-8, the byte order mark dropped)", async () => {
    const cfg = config(downloads());
    const name = `poker_now_log_${ID_B} (1).csv`;
    const r = await reply((res) => handleDownloadedFile(cfg, request(`/api/downloads/${encodeURIComponent(name)}`), res, encodeURIComponent(name)));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ name, text: LOG });
  });

  it("read no other file: not another name, not a folder, not through a link", async () => {
    const cfg = config(downloads());
    const status = async (raw: string) => (await reply((res) => handleDownloadedFile(cfg, request(`/api/downloads/${raw}`), res, raw))).status;
    expect(await status("report.csv")).toBe(400);
    expect(await status(encodeURIComponent("../report.csv"))).toBe(400);
    expect(await status(encodeURIComponent(`ledger_${ID_A}.csv/../report.csv`))).toBe(400);
    expect(await status(`ledger_${ID_B}.csv`)).toBe(404); // the folder
    expect(await status(`poker_now_log_${ID_A}.csv`)).toBe(404); // the link
    expect(await status(`ledger_pglMadeUpNotThere99.csv`)).toBe(404);
  });
});
