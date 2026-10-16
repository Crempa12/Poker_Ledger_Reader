// The server's answers for the review fixes: the hand-log answer is gzipped for a browser that takes gzip;
// the page's console check is kept for a few seconds, while a save still checks at once; /api/data says
// whether the data has a Games folder; and a save to a folder with no console data says how to fix it.
// Made-up data only, in temporary folders (the fixtures are never written).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { players } from "../../../packages/core/src/index.ts";
import {
  acceptsGzip,
  dataBasis,
  handleData,
  handleHandLogs,
  handleSave,
  handleSavedFile,
  handleSnapshot,
  type ApiConfig,
  type ConsoleCheck,
} from "../server/api.ts";
import { createHandLogCache } from "../server/handlogs.ts";

const PORT = 5173;
const TZ = "America/New_York";
const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
const RULES = players.serializeMergeRulesCSV(new Map([["dellab", "della"]]));
const MORE_RULES = players.serializeMergeRulesCSV(players.addMergeRule(players.parseMergeRulesCSV(RULES), "dells", "della"));
// A change made from this page on this computer: the custom header and the page's own origin.
const WRITE = { "x-plr": "1", origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

// Runs one handler and returns what it answered, with the body as bytes.
async function reply(run: (res: ServerResponse) => unknown): Promise<Reply> {
  let finish: (r: Reply) => void = () => undefined;
  const done = new Promise<Reply>((resolve) => {
    finish = resolve;
  });
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(chunk?: string | Buffer) {
      finish({ status: this.statusCode, headers, body: Buffer.from(chunk ?? "") });
    },
  };
  await run(res as unknown as ServerResponse);
  return done;
}

// A request built by hand, from this computer, with the body (if any) as text.
function request(method: string, url: string, headers: Record<string, string> = {}, body?: string): IncomingMessage {
  // The server reads a body as the bytes a socket gives, so a body is one Buffer, as it is there.
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(body, "utf8")]);
  Object.assign(req, {
    method,
    url,
    headers: { host: `127.0.0.1:${PORT}`, ...headers },
    socket: { remoteAddress: "127.0.0.1", localPort: PORT },
  });
  return req as unknown as IncomingMessage;
}

// A data folder with only the Saved_Data file the saves below change (no Games folder).
function savedDataOnly(): string {
  const root = mkdtempSync(join(tmpdir(), "plr-review-fixes-"));
  mkdirSync(join(root, "Saved_Data"));
  writeFileSync(join(root, "Saved_Data", "merge_rules.csv"), RULES);
  return root;
}

describe("the server's answers for the review fixes", () => {
  it("gzips the hand-log answer for a browser that takes gzip, and sends it plain to one that does not", async () => {
    const handLogs = createHandLogCache();
    const cfg: ApiConfig = { dataRoot: SYNTHETIC, timeZone: TZ, consoleProbe: async () => ({ open: 0 }), handLogs };
    const plain = await reply((res) => handleHandLogs(cfg, request("GET", "/api/handlogs"), res));
    expect(plain.status).toBe(200);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    const zipped = await reply((res) => handleHandLogs(cfg, request("GET", "/api/handlogs", { "accept-encoding": "gzip, deflate" }), res));
    expect(zipped.status).toBe(200);
    expect(zipped.headers["content-encoding"]).toBe("gzip");
    expect(zipped.body.length).toBeLessThan(plain.body.length);
    expect(JSON.parse(gunzipSync(zipped.body).toString("utf8"))).toEqual(JSON.parse(plain.body.toString("utf8")));
    // q=0 says the client does not take gzip.
    const refused = await reply((res) => handleHandLogs(cfg, request("GET", "/api/handlogs", { "accept-encoding": "gzip;q=0, identity" }), res));
    expect(refused.headers["content-encoding"]).toBeUndefined();
    expect(refused.body.equals(plain.body)).toBe(true);
    handLogs.close();
  });

  it("reads Accept-Encoding with its q-values", () => {
    for (const yes of ["gzip", "gzip, deflate, br", "br;q=1.0, gzip;q=0.8", "GZIP", " x-gzip ", "deflate, gzip; q=0.5"]) {
      expect(acceptsGzip(yes), yes).toBe(true);
    }
    for (const no of ["", "identity", "deflate, br", "gzip;q=0", "gzip; q=0.0, identity", "x-gzip;q=0", "*", "gzipped"]) {
      expect(acceptsGzip(no), no).toBe(false);
    }
  });

  it("makes no snapshot of a folder that is not the console app's, and says why", async () => {
    const root = mkdtempSync(join(tmpdir(), "plr-review-snapshot-"));
    const cfg: ApiConfig = { dataRoot: join(root, "missing"), timeZone: TZ, consoleProbe: async () => ({ open: 0 }), snapshotDir: join(root, "out") };
    const r = await reply((res) => handleSnapshot(cfg, request("POST", "/api/snapshot", WRITE, "{}"), res));
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body.toString("utf8")).error).toContain("is not there, or holds no console app data");
    expect(existsSync(join(root, "out"))).toBe(false);
  });

  it("keeps the page's console check for a few seconds, and a save checks at once", async () => {
    const root = savedDataOnly();
    let probes = 0;
    let answer: ConsoleCheck = { open: 0 };
    const cfg: ApiConfig = {
      dataRoot: root,
      timeZone: TZ,
      backupDir: join(root, "backups"),
      consoleProbe: async () => {
        probes++;
        return answer;
      },
    };
    await reply((res) => handleData(cfg, request("GET", "/api/data"), res));
    await reply((res) => handleData(cfg, request("GET", "/api/data"), res));
    expect(probes).toBe(1);

    // The console app is opened after the page loaded: the save refuses at once, not after the kept check.
    answer = { open: 2 };
    const basis = await dataBasis(root);
    const body = JSON.stringify({ file: "merge_rules.csv", before: RULES, text: MORE_RULES, basis });
    const saved = await reply((res) => handleSavedFile(cfg, request("POST", "/api/saved-file", WRITE, body), res));
    expect(saved.status).toBe(423);
    expect(probes).toBe(2);
    expect(readFileSync(join(root, "Saved_Data", "merge_rules.csv"), "utf8")).toBe(RULES);
  });

  it("says whether the data has a Games folder, for where a new game goes", async () => {
    const root = savedDataOnly();
    const page = async () => {
      const cfg: ApiConfig = { dataRoot: root, timeZone: TZ, consoleProbe: async () => ({ open: 0 }) };
      const r = await reply((res) => handleData(cfg, request("GET", "/api/data"), res));
      return JSON.parse(r.body.toString("utf8")) as { gamesFolder: boolean };
    };
    expect((await page()).gamesFolder).toBe(false);
    mkdirSync(join(root, "Games"));
    expect((await page()).gamesFolder).toBe(true);
  });

  it("tells a folder with no console data how to fix it, and changes nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "plr-empty-data-"));
    const cfg: ApiConfig = { dataRoot: root, timeZone: TZ, consoleProbe: async () => ({ open: 0 }) };
    const body = JSON.stringify({ fileName: "poker_now_log_pgl0123456789abc.csv", folder: "Nov", text: "entry,at,order\n", basis: "x" });
    const r = await reply((res) => handleSave(cfg, request("POST", "/api/save", WRITE, body), res));
    expect(r.status).toBe(409);
    const error = String((JSON.parse(r.body.toString("utf8")) as { error: unknown }).error);
    expect(error).toContain("Nothing was changed");
    expect(error).toContain("run the console app once in it");
    expect(existsSync(join(root, "Nov"))).toBe(false);
  });
});
