// The Saved_Data writer behind the website's buttons: what it writes, what it keeps,
// and everything it refuses. Each test gets its own temporary data root. The console
// app's process check is covered in server-console.test.ts, the Host and proxy rules
// in server-requests.test.ts.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { players, sessions } from "../../../packages/core/src/index.ts";
import { backupFolderOf, dataBasis, handleSavedFile, type ApiConfig, type ConsoleCheck } from "../server/api.ts";

const PORT = 5173;
const STALE =
  "Something changed since this page loaded (a game was added, or a saved file changed). Press Refresh and do it again.";

function request(
  body: unknown,
  headers: Record<string, string | undefined> = {},
  remoteAddress = "127.0.0.1",
): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method: "POST",
    url: "/api/saved-file",
    headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "x-plr": "1", ...headers },
    socket: { remoteAddress, localPort: PORT },
  });
  return req as unknown as IncomingMessage;
}

interface Reply {
  status: number;
  body: { error?: string; saved?: string; backup?: string | null; consoleOpen?: number };
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

interface Setup {
  cfg: ApiConfig;
  root: string;
  read: (name: string) => string;
  backups: () => string[];
  backupText: (name: string) => string;
  // The save the page would send right now: the basis is the data folder's as it is at this moment.
  save: (body: Record<string, unknown>, headers?: Record<string, string | undefined>) => Promise<Reply>;
}

const CONSOLE_CLOSED = async (): Promise<ConsoleCheck> => ({ open: 0 });

function setup(files: Record<string, string>, probe: () => Promise<ConsoleCheck> = CONSOLE_CLOSED): Setup {
  const root = mkdtempSync(join(tmpdir(), "plr-saved-"));
  mkdirSync(join(root, "Saved_Data"));
  mkdirSync(join(root, "Games"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "Saved_Data", name), text);
  const backupDir = join(root, "backups");
  // This data folder's old versions are kept in a folder of their own inside backupDir.
  const ownBackups = backupFolderOf(backupDir, root);
  const cfg: ApiConfig = { dataRoot: root, timeZone: "America/New_York", consoleProbe: probe, backupDir };
  return {
    cfg,
    root,
    read: (name) => readFileSync(join(root, "Saved_Data", name), "utf8"),
    backups: () => (existsSync(ownBackups) ? readdirSync(ownBackups) : []),
    backupText: (name) => readFileSync(join(ownBackups, name), "utf8"),
    save: async (body, headers) => call(cfg, request({ basis: await dataBasis(root), ...body }, headers)),
  };
}

const RULES = players.serializeMergeRulesCSV(new Map([["dellab", "della"]]));
const MORE_RULES = players.serializeMergeRulesCSV(players.addMergeRule(players.parseMergeRulesCSV(RULES), "dells", "della"));
const OTHER_RULES = players.serializeMergeRulesCSV(players.addMergeRule(players.parseMergeRulesCSV(RULES), "dlla", "della"));
const SETTINGS = "key,value\nme,della\nbanker,\ndisplay,fancy\n";
const SHEET = sessions.serializeSessionBalances(
  sessions.addSettlementBatch(new Map(), "night_one", [
    { fromDisplay: "Della", fromNormalized: "della", toDisplay: "Ozzie", toNormalized: "ozzie", amountCents: 1250, reason: "auto" },
  ]),
);

describe("saving a Saved_Data file from the website", () => {
  it("writes what the console app would write, and keeps the old version", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    const r = await t.save({ file: "merge_rules.csv", before: RULES, text: MORE_RULES });
    expect(r.status).toBe(200);
    expect(t.read("merge_rules.csv")).toBe(MORE_RULES);
    const kept = t.backups();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/_merge_rules\.csv$/);
    expect(t.backupText(kept[0] ?? "")).toBe(RULES);
  });

  it("creates a file the data folder does not have yet, with nothing to back up", async () => {
    const t = setup({});
    const r = await t.save({ file: "session_balances.csv", before: "", text: SHEET });
    expect(r.status).toBe(200);
    expect(r.body.backup).toBeNull();
    expect(t.read("session_balances.csv")).toBe(SHEET);
    expect(t.backups()).toHaveLength(0);
  });

  it("changes nothing when the file changed since the page read it", async () => {
    const t = setup({ "merge_rules.csv": MORE_RULES });
    // The basis is the current one, so only the file's own text is out of date.
    const r = await t.save({ file: "merge_rules.csv", before: RULES, text: RULES });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("changed since this page read it");
    expect(t.read("merge_rules.csv")).toBe(MORE_RULES);
    expect(t.backups()).toHaveLength(0);
  });

