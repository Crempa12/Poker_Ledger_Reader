// Who may read the data and who may change it, judged from the request alone: the
// address it came from, the Host name it was sent to, its Origin and Sec-Fetch-Site
// headers, and any proxy headers. Each request is built by hand, with made-up names.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { players } from "../../../packages/core/src/index.ts";
import {
  apiMiddleware,
  dataBasis,
  handleData,
  handlePokerNow,
  handleSave,
  handleSavedFile,
  handleSnapshotFile,
  type ApiConfig,
} from "../server/api.ts";

const PORT = 5173;
const RULES = players.serializeMergeRulesCSV(new Map([["dellab", "della"]]));
const MORE_RULES = players.serializeMergeRulesCSV(players.addMergeRule(players.parseMergeRulesCSV(RULES), "dells", "della"));

function make(
  method: "GET" | "POST",
  url: string,
  body: unknown,
  headers: Record<string, string | undefined>,
  remoteAddress = "127.0.0.1",
): IncomingMessage {
  const req = Readable.from(method === "POST" ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(req, { method, url, headers, socket: { remoteAddress, localPort: PORT } });
  return req as unknown as IncomingMessage;
}

// A read from a page on this computer: a same-origin GET carries a Host and no Origin.
function readHeaders(host = `127.0.0.1:${PORT}`): Record<string, string | undefined> {
  return { host };
}

// A change sent by the page itself: its own Host and Origin, and the custom header.
function writeHeaders(host = `127.0.0.1:${PORT}`): Record<string, string | undefined> {
  return { host, origin: `http://${host}`, "x-plr": "1" };
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
      // A snapshot download is the HTML file itself, not JSON.
      out.body = (/^\s*\{/.test(text) ? JSON.parse(text) : {}) as Record<string, unknown>;
    },
  };
  await handle(res as unknown as ServerResponse);
  return out;
}

function dataRoot(): { root: string; cfg: ApiConfig } {
  const root = mkdtempSync(join(tmpdir(), "plr-requests-"));
  mkdirSync(join(root, "Saved_Data"));
  mkdirSync(join(root, "Games"));
  writeFileSync(join(root, "Saved_Data", "merge_rules.csv"), RULES);
  const cfg: ApiConfig = {
    dataRoot: root,
    timeZone: "America/New_York",
    consoleProbe: async () => ({ open: 0 }),
    backupDir: join(root, "backups"),
  };
  return { root, cfg };
}

async function read(cfg: ApiConfig, req: IncomingMessage): Promise<Reply> {
  return reply((res) => handleData(cfg, req, res));
}

async function save(cfg: ApiConfig, req: IncomingMessage): Promise<Reply> {
  return reply((res) => handleSavedFile(cfg, req, res));
}

