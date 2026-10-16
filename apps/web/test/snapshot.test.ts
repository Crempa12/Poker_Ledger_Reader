// A snapshot is one file that opens anywhere: no separate scripts or styles, the data
// inside it, read-only. Built here from the made-up data into a temporary folder.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { ledger } from "../../../packages/core/src/index.ts";
import { SAVED_DATA_FILES, loadDataRoot } from "../../../tools/load.ts";
import { handleSnapshotFile, type ApiConfig } from "../server/api.ts";
import { handScopePayload, handWorldFromInputs } from "../server/handlogs.ts";
import { makeSnapshot, SNAPSHOT_NAME } from "../server/snapshot.ts";
import type { HandScopePayload } from "../src/handtypes.ts";

const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
const TZ = "America/New_York";

interface Payload {
  source: string;
  dataRoot: string;
  canWrite: boolean;
  consoleOpen: number;
  basis: string;
  ledgers: unknown[];
  saved: Record<string, string>;
  handlogs: Record<string, HandScopePayload>;
}

// The data element of a snapshot page, parsed.
function payloadOf(html: string): { json: string; payload: Payload } {
  const json = /<script id="plr-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  return { json, payload: JSON.parse(json) as Payload };
}

describe("a snapshot file", () => {
  it("holds the whole site and the data, and needs no other file", async () => {
    const out = mkdtempSync(join(tmpdir(), "plr-snap-test-"));
    const r = await makeSnapshot(SYNTHETIC, TZ, out);
    expect(r.name).toMatch(SNAPSHOT_NAME);
    const html = readFileSync(r.file, "utf8");
    expect(r.bytes).toBe(Buffer.byteLength(html));

    expect(html).not.toMatch(/\b(src|href)="\/assets\//);
    expect(html).toMatch(/<script type="module">/);
    expect(html).toMatch(/<style>/);

    const { json, payload } = payloadOf(html);
    expect(json).not.toContain("<");
    expect(payload.source).toBe("snapshot");
    expect(payload.canWrite).toBe(false);
    expect(payload.consoleOpen).toBe(0);
    expect(payload.basis).toBe("");
    expect(payload.dataRoot).not.toContain("/");
    const data = await loadDataRoot(SYNTHETIC);
    expect(payload.ledgers).toHaveLength(data.games.filter((g) => ledger.looksLikeLedger(g.text)).length);
    expect(Object.keys(payload.saved).sort()).toEqual([...SAVED_DATA_FILES].sort());
    for (const name of SAVED_DATA_FILES) expect(payload.saved[name]).toBe(data.savedData[name] ?? "");
  }, 120_000);

  it("carries the hand-log results for every folder, and for each folder, with dates open and no basis", async () => {
    const out = mkdtempSync(join(tmpdir(), "plr-snap-handlogs-"));
    const r = await makeSnapshot(SYNTHETIC, TZ, out);
    const { payload } = payloadOf(readFileSync(r.file, "utf8"));
    expect(Object.keys(payload.handlogs).sort()).toEqual(["", "Synthetic Autumn", "Synthetic Spring", "Synthetic Winter"]);
    for (const [folder, p] of Object.entries(payload.handlogs)) {
      expect(p.basis).toBe("");
      expect(p.scope).toEqual({ folder, from: null, to: null });
    }
    expect(payload.handlogs[""]?.logged).toBe(2);
    expect(payload.handlogs["Synthetic Autumn"]?.logged).toBe(2);
    expect(payload.handlogs["Synthetic Spring"]?.nights).toEqual([]);
    // The same as the server works out for the same data.
    const hw = handWorldFromInputs(await loadDataRoot(SYNTHETIC), TZ);
    expect(payload.handlogs[""]).toEqual(handScopePayload(hw, { folder: "", from: null, to: null }, ""));
  }, 120_000);

  it("carries only the six files the app keeps, not the console's own reports", async () => {
    const root = mkdtempSync(join(tmpdir(), "plr-snap-saved-"));
    mkdirSync(join(root, "Saved_Data"));
    writeFileSync(join(root, "Saved_Data", "merge_rules.csv"), "alias,canonical\ndellab,della\n");
    writeFileSync(join(root, "Saved_Data", "player_summary.csv"), "name,total\nDella,12.50\n");
    const out = mkdtempSync(join(tmpdir(), "plr-snap-out-"));
    const r = await makeSnapshot(root, TZ, out);
    const { json, payload } = payloadOf(readFileSync(r.file, "utf8"));
    expect(Object.keys(payload.saved).sort()).toEqual([...SAVED_DATA_FILES].sort());
    expect(payload.saved["merge_rules.csv"]).toBe("alias,canonical\ndellab,della\n");
    expect(payload.saved["settings.csv"]).toBe("");
    expect(json).not.toContain("player_summary");
  }, 120_000);

  it("refuses a folder that is not the console app's, and writes nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "plr-snap-empty-"));
    const out = mkdtempSync(join(tmpdir(), "plr-snap-out-"));
    await expect(makeSnapshot(root, TZ, out)).rejects.toThrow(/no snapshot was made/);
    await expect(makeSnapshot(join(root, "missing"), TZ, out)).rejects.toThrow(/no snapshot was made/);
    expect(readdirSync(out)).toEqual([]);
  });

  it("leaves no build folder behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "plr-snap-clean-"));
    mkdirSync(join(root, "Saved_Data"));
    const out = mkdtempSync(join(tmpdir(), "plr-snap-out-"));
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("plr-snapshot-")));
    await makeSnapshot(root, TZ, out);
    const left = readdirSync(tmpdir()).filter((n) => n.startsWith("plr-snapshot-") && !before.has(n));
    expect(left).toEqual([]);
  }, 120_000);
});

describe("downloading a snapshot", () => {
  async function get(name: string, dir: string, remoteAddress = "127.0.0.1", host = "127.0.0.1:5173"): Promise<{ status: number; disposition: string }> {
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
    const req = Readable.from([]);
    Object.assign(req, { method: "GET", url: `/api/snapshot/${name}`, headers: { host }, socket: { remoteAddress, localPort: 5173 } });
    await handleSnapshotFile({ dataRoot: dir, timeZone: TZ, snapshotDir: dir }, req as unknown as IncomingMessage, res as unknown as ServerResponse, name);
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
    expect((await get("poker-ledger-2031-05-01.html", dir, "127.0.0.1", "evil.example:5173")).status).toBe(403);
  });

  it("decodes the name inside the handler, and answers a bad encoding with 400 instead of throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plr-snap-enc-"));
    writeFileSync(join(dir, "poker-ledger-2031-05-01.html"), "<!doctype html>");
    expect((await get("%E0%A4%A", dir)).status).toBe(400);
    expect((await get("poker-ledger-2031-05-01%2Ehtml", dir)).status).toBe(200);
  });
});
