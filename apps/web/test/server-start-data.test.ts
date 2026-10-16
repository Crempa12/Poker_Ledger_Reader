// Starting a data folder for a group without the console app: where the site reads by default, when the
// page offers it, and where the server refuses it. Temporary folders only.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { handleData, handleStartData, type ApiConfig } from "../server/api.ts";
import { canStartDataRoot, defaultDataRoot } from "../server/dataroot.ts";

const PORT = 5173;
const WRITE = { host: `127.0.0.1:${PORT}`, "x-plr": "1", origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };

async function reply(run: (res: ServerResponse) => unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  let finish: (r: { status: number; json: Record<string, unknown> }) => void = () => undefined;
  const done = new Promise<{ status: number; json: Record<string, unknown> }>((resolve) => {
    finish = resolve;
  });
  const res = {
    statusCode: 0,
    setHeader() {},
    end(chunk?: string | Buffer) {
      finish({ status: this.statusCode, json: JSON.parse(String(chunk ?? "{}")) as Record<string, unknown> });
    },
  };
  await run(res as unknown as ServerResponse);
  return done;
}

function request(method: string, url: string, headers: Record<string, string>, remoteAddress = "127.0.0.1"): IncomingMessage {
  const req = Readable.from(method === "POST" ? [Buffer.from("{}")] : []);
  Object.assign(req, { method, url, headers, socket: { remoteAddress, localPort: PORT } });
  return req as unknown as IncomingMessage;
}

const config = (dataRoot: string): ApiConfig => ({ dataRoot, timeZone: "America/New_York", consoleProbe: async () => ({ open: 0 }) });
const start = (root: string, headers = WRITE, from = "127.0.0.1") =>
  reply((res) => handleStartData(config(root), request("POST", "/api/start-data", headers, from), res));

describe("the data folder the site reads", () => {
  it("is the console app's folder next to the project when there is one, else the project's own data folder", () => {
    const parent = mkdtempSync(join(tmpdir(), "plr-default-root-"));
    const project = join(parent, "Poker_Ledger_Web");
    mkdirSync(project);
    expect(defaultDataRoot(project)).toBe(join(project, "data"));
    mkdirSync(join(parent, "Poker_Ledger_Reader"));
    expect(defaultDataRoot(project)).toBe(join(parent, "Poker_Ledger_Reader"));
  });
});

describe("starting a data folder", () => {
  it("makes Games and Saved_Data in a folder that is not there yet, or is empty", async () => {
    const parent = mkdtempSync(join(tmpdir(), "plr-start-"));
    const missing = join(parent, "data");
    expect((await start(missing)).status).toBe(200);
    expect(readdirSync(missing).sort()).toEqual(["Games", "Saved_Data"]);

    const empty = join(parent, "empty");
    mkdirSync(empty);
    writeFileSync(join(empty, ".DS_Store"), "made by Finder");
    expect((await start(empty)).status).toBe(200);
    expect(existsSync(join(empty, "Games"))).toBe(true);
  });

  it("never takes over a folder with files in it, nor one that holds data already", async () => {
    const parent = mkdtempSync(join(tmpdir(), "plr-start-refuse-"));
    const busy = join(parent, "busy");
    mkdirSync(busy);
    writeFileSync(join(busy, "notes.txt"), "someone's notes");
    const r = await start(busy);
    expect(r.status).toBe(409);
    expect(String(r.json.error)).toContain("has other files in it");
    expect(readdirSync(busy)).toEqual(["notes.txt"]);
    expect(await canStartDataRoot(busy)).toBe(false);

    const ready = join(parent, "ready");
    mkdirSync(join(ready, "Saved_Data"), { recursive: true });
    expect((await start(ready)).status).toBe(409);
    expect(existsSync(join(ready, "Games"))).toBe(false);

    const file = join(parent, "a-file");
    writeFileSync(file, "x");
    expect((await start(file)).status).toBe(409);
  });

  it("is only for this page on this computer", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "plr-start-gate-")), "data");
    expect((await start(root, { ...WRITE, origin: "https://evil.example" })).status).toBe(403);
    expect((await start(root, { ...WRITE, host: `192.168.1.20:${PORT}` }, "192.168.1.30")).status).toBe(403);
    expect(existsSync(root)).toBe(false);
  });

  it("is offered by /api/data only where it may be done", async () => {
    const parent = mkdtempSync(join(tmpdir(), "plr-start-offer-"));
    const page = async (root: string) =>
      (await reply((res) => handleData(config(root), request("GET", "/api/data", { host: `127.0.0.1:${PORT}` }), res))).json;
    expect(await page(join(parent, "data"))).toMatchObject({ dataReady: false, canStartData: true });
    const busy = join(parent, "busy");
    mkdirSync(busy);
    writeFileSync(join(busy, "notes.txt"), "x");
    expect(await page(busy)).toMatchObject({ dataReady: false, canStartData: false });
    const ready = join(parent, "ready");
    mkdirSync(join(ready, "Games"), { recursive: true });
    expect(await page(ready)).toMatchObject({ dataReady: true, canStartData: false });
  });
});
