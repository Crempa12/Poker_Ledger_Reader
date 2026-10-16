// The hand-log payload (server/handlogs.ts) against the core's own results and against the
// console's printed "Hand logs in scope" tables, on the made-up data only. Also the query
// the server reads for GET /api/handlogs, and that the payload is plain JSON.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  beatenAtShowdown,
  formatLocalDate,
  handViewOf,
  hitrun,
  money,
  parseLocalDate,
  playstyle,
  type HandWorld,
  type Scope,
} from "../../../packages/core/src/index.ts";
import { fixedText } from "../../../packages/core/src/util.ts";
import { loadDataRoot } from "../../../tools/load.ts";
import { handScopePayload, handWorldFromInputs, handWorldInTurns, parseHandScope } from "../server/handlogs.ts";
import type { HandNight, HandScopePayload } from "../src/handtypes.ts";

const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
const EDGE = fileURLToPath(new URL("../../../fixtures/synthetic-edge/", import.meta.url));
const REF = fileURLToPath(new URL("../../../fixtures/synthetic-reference/scenarios/", import.meta.url));
const EDGE_REF = fileURLToPath(new URL("../../../fixtures/synthetic-edge-reference/scenarios/", import.meta.url));
const TZ = "America/New_York";
const WHOLE: Scope = { folder: "", from: null, to: null };

// One load per data root for the whole file.
const worlds = new Map<string, Promise<HandWorld>>();
function worldOf(root: string): Promise<HandWorld> {
  let w = worlds.get(root);
  if (w === undefined) {
    w = loadDataRoot(root).then((inputs) => handWorldFromInputs(inputs, TZ));
    worlds.set(root, w);
  }
  return w;
}

// The payload's fields, each checked against the core's own result for the same scope.
function expectSameAsCore(p: HandScopePayload, hw: HandWorld, scope: Scope): void {
  const view = handViewOf(hw, scope);
  expect(p.basis).toBe("b");
  expect(p.scope).toEqual({ folder: scope.folder, from: scope.from, to: scope.to });
  expect(p.games).toBe(view.scoped.length);
  expect(p.logged).toBe(view.logs.length);
  expect(p.hands).toBe(view.logs.reduce((n, log) => n + log.hands.length, 0));
  expect(p.messages).toEqual(hw.messages);
  expect(p.style).toEqual(view.style);
  expect(p.profiles).toHaveLength(view.profiles.length);
  // Each profile is the core's, with its hit & run columns filled in the way the console's menu 21 does.
  const facts = hitrun.hitRunFacts(view.hitRun.summaries);
  view.profiles.forEach((profile, i) => {
    const { showdownHandClass, ...rest } = profile;
    const fact = facts.get(profile.normalizedName);
    const annotated =
      fact === undefined
        ? rest
        : { ...rest, hitRun: fact.hitRun, hitRunReliable: fact.hitRunReliable, hitRunTag: fact.hitRunTag, hitRunLine: fact.hitRunLine };
    expect(p.profiles[i]).toEqual({ ...annotated, showdownHandClass: [...showdownHandClass] });
  });
  expect(p.pool).toEqual(playstyle.poolAverages(view.profiles));
  expect(p.hitRun).toEqual({ summaries: view.hitRun.summaries, nights: view.hitRun.nights, unmeasured: view.hitRun.unmeasured });
  // The Maps keep their order: the keys come out as the core's Maps walk them.
  expect(Object.keys(p.playtime)).toEqual([...view.playtime.keys()]);
  for (const [name, time] of view.playtime) expect(p.playtime[name]).toEqual(time);
  expect(Object.keys(p.showdowns)).toEqual([...view.stats.keys()]);
  for (const name of view.stats.keys()) expect(p.showdowns[name]).toEqual(beatenAtShowdown(view, name));
  expect(p.exports).toEqual(view.exports);
  // The nights: one per log in the scope, in the scope's order.
  expect(p.nights.map((n) => n.gameId)).toEqual(view.logs.map((log) => log.gameId));
}

// Every value that JSON cannot carry as it is: a Map, Set, class instance, undefined, NaN or
// Infinity, found anywhere in the tree. An empty list means the payload is plain.
function plainProblems(value: unknown, path = "$", out: string[] = []): string[] {
  if (value === undefined) out.push(`${path}: undefined`);
  else if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(`${path}: ${value}`);
  } else if (value === null || typeof value === "string" || typeof value === "boolean") {
    // plain
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => plainProblems(v, `${path}[${i}]`, out));
  } else if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) out.push(`${path}: not a plain object`);
    for (const [k, v] of Object.entries(value)) plainProblems(v, `${path}.${k}`, out);
  } else {
    out.push(`${path}: ${typeof value}`);
  }
  return out;
}