  it("refuses text the console app would not write", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    for (const text of [RULES + "junk\n", RULES.replace("\n", "\r\n"), "", "alias,canonical\n"]) {
      const r = await t.save({ file: "merge_rules.csv", before: RULES, text });
      expect(r.status, JSON.stringify(text)).toBe(400);
    }
    const r = await t.save({ file: "merge_rules.csv", before: RULES, text: 42 });
    expect(r.status).toBe(400);
    expect(t.read("merge_rules.csv")).toBe(RULES);
  });

  it("refuses any file that is not one of the six the console app keeps", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    for (const file of ["../Games/ledger_x.csv", "player_summary.csv", "__proto__", "constructor", "toString", "Merge_Rules.csv", 7]) {
      const r = await t.save({ file, before: RULES, text: RULES });
      expect(r.status, String(file)).toBe(400);
    }
  });

  it("accepts what the console app itself writes: an unknown date, a status word it keeps", async () => {
    const t = setup({});
    const adjustments = "group,date,player_normalized,amount,folder,note\ng1,unknown,della,12.50,,paid\n";
    const r1 = await t.save({ file: "adjustments.csv", before: "", text: adjustments });
    expect(r1.status).toBe(200);
    expect(t.read("adjustments.csv")).toBe(adjustments);
    const balances =
      "session_id,from_display,from_normalized,to_display,to_normalized,original_amount,remaining_amount,status\n" +
      "night_one,Della,della,Ozzie,ozzie,12.50,12.50,settled-ish\n";
    const r2 = await t.save({ file: "session_balances.csv", before: "", text: balances });
    expect(r2.status).toBe(200);
    expect(t.read("session_balances.csv")).toBe(balances);
  });

  it("refuses a payment preference that pays oneself, and takes the same row without it", async () => {
    const t = setup({});
    const header = "payer_normalized,payee_normalized,note\n";
    const selfPin = await t.save({ file: "payment_preferences.csv", before: "", text: header + "della,della,\n" });
    expect(selfPin.status).toBe(400);
    expect(t.backups()).toHaveLength(0);
    const pin = await t.save({ file: "payment_preferences.csv", before: "", text: header + "della,ozzie,\n" });
    expect(pin.status).toBe(200);
    expect(t.read("payment_preferences.csv")).toBe(header + "della,ozzie,\n");
  });
});

describe("who may change a Saved_Data file", () => {
  it("only takes changes from this page on this computer", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    const body = { file: "merge_rules.csv", before: RULES, text: MORE_RULES };
    expect((await t.save(body, { "x-plr": undefined })).status).toBe(403);
    expect((await t.save(body, { origin: "http://elsewhere.example" })).status).toBe(403);
    expect((await t.save(body, { origin: "http://127.0.0.1:5174" })).status).toBe(403);
    expect((await t.save(body, { origin: undefined })).status).toBe(403); // a browser always sends its Origin with a change
    expect((await t.save(body, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await t.save(body, { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await t.save(body, { host: "127.0.0.1:9999", origin: "http://127.0.0.1:9999" })).status).toBe(403);
    expect((await t.save(body, { "x-forwarded-for": "203.0.113.9" })).status).toBe(403);
    expect((await call(t.cfg, request({ ...body, basis: await dataBasis(t.root) }, {}, "192.168.1.20"))).status).toBe(403);
    expect(t.read("merge_rules.csv")).toBe(RULES);
  });
});

describe("the basis: the whole data folder, not only the one file", () => {
  it("refuses a save when a game was added since the page loaded", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    const basis = await dataBasis(t.root);
    writeFileSync(join(t.root, "Games", "ledger_pglAAAAAAAAAA.csv"), "made up\n");
    const r = await call(t.cfg, request({ file: "merge_rules.csv", before: RULES, text: MORE_RULES, basis }));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(STALE);
    expect(t.read("merge_rules.csv")).toBe(RULES);
  });

  it("refuses a save when another saved file changed since the page loaded", async () => {
    const t = setup({ "merge_rules.csv": RULES, "settings.csv": SETTINGS });
    const basis = await dataBasis(t.root);
    writeFileSync(join(t.root, "Saved_Data", "settings.csv"), "key,value\nme,ozzie\nbanker,\ndisplay,fancy\n");
    const r = await call(t.cfg, request({ file: "merge_rules.csv", before: RULES, text: MORE_RULES, basis }));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(STALE);
    expect(t.read("merge_rules.csv")).toBe(RULES);
  });

  it("refuses a save that carries no basis", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    const r = await call(t.cfg, request({ file: "merge_rules.csv", before: RULES, text: MORE_RULES }));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(STALE);
    expect(t.read("merge_rules.csv")).toBe(RULES);
  });
});

