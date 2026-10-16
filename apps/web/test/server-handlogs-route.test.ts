// GET /api/handlogs (server/api.ts): who may read it, the queries it refuses, the route itself,
// and that a changed data basis reads the hand logs again. Made-up data, and requests built by hand.
import { appendFileSync, cpSync, mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { apiMiddleware, dataBasis, handleHandLogs, type ApiConfig } from "../server/api.ts";
import { createHandLogCache, type HandLogCache } from "../server/handlogs.ts";
import { handLogsQuery } from "../src/handlogs.ts";

const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
const TZ = "America/New_York";
const PORT = 5173;

// A request as the server sees it: its method, path and query, its headers, and the address it came from.
function make(
  url: string,
  headers: Record<string, string | undefined>,
  remoteAddress = "127.0.0.1",
  method = "GET",
): IncomingMessage {
  const req = Readable.from([]);
  Object.assign(req, { method, url, headers, socket: { remoteAddress, localPort: PORT } });
  return req as unknown as IncomingMessage;
}

// A read from a page on this computer: a same-origin GET carries a Host and no Origin.
function readHeaders(host = `127.0.0.1:${PORT}`): Record<string, string | undefined> {
  return { host };
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  text: string;
  body: Record<string, unknown>;
}

// Runs one request through a handler, and returns what it answered.
async function answer(run: (res: ServerResponse) => unknown): Promise<Answer> {
  let finish: (a: Answer) => void = () => undefined;
  const done = new Promise<Answer>((resolve) => {
    finish = resolve;
  });
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(text: string) {
      const body = /^\s*\{/.test(text) ? (JSON.parse(text) as Record<string, unknown>) : {};
      finish({ status: this.statusCode, headers, text, body });
    },
  };
  await run(res as unknown as ServerResponse);
  return done;
}

function configFor(root: string, cache: HandLogCache = createHandLogCache()): ApiConfig {
  return { dataRoot: root, timeZone: TZ, handLogs: cache };
}

describe("who may read the hand logs", () => {
  it("gives them to this computer, as JSON that is not kept", async () => {
    const cfg = configFor(SYNTHETIC);
    const a = await answer((res) => handleHandLogs(cfg, make("/api/handlogs?folder=Synthetic%20Autumn", readHeaders()), res));
    expect(a.status).toBe(200);
    expect(a.headers["cache-control"]).toBe("no-store");
    expect(a.headers["content-type"]).toContain("application/json");
    expect(a.body.scope).toEqual({ folder: "Synthetic Autumn", from: null, to: null });
    expect(a.body.logged).toBe(2);
    expect(a.body.basis).toBe(await dataBasis(SYNTHETIC));
    // The answer holds no path on this computer.
    expect(a.text).not.toContain(SYNTHETIC);
  });

  it("gives them to a phone on the same Wi-Fi by its IP address", async () => {
    const cfg = configFor(SYNTHETIC);
    const headers = { host: "192.168.1.20:5173", origin: "http://192.168.1.20:5173" };
    const a = await answer((res) => handleHandLogs(cfg, make("/api/handlogs", headers, "192.168.1.20"), res));
    expect(a.status).toBe(200);
    expect(a.body.scope).toEqual({ folder: "", from: null, to: null });
  });

  it("refuses a DNS name pointed at this computer, another site's page, and a request that came through a proxy", async () => {
    const cfg = configFor(SYNTHETIC);
    const refused = [
      make("/api/handlogs", readHeaders("evil.example:5173")),
      make("/api/handlogs", { ...readHeaders(), origin: "http://localhost:3000" }),
      make("/api/handlogs", { ...readHeaders(), "x-forwarded-for": "203.0.113.9" }),
    ];
    for (const req of refused) {
      const a = await answer((res) => handleHandLogs(cfg, req, res));
      expect(a.status).toBe(403);
      expect(a.body).not.toHaveProperty("scope");
      expect(a.body).not.toHaveProperty("nights");
    }
  });

  it("checks who is asking before it looks at the query", async () => {
    const cfg = configFor(SYNTHETIC);
    const a = await answer((res) => handleHandLogs(cfg, make("/api/handlogs?bad=1", readHeaders("evil.example:5173")), res));
    expect(a.status).toBe(403);
  });
});

describe("the queries it refuses", () => {
  it("answers 400 with a short message that does not repeat the value", async () => {
    const cfg = configFor(SYNTHETIC);
    const cases: Array<[string, string]> = [
      ["/api/handlogs?from=abc", "abc"],
      ["/api/handlogs?to=-1", "-1"],
      ["/api/handlogs?folder=a&folder=b", ""],
      ["/api/handlogs?from=1700086400&to=1700000000", "1700086400"],
      [`/api/handlogs?folder=${"f".repeat(201)}`, "f".repeat(201)],
    ];
    for (const [url, value] of cases) {
      const a = await answer((res) => handleHandLogs(cfg, make(url, readHeaders()), res));
      expect(a.status, url).toBe(400);
      expect(typeof a.body.error, url).toBe("string");
      if (value !== "") expect(a.text, url).not.toContain(value);
    }
  });
});

describe("the route", () => {
  it("is GET /api/handlogs, and nothing else", async () => {
    const cfg = configFor(SYNTHETIC);
    const middleware = apiMiddleware(cfg);
    const next = vi.fn();
    const ok = await answer((res) => middleware(make("/api/handlogs?folder=", readHeaders()), res, next));
    expect(ok.status).toBe(200);
    expect(next).not.toHaveBeenCalled();
    const post = await answer((res) => middleware(make("/api/handlogs", readHeaders(), "127.0.0.1", "POST"), res, next));
    expect(post.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("the data basis", () => {
  it("reads the hand logs again only when the data changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "plr-handlogs-route-"));
    cpSync(SYNTHETIC, root, { recursive: true });
    const cache = createHandLogCache();
    const cfg = configFor(root, cache);
    const first = await answer((res) => handleHandLogs(cfg, make("/api/handlogs", readHeaders()), res));
    expect(first.status).toBe(200);
    expect(cache.status().loads).toBe(1);

    const again = await answer((res) => handleHandLogs(cfg, make("/api/handlogs", readHeaders()), res));
    expect(again.body.basis).toBe(first.body.basis);
    expect(cache.status().loads).toBe(1);

    appendFileSync(join(root, "Saved_Data", "merge_rules.csv"), "zzq,zzr\n");
    const changed = await answer((res) => handleHandLogs(cfg, make("/api/handlogs", readHeaders()), res));
    expect(changed.status).toBe(200);
    expect(changed.body.basis).not.toBe(first.body.basis);
    expect(cache.status().loads).toBe(2);
  });

  it("answers under the basis the data had when it was read, asking again when it changed during the read", async () => {
    const root = mkdtempSync(join(tmpdir(), "plr-handlogs-race-"));
    cpSync(SYNTHETIC, root, { recursive: true });
    const real = createHandLogCache();
    let asks = 0;
    // The first ask changes a saved file after the basis was read and before the hand logs are read.
    const cache: HandLogCache = {
      payloadFor(dataRoot, timeZone, basis, scope) {
        asks++;
        if (asks === 1) appendFileSync(join(root, "Saved_Data", "merge_rules.csv"), "zzq,zzr\n");
        return real.payloadFor(dataRoot, timeZone, basis, scope);
      },
      status: () => real.status(),
      parses: () => real.parses(),
      close: () => real.close(),
    };
    const a = await answer((res) => handleHandLogs(configFor(root, cache), make("/api/handlogs", readHeaders()), res));
    expect(a.status).toBe(200);
    expect(a.body.basis).toBe(await dataBasis(root));
    expect(asks).toBe(2);
    real.close();
  });
});

describe("the page's query for a folder with a space in its name", () => {
  it("is read as that folder when the page sends it", async () => {
    const cfg = configFor(SYNTHETIC);
    const query = handLogsQuery({ folder: "Synthetic Autumn", from: null, to: null });
    const a = await answer((res) => handleHandLogs(cfg, make(`/api/handlogs?${query}`, readHeaders()), res));
    expect(a.status).toBe(200);
    expect(a.body.scope).toEqual({ folder: "Synthetic Autumn", from: null, to: null });
    expect(a.body.games).toBe(6);
    expect(a.body.logged).toBe(2);
    expect(a.body.nights).toHaveLength(2);
  });

  it("is read as that folder when a form sends the plus sign for the space", async () => {
    const cfg = configFor(SYNTHETIC);
    const a = await answer((res) =>
      handleHandLogs(cfg, make("/api/handlogs?folder=Synthetic+Autumn", readHeaders()), res),
    );
    expect(a.status).toBe(200);
    expect(a.body.games).toBe(6);
    expect(a.body.logged).toBe(2);
  });
});