// A row of the printed "Hand logs in scope" table, cell by cell as the console prints it.
interface PrintedNight {
  date: string;
  folder: string;
  hands: string;
  hours: string;
  players: string;
  showdown: string;
  pot: string;
  winner: string;
  hand: string;
  mismatches: number; // the "*N" after the hand number, 0 when there is none
}

const PRINTED_ROW =
  /^(\d{4}-\d{2}-\d{2})\s+(.+?)\s+(\d+)\s+(\d+\.\d)\s+(\d+)\s+(\d+)%\s+(-?\$[\d,]+\.\d{2})\s+(.+?)\s+#(\d+)(?:\s+\*(\d+))?\s*$/;

// The rows under "-- Hand logs in scope", up to the next section. A file with no such section has none.
function printedNights(styleText: string): PrintedNight[] {
  const lines = styleText.split("\n");
  const at = lines.findIndex((l) => l.startsWith("-- Hand logs in scope"));
  if (at === -1) return [];
  const rows: PrintedNight[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith("-- ")) break;
    const m = PRINTED_ROW.exec(line);
    if (m === null) continue;
    rows.push({
      date: m[1] ?? "",
      folder: m[2] ?? "",
      hands: m[3] ?? "",
      hours: m[4] ?? "",
      players: m[5] ?? "",
      showdown: `${m[6] ?? ""}%`,
      pot: m[7] ?? "",
      winner: m[8] ?? "",
      hand: m[9] ?? "",
      mismatches: Number(m[10] ?? "0"),
    });
  }
  return rows;
}

// The same cells, from a night of the payload, as the console prints them.
function cellsOf(n: HandNight): PrintedNight {
  return {
    date: formatLocalDate(n.start, TZ),
    folder: n.folder,
    hands: String(n.hands),
    hours: fixedText(n.hours, 1),
    players: String(n.players),
    showdown: `${fixedText(n.showdownPercent, 0)}%`,
    pot: money(n.biggestPot),
    winner: n.biggestPotWinner,
    hand: String(n.biggestPotHand),
    mismatches: n.stackMismatches,
  };
}

describe("the hand-log payload", () => {
  it("is what the core gives for the made-up data, whole and by folder", async () => {
    const hw = await worldOf(SYNTHETIC);
    expectSameAsCore(handScopePayload(hw, WHOLE, "b"), hw, WHOLE);
    for (const folder of ["Synthetic Autumn", "Synthetic Spring", "Synthetic Winter"]) {
      expectSameAsCore(handScopePayload(hw, { folder, from: null, to: null }, "b"), hw, { folder, from: null, to: null });
    }
  });

  it("is what the core gives for the edge-case made-up data, by folder and in a date range", async () => {
    const hw = await worldOf(EDGE);
    expectSameAsCore(handScopePayload(hw, WHOLE, "b"), hw, WHOLE);
    for (const folder of ["Synthetic Edge A", "Synthetic Edge B", "Synthetic Edge C"]) {
      expectSameAsCore(handScopePayload(hw, { folder, from: null, to: null }, "b"), hw, { folder, from: null, to: null });
    }
    const range: Scope = { folder: "", from: parseLocalDate("2026-10-06", false, TZ), to: parseLocalDate("2026-10-07", true, TZ) };
    expectSameAsCore(handScopePayload(hw, range, "b"), hw, range);
  });

  it("holds only plain JSON (no Map, Set, NaN, Infinity or undefined), and reads back the same", async () => {
    const hw = await worldOf(EDGE);
    for (const scope of [WHOLE, { folder: "Synthetic Edge A", from: null, to: null }]) {
      const p = handScopePayload(hw, scope, "b");
      expect(plainProblems(p)).toEqual([]);
      const text = JSON.stringify(p);
      expect(text).not.toMatch(/\bNaN\b|\bInfinity\b/);
      expect(JSON.parse(text)).toEqual(p);
    }
    const synthetic = handScopePayload(await worldOf(SYNTHETIC), WHOLE, "b");
    expect(plainProblems(synthetic)).toEqual([]);
  });

  it("gives an empty set of nights when no log is in the scope", async () => {
    const hw = await worldOf(SYNTHETIC);
    const p = handScopePayload(hw, { folder: "Synthetic Spring", from: null, to: null }, "b");
    expect(p.logged).toBe(0);
    expect(p.nights).toEqual([]);
    expect(p.exports.styleStats).toBeNull();
    expect(p.exports.hitAndRun).toBeNull();
  });
});

