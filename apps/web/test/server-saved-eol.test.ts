// A Saved_Data save keeps the file's own line endings and byte order mark. The console writes its
// files as text, so on Windows they have CRLF line ends; the website's text is LF, and it is written
// the way the file already is. A file with no BOM gets none, and a file with LF gets LF.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { players } from "../../../packages/core/src/index.ts";
import { dataBasis, handleSavedFile, type ApiConfig } from "../server/api.ts";

const PORT = 5173;
const RULES = players.serializeMergeRulesCSV(new Map([["dellab", "della"]]));
const MORE_RULES = players.serializeMergeRulesCSV(players.addMergeRule(players.parseMergeRulesCSV(RULES), "dells", "della"));
const BOM = "\uFEFF";
const crlf = (s: string): string => s.replace(/\n/g, "\r\n");

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

interface Reply {
  status: number;
  body: { error?: string; backup?: string | null };
}

async function save(cfg: ApiConfig, body: Record<string, unknown>): Promise<Reply> {
  const out: Reply = { status: 0, body: {} };
  const res = {
    statusCode: 0,
    setHeader() {},
    end(text: string) {
      out.status = this.statusCode;
      out.body = JSON.parse(text) as Reply["body"];
    },
  };
  await handleSavedFile(cfg, make(body), res as unknown as ServerResponse);
  return out;
}

// A data folder holding merge_rules.csv with the given text, and the save's config.
function folderWith(text: string): { root: string; cfg: ApiConfig; file: string } {
  const root = mkdtempSync(join(tmpdir(), "plr-eol-"));
  mkdirSync(join(root, "Saved_Data"));
  mkdirSync(join(root, "Games"));
  const file = join(root, "Saved_Data", "merge_rules.csv");
  writeFileSync(file, text, "utf8");
  const cfg: ApiConfig = {
    dataRoot: root,
    timeZone: "America/New_York",
    consoleProbe: async () => ({ open: 0 }),
    backupDir: join(root, "backups"),
  };
  return { root, cfg, file };
}

// The save the page sends: its text (LF, as the core writes it) and the file's text as the page read it.
async function saveRules(root: string, cfg: ApiConfig, before: string, text: string): Promise<Reply> {
  return save(cfg, { file: "merge_rules.csv", before, text, basis: await dataBasis(root) });
}

describe("a Saved_Data save keeps the file's line ends and byte order mark", () => {
  it("writes CRLF into a file that has CRLF, and keeps the old bytes in the backup", async () => {
    const before = crlf(RULES);
    const { root, cfg, file } = folderWith(before);
    const r = await saveRules(root, cfg, before, MORE_RULES);
    expect(r.status).toBe(200);
    const after = readFileSync(file, "utf8");
    expect(after).toBe(crlf(MORE_RULES));
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
    expect(readFileSync(String(r.body.backup), "utf8")).toBe(before);
  });

  it("keeps a byte order mark that the file has, and writes it back first", async () => {
    const before = BOM + RULES;
    const { root, cfg, file } = folderWith(before);
    const r = await saveRules(root, cfg, before, MORE_RULES);
    expect(r.status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe(BOM + MORE_RULES);
  });

  it("keeps the byte order mark and the CRLF together", async () => {
    const before = BOM + crlf(RULES);
    const { root, cfg, file } = folderWith(before);
    expect((await saveRules(root, cfg, before, MORE_RULES)).status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe(BOM + crlf(MORE_RULES));
  });

  it("writes LF into a file that has LF, with no byte order mark added", async () => {
    const { root, cfg, file } = folderWith(RULES);
    expect((await saveRules(root, cfg, RULES, MORE_RULES)).status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe(MORE_RULES);
  });

  it("leaves a CRLF file alone when the text is the same rows (no backup, no change)", async () => {
    const before = crlf(RULES);
    const { root, cfg, file } = folderWith(before);
    const r = await saveRules(root, cfg, before, RULES);
    expect(r.status).toBe(200);
    expect(r.body.backup).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
