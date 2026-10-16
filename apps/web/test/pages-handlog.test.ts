// The hand-log pages (Play style, the player page's "At the table" and "Beaten at showdown by")
// rendered from made-up data, checked against the console app's recorded output: every row of the
// style, nights, profile and hit & run tables, the player history blocks, the scope lines, and the
// download names and bytes. Also the hook's snapshot path, its server path, and the downloads.
// Made-up data only (fixtures/synthetic and fixtures/synthetic-edge).
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { players, showdowns, type Scope } from "../../../packages/core/src/index.ts";
import type { HandWorld } from "../../../packages/core/src/handworld.ts";
import { loadDataRoot } from "../../../tools/load.ts";
import { handScopePayload, handWorldFromInputs, parseHandScope, snapshotHandLogs } from "../server/handlogs.ts";
import { buildCtx, type Ctx } from "../src/context.ts";
import { EVERYTHING, type Payload, type ScopeChoice } from "../src/data.ts";
import { cachedHandLogs, DATES_OUT_OF_RANGE, datesOutOfRange, fetchHandLogs, fromSnapshot, handLogsQuery, KEEP_SCOPES } from "../src/handlogs.ts";
import { cutCell, entryOf } from "../src/handformat.ts";
import type { HandScopePayload } from "../src/handtypes.ts";
import { Downloads, downloadsFor } from "../src/components/downloads.tsx";
import { HitRunPlayer, HitRunView } from "../src/components/hitrun.tsx";
import { ProfileDetail, ProfilesView, NightsCard, StyleCard } from "../src/components/playstyle.tsx";
import { AtTheTable, BeatenAtShowdown, beatenFor } from "../src/components/hands.tsx";
import { PlayStylePage } from "../src/pages/PlayStyle.tsx";
import { PlayerPage } from "../src/pages/Player.tsx";

const TZ = "America/New_York";
const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
const EDGE = fileURLToPath(new URL("../../../fixtures/synthetic-edge/", import.meta.url));
const REF = fileURLToPath(new URL("../../../fixtures/synthetic-reference/scenarios/", import.meta.url));
const EDGE_REF = fileURLToPath(new URL("../../../fixtures/synthetic-edge-reference/scenarios/", import.meta.url));

const ALL: ScopeChoice = EVERYTHING;
const AUTUMN: ScopeChoice = { folder: "Synthetic Autumn", from: "", to: "" };
const WINTER: ScopeChoice = { folder: "Synthetic Winter", from: "", to: "" };
const OPEN_ALL: Scope = { folder: "", from: null, to: null };

// ---- the made-up data, the way the server builds it ----------------------------------------

const hands = new Map<string, Promise<HandWorld>>();
async function handWorldOf(root: string): Promise<HandWorld> {
  let found = hands.get(root);
  if (found === undefined) {
    found = loadDataRoot(root).then((inputs) => handWorldFromInputs(inputs, TZ));
    hands.set(root, found);
  }
  return found;
}

// The payload a snapshot file carries: every folder's results, all dates open.
function snapshotPayload(hw: HandWorld): Payload {
  return {
    source: "snapshot",
    dataRoot: "",
    timeZone: TZ,
    loadedAt: 0,
    ledgers: [],
    logs: [],
    saved: {},
    canWrite: false,
    consoleOpen: 0,
    basis: "",
    handlogs: JSON.parse(JSON.stringify(snapshotHandLogs(hw))) as Payload["handlogs"],
  };
}

// The page context for a snapshot of the made-up data (its results come embedded, no fetch).
async function snapshotCtx(root: string, choice: ScopeChoice): Promise<Ctx> {
  const hw = await handWorldOf(root);
  return buildCtx(snapshotPayload(hw), hw.world, choice);
}

// The page context for the live server: the same data, but the results must be asked for.
async function liveCtx(root: string, choice: ScopeChoice): Promise<Ctx> {
  const hw = await handWorldOf(root);
  const payload: Payload = { ...snapshotPayload(hw), source: "local", basis: "made-up", handlogs: undefined };
  return buildCtx(payload, hw.world, choice);
}