describe("the hand-log rows against the console's table", () => {
  // Each table the console prints for these scopes, with the scope it was printed for.
  const cases: Array<{ name: string; root: string; scope: Scope; file: string; from?: string; to?: string }> = [
    { name: "synthetic, every folder", root: SYNTHETIC, scope: WHOLE, file: `${REF}handlog/logs/style.txt` },
    {
      name: "synthetic, Synthetic Autumn",
      root: SYNTHETIC,
      scope: { folder: "Synthetic Autumn", from: null, to: null },
      file: `${REF}handlog-folder-synthetic-autumn/logs/style.txt`,
    },
    {
      name: "synthetic, Synthetic Spring (no log, no table)",
      root: SYNTHETIC,
      scope: { folder: "Synthetic Spring", from: null, to: null },
      file: `${REF}handlog-folder-synthetic-spring/logs/style.txt`,
    },
    { name: "edge, every folder", root: EDGE, scope: WHOLE, file: `${EDGE_REF}handlog/logs/style.txt` },
    {
      name: "edge, Synthetic Edge A",
      root: EDGE,
      scope: { folder: "Synthetic Edge A", from: null, to: null },
      file: `${EDGE_REF}handlog-folder-synthetic-edge-a/logs/style.txt`,
    },
    {
      name: "edge, Synthetic Edge B",
      root: EDGE,
      scope: { folder: "Synthetic Edge B", from: null, to: null },
      file: `${EDGE_REF}handlog-folder-synthetic-edge-b/logs/style.txt`,
    },
    {
      name: "edge, Synthetic Edge C",
      root: EDGE,
      scope: { folder: "Synthetic Edge C", from: null, to: null },
      file: `${EDGE_REF}handlog-folder-synthetic-edge-c/logs/style.txt`,
    },
    {
      name: "edge, 6 to 7 October (a date range)",
      root: EDGE,
      scope: { folder: "", from: parseLocalDate("2026-10-06", false, TZ), to: parseLocalDate("2026-10-07", true, TZ) },
      file: `${EDGE_REF}handlog/logs/style.txt`,
      from: "2026-10-06",
      to: "2026-10-07",
    },
  ];

  // How many rows each printed table has, so a parser that finds none cannot pass by matching nothing.
  const ROWS: Record<string, number> = {
    "synthetic, every folder": 2,
    "synthetic, Synthetic Autumn": 2,
    "synthetic, Synthetic Spring (no log, no table)": 0,
    "edge, every folder": 6,
    "edge, Synthetic Edge A": 3,
    "edge, Synthetic Edge B": 2,
    "edge, Synthetic Edge C": 1,
    "edge, 6 to 7 October (a date range)": 3,
  };

  for (const c of cases) {
    it(`has the rows the console prints: ${c.name}`, async () => {
      const hw = await worldOf(c.root);
      const nights = handScopePayload(hw, c.scope, "b").nights;
      let printed = printedNights(readFileSync(c.file, "utf8"));
      if (c.from !== undefined && c.to !== undefined) {
        printed = printed.filter((r) => r.date >= (c.from ?? "") && r.date <= (c.to ?? ""));
      }
      expect(printed).toHaveLength(ROWS[c.name] ?? -1);
      expect(nights.map(cellsOf)).toEqual(printed);
    });
  }

  it("reads the printed table's rows (a self-check of the parser)", () => {
    const rows = printedNights(readFileSync(`${EDGE_REF}handlog/logs/style.txt`, "utf8"));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({
      date: "2026-10-03",
      folder: "Synthetic Edge B",
      hands: "70",
      hours: "1.8",
      players: "7",
      showdown: "50%",
      pot: "$74.36",
      winner: "Rune",
      hand: "23",
      mismatches: 67,
    });
  });
});

