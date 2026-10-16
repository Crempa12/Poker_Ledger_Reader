// Adding a game (POST /api/save) and the data-root checks, on made-up data. A game is refused
// when the same ledger or hand log is already filed in any folder (menu 19 does the same), a save
// must carry the basis the page was built from, a folder named Games is refused when the data has
// no Games folder, and nothing is made when the data folder is not the console app's.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { dataBasis, handleSave, handleSavedFile, type ApiConfig } from "../server/api.ts";

const PORT = 5173;
const LEDGER = "player_nickname,player_id,session_start_at\nDella,pgl0000000001,2026-10-01 20:00:00\n";
const HAND_LOG = "entry,at,order,message\n";
const ID = "pglAAAAAAAAAAAA";

function make(url: string, body: unknown, headers: Record<string, string | undefined>): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method: "POST",
    url,
    headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "x-plr": "1", ...headers },
    socket: { remoteAddress: "127.0.0.1", localPort: PORT },
  });
  return req as unknown as IncomingMessage;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function reply(handle: (res: ServerResponse) => Promise<void>): Promise<Reply> {
  const out: Reply = { status: 0, body: {} };
  const res = {
    statusCode: 0,
    setHeader() {},
    end(text: string) {
      out.status = this.statusCode;
      out.body = JSON.parse(text) as Record<string, unknown>;
    },
  };
  await handle(res as unknown as ServerResponse);
  return out;
}

function config(root: string): ApiConfig {
  return { dataRoot: root, timeZone: "America/New_York", consoleProbe: async () => ({ open: 0 }), backupDir: join(root, "backups") };
}

// A data folder the way the console app makes it: Games/ and Saved_Data/ both there.
function dataFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "plr-saves-"));
  mkdirSync(join(root, "Games"));
  mkdirSync(join(root, "Saved_Data"));
  return root;
}

// A game save as the page sends it: the basis is the data folder's as it is at this moment.
async function addGame(root: string, body: { fileName: string; folder: string; text: string }, basis?: string): Promise<Reply> {
  const cfg = config(root);
  const b = basis ?? (await dataBasis(root));
  return reply((res) => handleSave(cfg, make("/api/save", { ...body, basis: b }, {}), res));
}

describe("adding a game: the same game is not filed twice", () => {
  it("refuses a ledger whose game is already filed in another folder, and writes nothing", async () => {
    const root = dataFolder();
    mkdirSync(join(root, "Games", "Winter"));
    writeFileSync(join(root, "Games", "Winter", `ledger_${ID}.csv`), LEDGER);
    const r = await addGame(root, { fileName: `ledger_${ID}.csv`, folder: "Autumn", text: LEDGER });
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toContain("Winter");
    expect(existsSync(join(root, "Games", "Autumn"))).toBe(false);
  });

  it("refuses a hand log whose id is already filed in another folder", async () => {
    const root = dataFolder();
    mkdirSync(join(root, "Games", "Winter"));
    writeFileSync(join(root, "Games", "Winter", `poker_now_log_${ID}.csv`), HAND_LOG);
    const r = await addGame(root, { fileName: `poker_now_log_${ID}.csv`, folder: "Autumn", text: HAND_LOG });
    expect(r.status).toBe(409);
    expect(existsSync(join(root, "Games", "Autumn"))).toBe(false);
  });

  it("files a hand log whose ledger is already filed: the two kinds are checked apart, as the console does", async () => {
    const root = dataFolder();
    mkdirSync(join(root, "Games", "Winter"));
    writeFileSync(join(root, "Games", "Winter", `ledger_${ID}.csv`), LEDGER);
    const r = await addGame(root, { fileName: `poker_now_log_${ID}.csv`, folder: "Winter", text: HAND_LOG });
    expect(r.status).toBe(200);
    expect(existsSync(join(root, "Games", "Winter", `poker_now_log_${ID}.csv`))).toBe(true);
  });

  it("refuses a game that is filed under a browser copy name (\" (1)\") in another folder", async () => {
    const root = dataFolder();
    mkdirSync(join(root, "Games", "Winter"));
    writeFileSync(join(root, "Games", "Winter", `ledger_${ID} (1).csv`), LEDGER);
    const r = await addGame(root, { fileName: `ledger_${ID}.csv`, folder: "Autumn", text: LEDGER });
    expect(r.status).toBe(409);
  });
});