describe("saves of one file at the same time", () => {
  it("lets one of two saves through, and refuses the other", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    const basis = await dataBasis(t.root);
    const [a, b] = await Promise.all([
      call(t.cfg, request({ file: "merge_rules.csv", before: RULES, text: MORE_RULES, basis })),
      call(t.cfg, request({ file: "merge_rules.csv", before: RULES, text: OTHER_RULES, basis })),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
    expect(t.read("merge_rules.csv")).toBe(a.status === 200 ? MORE_RULES : OTHER_RULES);
    expect(t.backups()).toHaveLength(1);
  });

  it("refuses a save made on the basis of a version that a save has since replaced", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    const basis = await dataBasis(t.root);
    expect((await call(t.cfg, request({ file: "merge_rules.csv", before: RULES, text: MORE_RULES, basis }))).status).toBe(200);
    const again = await call(t.cfg, request({ file: "merge_rules.csv", before: RULES, text: OTHER_RULES, basis }));
    expect(again.status).toBe(409);
    expect(t.read("merge_rules.csv")).toBe(MORE_RULES);
  });
});

describe("the old versions kept in local/backups", () => {
  it("keeps only the newest 50 of each file, and leaves other files' backups alone", async () => {
    const t = setup({ "merge_rules.csv": RULES, "settings.csv": SETTINGS });
    mkdirSync(backupFolderOf(join(t.root, "backups"), t.root), { recursive: true });
    // Names start with the time they were kept, so these are older than any save made now.
    const old = Array.from({ length: 55 }, (_, i) => `2020-01-01T00-00-${String(i).padStart(2, "0")}-000Z_merge_rules.csv`);
    for (const name of old) writeFileSync(join(backupFolderOf(join(t.root, "backups"), t.root),name), RULES);
    for (let i = 0; i < 3; i++) writeFileSync(join(backupFolderOf(join(t.root, "backups"), t.root),`2020-01-01T00-00-0${i}-000Z_settings.csv`), SETTINGS);
    const r = await t.save({ file: "merge_rules.csv", before: RULES, text: MORE_RULES });
    expect(r.status).toBe(200);
    const mine = t.backups().filter((n) => n.endsWith("_merge_rules.csv")).sort();
    expect(mine).toHaveLength(50);
    expect(mine).not.toContain(old[5]); // 56 versions in all: the six oldest went
    expect(mine).toContain(old[6]);
    expect(mine.at(-1)?.startsWith("2020")).toBe(false); // the new one is the newest
    expect(t.backups().filter((n) => n.endsWith("_settings.csv"))).toHaveLength(3);
  });

  it("never removes the backup it just made, even when 50 older ones sort after it", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    mkdirSync(backupFolderOf(join(t.root, "backups"), t.root), { recursive: true });
    // Named as if the clock had been ahead: all 50 are later than the time of this save.
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(backupFolderOf(join(t.root, "backups"), t.root),`2031-01-01T00-00-${String(i).padStart(2, "0")}-000Z_merge_rules.csv`), RULES);
    }
    const r = await t.save({ file: "merge_rules.csv", before: RULES, text: MORE_RULES });
    expect(r.status).toBe(200);
    const reported = r.body.backup ?? "";
    expect(existsSync(reported)).toBe(true);
    expect(readFileSync(reported, "utf8")).toBe(RULES);
    expect(t.backups().filter((n) => n.endsWith("_merge_rules.csv"))).toHaveLength(50);
  });

  it("keeps the newest backups when the clock was moved back, so a later save does not remove them", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    mkdirSync(backupFolderOf(join(t.root, "backups"), t.root), { recursive: true });
    for (let i = 0; i < 49; i++) {
      writeFileSync(join(backupFolderOf(join(t.root, "backups"), t.root),`2031-01-01T00-00-${String(i).padStart(2, "0")}-000Z_merge_rules.csv`), RULES);
    }
    const first = await t.save({ file: "merge_rules.csv", before: RULES, text: MORE_RULES });
    const second = await t.save({ file: "merge_rules.csv", before: MORE_RULES, text: OTHER_RULES });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(readFileSync(first.body.backup ?? "", "utf8")).toBe(RULES);
    expect(readFileSync(second.body.backup ?? "", "utf8")).toBe(MORE_RULES);
    expect(t.backups().filter((n) => n.endsWith("_merge_rules.csv"))).toHaveLength(50);
  });

  it("refuses to rewrite a file whose bytes are not valid UTF-8, and keeps those bytes", async () => {
    const t = setup({});
    // A Latin-1 e-acute (0xE9) at the end of a note: not UTF-8.
    const raw = Buffer.from("alias,canonical\ndellab,della\nnote café", "latin1");
    writeFileSync(join(t.root, "Saved_Data", "merge_rules.csv"), raw);
    const r = await t.save({ file: "merge_rules.csv", before: raw.toString("utf8"), text: MORE_RULES });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("not plain UTF-8");
    expect(readFileSync(join(t.root, "Saved_Data", "merge_rules.csv")).equals(raw)).toBe(true);
    expect(t.backups()).toHaveLength(0);
  });

  it("does not count a file the app does not read, such as .DS_Store, as a change", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    const basis = await dataBasis(t.root);
    writeFileSync(join(t.root, "Saved_Data", ".DS_Store"), "made by Finder");
    const r = await call(t.cfg, request({ file: "merge_rules.csv", before: RULES, text: MORE_RULES, basis }));
    expect(r.status).toBe(200);
    expect(t.read("merge_rules.csv")).toBe(MORE_RULES);
  });

  it.skipIf(process.getuid?.() === 0)("removes the backup of a save that could not write, so the folder is left as it was", async () => {
    const t = setup({ "merge_rules.csv": RULES }, async () => {
      // Once the lock is held and the old text is read, the folder stops taking writes.
      chmodSync(join(t.root, "Saved_Data"), 0o555);
      return { open: 0 };
    });
    try {
      const r = await t.save({ file: "merge_rules.csv", before: RULES, text: MORE_RULES });
      expect(r.status).toBe(500);
      expect(String(r.body.error)).not.toContain(t.root);
      expect(t.backups()).toHaveLength(0);
      expect(t.read("merge_rules.csv")).toBe(RULES);
    } finally {
      chmodSync(join(t.root, "Saved_Data"), 0o755);
    }
  });
});

