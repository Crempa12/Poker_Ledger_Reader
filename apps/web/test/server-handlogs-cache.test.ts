// The cache of hand-log results (server/handlogs.ts): one read per data basis, the last scopes
// kept, one read shared by concurrent asks, the idle drop, and a failed read not kept.
// Made-up data only.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { Scope } from "../../../packages/core/src/index.ts";
import { createHandLogCache, SCOPE_CACHE_SIZE } from "../server/handlogs.ts";

const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
const TZ = "America/New_York";
const WHOLE: Scope = { folder: "", from: null, to: null };
const AUTUMN: Scope = { folder: "Synthetic Autumn", from: null, to: null };

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

describe("the hand-log cache", () => {
  it("reads the hand logs once for a basis, and answers the next asks from memory", async () => {
    const cache = createHandLogCache();
    const whole = await cache.payloadFor(SYNTHETIC, TZ, "b1", WHOLE);
    const autumn = await cache.payloadFor(SYNTHETIC, TZ, "b1", AUTUMN);
    const again = await cache.payloadFor(SYNTHETIC, TZ, "b1", WHOLE);
    expect(cache.status()).toEqual({ loads: 1, held: true, scopes: 2 });
    expect(again).toBe(whole);
    expect(autumn.logged).toBe(2);
    cache.close();
  });

  it("shares one read between asks that come at once", async () => {
    const cache = createHandLogCache();
    const [whole, autumn, whole2] = await Promise.all([
      cache.payloadFor(SYNTHETIC, TZ, "b1", WHOLE),
      cache.payloadFor(SYNTHETIC, TZ, "b1", AUTUMN),
      cache.payloadFor(SYNTHETIC, TZ, "b1", WHOLE),
    ]);
    expect(cache.status().loads).toBe(1);
    expect(whole2).toBe(whole);
    expect(autumn.scope.folder).toBe("Synthetic Autumn");
    cache.close();
  });

  it("reads again when the basis changes, and drops what it had", async () => {
    const cache = createHandLogCache();
    await cache.payloadFor(SYNTHETIC, TZ, "b1", WHOLE);
    await cache.payloadFor(SYNTHETIC, TZ, "b1", AUTUMN);
    const next = await cache.payloadFor(SYNTHETIC, TZ, "b2", WHOLE);
    expect(cache.status()).toEqual({ loads: 2, held: true, scopes: 1 });
    expect(next.basis).toBe("b2");
    cache.close();
  });

  it("keeps the scopes asked for last, twelve at most", async () => {
    const cache = createHandLogCache();
    const folder = (i: number): Scope => ({ folder: `no-such-folder-${i}`, from: null, to: null });
    const made: object[] = [];
    for (let i = 0; i <= SCOPE_CACHE_SIZE; i++) made.push(await cache.payloadFor(SYNTHETIC, TZ, "b1", folder(i)));
    expect(cache.status()).toEqual({ loads: 1, held: true, scopes: SCOPE_CACHE_SIZE });

    // The oldest (the first) was dropped, so it is worked out again: a new object.
    const first = await cache.payloadFor(SYNTHETIC, TZ, "b1", folder(0));
    expect(first).not.toBe(made[0]);
    // The newest is still there: the same object.
    expect(await cache.payloadFor(SYNTHETIC, TZ, "b1", folder(SCOPE_CACHE_SIZE))).toBe(made[SCOPE_CACHE_SIZE]);
    expect(cache.status()).toEqual({ loads: 1, held: true, scopes: SCOPE_CACHE_SIZE });
    cache.close();
  });

  it("forgets the hand logs after the idle time, and reads them again", async () => {
    const cache = createHandLogCache({ idleMs: 60 });
    await cache.payloadFor(SYNTHETIC, TZ, "b1", WHOLE);
    expect(cache.status()).toEqual({ loads: 1, held: true, scopes: 1 });
    await sleep(300);
    expect(cache.status()).toEqual({ loads: 1, held: false, scopes: 0 });
    await cache.payloadFor(SYNTHETIC, TZ, "b1", WHOLE);
    expect(cache.status()).toEqual({ loads: 2, held: true, scopes: 1 });
    cache.close();
  });

  it("does not drop the hand logs while an ask is still being answered", async () => {
    // The idle time is shorter than the read, so the countdown runs out during it.
    const cache = createHandLogCache({ idleMs: 1 });
    const payload = await cache.payloadFor(SYNTHETIC, TZ, "b1", WHOLE);
    expect(payload.logged).toBe(2);
    expect(cache.status().held).toBe(true);
    cache.close();
  });

  it("does not keep a read that failed, so the next ask reads again", async () => {
    const cache = createHandLogCache();
    await expect(cache.payloadFor(SYNTHETIC, "Not/A_Zone", "b1", WHOLE)).rejects.toThrow();
    expect(cache.status()).toEqual({ loads: 0, held: false, scopes: 0 });
    await expect(cache.payloadFor(SYNTHETIC, "Not/A_Zone", "b1", WHOLE)).rejects.toThrow();
    expect(cache.status().loads).toBe(0);
    cache.close();
  });

  it("drops everything when it is closed", async () => {
    const cache = createHandLogCache();
    await cache.payloadFor(SYNTHETIC, TZ, "b1", WHOLE);
    cache.close();
    expect(cache.status()).toEqual({ loads: 1, held: false, scopes: 0 });
  });
});