describe("who may read the data", () => {
  it("gives it to this computer, with the folder's full path", async () => {
    const { root, cfg } = dataRoot();
    const r = await read(cfg, make("GET", "/api/data", null, readHeaders()));
    expect(r.status).toBe(200);
    expect(r.body.canWrite).toBe(true);
    expect(r.body.dataRoot).toBe(root);
  });

  it("gives it to a phone on the same Wi-Fi by its IP address, read-only, with only the folder's name", async () => {
    const { root, cfg } = dataRoot();
    const headers = readHeaders("192.168.1.20:5173");
    const r = await read(cfg, make("GET", "/api/data", null, { ...headers, origin: "http://192.168.1.20:5173" }, "192.168.1.20"));
    expect(r.status).toBe(200);
    expect(r.body.canWrite).toBe(false);
    expect(r.body.dataRoot).toBe(basename(root));
    expect(String(r.body.dataRoot)).not.toContain("/");
  });

  it("refuses a DNS name that points at this computer (DNS rebinding)", async () => {
    const { cfg } = dataRoot();
    const r = await read(cfg, make("GET", "/api/data", null, readHeaders("evil.example:5173")));
    expect(r.status).toBe(403);
    expect(r.body.ledgers).toBeUndefined();
  });

  it("refuses a page from another site or another port", async () => {
    const { cfg } = dataRoot();
    expect((await read(cfg, make("GET", "/api/data", null, { ...readHeaders(), origin: "http://localhost:3000" }))).status).toBe(403);
    expect((await read(cfg, make("GET", "/api/data", null, { ...readHeaders(), origin: "http://127.0.0.1:5174" }))).status).toBe(403);
    expect((await read(cfg, make("GET", "/api/data", null, { ...readHeaders(), origin: "null" }))).status).toBe(403);
  });

  it("refuses a request that came through a proxy", async () => {
    const { cfg } = dataRoot();
    expect((await read(cfg, make("GET", "/api/data", null, { ...readHeaders(), "x-forwarded-for": "203.0.113.9" }))).status).toBe(403);
    expect((await read(cfg, make("GET", "/api/data", null, { ...readHeaders(), forwarded: "for=203.0.113.9" }))).status).toBe(403);
  });

  it("refuses a request the browser says came from another site, and takes one from this site", async () => {
    const { cfg } = dataRoot();
    expect((await read(cfg, make("GET", "/api/data", null, { ...readHeaders(), "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await read(cfg, make("GET", "/api/data", null, { ...readHeaders(), "sec-fetch-site": "same-origin" }))).status).toBe(200);
    expect((await read(cfg, make("GET", "/api/data", null, { ...readHeaders(), "sec-fetch-site": "none" }))).status).toBe(200);
  });

  it("hands a snapshot download to this computer only, by a name this computer's Host gives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plr-requests-snap-"));
    writeFileSync(join(dir, "poker-ledger-2031-05-01.html"), "<!doctype html>");
    const cfg: ApiConfig = { dataRoot: dir, timeZone: "America/New_York", snapshotDir: dir };
    const name = "poker-ledger-2031-05-01.html";
    const status = async (req: IncomingMessage) => (await reply((res) => handleSnapshotFile(cfg, req, res, name))).status;
    expect(await status(make("GET", `/api/snapshot/${name}`, null, readHeaders()))).toBe(200);
    expect(await status(make("GET", `/api/snapshot/${name}`, null, readHeaders("evil.example:5173")))).toBe(403);
    expect(await status(make("GET", `/api/snapshot/${name}`, null, readHeaders("192.168.1.20:5173"), "192.168.1.20"))).toBe(403);
    expect(await status(make("GET", `/api/snapshot/${name}`, null, { ...readHeaders(), "x-forwarded-host": "tailnet.example" }))).toBe(403);
  });
});

describe("who may change the data", () => {
  it("takes a change from this computer under its loopback names, IPv6 included", async () => {
    const { root, cfg } = dataRoot();
    const basis = await dataBasis(root);
    const body = { file: "merge_rules.csv", before: RULES, text: MORE_RULES, basis };
    expect((await save(cfg, make("POST", "/api/saved-file", body, writeHeaders("[::1]:5173")))).status).toBe(200);
    expect(readFileSync(join(root, "Saved_Data", "merge_rules.csv"), "utf8")).toBe(MORE_RULES);
  });

  it("refuses a change sent under a DNS name, an address, or another port, even with a matching Origin", async () => {
    const { root, cfg } = dataRoot();
    const basis = await dataBasis(root);
    const body = { file: "merge_rules.csv", before: RULES, text: MORE_RULES, basis };
    expect((await save(cfg, make("POST", "/api/saved-file", body, writeHeaders("evil.example:5173")))).status).toBe(403);
    expect((await save(cfg, make("POST", "/api/saved-file", body, writeHeaders("192.168.1.20:5173")))).status).toBe(403);
    expect((await save(cfg, make("POST", "/api/saved-file", body, writeHeaders("127.0.0.1:9999")))).status).toBe(403);
    expect((await save(cfg, make("POST", "/api/saved-file", body, { ...writeHeaders(), "x-real-ip": "203.0.113.9" }))).status).toBe(403);
    expect(readFileSync(join(root, "Saved_Data", "merge_rules.csv"), "utf8")).toBe(RULES);
  });

  it("refuses a change from another site on this computer, a proxy's, or a same-site request", async () => {
    const { root, cfg } = dataRoot();
    const basis = await dataBasis(root);
    const body = { file: "merge_rules.csv", before: RULES, text: MORE_RULES, basis };
    expect((await save(cfg, make("POST", "/api/saved-file", body, { ...writeHeaders(), "sec-fetch-site": "same-site" }))).status).toBe(403);
    expect((await save(cfg, make("POST", "/api/saved-file", body, { ...writeHeaders(), "x-forwarded-host": "tailnet.example" }))).status).toBe(403);
    expect((await save(cfg, make("POST", "/api/saved-file", body, { ...writeHeaders(), origin: "null" }))).status).toBe(403);
    expect(readFileSync(join(root, "Saved_Data", "merge_rules.csv"), "utf8")).toBe(RULES);
  });

  it("refuses a change that carries no Origin, and one that came through a tunnel or proxy", async () => {
    const { root, cfg } = dataRoot();
    const basis = await dataBasis(root);
    const body = { file: "merge_rules.csv", before: RULES, text: MORE_RULES, basis };
    expect((await save(cfg, make("POST", "/api/saved-file", body, { ...writeHeaders(), origin: undefined }))).status).toBe(403);
    for (const header of [
      { "cf-connecting-ip": "203.0.113.9" },
      { "tailscale-user-login": "someone@example.test" },
      { "true-client-ip": "203.0.113.9" },
      { "x-forwarded-proto": "https" },
    ]) {
      expect((await save(cfg, make("POST", "/api/saved-file", body, { ...writeHeaders(), ...header }))).status, JSON.stringify(header)).toBe(403);
    }
    expect(readFileSync(join(root, "Saved_Data", "merge_rules.csv"), "utf8")).toBe(RULES);
  });
});

// The made-up ledger text the import and PokerNow tests send: a header line, one row.
const LEDGER = "player_nickname,player_id,session_start_at\nDella,pgl0000000001,2026-10-01 20:00:00\n";

// The request as the dev server hands it over: the middleware answers once the route is done.
function viaMiddleware(cfg: ApiConfig, req: IncomingMessage): Promise<Reply> {
  return new Promise((done) => {
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text: string) {
        done({ status: this.statusCode, body: JSON.parse(text) as Record<string, unknown> });
      },
    };
    apiMiddleware(cfg)(req, res as unknown as ServerResponse, () => done({ status: -1, body: {} }));
  });
}

