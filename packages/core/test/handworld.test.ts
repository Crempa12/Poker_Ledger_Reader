// The hand-log facade (handworld.ts) on the made-up data: the logs load and pair with their ledgers,
// every export of a scope is written exactly when the app writes it, and the player history gets its
// time and its showdown note. The byte-for-byte check against the C++ app is tools/parity.ts; these
// tests pin what the facade promises on its own. Made-up data only (fixtures/synthetic).

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadDataRoot } from "../../../tools/load.ts";
import { atTheTable, beatenAtShowdown, handViewOf, loadHandWorld } from "../src/handworld.ts";
import type { HandWorld } from "../src/handworld.ts";
import type { Scope } from "../src/models.ts";
import { loadWorld } from "../src/world.ts";

const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic", import.meta.url));
const ALL: Scope = { folder: "", from: null, to: null };
const AUTUMN: Scope = { folder: "Synthetic Autumn", from: null, to: null };
const WINTER: Scope = { folder: "Synthetic Winter", from: null, to: null };

// The made-up data read the way the app reads it, with its two hand logs paired.
async function syntheticHands(): Promise<HandWorld> {
  const inputs = await loadDataRoot(SYNTHETIC);
  const world = loadWorld({ timeZone: "America/New_York", ledgers: inputs.games, saved: inputs.savedData });
  return loadHandWorld(world, inputs.games);
}

describe("loadHandWorld: the hand logs of the made-up data", () => {
  it("loads both logs and pairs each with its ledger game", async () => {
    const hw = await syntheticHands();
    expect([...hw.logs.keys()].sort()).toEqual(["pglFAKE0014", "pglFAKE0015"]);
    expect(hw.messages.filter((m) => m.includes("hand log"))).toEqual([]);
    for (const id of ["pglFAKE0014", "pglFAKE0015"]) {
      expect(hw.logs.get(id)?.seats.size, id).toBeGreaterThan(0);
    }
  });

  it("keeps the special hands: a bomb pot, a run it twice, a bounty, a rebuy and a cut-short hand", async () => {
    const hw = await syntheticHands();
    const night14 = hw.logs.get("pglFAKE0014");
    const night15 = hw.logs.get("pglFAKE0015");
    expect(night14?.hands.some((h) => h.runItTwice)).toBe(true);
    expect(night14?.events.some((e) => e.kind === "rebuy")).toBe(true);
    expect(night14?.hands.at(-1)?.actions.length ?? 0).toBeGreaterThan(0);
    expect(night15?.hands.some((h) => h.bombPot)).toBe(true);
    expect(night15?.hands.some((h) => h.bounty.size > 0)).toBe(true);
    expect(night14?.stackMismatches).toBe(0);
    expect(night15?.stackMismatches).toBe(0);
  });
});

describe("handViewOf: the menu 21 rows carry their hit & run columns", () => {
  it("gives each profile the factor and tag of the person's style row, as deepPlaystyle does", async () => {
    // The edge data has people with enough winning nights for a factor and a tag.
    const inputs = await loadDataRoot(fileURLToPath(new URL("../../../fixtures/synthetic-edge", import.meta.url)));
    const world = loadWorld({ timeZone: "America/New_York", ledgers: inputs.games, saved: inputs.savedData });
    const view = handViewOf(loadHandWorld(world, inputs.games), ALL);
    const styleOf = new Map(view.style.map((s) => [s.normalizedName, s]));
    let judged = 0;
    for (const p of view.profiles) {
      const s = styleOf.get(p.normalizedName);
      if (s === undefined) continue;
      expect([p.hitRun, p.hitRunReliable, p.hitRunTag], p.normalizedName).toEqual([s.hitRun, s.hitRunReliable, s.hitRunTag]);
      if (p.hitRunTag !== "") judged++;
    }
    expect(judged).toBeGreaterThan(0);
  });
});

describe("handViewOf: an export is written exactly when the app writes it", () => {
  it("writes every hand-log export for a folder with logs", async () => {
    const view = handViewOf(await syntheticHands(), AUTUMN);
    expect(view.logs.length).toBe(2);
    expect(view.exports.styleStats?.startsWith("player,normalized,games,hands,")).toBe(true);
    expect(view.exports.playstyle?.startsWith("player,games,hands,hands_voluntary,")).toBe(true);
    expect(view.exports.hitAndRun?.startsWith("player,normalized,nights,")).toBe(true);
    expect(view.exports.hitAndRunNights?.startsWith("date,game,player,normalized,")).toBe(true);
    expect(view.exports.playerSummary.split("\n")[0]).toMatch(/,hands_dealt,nights_logged,seconds_dealt,seconds_estimated,hours,per_hour$/);
  });

  it("writes no hand-log export for a folder without logs, and keeps the ledger exports", async () => {
    const view = handViewOf(await syntheticHands(), WINTER);
    expect(view.logs).toEqual([]);
    expect(view.exports.styleStats).toBeNull();
    expect(view.exports.playstyle).toBeNull();
    expect(view.exports.hitAndRun).toBeNull();
    expect(view.exports.hitAndRunNights).toBeNull();
    expect(view.exports.playerSummary.split("\n")[0]).toMatch(/,per_hour$/);
    expect(view.exports.showdownRivals).toBe("loser,loser_normalized,winner,winner_normalized,times,amount\n");
  });
});

describe("the player history: time at the table and beaten at showdown", () => {
  it("gives a player who was dealt hands their time, and a showdown note for the scope", async () => {
    const view = handViewOf(await syntheticHands(), ALL);
    const time = atTheTable(view, "tovrin");
    expect(time?.hands).toBeGreaterThan(0);
    expect(time?.nightsLogged).toBeGreaterThan(0);
    const note = beatenAtShowdown(view, "tovrin");
    expect(note.noLogs).toBe(false);
    expect(note.coverText).toBe("2 of 14 games in scope have a hand log");
  });

  it("says there is nothing to read when the scope has no hand log", async () => {
    const view = handViewOf(await syntheticHands(), WINTER);
    expect(beatenAtShowdown(view, "zaqvin").noLogs).toBe(true);
    // No hand was dealt, so the time is the ledger's seat time, all of it estimated.
    expect(atTheTable(view, "zaqvin")?.hands).toBe(0);
    expect(atTheTable(view, "zaqvin")?.secondsEstimated).toBeGreaterThan(0);
  });
});