// The payload the server gives for one scope, as the page receives it (JSON, so no Map gets through).
async function scopePayload(root: string, scope: Scope): Promise<HandScopePayload> {
  const hw = await handWorldOf(root);
  return JSON.parse(JSON.stringify(handScopePayload(hw, scope, "made-up"))) as HandScopePayload;
}

// ---- the console's recorded output ---------------------------------------------------------

function reference(path: string): string {
  return readFileSync(path, "utf8");
}

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();

// The rows of a recorded table: the lines after its header and rule, up to the rule that ends it.
function consoleRows(text: string, header: RegExp): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => header.test(line));
  expect(at, `the console table ${header}`).toBeGreaterThanOrEqual(0);
  const rows: string[] = [];
  for (let i = at + 2; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^-{10,}/.test(line)) break;
    rows.push(normalize(line));
  }
  return rows;
}

// The lines of a recorded block, from the line after its heading to the next heading or prompt,
// without the rules. Joined with spaces, so a sentence the console breaks over two lines compares whole.
function consoleBlock(text: string, heading: string, stops: string[]): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith(heading));
  expect(at, `the console block ${heading}`).toBeGreaterThanOrEqual(0);
  const kept: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (stops.some((stop) => line.startsWith(stop))) break;
    if (/^-{10,}/.test(line.trim()) || line.trim() === "") continue;
    kept.push(normalize(line));
  }
  return kept.join(" ");
}

// ---- rendered markup as text ---------------------------------------------------------------

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

function textOf(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/(td|th|span|a|button)>/g, " ")
    .replace(/<\/(p|div|li|tr|h1|h2|h3|dt|dd|summary|section|details|ul|table|nav)>|<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return normalize(text.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m] ?? m));
}

// The text of each table row, without the header rows.
function dataRowsOf(html: string, headerStart: string): string[] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => textOf(m[1] ?? ""))
    .filter((row) => !row.startsWith(headerStart));
}