describe("the query of GET /api/handlogs", () => {
  it("reads folder, from and to, and leaves out what is not given", () => {
    expect(parseHandScope("")).toEqual({ scope: { folder: "", from: null, to: null } });
    expect(parseHandScope("folder=Synthetic%20Autumn&from=1700000000&to=1700086400")).toEqual({
      scope: { folder: "Synthetic Autumn", from: 1700000000, to: 1700086400 },
    });
    expect(parseHandScope("folder=")).toEqual({ scope: { folder: "", from: null, to: null } });
    expect(parseHandScope("to=1700000000")).toEqual({ scope: { folder: "", from: null, to: 1700000000 } });
    expect(parseHandScope("from=0&to=4102444800")).toEqual({ scope: { folder: "", from: 0, to: 4102444800 } });
  });

  it("reads a plus sign as a space, as a form sends it, and %2B as a plus sign", () => {
    expect(parseHandScope("folder=A+B")).toEqual({ scope: { folder: "A B", from: null, to: null } });
    expect(parseHandScope("folder=A%2BB")).toEqual({ scope: { folder: "A+B", from: null, to: null } });
  });

  it("takes a folder of 200 characters, and refuses 201", () => {
    const ok = parseHandScope(`folder=${"f".repeat(200)}`);
    expect("scope" in ok && ok.scope.folder.length).toBe(200);
    expect(parseHandScope(`folder=${"f".repeat(201)}`)).toEqual({ error: "the folder name is longer than 200 characters" });
  });

  it("refuses anything else with a short message that does not repeat the value", () => {
    const bad: Array<[string, string]> = [
      ["from=abc", "abc"],
      ["from=", ""],
      ["to=-1", "-1"],
      ["from=1.5", "1.5"],
      ["from=4102444801", "4102444801"],
      ["to=99999999999", "99999999999"],
      ["from=1700086400&to=1700000000", "1700086400"],
      ["x=1", "x"],
      ["folder=a&folder=b", ""],
      ["from=1&from=2", ""],
      ["folder=%E0%A4%A", "%E0"],
      ["folder=a&&to=5", "&&"],
    ];
    for (const [query, value] of bad) {
      const r = parseHandScope(query);
      expect(r, query).toHaveProperty("error");
      if ("error" in r && value !== "") expect(r.error, query).not.toContain(value);
      if ("error" in r) expect(r.error.length, query).toBeLessThan(120);
    }
  });
});

// The rows the page shows for a payload's games without a log: "<date> <folder> <id>".
function unloggedRows(p: HandScopePayload): string[] {
  return (p.unlogged ?? []).map((g) => `${formatLocalDate(g.start, TZ)} ${g.folder} ${g.id}`);
}

// The games the console prints under "Games without a log" (main.cpp handLogStats), read from its recorded
// output: one "  <date>  <folder>  <id>" row each, up to the "  ..." line, as "<date> <folder> <id>".
function printedUnlogged(text: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("Games without a log"));
  expect(at, "the console's list of games without a log").toBeGreaterThanOrEqual(0);
  const rows: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("  ") || line.trim() === "...") break;
    const m = /^\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s+(ledger_\S+)\s*$/.exec(line);
    rows.push(m === null ? line : `${m[1]} ${m[2]} ${m[3]}`);
  }
  return rows;
}

describe("the hit & run columns on the profiles, and the games without a log", () => {
  it("a profile row has the hit & run the style row has, as the console's menu 21 prints it", async () => {
    const data = JSON.parse(JSON.stringify(handScopePayload(await worldOf(EDGE), WHOLE, "b"))) as HandScopePayload;
    const profile = data.profiles.find((p) => p.normalizedName === "sable");
    const style = data.style.find((s) => s.normalizedName === "sable");
    expect(profile?.hitRunTag).toBe("Stays late");
    expect(profile?.hitRun).toBe(style?.hitRun);
    expect(profile?.hitRunReliable).toBe(style?.hitRunReliable);
  });

  it("lists the newest five games with no log, then how many are left out, as the console does", async () => {
    const hw = await worldOf(SYNTHETIC);
    const whole = handScopePayload(hw, WHOLE, "b");
    const autumn = handScopePayload(hw, { folder: "Synthetic Autumn", from: null, to: null }, "b");
    expect(unloggedRows(whole)).toEqual(printedUnlogged(readFileSync(REF + "handlog/logs/style.txt", "utf8")));
    expect(whole.unloggedMore).toBe(7);
    expect(unloggedRows(autumn)).toEqual(printedUnlogged(readFileSync(REF + "handlog-folder-synthetic-autumn/logs/style.txt", "utf8")));
    expect(autumn.unloggedMore).toBe(0);
  });

  it("the edge data's games without a log match the console too", async () => {
    const data = handScopePayload(await worldOf(EDGE), WHOLE, "b");
    expect(unloggedRows(data)).toEqual(printedUnlogged(readFileSync(EDGE_REF + "handlog/logs/style.txt", "utf8")));
    expect(data.unloggedMore).toBe(0);
  });
});

describe("the hand logs are loaded in turns", () => {
  it("other requests get a turn between the games, and the same hand logs come out", async () => {
    const inputs = await loadDataRoot(SYNTHETIC);
    let finished = false;
    let turns = 0;
    const tick = (): void => {
      if (finished) return;
      turns++;
      setImmediate(tick);
    };
    setImmediate(tick);
    const inTurns = await handWorldInTurns(inputs, TZ).finally(() => {
      finished = true;
    });
    expect(turns).toBeGreaterThan(1);
    const whole = JSON.stringify(handScopePayload(inTurns, WHOLE, "b"));
    expect(whole).toBe(JSON.stringify(handScopePayload(await worldOf(SYNTHETIC), WHOLE, "b")));
  });
});