describe("importing a game file", () => {
  it("writes a game file once when the same import comes twice at once", async () => {
    const { root, cfg } = dataRoot();
    const body = { fileName: "ledger_pglAAAAAAAAAAAA.csv", folder: "Oct", text: LEDGER, basis: await dataBasis(root) };
    const [a, b] = await Promise.all([
      reply((res) => handleSave(cfg, make("POST", "/api/save", body, writeHeaders()), res)),
      reply((res) => handleSave(cfg, make("POST", "/api/save", body, writeHeaders()), res)),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
    expect(readFileSync(join(root, "Games", "Oct", "ledger_pglAAAAAAAAAAAA.csv"), "utf8")).toBe(LEDGER);
  });

  it("answers an unexpected failure with a short line that holds no path, and logs the detail", async () => {
    const { root, cfg } = dataRoot();
    // A file where the game's folder should go: the import cannot make the folder.
    writeFileSync(join(root, "Games", "Blocked"), "not a folder");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const basis = await dataBasis(root);
      const r = await viaMiddleware(cfg, make("POST", "/api/save", { fileName: "ledger_pglAAAAAAAAAAAA.csv", folder: "Blocked", text: LEDGER, basis }, writeHeaders()));
      expect(r.status).toBe(500);
      expect(String(r.body.error)).not.toContain(root);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe("fetching a game's ledger from PokerNow", () => {
  afterEach(() => vi.unstubAllGlobals());
  const LINK = { link: "https://www.pokernow.com/games/pglBBBBBBBBBBBB/" };

  it("takes the ledger when PokerNow sends one", async () => {
    vi.stubGlobal("fetch", async () => new Response(LEDGER));
    const r = await reply((res) => handlePokerNow(make("POST", "/api/pokernow", LINK, writeHeaders()), res));
    expect(r.status).toBe(200);
    expect(r.body.text).toBe(LEDGER);
  });

  it("asks PokerNow's own address, and follows a redirect only to that address", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (urls.length === 1) {
        return new Response(null, { status: 301, headers: { location: "https://www.pokernow.com/games/pglBBBBBBBBBBBB/ledger_pglBBBBBBBBBBBB.csv" } });
      }
      return new Response(LEDGER);
    });
    const r = await reply((res) => handlePokerNow(make("POST", "/api/pokernow", LINK, writeHeaders()), res));
    expect(r.status).toBe(200);
    expect(urls).toEqual([
      "https://www.pokernow.com/games/pglBBBBBBBBBBBB/ledger_pglBBBBBBBBBBBB.csv",
      "https://www.pokernow.com/games/pglBBBBBBBBBBBB/ledger_pglBBBBBBBBBBBB.csv",
    ]);
  });

  it("refuses a redirect to any other address, and does not go there", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(null, { status: 302, headers: { location: "https://evil.example/ledger.csv" } });
    });
    const r = await reply((res) => handlePokerNow(make("POST", "/api/pokernow", LINK, writeHeaders()), res));
    expect(r.status).toBe(502);
    expect(urls).toHaveLength(1);
  });

  it("gives up on a PokerNow that does not answer in time", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, fail) => {
          init.signal?.addEventListener("abort", () => fail(new Error("aborted")));
        }),
    );
    const r = await reply((res) => handlePokerNow(make("POST", "/api/pokernow", LINK, writeHeaders()), res, { timeoutMs: 20, maxBytes: 1000 }));
    expect(r.status).toBe(502);
    expect(String(r.body.error)).toContain("did not answer");
  });

  it("refuses an answer over the size the site takes", async () => {
    vi.stubGlobal("fetch", async () => new Response("x".repeat(500)));
    const r = await reply((res) => handlePokerNow(make("POST", "/api/pokernow", LINK, writeHeaders()), res, { timeoutMs: 5_000, maxBytes: 100 }));
    expect(r.status).toBe(502);
    expect(String(r.body.error)).toContain("more for that game");
  });

  it("refuses an answer that is not a ledger", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>sorry</html>"));
    const r = await reply((res) => handlePokerNow(make("POST", "/api/pokernow", LINK, writeHeaders()), res));
    expect(r.status).toBe(502);
  });
});