function show(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

// ---- tests ---------------------------------------------------------------------------------

describe("playing style (menu 18) with the made-up data, against the console", () => {
  it("the style table has the console's rows, columns and order", async () => {
    const ctx = await snapshotCtx(SYNTHETIC, ALL);
    const data = ctx.payload.handlogs?.[""];
    expect(data).toBeDefined();
    const rows = dataRowsOf(show(createElement(StyleCard, { style: data?.style ?? [] })), "Player ");
    const recorded = consoleRows(reference(REF + "handlog/logs/style.txt"), /^Player\s+Games\s+Hands/);
    expect(recorded.length).toBeGreaterThan(0);
    expect(rows).toEqual(recorded);
  });

  it("the hand logs in scope table has the console's nights, in order", async () => {
    const ctx = await snapshotCtx(SYNTHETIC, ALL);
    const data = ctx.payload.handlogs?.[""];
    const rows = dataRowsOf(show(createElement(NightsCard, { data: data as HandScopePayload, tz: TZ })), "Date ");
    const recorded = consoleRows(reference(REF + "handlog/logs/style.txt"), /^Date\s+Folder\s+Hands/);
    expect(recorded).toHaveLength(2);
    expect(rows).toEqual(recorded);
  });

  it("the Autumn folder's style and nights tables match its own recorded output", async () => {
    const ctx = await snapshotCtx(SYNTHETIC, AUTUMN);
    const data = ctx.payload.handlogs?.["Synthetic Autumn"] as HandScopePayload;
    const style = dataRowsOf(show(createElement(StyleCard, { style: data.style })), "Player ");
    const nights = dataRowsOf(show(createElement(NightsCard, { data, tz: TZ })), "Date ");
    const file = REF + "handlog-folder-synthetic-autumn/logs/style.txt";
    expect(style).toEqual(consoleRows(reference(file), /^Player\s+Games\s+Hands/));
    expect(nights).toEqual(consoleRows(reference(file), /^Date\s+Folder\s+Hands/));
  });

  it("the edge data's style and nights tables match the console, including the not-reconciled marks", async () => {
    const ctx = await snapshotCtx(EDGE, ALL);
    const data = ctx.payload.handlogs?.[""] as HandScopePayload;
    const file = EDGE_REF + "handlog/logs/style.txt";
    expect(dataRowsOf(show(createElement(StyleCard, { style: data.style })), "Player ")).toEqual(
      consoleRows(reference(file), /^Player\s+Games\s+Hands/),
    );
    expect(dataRowsOf(show(createElement(NightsCard, { data, tz: TZ })), "Date ")).toEqual(
      consoleRows(reference(file), /^Date\s+Folder\s+Hands/),
    );
    expect(textOf(show(createElement(NightsCard, { data, tz: TZ })))).toContain("Rune #23 *67");
  });

  it("the scope line and the loader notes are the console's", async () => {
    const ctx = await snapshotCtx(SYNTHETIC, ALL);
    const out = textOf(show(createElement(PlayStylePage, { ctx, section: "", person: "" })));
    expect(out).toContain("Hand-log statistics for all folders: 2 of 14 games have a log.");
    // The made-up synthetic logs load without a skipped or duplicate file, so there are no notes to show.
    expect(out).not.toContain("Notes from the hand logs");
    expect(out).toContain("Games without a log: download");
    const edge = textOf(show(createElement(PlayStylePage, { ctx: await snapshotCtx(EDGE, ALL), section: "", person: "" })));
    expect(edge).toContain("Hand-log statistics for all folders: 6 of 8 games have a log.");
    // The edge data has a duplicate log and an empty one; the console names both in its notes.
    expect(edge).toContain("Notes from the hand logs (2)");
  });

  it("the player names link to the player page", async () => {
    const ctx = await snapshotCtx(SYNTHETIC, ALL);
    const data = ctx.payload.handlogs?.[""] as HandScopePayload;
    const html = show(createElement(StyleCard, { style: data.style }));
    expect(html).toContain('href="#/player/pethra"');
  });
});

describe("deep profiles (menu 21) and the long read, against the console", () => {
  it("the two profile tables have the console's rows in order, with its pool line", async () => {
    const ctx = await snapshotCtx(EDGE, ALL);
    const data = ctx.payload.handlogs?.[""] as HandScopePayload;
    const html = show(createElement(ProfilesView, { data, scope: "all folders" }));
    const file = EDGE_REF + "handlog/logs/playstyle.txt";
    const before = consoleRows(reference(file), /^Player\s+Hands\s+VPIP/);
    const after = consoleRows(reference(file), /^Player\s+CBet/);
    expect(before.length).toBeGreaterThan(0);
    expect(dataRowsOf(html, "Player ")).toEqual([...before, ...after]);
    const text = textOf(html);
    expect(text).toContain("Deep playstyle for all folders: 6 of 8 games have a log, 288 hands analysed.");
    expect(text).toContain("NOTE: 2 games in scope have no hand log, so these reads cover only part of the money.");
    expect(text).toContain("Pool average over 2 players with 200+ hands: VPIP 47%, PFR 12%");
    expect(text).toContain("A rate in (brackets) has fewer than 25 opportunities behind it and is not a tendency.");
  });

  it("a player with fewer than 50 hands is left out of the tables and listed below them", async () => {
    const ctx = await snapshotCtx(SYNTHETIC, ALL);
    const data = ctx.payload.handlogs?.[""] as HandScopePayload;
    const html = show(createElement(ProfilesView, { data, scope: "all folders" }));
    expect(dataRowsOf(html, "Player ")).toEqual([]);
    expect(textOf(html)).toContain("Players with under 50 hands (");
  });

  it("the long read for one player says what the console says, with the same numbers", async () => {
    const ctx = await snapshotCtx(EDGE, ALL);
    const data = ctx.payload.handlogs?.[""] as HandScopePayload;
    const text = textOf(show(createElement(ProfileDetail, { data, person: "sable" })));
    expect(text).toContain("Sable - 233 hands over 5 games");
    expect(text).toContain("Archetype Average-passive");
    expect(text).toContain("Hit & run 9 - Stays late");
    expect(text).toMatch(/VPIP \/ PFR \d+\.\d% \/ \d+\.\d% \(pool 47% \/ 12%\)/);
    expect(text).toContain("NOTE bb/100 over 233 hands carries a confidence interval far wider than any plausible edge.");
    // The same rate the table shows (a rate with its count: 48% of 233 hands is the VPIP cell).
    expect(textOf(show(createElement(ProfilesView, { data, scope: "all folders" })))).toContain("Sable 233 48% 11% 46%");
  });
});

describe("hit & run (menu 22) with the made-up data, against the console", () => {
  it("the table has the console's rows, in order, and its explanation", async () => {
    const ctx = await snapshotCtx(SYNTHETIC, ALL);
    const data = ctx.payload.handlogs?.[""] as HandScopePayload;
    const html = show(createElement(HitRunView, { data, scope: "all folders" }));
    const file = REF + "handlog/logs/hit-and-run.txt";
    expect(consoleRows(reference(file), /^Player\s+Nights\s+Play/)).toHaveLength(12);
    expect(dataRowsOf(html, "Player ")).toEqual(consoleRows(reference(file), /^Player\s+Nights\s+Play/));
    const text = textOf(html);
    expect(text).toContain("Hit & run for all folders.");
    expect(text).toContain("2 nights with a hand log, measured hand by hand.");
    expect(text).toContain("12 nights in scope have no hand log and are left out: a ledger cannot say when someone stopped playing.");
    // The console's footer, line for line (its line breaks fall where the page wraps).
    const legend = consoleBlock(reference(file), "-- Hit & run", ["Show every night", "Exported"]);
    expect(text).toContain(legend.slice(legend.indexOf("Each night ends in one exit")));
  });

  it("the edge data's table and average match the console", async () => {
    const ctx = await snapshotCtx(EDGE, ALL);
    const data = ctx.payload.handlogs?.[""] as HandScopePayload;
    const html = show(createElement(HitRunView, { data, scope: "all folders" }));
    const file = EDGE_REF + "handlog/logs/hit-and-run.txt";
    expect(dataRowsOf(html, "Player ")).toEqual(consoleRows(reference(file), /^Player\s+Nights\s+Play/));
    const text = textOf(html);
    expect(text).toContain("6 nights with a hand log, measured hand by hand.");
    expect(text).toContain("2 of those logs start late (PokerNow cuts the first hands off a long night); seats from before a log begins are placed by the ledger's times.");
    expect(text).toContain("Average H&R over the 3 players with 3+ winning nights: 10.");
  });

  it("one person's nights add up to their line in the table", async () => {
    const ctx = await snapshotCtx(EDGE, ALL);
    const data = ctx.payload.handlogs?.[""] as HandScopePayload;
    const sable = data.hitRun.summaries.find((s) => s.person === "sable");
    expect(sable?.nights).toBe(6);
    const text = textOf(show(createElement(HitRunPlayer, { data, person: "sable", tz: TZ })));
    expect(text).toContain("Sable - hit & run 9 (Stays late)");
    expect(text).toContain("When winning left with");
    expect(text).toContain("Exits stayed 4 (");
    const rows = dataRowsOf(show(createElement(HitRunPlayer, { data, person: "sable", tz: TZ })), "Date ");
    expect(rows).toHaveLength(6);
    // Newest first: each row's date is not later than the row above it.
    const dates = rows.map((r) => r.slice(0, 10));
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});

describe("the player history: At the table and Beaten at showdown by, against every history file", () => {
  it("each player's blocks match their history_<n>.txt", async () => {
    const ctx = await snapshotCtx(SYNTHETIC, ALL);
    const data = ctx.payload.handlogs?.[""] as HandScopePayload;
    const dir = REF + "history/history/";
    const files = readdirSync(dir).filter((f) => /^history_\d+\.txt$/.test(f));
    expect(files).toHaveLength(47);
    let checked = 0;
    for (const file of files) {
      const text = reference(dir + file);
      const name = /^-- (.+), night by night/m.exec(text)?.[1];
      expect(name, file).toBeDefined();
      const p = ctx.view.board.find((x) => x.displayName === name);
      expect(p, `${file}: ${name}`).toBeDefined();
      if (p === undefined) continue;
      const normalized = p.normalizedName;
      const totalNet = players.playerDollars(p).totalNet;

      const atTheTable = consoleBlock(text, "-- At the table", ["-- Beaten at showdown by"]);
      const shownTable = textOf(show(createElement(AtTheTable, { displayName: p.displayName, totalNet, time: data.playtime[normalized] })));
      expect(shownTable, `${file}: At the table`).toBe(atTheTable);

      const beaten = consoleBlock(text, "-- Beaten at showdown by", ["(press Enter", "+---"]).replace(/ +$/, "");
      const shownBeaten = textOf(
        show(createElement(BeatenAtShowdown, { displayName: p.displayName, games: data.games, summary: beatenFor(data, normalized) })),
      );
      expect(shownBeaten, `${file}: Beaten at showdown by`).toBe(beaten);
      checked++;
    }
    expect(checked).toBe(47);
  });

  it("the player page shows both blocks in its own cards, from the snapshot", async () => {
    const ctx = await snapshotCtx(SYNTHETIC, ALL);
    const sybnari = ctx.view.board.find((x) => x.displayName === "Sybnari");
    expect(sybnari).toBeDefined();
    const html = show(createElement(PlayerPage, { ctx, normalized: sybnari?.normalizedName ?? "" }));
    const text = textOf(html);
    expect(text).toContain("At the table Time ~12.2 h over 3 nights, 4.0 h a night");
    expect(text).toContain("Beaten at showdown by Sybnari reached no showdowns (2 of 14 games in scope have a hand log).");
    expect(text).toContain("Running total");
    expect(text).not.toContain("Reading the hand logs");
  });
});

describe("the hook's snapshot path and the server path", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a snapshot gives the results for all dates, for all folders and for each folder", async () => {
    const hw = await handWorldOf(SYNTHETIC);
    const payload = snapshotPayload(hw);
    const all = fromSnapshot(payload, OPEN_ALL);
    expect(all.status).toBe("ready");
    expect(all.data?.games).toBe(14);
    expect(all.data?.logged).toBe(2);
    const autumn = fromSnapshot(payload, { folder: "Synthetic Autumn", from: null, to: null });
    expect(autumn.status).toBe("ready");
    expect(autumn.data?.logged).toBe(2);
    const winter = fromSnapshot(payload, { folder: "Synthetic Winter", from: null, to: null });
    expect(winter.status).toBe("ready");
    expect(winter.data?.logged).toBe(0);
  });

  it("a snapshot cannot give a date range, and says so in plain words", async () => {
    const payload = snapshotPayload(await handWorldOf(SYNTHETIC));
    const dated = fromSnapshot(payload, { folder: "", from: 1_790_000_000, to: null });
    expect(dated.status).toBe("unavailable");
    expect(dated.message).toBe('A snapshot has the hand-log results for all dates only. Choose "All time" above to see them.');
  });

  it("an older snapshot without hand-log results, or a folder it does not hold, is unavailable", async () => {
    const payload = snapshotPayload(await handWorldOf(SYNTHETIC));
    expect(fromSnapshot({ ...payload, handlogs: undefined }, OPEN_ALL).message).toBe(
      "This snapshot has no hand-log results. Ask whoever sent it for a new one.",
    );
    expect(fromSnapshot(payload, { folder: "No such folder", from: null, to: null }).message).toBe(
      "This snapshot has no hand-log results for this folder.",
    );
  });

  it("the Play style page renders from the snapshot without asking the server", async () => {
    const fetched = vi.fn(() => {
      throw new Error("a snapshot must not fetch");
    });
    vi.stubGlobal("fetch", fetched);
    const ctx = await snapshotCtx(SYNTHETIC, ALL);
    const out = textOf(show(createElement(PlayStylePage, { ctx, section: "hitrun", person: "" })));
    expect(out).toContain("Hit & run for all folders.");
    expect(out).toContain("Downloads");
    expect(fetched).not.toHaveBeenCalled();
  });

  it("a date range in a snapshot shows the reason, and the player page does not wait for it", async () => {
    const ctx = await snapshotCtx(SYNTHETIC, { folder: "", from: "2026-10-01", to: "" });
    const out = textOf(show(createElement(PlayStylePage, { ctx, section: "", person: "" })));
    expect(out).toContain("A snapshot has the hand-log results for all dates only.");
    const sybnari = ctx.view.board.find((x) => x.displayName === "Sybnari");
    const player = textOf(show(createElement(PlayerPage, { ctx, normalized: sybnari?.normalizedName ?? "" })));
    expect(player).toContain("Running total");
    expect(player).toContain("A snapshot has the hand-log results for all dates only.");
  });

  it("on the live server the results are still on the way at first, and the rest of the page is not held up", async () => {
    const ctx = await liveCtx(SYNTHETIC, ALL);
    const page = textOf(show(createElement(PlayStylePage, { ctx, section: "", person: "" })));
    expect(page).toContain("Reading the hand logs for this scope");
    expect(page).toContain("Playing style");
    expect(page).toContain("Deep profiles");
    const sybnari = ctx.view.board.find((x) => x.displayName === "Sybnari");
    const player = textOf(show(createElement(PlayerPage, { ctx, normalized: sybnari?.normalizedName ?? "" })));
    expect(player).toContain("Running total");
    expect(player).toContain("At the table Reading the hand logs for this scope");
  });

  it("the query names the folder, and the dates only when they are set", () => {
    expect(handLogsQuery({ folder: "", from: null, to: null })).toBe("folder=");
    expect(handLogsQuery({ folder: "Synthetic Autumn", from: null, to: null })).toBe("folder=Synthetic%20Autumn");
    expect(handLogsQuery({ folder: "x", from: 1_790_000_000, to: 1_800_000_000 })).toBe("folder=x&from=1790000000&to=1800000000");
  });

  it("a fetched scope is kept for its data basis, and a new basis drops the old results", async () => {
    const payload = await scopePayload(SYNTHETIC, OPEN_ALL);
    const fetched = vi.fn(async () => new Response(JSON.stringify({ ...payload, basis: "test-basis-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetched);
    const scope: Scope = { folder: "", from: null, to: null };
    const got = await fetchHandLogs("test-basis-1", scope);
    expect(got.logged).toBe(2);
    expect(fetched).toHaveBeenCalledWith("/api/handlogs?folder=", { cache: "no-store" });
    expect(cachedHandLogs("test-basis-1", scope)?.logged).toBe(2);

    fetched.mockImplementation(async () => new Response(JSON.stringify({ ...payload, basis: "test-basis-2" }), { status: 200 }));
    await fetchHandLogs("test-basis-2", scope);
    expect(cachedHandLogs("test-basis-1", scope)).toBeUndefined();
    expect(cachedHandLogs("test-basis-2", scope)?.logged).toBe(2);
  });

  it("keeps only the newest scopes for a basis", async () => {
    const payload = await scopePayload(SYNTHETIC, OPEN_ALL);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...payload, basis: "test-basis-keep" }), { status: 200 })));
    const scopes: Scope[] = Array.from({ length: KEEP_SCOPES + 3 }, (_, i) => ({ folder: `Folder ${i}`, from: null, to: null }));
    for (const s of scopes) await fetchHandLogs("test-basis-keep", s);
    const kept = scopes.filter((s) => cachedHandLogs("test-basis-keep", s) !== undefined);
    expect(kept).toEqual(scopes.slice(3));
  });

  it("dates the server cannot read are explained, not asked for", () => {
    expect(datesOutOfRange({ folder: "", from: -144_705_600, to: null })).toBe(true);
    expect(datesOutOfRange({ folder: "", from: null, to: 4_134_085_199 })).toBe(true);
    expect(datesOutOfRange({ folder: "", from: 0, to: 4_102_444_800 })).toBe(false);
    expect(parseHandScope("folder=&from=0&to=4102444800")).not.toHaveProperty("error");
    expect(DATES_OUT_OF_RANGE).not.toMatch(/seconds|epoch/);
  });

  it("a refusal from the server is shown with the server's words", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "only folder, from and to can be given" }), { status: 400 })),
    );
    await expect(fetchHandLogs("test-basis-3", { folder: "", from: null, to: null })).rejects.toThrow(
      "only folder, from and to can be given",
    );
  });
});

