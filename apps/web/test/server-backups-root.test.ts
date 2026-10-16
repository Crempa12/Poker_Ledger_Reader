// The old versions of a Saved_Data file are kept per data folder. Two data folders that share one
// backup folder (a test server's scratch copy, say, with no PLR_BACKUP_DIR of its own) must not
// count toward each other's 50, so a save from one never removes the other's oldest version.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { players } from "../../../packages/core/src/index.ts";
import { dataBasis, handleSavedFile, type ApiConfig } from "../server/api.ts";

const PORT = 5173;
const RULES = players.serializeMergeRulesCSV(new Map([["dellab", "della"]]));

function make(body: unknown): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method: "POST",
    url: "/api/saved-file",
    headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "x-plr": "1" },
    socket: { remoteAddress: "127.0.0.1", localPort: PORT },
  });
  return req as unknown as IncomingMessage;
}

async function save(cfg: ApiConfig, body: Record<string, unknown>): Promise<number> {
  let status = 0;
  const res = {
    statusCode: 0,
    setHeader() {},
    end(_text: string) {
      status = this.statusCode;
    },
  };
  await handleSavedFile(cfg, make(body), res as unknown as ServerResponse);
  return status;
}

// A data folder with its own merge_rules.csv, using the shared backup folder.
function folder(backupDir: string): { root: string; cfg: ApiConfig } {
  const root = mkdtempSync(join(tmpdir(), "plr-backup-root-"));
  mkdirSync(join(root, "Saved_Data"));
  mkdirSync(join(root, "Games"));
  writeFileSync(join(root, "Saved_Data", "merge_rules.csv"), RULES);
  return { root, cfg: { dataRoot: root, timeZone: "America/New_York", consoleProbe: async () => ({ open: 0 }), backupDir } };
}

// Every backup file under the shared folder (they may sit in one folder per data folder).
function allBackups(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"));
}

describe("the old versions kept for each data folder", () => {
  it("does not let a save from another data folder remove the oldest version of this one", async () => {
    const shared = mkdtempSync(join(tmpdir(), "plr-shared-backups-"));
    const a = folder(shared);
    // Every save changes the rules, so each one keeps a version of the file.
    let before = RULES;
    let rules = players.parseMergeRulesCSV(RULES);
    // Names made of letters only (the rules drop digits), all different.
    const alias = (i: number): string => `aka${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;
    for (let i = 0; i < 50; i++) {
      rules = players.addMergeRule(rules, alias(i), "della");
      const text = players.serializeMergeRulesCSV(rules);
      expect(await save(a.cfg, { file: "merge_rules.csv", before, text, basis: await dataBasis(a.root) })).toBe(200);
      before = text;
    }
    // The first save's version (the original rules) is the oldest one kept for this data folder.
    expect(allBackups(shared)).toContain(RULES);

    const b = folder(shared);
    const bText = players.serializeMergeRulesCSV(players.addMergeRule(players.parseMergeRulesCSV(RULES), "other", "della"));
    expect(await save(b.cfg, { file: "merge_rules.csv", before: RULES, text: bText, basis: await dataBasis(b.root) })).toBe(200);

    expect(allBackups(shared)).toContain(RULES);
  });
});
