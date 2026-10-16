// The Saved_Data writer behind the website's buttons: what it writes, what it keeps,
// and everything it refuses. Each test gets its own temporary data root.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { players, sessions } from "../../../packages/core/src/index.ts";
import { countConsoleApps, handleSavedFile, type ApiConfig } from "../server/api.ts";

function request(body: unknown, headers: Record<string, string | undefined> = {}, remoteAddress = "127.0.0.1"): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method: "POST",
    url: "/api/saved-file",
    headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173", "x-plr": "1", ...headers },
    socket: { remoteAddress },
  });
  return req as unknown as IncomingMessage;
}

interface Reply {
  status: number;
  body: { error?: string; saved?: string; backup?: string | null };
}

async function call(cfg: ApiConfig, req: IncomingMessage): Promise<Reply> {
  const out: Reply = { status: 0, body: {} };
  const res = {
    statusCode: 0,
    setHeader() {},
    end(text: string) {
      out.status = this.statusCode;
      out.body = JSON.parse(text) as Reply["body"];
    },
  };
  await handleSavedFile(cfg, req, res as unknown as ServerResponse);
  return out;
}

function setup(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "plr-saved-"));
  mkdirSync(join(root, "Saved_Data"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "Saved_Data", name), text);
  const backupDir = join(root, "backups");
  const cfg: ApiConfig = { dataRoot: root, timeZone: "America/New_York", consoleCheck: false, backupDir };
  return {
    cfg,
    read: (name: string) => readFileSync(join(root, "Saved_Data", name), "utf8"),
    exists: (name: string) => existsSync(join(root, "Saved_Data", name)),
    backups: () => (existsSync(backupDir) ? readdirSync(backupDir) : []),
    backupText: (name: string) => readFileSync(join(backupDir, name), "utf8"),
  };
}

const RULES = players.serializeMergeRulesCSV(new Map([["dellab", "della"]]));
const MORE_RULES = players.serializeMergeRulesCSV(players.addMergeRule(players.parseMergeRulesCSV(RULES), "dells", "della"));

describe("saving a Saved_Data file from the website", () => {
  it("writes what the console app would write, and keeps the old version", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    const r = await call(t.cfg, request({ file: "merge_rules.csv", before: RULES, text: MORE_RULES }));
    expect(r.status).toBe(200);
    expect(t.read("merge_rules.csv")).toBe(MORE_RULES);
    const kept = t.backups();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/_merge_rules\.csv$/);
    expect(t.backupText(kept[0] ?? "")).toBe(RULES);
  });

  it("creates a file the data folder does not have yet, with nothing to back up", async () => {
    const t = setup({});
    const sheet = sessions.serializeSessionBalances(
      sessions.addSettlementBatch(new Map(), "night_one", [
        { fromDisplay: "Della", fromNormalized: "della", toDisplay: "Ozzie", toNormalized: "ozzie", amountCents: 1250, reason: "auto" },
      ]),
    );
    const r = await call(t.cfg, request({ file: "session_balances.csv", before: "", text: sheet }));
    expect(r.status).toBe(200);
    expect(r.body.backup).toBeNull();
    expect(t.read("session_balances.csv")).toBe(sheet);
    expect(t.backups()).toHaveLength(0);
  });

  it("changes nothing when the file changed since the page read it", async () => {
    const t = setup({ "merge_rules.csv": MORE_RULES });
    const r = await call(t.cfg, request({ file: "merge_rules.csv", before: RULES, text: RULES }));
    expect(r.status).toBe(409);
    expect(t.read("merge_rules.csv")).toBe(MORE_RULES);
    expect(t.backups()).toHaveLength(0);
  });

  it("refuses text the console app would not write", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    for (const text of [RULES + "junk\n", RULES.replace("\n", "\r\n"), "", "alias,canonical\n"]) {
      const r = await call(t.cfg, request({ file: "merge_rules.csv", before: RULES, text }));
      expect(r.status, JSON.stringify(text)).toBe(400);
    }
    const r = await call(t.cfg, request({ file: "merge_rules.csv", before: RULES, text: 42 }));
    expect(r.status).toBe(400);
    expect(t.read("merge_rules.csv")).toBe(RULES);
  });

  it("refuses any file that is not one of the six the console app keeps", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    for (const file of ["../Games/ledger_x.csv", "player_summary.csv", "__proto__", "constructor", "toString", "Merge_Rules.csv", 7]) {
      const r = await call(t.cfg, request({ file, before: RULES, text: RULES }));
      expect(r.status, String(file)).toBe(400);
    }
  });

  it("only takes changes from this page on this computer", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    const body = { file: "merge_rules.csv", before: RULES, text: MORE_RULES };
    expect((await call(t.cfg, request(body, { "x-plr": undefined }))).status).toBe(403);
    expect((await call(t.cfg, request(body, { origin: "http://elsewhere.example" }))).status).toBe(403);
    expect((await call(t.cfg, request(body, {}, "192.168.1.20"))).status).toBe(403);
    expect(t.read("merge_rules.csv")).toBe(RULES);
  });
});

describe("telling whether the console app is open", () => {
  it("counts the app's own executable, wherever it was built, and nothing else", () => {
    const ps = [
      "/Users/someone/Projects/Poker_Ledger_Reader/cmake-build-debug/Poker_Ledger_Reader",
      "./cmake-build-release/Poker_Ledger_Reader",
      "C:\\Users\\someone\\Poker_Ledger_Reader\\build\\Poker_Ledger_Reader.exe",
      "/Applications/CLion.app/Contents/MacOS/clion",
      "/private/tmp/scratch/plr",
      "/tmp/Poker_Ledger_Reader_tests",
      "vim Poker_Ledger_Reader",
      "",
    ].join("\n");
    expect(countConsoleApps(ps)).toBe(3);
    expect(countConsoleApps("")).toBe(0);
  });
});
