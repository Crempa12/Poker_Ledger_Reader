// GET /api/data sends the ledgers and the names of the hand logs, not the hand logs' text. The loader
// can skip reading hand-log text (it is large), and then still lists every file. Made-up data.
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { ledger } from "../../../packages/core/src/index.ts";
import { handleData, type ApiConfig } from "../server/api.ts";
import { loadDataRoot } from "../../../tools/load.ts";

const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));

describe("loading a data folder without the hand logs' text", () => {
  it("still lists every hand log and reads every ledger in full", async () => {
    const full = await loadDataRoot(SYNTHETIC);
    const light = await loadDataRoot(SYNTHETIC, { handLogText: false });
    const logsOf = (games: { relativePath: string }[]) => games.map((g) => g.relativePath).filter((p) => /poker_now_log_/i.test(p));
    expect(logsOf(light.games)).toEqual(logsOf(full.games));
    expect(logsOf(full.games).length).toBeGreaterThan(0);
    for (const g of light.games.filter((x) => /poker_now_log_/i.test(x.relativePath))) expect(g.text).toBe("");
    const fullLedgers = full.games.filter((g) => ledger.looksLikeLedger(g.text));
    const lightLedgers = light.games.filter((g) => ledger.looksLikeLedger(g.text));
    expect(lightLedgers.map((g) => g.text)).toEqual(fullLedgers.map((g) => g.text));
    expect(light.savedData).toEqual(full.savedData);
  });

  it("keeps the default: the hand logs' text is read when nothing is asked", async () => {
    const full = await loadDataRoot(SYNTHETIC);
    const log = full.games.find((g) => /poker_now_log_/i.test(g.relativePath));
    expect(log?.text.length ?? 0).toBeGreaterThan(0);
  });
});

describe("GET /api/data", () => {
  it("answers with the same ledgers and hand-log names as before, read locally", async () => {
    const cfg: ApiConfig = { dataRoot: SYNTHETIC, timeZone: "America/New_York", consoleProbe: async () => ({ open: 0 }) };
    const req = Readable.from([]);
    Object.assign(req, { method: "GET", url: "/api/data", headers: { host: "127.0.0.1:5173" }, socket: { remoteAddress: "127.0.0.1", localPort: 5173 } });
    let body: Record<string, unknown> = {};
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text: string) {
        body = JSON.parse(text) as Record<string, unknown>;
      },
    };
    await handleData(cfg, req as unknown as IncomingMessage, res as unknown as ServerResponse);
    const full = await loadDataRoot(SYNTHETIC);
    const ledgers = full.games.filter((g) => ledger.looksLikeLedger(g.text)).map((g) => g.relativePath);
    const logs = full.games.filter((g) => /(^|\/)poker_now_log_[^/]*\.csv$/i.test(g.relativePath)).map((g) => g.relativePath);
    expect((body.ledgers as { relativePath: string }[]).map((g) => g.relativePath)).toEqual(ledgers);
    expect(body.logs).toEqual(logs);
    expect(logs.length).toBeGreaterThan(0);
  });
});
