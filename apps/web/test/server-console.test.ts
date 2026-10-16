// The console app check: what counts as open, and what a check that fails or takes too
// long does. Such a check must refuse a save (423), never assume the app is closed. The
// processes come from a fake runner, with made-up output.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { players } from "../../../packages/core/src/index.ts";
import {
  countConsoleApps,
  countTasklistApps,
  dataBasis,
  handleData,
  handleSavedFile,
  probeConsoleApps,
  type ApiConfig,
  type ConsoleCheck,
  type ConsoleRunner,
} from "../server/api.ts";

const PORT = 5173;
const RULES = players.serializeMergeRulesCSV(new Map([["dellab", "della"]]));
const MORE_RULES = players.serializeMergeRulesCSV(players.addMergeRule(players.parseMergeRulesCSV(RULES), "dells", "della"));

function enoent(): Error {
  return Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT" });
}

function timedOut(): Error {
  return Object.assign(new Error("Command failed: ps -axo comm="), { killed: true, signal: "SIGTERM" });
}

// A runner that answers with the given output, or fails with the given error, and records each call.
function runner(answer: string | Error, calls: string[][] = []): ConsoleRunner {
  return async (file, args) => {
    calls.push([file, ...args]);
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "plr-console-"));
  mkdirSync(join(root, "Saved_Data"));
  writeFileSync(join(root, "Saved_Data", "merge_rules.csv"), RULES);
  return root;
}

function getRequest(url: string): IncomingMessage {
  const req = Readable.from([]);
  Object.assign(req, { method: "GET", url, headers: { host: `127.0.0.1:${PORT}` }, socket: { remoteAddress: "127.0.0.1", localPort: PORT } });
  return req as unknown as IncomingMessage;
}

function saveRequest(body: Record<string, unknown>): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method: "POST",
    url: "/api/saved-file",
    headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "x-plr": "1" },
    socket: { remoteAddress: "127.0.0.1", localPort: PORT },
  });
  return req as unknown as IncomingMessage;
}

async function reply(handle: (res: ServerResponse) => Promise<void>): Promise<{ status: number; body: Record<string, unknown> }> {
  const out: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
  const res = {
    statusCode: 0,
    setHeader() {},
    end(text: string) {
      out.status = this.statusCode;
      out.body = JSON.parse(text) as Record<string, unknown>;
    },
  };
  await handle(res as unknown as ServerResponse);
  return out;
}

describe("counting the console app's processes", () => {
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

  it("counts the name Linux's ps gives a command: cut to 15 characters", () => {
    const ps = ["Poker_Ledger_Re", "bash", "/home/someone/build/Poker_Ledger_Re", "Poker_Ledger_Rex", "vim Poker_Ledger_Re"].join("\n");
    expect(countConsoleApps(ps)).toBe(2);
  });

  it("counts the console app's windows in tasklist output on Windows", () => {
    const out = [
      '"Poker_Ledger_Reader.exe","4321","Console","1","12,000 K"',
      '"notepad.exe","99","Console","1","3,000 K"',
      "INFO: No tasks are running which match the specified criteria.",
    ].join("\n");
    expect(countTasklistApps(out)).toBe(1);
    expect(countTasklistApps("")).toBe(0);
  });
});

describe("the check itself", () => {
  it("reads the process list with ps on Mac and Linux, and with tasklist on Windows", async () => {
    const calls: string[][] = [];
    await probeConsoleApps("darwin", runner("", calls));
    await probeConsoleApps("linux", runner("", calls));
    await probeConsoleApps("win32", runner("", calls));
    expect(calls).toEqual([
      ["ps", "-axo", "comm="],
      ["ps", "-axo", "comm="],
      ["tasklist", "/FO", "CSV", "/NH"],
    ]);
  });

  it("counts the console app through the probe, on Linux and on Windows", async () => {
    expect(await probeConsoleApps("linux", runner("/usr/bin/Poker_Ledger_Re\n"))).toEqual({ open: 1 });
    expect(await probeConsoleApps("win32", runner('"Poker_Ledger_Reader.exe","4321","Console","1","1 K"\n'))).toEqual({ open: 1 });
  });

  it("treats a missing ps as nothing that can be seen here, so nothing counts as open", async () => {
    expect(await probeConsoleApps("linux", runner(enoent()))).toEqual({ open: 0 });
  });

  it("treats any other failure as unknown, so a save waits", async () => {
    const check = await probeConsoleApps("linux", runner(new Error("ps: permission denied\nmore detail")));
    expect(check).toEqual({ unknown: "ps: permission denied" });
  });

  it("treats a check that takes too long as unknown", async () => {
    const check = await probeConsoleApps("linux", runner(timedOut()));
    expect("unknown" in check && check.unknown.includes("longer than 5 seconds")).toBe(true);
  });
});

describe("what a check that did not give an answer does to a save and to the page", () => {
  async function saveWith(probe: () => Promise<ConsoleCheck>) {
    const root = dataRoot();
    const cfg: ApiConfig = { dataRoot: root, timeZone: "America/New_York", consoleProbe: probe, backupDir: join(root, "backups") };
    const basis = await dataBasis(root);
    const r = await reply((res) => handleSavedFile(cfg, saveRequest({ file: "merge_rules.csv", before: RULES, text: MORE_RULES, basis }), res));
    return { root, cfg, r };
  }

  it("answers 423 when the check could not tell, and changes nothing", async () => {
    const { root, r } = await saveWith(async () => ({ unknown: "Command failed: ps -axo comm=" }));
    expect(r.status).toBe(423);
    expect(String(r.body.error)).toContain("Could not tell whether the console app is open");
    expect(r.body.consoleOpen).toBe(-1);
    expect(readFileSync(join(root, "Saved_Data", "merge_rules.csv"), "utf8")).toBe(RULES);
  });

  it("answers 423 while the console app is open, and says how many windows", async () => {
    const { root, r } = await saveWith(async () => ({ open: 2 }));
    expect(r.status).toBe(423);
    expect(String(r.body.error)).toContain("2 windows");
    expect(r.body.consoleOpen).toBe(2);
    expect(readFileSync(join(root, "Saved_Data", "merge_rules.csv"), "utf8")).toBe(RULES);
  });

  it("saves when the check found no console app", async () => {
    const { root, r } = await saveWith(async () => ({ open: 0 }));
    expect(r.status).toBe(200);
    expect(readFileSync(join(root, "Saved_Data", "merge_rules.csv"), "utf8")).toBe(MORE_RULES);
  });

  it("reports on the page -1 when the check could not tell, and the count otherwise", async () => {
    const root = dataRoot();
    const base = { dataRoot: root, timeZone: "America/New_York", backupDir: join(root, "backups") };
    const unknown = await reply((res) =>
      handleData({ ...base, consoleProbe: async () => ({ unknown: "timed out" }) }, getRequest("/api/data"), res),
    );
    expect(unknown.status).toBe(200);
    expect(unknown.body.consoleOpen).toBe(-1);
    const open = await reply((res) => handleData({ ...base, consoleProbe: async () => ({ open: 1 }) }, getRequest("/api/data"), res));
    expect(open.body.consoleOpen).toBe(1);
    const noPs = await reply((res) =>
      handleData({ ...base, consoleProbe: () => probeConsoleApps("linux", runner(enoent())) }, getRequest("/api/data"), res),
    );
    expect(noPs.body.consoleOpen).toBe(0);
  });
});
