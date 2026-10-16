// The server half of the fixes from walking through real use of the site on made-up data: a download bigger
// than the copy already filed is pointed out, a folder the console app skips is named, a Saved_Data folder the
// site may not write to says so, and /api/data says whether the site starts data folders where it reads.
// Temporary folders only.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { dataBasis, handleData, handleDownloads, handleSave, handleSavedFile, type ApiConfig } from "../server/api.ts";

const PORT = 5173;
const TZ = "America/New_York";
const PAGE = { host: `127.0.0.1:${PORT}`, "x-plr": "1" };
const WRITE = { ...PAGE, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
const LOG = "entry,at,order\n";
const LEDGER = "player_nickname,player_id,session_start_at,session_end_at,buy_in,buy_out,stack,net\n";
const ID = "pglMadeUpBigger01";

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

function request(method: string, url: string, headers: Record<string, string>, body?: unknown): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers, socket: { remoteAddress: "127.0.0.1", localPort: PORT } });
  return req as unknown as IncomingMessage;
}

const config = (dataRoot: string, extra: Partial<ApiConfig> = {}): ApiConfig => ({
  dataRoot,
  timeZone: TZ,
  consoleProbe: async () => ({ open: 0 }),
  ...extra,
});

function dataRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "Games", "Nov"), { recursive: true });
  mkdirSync(join(root, "Saved_Data"));
  return root;
}

describe("a download of a game already filed", () => {
  it("carries the filed copy's place and size, so the page can point out a bigger one", async () => {
    const root = dataRoot("plr-bigger-");
    const early = `${LOG}a game filed before the night ended\n`;
    writeFileSync(join(root, "Games", "Nov", `poker_now_log_${ID}.csv`), early);
    const downloads = mkdtempSync(join(tmpdir(), "plr-bigger-downloads-"));
    writeFileSync(join(downloads, `poker_now_log_${ID} (1).csv`), `${LOG}${"the whole night\n".repeat(40)}`);
    writeFileSync(join(downloads, "ledger_pglMadeUpNotFiled1.csv"), LEDGER);
    const r = await reply((res) => handleDownloads(config(root, { downloadsDir: downloads }), request("GET", "/api/downloads", PAGE), res));
    expect(r.status).toBe(200);
    const files = r.json.files as { name: string; filed?: { path: string; bytes: number } }[];
    expect(files.find((f) => f.name.startsWith("poker_now_log_"))?.filed).toEqual({
      path: `Nov/poker_now_log_${ID}.csv`,
      bytes: Buffer.byteLength(early),
    });
    expect(files.find((f) => f.name.startsWith("ledger_"))?.filed).toBeUndefined();
  });
});

describe("filing a game", () => {
  async function save(root: string, folder: string) {
    const body = { fileName: `poker_now_log_${ID}.csv`, folder, text: LOG, basis: await dataBasis(root) };
    return reply((res) => handleSave(config(root), request("POST", "/api/save", WRITE, body), res));
  }

  it("names a folder the console app skips, instead of listing rules it passes", async () => {
    const root = dataRoot("plr-skipped-");
    const build = await save(root, "Nov/build");
    expect(build.status).toBe(400);
    expect(String(build.json.error)).toBe("the console app skips folders named build, so a game there would not be read: pick another name");
    // The console app reads "Reports", but a Mac or Windows can take it for "reports", which it skips.
    const reports = await save(root, "Reports");
    expect(reports.status).toBe(400);
    expect(String(reports.json.error)).toBe(
      "the site does not file games into Reports: the console app skips reports, and on a Mac or Windows the two names can be the same folder: pick another name",
    );
    expect(String((await save(root, "Nov:1")).json.error)).toContain("pick another folder name");
  });
});

describe("a Saved_Data folder the site may not write to", () => {
  it("says so and changes nothing", async () => {
    // Permissions mean nothing to an administrator or on Windows, so there is nothing to see there.
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = dataRoot("plr-readonly-");
    const settings = join(root, "Saved_Data", "settings.csv");
    const before = "key,value\nme,della\nbanker,\ndisplay,fancy\n";
    writeFileSync(settings, before);
    chmodSync(join(root, "Saved_Data"), 0o555);
    try {
      const body = { file: "settings.csv", before, text: before.replace("della", "ozzie"), basis: await dataBasis(root) };
      const r = await reply((res) => handleSavedFile(config(root, { backupDir: mkdtempSync(join(tmpdir(), "plr-ro-backups-")) }), request("POST", "/api/saved-file", WRITE, body), res));
      expect(r.status).toBe(500);
      expect(String(r.json.error)).toMatch(/^settings\.csv could not be written, so nothing changed: the site may not write to the Saved_Data folder \(EACCES\)/);
      expect(readFileSync(settings, "utf8")).toBe(before);
      expect(existsSync(join(root, "Saved_Data", ".web-save.lock"))).toBe(false);
    } finally {
      chmodSync(join(root, "Saved_Data"), 0o755);
    }
  });
});

describe("/api/data, for a folder with other files in it", () => {
  it("says the site would start one here, so the page can say why it does not", async () => {
    const root = mkdtempSync(join(tmpdir(), "plr-other-files-"));
    writeFileSync(join(root, "notes.txt"), "someone's notes");
    const page = async (startable: boolean) =>
      (await reply((res) => handleData(config(root, { startable }), request("GET", "/api/data", { host: `127.0.0.1:${PORT}` }), res))).json;
    expect(await page(true)).toMatchObject({ dataReady: false, canStartData: false, dataStartable: true });
    expect(await page(false)).toMatchObject({ dataReady: false, canStartData: false, dataStartable: false });
  });
});
