// Starting a data folder for a group without the console app: where the site reads by default, when the
// page offers it, and where the server refuses it. Temporary folders only.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { dataBasis, handleData, handleSave, handleStartData, type ApiConfig } from "../server/api.ts";
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

// startable: the site's own data/ folder or one PLR_DATA_ROOT names (vite.config.ts), as in most tests here.
const config = (dataRoot: string, startable = true): ApiConfig => ({
  dataRoot,
  timeZone: "America/New_York",
  consoleProbe: async () => ({ open: 0 }),
  startable,
});
const start = (root: string, headers = WRITE, from = "127.0.0.1", startable = true) =>
  reply((res) => handleStartData(config(root, startable), request("POST", "/api/start-data", headers, from), res));

describe("the data folder the site reads", () => {
  it("is the console app's folder next to the project when there is one, else the project's own data folder", () => {
    const parent = mkdtempSync(join(tmpdir(), "plr-default-root-"));
    const project = join(parent, "Poker_Ledger_Web");
    mkdirSync(project);
    expect(defaultDataRoot(project)).toBe(join(project, "data"));
    mkdirSync(join(parent, "Poker_Ledger_Reader"));
    expect(defaultDataRoot(project)).toBe(join(parent, "Poker_Ledger_Reader"));
  });

  it("is the console app's path even when that is a link to a drive that is not there", () => {
    const parent = mkdtempSync(join(tmpdir(), "plr-default-link-"));
    const project = join(parent, "Poker_Ledger_Web");
    mkdirSync(project);
    try {
      symlinkSync(join(parent, "unplugged-drive", "Poker_Ledger_Reader"), join(parent, "Poker_Ledger_Reader"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return; // Windows without Developer Mode makes no links
      throw err;
    }
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

  it("never starts one in the console app's folder, even when it is missing for a while", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "plr-start-console-")), "Poker_Ledger_Reader");
    const r = await start(root, WRITE, "127.0.0.1", false);
    expect(r.status).toBe(409);
    expect(String(r.json.error)).toContain("console app's folder");
    expect(existsSync(root)).toBe(false);
  });

  it("makes no folder above the one named, and offers nothing it cannot do", async () => {
    const parent = mkdtempSync(join(tmpdir(), "plr-start-deep-"));
    const deep = join(parent, "mistyped", "Poker", "data");
    expect(await canStartDataRoot(deep)).toBe(false);
    expect((await start(deep)).status).toBe(409);
    expect(existsSync(join(parent, "mistyped"))).toBe(false);
    const file = join(parent, "a-file");
    writeFileSync(file, "x");
    expect(await canStartDataRoot(join(file, "data"))).toBe(false); // the folder it would go in is a file
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
    const consoleFolder = join(parent, "Poker_Ledger_Reader");
    const offered = (await reply((res) => handleData(config(consoleFolder, false), request("GET", "/api/data", { host: `127.0.0.1:${PORT}` }), res))).json;
    expect(offered).toMatchObject({ dataReady: false, canStartData: false });
    const busy = join(parent, "busy");
    mkdirSync(busy);
    writeFileSync(join(busy, "notes.txt"), "x");
    expect(await page(busy)).toMatchObject({ dataReady: false, canStartData: false });
    const ready = join(parent, "ready");
    mkdirSync(join(ready, "Games"), { recursive: true });
    expect(await page(ready)).toMatchObject({ dataReady: true, canStartData: false });
  });
});

describe("filing a game into a folder that is already there", () => {
  async function save(root: string, folder: string, id: string) {
    const body = JSON.stringify({ fileName: `poker_now_log_${id}.csv`, folder, text: "entry,at,order\n", basis: await dataBasis(root) });
    const req = Readable.from([Buffer.from(body)]);
    Object.assign(req, { method: "POST", url: "/api/save", headers: WRITE, socket: { remoteAddress: "127.0.0.1", localPort: PORT } });
    return reply((res) => handleSave(config(root), req as unknown as IncomingMessage, res));
  }

  it("takes an existing folder as it is, even one a new folder could not be called", async () => {
    const root = mkdtempSync(join(tmpdir(), "plr-existing-folder-"));
    mkdirSync(join(root, "Games", "Week 1 "), { recursive: true }); // a space at its end
    mkdirSync(join(root, "Games", "Week 1"), { recursive: true });
    mkdirSync(join(root, "Games", "Is it on?"), { recursive: true });
    const a = await save(root, "Week 1 ", "pglMadeUpExisting01");
    expect(a.status).toBe(200);
    expect(existsSync(join(root, "Games", "Week 1 ", "poker_now_log_pglMadeUpExisting01.csv"))).toBe(true);
    expect(readdirSync(join(root, "Games", "Week 1"))).toEqual([]); // not the look-alike
    if (process.platform !== "win32") {
      expect((await save(root, "Is it on?", "pglMadeUpExisting02")).status).toBe(200);
    }
    // A new name still has to pass the rules.
    expect((await save(root, "New?", "pglMadeUpExisting03")).status).toBe(400);
  });

  it("does not take a skipped folder, or one only like an existing name in case", async () => {
    const root = mkdtempSync(join(tmpdir(), "plr-existing-skipped-"));
    mkdirSync(join(root, "Games", "reports"), { recursive: true });
    expect((await save(root, "reports", "pglMadeUpExisting04")).status).toBe(400);
    expect((await save(root, "Reports", "pglMadeUpExisting05")).status).toBe(400);
    expect(readdirSync(join(root, "Games", "reports"))).toEqual([]);
  });

  it("points a group with no data folder yet to Start a new data folder", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "plr-not-started-")), "data");
    const r = await save(root, "Nov", "pglMadeUpExisting06");
    expect(r.status).toBe(409);
    expect(String(r.json.error)).toContain("Start a new data folder on the Overview");
  });
});
