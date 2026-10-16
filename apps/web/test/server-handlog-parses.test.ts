// The hand-log read keeps each file's parse (server/handlogs.ts): a new basis pairs again without parsing
// the files again, a file whose text changed is parsed again (and only that one), and the loaded logs are
// the ones core's own loader gives (the same logs, messages and pairing). Made-up data only.
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ledger, loadHandWorld, loadWorld, type Scope } from "../../../packages/core/src/index.ts";
import { loadDataRoot } from "../../../tools/load.ts";
import { createHandLogCache, handWorldInTurns, savedForPage } from "../server/handlogs.ts";

const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
const TZ = "America/New_York";
const WHOLE: Scope = { folder: "", from: null, to: null };
const HAND_LOG = /(^|\/)poker_now_log_[^/]*\.csv$/i;

// A copy of the made-up data, so a test may change a file in it.
function copyOfSynthetic(): string {
  const root = mkdtempSync(join(tmpdir(), "plr-handlog-parses-"));
  cpSync(SYNTHETIC, root, { recursive: true });
  return root;
}

// The path (under root) of the first hand log in it.
function firstLog(root: string): string {
  const found = readdirSync(root, { recursive: true })
    .map(String)
    .find((p) => HAND_LOG.test(p));
  if (found === undefined) throw new Error("the made-up data has no hand log");
  return join(root, found);
}

describe("the hand-log cache keeps each file's parse", () => {
  it("pairs again for a new basis without parsing the files again", async () => {
    const cache = createHandLogCache();
    const first = await cache.payloadFor(SYNTHETIC, TZ, "b1", WHOLE);
    const parsed = cache.parses();
    expect(parsed).toBeGreaterThan(0);
    const second = await cache.payloadFor(SYNTHETIC, TZ, "b2", WHOLE);
    expect(cache.parses()).toBe(parsed);
    expect(cache.status().loads).toBe(2);
    expect(second.logged).toBe(first.logged);
    // The same answer as a cache that reads everything itself under the new basis.
    const alone = createHandLogCache();
    expect(second).toEqual(await alone.payloadFor(SYNTHETIC, TZ, "b2", WHOLE));
    alone.close();
    cache.close();
  });

  it("parses a file again when its text changed, and only that file", async () => {
    const root = copyOfSynthetic();
    const cache = createHandLogCache();
    await cache.payloadFor(root, TZ, "b1", WHOLE);
    const before = cache.parses();
    appendFileSync(firstLog(root), "\n");
    await cache.payloadFor(root, TZ, "b2", WHOLE);
    expect(cache.parses()).toBe(before + 1);
    cache.close();
  });

  it("reads the logs the way core's loader does: the same logs, messages and pairing", async () => {
    const root = copyOfSynthetic();
    // The same game filed twice (in a folder of Games/, where the hand logs are read): core keeps one and says it ignored the other.
    const dir = join(root, "Games", "Copy of games");
    mkdirSync(dir);
    copyFileSync(firstLog(root), join(dir, basename(firstLog(root))));
    const inputs = await loadDataRoot(root);
    const ledgers = inputs.games.filter((g) => ledger.looksLikeLedger(g.text));
    const logs = inputs.games.filter((g) => HAND_LOG.test(g.relativePath));
    const reference = loadHandWorld(loadWorld({ timeZone: TZ, ledgers, saved: savedForPage(inputs.savedData) }), logs);
    expect(reference.messages.some((m) => m.startsWith("Duplicate hand log ignored"))).toBe(true);

    const ours = await handWorldInTurns(inputs, TZ);
    expect(ours.messages).toEqual(reference.messages);
    expect([...ours.logs.keys()]).toEqual([...reference.logs.keys()]);
    for (const [id, log] of reference.logs) {
      const mine = ours.logs.get(id);
      expect(mine?.path).toBe(log.path);
      expect(mine?.hands.length).toBe(log.hands.length);
      expect(JSON.stringify([...(mine?.seats ?? [])])).toBe(JSON.stringify([...log.seats]));
    }
  });
});
