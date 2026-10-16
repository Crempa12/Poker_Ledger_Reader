// A snapshot is one file that opens anywhere: no separate scripts or styles, the
// data inside it, read-only. Built here from the made-up data into a temporary folder.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ledger } from "../../../packages/core/src/index.ts";
import { loadDataRoot } from "../../../tools/load.ts";
import { handleSnapshotFile } from "../server/api.ts";
import { makeSnapshot, SNAPSHOT_NAME } from "../server/snapshot.ts";

const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));

describe("a snapshot file", () => {
  it("holds the whole site and the data, and needs no other file", async () => {
    const out = mkdtempSync(join(tmpdir(), "plr-snap-test-"));
    const r = await makeSnapshot(SYNTHETIC, "America/New_York", out);
    expect(r.name).toMatch(SNAPSHOT_NAME);
    const html = readFileSync(r.file, "utf8");
    expect(r.bytes).toBe(Buffer.byteLength(html));

    expect(html).not.toMatch(/\b(src|href)="\/assets\//);
    expect(html).toMatch(/<script type="module">/);
    expect(html).toMatch(/<style>/);

    const json = /<script id="plr-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    expect(json).not.toContain("<");
    const payload = JSON.parse(json) as { source: string; canWrite: boolean; consoleOpen: number; ledgers: unknown[]; saved: Record<string, string>; dataRoot: string };
    expect(payload.source).toBe("snapshot");
    expect(payload.canWrite).toBe(false);
    expect(payload.consoleOpen).toBe(0);
    expect(payload.dataRoot).not.toContain("/");
    const data = await loadDataRoot(SYNTHETIC);
    expect(payload.ledgers).toHaveLength(data.games.filter((g) => ledger.looksLikeLedger(g.text)).length);
    expect(payload.saved).toEqual(data.savedData);
  }, 120_000);
});

describe("downloading a snapshot", () => {
  async function get(name: string, dir: string, remoteAddress = "127.0.0.1"): Promise<{ status: number; disposition: string }> {
    const out = { status: 0, disposition: "" };
    const headers = new Map<string, string>();
    const res = {
      statusCode: 0,
      setHeader(k: string, v: string) {
        headers.set(k.toLowerCase(), v);
      },
      end() {
        out.status = this.statusCode;
        out.disposition = headers.get("content-disposition") ?? "";
      },
    };
    const req = { headers: {}, socket: { remoteAddress } } as unknown as IncomingMessage;
    await handleSnapshotFile({ dataRoot: dir, timeZone: "America/New_York", snapshotDir: dir }, req, res as unknown as ServerResponse, name);
    return out;
  }

  it("hands over a snapshot by its name, and nothing else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plr-snap-get-"));
    writeFileSync(join(dir, "poker-ledger-2031-05-01.html"), "<!doctype html>");
    writeFileSync(join(dir, "other.html"), "<!doctype html>");
    const ok = await get("poker-ledger-2031-05-01.html", dir);
    expect(ok.status).toBe(200);
    expect(ok.disposition).toContain("poker-ledger-2031-05-01.html");
    for (const name of ["other.html", "../poker-ledger-2031-05-01.html", "poker-ledger-2031-05-02.html", ""]) {
      expect((await get(name, dir)).status, name).toBe(404);
    }
    expect((await get("poker-ledger-2031-05-01.html", dir, "192.168.1.20")).status).toBe(403);
  });
});