describe("downloads: the console's file names and bytes", () => {
  it("the made-up data offers the six files, with the bytes the console writes", async () => {
    const data = await scopePayload(SYNTHETIC, OPEN_ALL);
    const files = downloadsFor(data.exports);
    expect(files.map((f) => f.name)).toEqual([
      "style_stats.csv",
      "playstyle.csv",
      "hit_and_run.csv",
      "hit_and_run_nights.csv",
      "player_summary.csv",
      "showdown_rivals.csv",
    ]);
    const byName = new Map(files.map((f) => [f.name, f.text]));
    expect(byName.get("style_stats.csv")).toBe(reference(REF + "handlog/style_stats.csv"));
    expect(byName.get("playstyle.csv")).toBe(reference(REF + "handlog/playstyle.csv"));
    expect(byName.get("hit_and_run.csv")).toBe(reference(REF + "handlog/hit_and_run.csv"));
    expect(byName.get("hit_and_run_nights.csv")).toBe(reference(REF + "handlog/hit_and_run_nights.csv"));
    expect(byName.get("player_summary.csv")).toBe(reference(REF + "all/player_summary.csv"));
    expect(byName.get("showdown_rivals.csv")).toBe(reference(REF + "all/showdown_rivals.csv"));
  });

  it("the edge data's hit & run files match the console's too", async () => {
    const data = await scopePayload(EDGE, OPEN_ALL);
    const byName = new Map(downloadsFor(data.exports).map((f) => [f.name, f.text]));
    expect(byName.get("style_stats.csv")).toBe(reference(EDGE_REF + "handlog/style_stats.csv"));
    expect(byName.get("playstyle.csv")).toBe(reference(EDGE_REF + "handlog/playstyle.csv"));
    expect(byName.get("hit_and_run_nights.csv")).toBe(reference(EDGE_REF + "handlog/hit_and_run_nights.csv"));
  });

  it("a folder without hand logs offers only the ledger's files", async () => {
    const data = await scopePayload(SYNTHETIC, { folder: "Synthetic Winter", from: null, to: null });
    expect(downloadsFor(data.exports).map((f) => f.name)).toEqual(["player_summary.csv", "showdown_rivals.csv"]);
  });

  it("says which menus the files come from, because two of them come from menu 12", async () => {
    const data = await scopePayload(SYNTHETIC, OPEN_ALL);
    expect(textOf(show(createElement(Downloads, { exports: data.exports })))).toContain("(menus 12, 18, 21 and 22)");
  });
});