describe("saves from two servers on one data folder", () => {
  it("lets one of two saves of different files on the same basis through, and refuses the other", async () => {
    const t = setup({ "merge_rules.csv": RULES, "settings.csv": SETTINGS });
    const basis = await dataBasis(t.root);
    const [a, b] = await Promise.all([
      call(t.cfg, request({ file: "merge_rules.csv", before: RULES, text: MORE_RULES, basis })),
      call(t.cfg, request({ file: "settings.csv", before: SETTINGS, text: "key,value\nme,ozzie\nbanker,\ndisplay,fancy\n", basis })),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
  });

  it("waits for another server's save, and answers 423 when the wait runs out", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    const lock = join(t.root, "Saved_Data", ".web-save.lock");
    writeFileSync(lock, "4321\n");
    const basis = await dataBasis(t.root);
    const r = await call({ ...t.cfg, lockWaitMs: 0 }, request({ file: "merge_rules.csv", before: RULES, text: MORE_RULES, basis }));
    expect(r.status).toBe(423);
    expect(t.read("merge_rules.csv")).toBe(RULES);
    expect(existsSync(lock)).toBe(true); // the other server's lock is left alone
  });

  it("takes over a lock a process left behind, and lets go of its own lock afterwards", async () => {
    const t = setup({ "merge_rules.csv": RULES });
    const lock = join(t.root, "Saved_Data", ".web-save.lock");
    writeFileSync(lock, "4321\n");
    const longAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, longAgo, longAgo);
    const r = await t.save({ file: "merge_rules.csv", before: RULES, text: MORE_RULES });
    expect(r.status).toBe(200);
    expect(existsSync(lock)).toBe(false);
  });

  it("lets go of its lock when a save is refused", async () => {
    const t = setup({ "merge_rules.csv": MORE_RULES });
    const r = await t.save({ file: "merge_rules.csv", before: RULES, text: OTHER_RULES });
    expect(r.status).toBe(409);
    expect(existsSync(join(t.root, "Saved_Data", ".web-save.lock"))).toBe(false);
  });
});
