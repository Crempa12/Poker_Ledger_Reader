// The hand-log results depend on the game files and on three Saved_Data files only: merge_rules.csv
// (names), seat_owners.csv (whose seat is whose) and adjustments.csv (the money in the stats). A save of
// the other files (settings, pinned payments, saved sheets) must not make the server read and pair every
// hand log again, while the answer still carries the data's full basis. Made-up data, copied from the fixtures.
import { appendFileSync, cpSync, mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { dataBasis, handleHandLogs, type ApiConfig } from "../server/api.ts";
import { createHandLogCache, type HandLogCache } from "../server/handlogs.ts";

const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
const PORT = 5173;

function make(url: string): IncomingMessage {
  const req = Readable.from([]);
  Object.assign(req, {
    method: "GET",
    url,
    headers: { host: `127.0.0.1:${PORT}` },
    socket: { remoteAddress: "127.0.0.1", localPort: PORT },
  });
  return req as unknown as IncomingMessage;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function ask(cfg: ApiConfig): Promise<Reply> {
  const out: Reply = { status: 0, body: {} };
  const res = {
    statusCode: 0,
    setHeader() {},
    end(text: string) {
      out.status = this.statusCode;
      out.body = JSON.parse(text) as Record<string, unknown>;
    },
  };
  await handleHandLogs(cfg, make("/api/handlogs"), res as unknown as ServerResponse);
  return out;
}

function copyOf(): string {
  const root = mkdtempSync(join(tmpdir(), "plr-handlogs-basis-"));
  cpSync(SYNTHETIC, root, { recursive: true });
  return root;
}

describe("the hand-log results and the data they depend on", () => {
  it("does not read the hand logs again for a change to settings, pinned payments or saved sheets", async () => {
    const root = copyOf();
    const cache: HandLogCache = createHandLogCache();
    const cfg: ApiConfig = { dataRoot: root, timeZone: "America/New_York", consoleProbe: async () => ({ open: 0 }), handLogs: cache };
    const first = await ask(cfg);
    expect(first.status).toBe(200);
    expect(cache.status().loads).toBe(1);

    for (const file of ["settings.csv", "payment_preferences.csv", "session_balances.csv"]) {
      appendFileSync(join(root, "Saved_Data", file), "zzq,zzr\n");
      const next = await ask(cfg);
      expect(next.status, file).toBe(200);
      expect(cache.status().loads, file).toBe(1);
      // The answer still names the data as it is now, not the basis it was first worked out under.
      expect(next.body.basis, file).toBe(await dataBasis(root));
      expect(next.body.logged).toBe(first.body.logged);
      expect(next.body.nights).toEqual(first.body.nights);
    }
    cache.close();
  });

  it("reads the hand logs again for a change to merge rules, seat owners or adjustments", async () => {
    const root = copyOf();
    const cache: HandLogCache = createHandLogCache();
    const cfg: ApiConfig = { dataRoot: root, timeZone: "America/New_York", consoleProbe: async () => ({ open: 0 }), handLogs: cache };
    await ask(cfg);
    let loads = cache.status().loads;
    for (const file of ["merge_rules.csv", "seat_owners.csv", "adjustments.csv"]) {
      appendFileSync(join(root, "Saved_Data", file), "zzq,zzr\n");
      const next = await ask(cfg);
      expect(next.status, file).toBe(200);
      expect(cache.status().loads, file).toBe(loads + 1);
      loads = cache.status().loads;
    }
    cache.close();
  });

  it("reads the hand logs again for a change to a game file", async () => {
    const root = copyOf();
    const cache: HandLogCache = createHandLogCache();
    const cfg: ApiConfig = { dataRoot: root, timeZone: "America/New_York", consoleProbe: async () => ({ open: 0 }), handLogs: cache };
    await ask(cfg);
    appendFileSync(join(root, "Games", "Synthetic Autumn", "ledger_pglFAKE0010.csv"), "\n");
    const next = await ask(cfg);
    expect(next.status).toBe(200);
    expect(cache.status().loads).toBe(2);
    cache.close();
  });
});