describe("the page's query and the server's reading of it", () => {
  it("the query the page sends names the same scope when the server reads it back", () => {
    const scopes: Scope[] = [
      { folder: "", from: null, to: null },
      { folder: "Synthetic Autumn", from: null, to: null },
      { folder: "A+B & C%D/é ?#", from: 1_790_000_000, to: 1_800_000_000 },
    ];
    for (const scope of scopes) expect(parseHandScope(handLogsQuery(scope))).toEqual({ scope });
  });
});

describe("a date range that ends before it starts", () => {
  const REVERSED = "The From date is after the To date. Change the dates above.";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is said in plain words on the live server, and the server is not asked for it", async () => {
    const fetched = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetched);
    const ctx = await liveCtx(SYNTHETIC, { folder: "", from: "2026-10-20", to: "2026-10-01" });
    const out = textOf(show(createElement(PlayStylePage, { ctx, section: "", person: "" })));
    expect(out).toContain(REVERSED);
    expect(out).not.toContain("Reading the hand logs");
    expect(out).not.toContain("Try again");
    expect(fetched).not.toHaveBeenCalled();
  });

  it("is said in plain words in a snapshot too", async () => {
    const ctx = await snapshotCtx(SYNTHETIC, { folder: "", from: "2026-10-20", to: "2026-10-01" });
    expect(textOf(show(createElement(PlayStylePage, { ctx, section: "", person: "" })))).toContain(REVERSED);
  });
});