describe("adding a game: the basis", () => {
  it("refuses a game save that carries no basis, and writes nothing", async () => {
    const root = dataFolder();
    const cfg = config(root);
    const r = await reply((res) => handleSave(cfg, make("/api/save", { fileName: `ledger_${ID}.csv`, folder: "Oct", text: LEDGER }, {}), res));
    expect(r.status).toBe(409);
    expect(existsSync(join(root, "Games", "Oct"))).toBe(false);
  });

  it("refuses a save made on a basis from before another game was filed", async () => {
    const root = dataFolder();
    const stale = await dataBasis(root);
    writeFileSync(join(root, "Games", "other_file.csv"), "x\n");
    const r = await addGame(root, { fileName: `ledger_${ID}.csv`, folder: "Oct", text: LEDGER }, stale);
    expect(r.status).toBe(409);
    expect(existsSync(join(root, "Games", "Oct"))).toBe(false);
  });

  it("returns the new basis, so the next game in the same batch goes through", async () => {
    const root = dataFolder();
    const first = await addGame(root, { fileName: `ledger_${ID}.csv`, folder: "Oct", text: LEDGER });
    expect(first.status).toBe(200);
    expect(typeof first.body.basis).toBe("string");
    expect(first.body.basis).toBe(await dataBasis(root));
    const second = await addGame(root, { fileName: "ledger_pglBBBBBBBBBBBB.csv", folder: "Oct", text: LEDGER }, String(first.body.basis));
    expect(second.status).toBe(200);
  });
});

describe("adding a game: folder names", () => {
  it("refuses a folder named Games when the data has no Games folder, because it would hide the games at the root", async () => {
    const root = mkdtempSync(join(tmpdir(), "plr-saves-root-"));
    writeFileSync(join(root, "ledger_pglCCCCCCCCCCCC.csv"), LEDGER);
    const cfg = config(root);
    const basis = await dataBasis(root);
    const r = await reply((res) => handleSave(cfg, make("/api/save", { fileName: `ledger_${ID}.csv`, folder: "Games", text: LEDGER, basis }, {}), res));
    expect(r.status).toBe(400);
    expect(existsSync(join(root, "Games"))).toBe(false);
  });

  it("refuses a folder named games in any letter case when there is no Games folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "plr-saves-root-"));
    writeFileSync(join(root, "ledger_pglCCCCCCCCCCCC.csv"), LEDGER);
    const r = await addGame(root, { fileName: `ledger_${ID}.csv`, folder: "games", text: LEDGER });
    expect(r.status).toBe(400);
    expect(existsSync(join(root, "games"))).toBe(false);
  });

  it("still files into a folder named Games when the Games folder is there", async () => {
    const root = dataFolder();
    const r = await addGame(root, { fileName: `ledger_${ID}.csv`, folder: "Games", text: LEDGER });
    expect(r.status).toBe(200);
    expect(readFileSync(join(root, "Games", "Games", `ledger_${ID}.csv`), "utf8")).toBe(LEDGER);
  });
});

describe("a folder that is not the console app's data", () => {
  it("refuses a game save into a folder that does not exist, and creates nothing", async () => {
    const root = join(tmpdir(), `plr-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const r = await addGame(root, { fileName: `ledger_${ID}.csv`, folder: "Oct", text: LEDGER });
    expect(r.status).toBe(409);
    expect(existsSync(root)).toBe(false);
  });

  it("refuses a saved-file write into an empty folder, and creates no Saved_Data folder in it", async () => {
    const root = mkdtempSync(join(tmpdir(), "plr-empty-"));
    const cfg = config(root);
    const body = { file: "settings.csv", before: "", text: "key,value\nme,ozzie\nbanker,\ndisplay,simple\n", basis: await dataBasis(root) };
    const r = await reply((res) => handleSavedFile(cfg, make("/api/saved-file", body, {}), res));
    expect(r.status).toBe(409);
    expect(existsSync(join(root, "Saved_Data"))).toBe(false);
  });

  it("refuses a saved-file write into a folder that does not exist, and creates nothing", async () => {
    const root = join(tmpdir(), `plr-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const cfg = config(root);
    const body = { file: "settings.csv", before: "", text: "key,value\nme,ozzie\nbanker,\ndisplay,simple\n", basis: await dataBasis(root) };
    const r = await reply((res) => handleSavedFile(cfg, make("/api/saved-file", body, {}), res));
    expect(r.status).toBe(409);
    expect(existsSync(root)).toBe(false);
  });
});