describe("names the records do not hold", () => {
  it("a folder named like an object's own member is not one the snapshot holds", async () => {
    const payload = snapshotPayload(await handWorldOf(SYNTHETIC));
    const got = fromSnapshot(payload, { folder: "constructor", from: null, to: null });
    expect(got.status).toBe("unavailable");
    expect(got.data).toBeUndefined();
  });

  it("a person with no showdown record gets the no-record summary, and entryOf finds only a record's own names", async () => {
    const ctx = await snapshotCtx(SYNTHETIC, ALL);
    const data = ctx.payload.handlogs?.[""] as HandScopePayload;
    const bare: HandScopePayload = { ...data, showdowns: {} };
    expect(beatenFor(bare, "constructor")).toEqual(showdowns.showdownSummary(undefined, bare.logged, bare.games));
    const none: Record<string, number> = {};
    expect(entryOf(none, "constructor")).toBeUndefined();
    expect(entryOf({ a: 1 }, "a")).toBe(1);
  });
});

describe("the Archetype column and the games without a log", () => {
  it("cuts a long label to 32 columns the way the console does, and keeps the whole label on hover and on the long read", async () => {
    const ctx = await snapshotCtx(EDGE, ALL);
    const data = JSON.parse(JSON.stringify(ctx.payload.handlogs?.[""])) as HandScopePayload;
    const sable = data.profiles.find((p) => p.normalizedName === "sable");
    if (sable === undefined) throw new Error("the edge data has no profile for sable");
    // Raises well above the pool and folds to most c-bets: the label gains "(fires and folds)".
    sable.pfr = { made: 40, opportunities: 100 };
    sable.foldToCbet = { made: 60, opportunities: 100 };
    const html = show(createElement(ProfilesView, { data, scope: "all folders" }));
    expect(textOf(html)).toContain("Average-aggressive (fires and f…");
    expect(html).toContain('title="Average-aggressive (fires and folds)"');
    expect(textOf(show(createElement(ProfileDetail, { data, person: "sable" })))).toContain(
      "Archetype Average-aggressive (fires and folds)",
    );
  });

  it("cutCell keeps a short label whole and cuts a long one to the column with an ellipsis", () => {
    expect(cutCell("Average-passive", 32)).toBe("Average-passive");
    expect(cutCell("Average-aggressive (fires and folds)", 32)).toBe("Average-aggressive (fires and f…");
    expect(cutCell("Average-aggressive (fires and folds)", 32)).toHaveLength(32);
  });

  it("the Play style page lists the newest five games with no log, then how many are left out", async () => {
    const ctx = await snapshotCtx(SYNTHETIC, ALL);
    const text = textOf(show(createElement(PlayStylePage, { ctx, section: "", person: "" })));
    expect(text).toContain("Games without a log");
    expect(text).toContain("2026-11-01 Synthetic Autumn ledger_pglFAKE0012");
    expect(text).toContain("7 more games without a log are not listed");
  });
});
