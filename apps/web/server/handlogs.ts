// The hand-log results for the pages: the console app's menus 18, 21 and 22, and the player
// history's "At the table" and "Beaten at showdown by". They are worked out here, from the hand
// logs and the ledgers, and handed out as plain JSON (GET /api/handlogs). A snapshot carries
// them ready-made (snapshot.ts). The hand logs are tens of megabytes, so the work is done once
// per data basis and kept for a while (createHandLogCache). Nothing here writes a file.
import { looksLikeLedger, listFolders } from "../../../packages/core/src/ledger.ts";
import type { Scope } from "../../../packages/core/src/models.ts";
import { displayNameAt, loadAllLogs, logIdOf, pairWithLedger } from "../../../packages/core/src/handlog.ts";
import type { HandLogInput } from "../../../packages/core/src/handlog.ts";
import { hitRunFacts } from "../../../packages/core/src/hitrun.ts";
import { poolAverages } from "../../../packages/core/src/playstyle.ts";
import type { HitRunFacts, Profile } from "../../../packages/core/src/playstyle.ts";
import { beatenAtShowdown, handViewOf, loadHandWorld } from "../../../packages/core/src/handworld.ts";
import type { HandView, HandWorld } from "../../../packages/core/src/handworld.ts";
import type { ShowdownSummary } from "../../../packages/core/src/showdowns.ts";
import { loadWorld } from "../../../packages/core/src/world.ts";
import type { World } from "../../../packages/core/src/world.ts";
import { SAVED_DATA_FILES, loadDataRoot } from "../../../tools/load.ts";
import type { DataRootInputs } from "../../../tools/load.ts";
import type { HandNight, HandProfile, HandScope, HandScopePayload, SnapshotHandLogs, UnloggedGame } from "../src/handtypes.ts";

// The game files that are hand logs (the same test the site's /api/data uses for its list).
const HAND_LOG_FILE = /(^|\/)poker_now_log_[^/]*\.csv$/i;

// The saved files a page may see: the six the app keeps, "" when a file is missing.
export function savedForPage(saved: Record<string, string>): Record<string, string> {
  return Object.fromEntries(SAVED_DATA_FILES.map((name): [string, string] => [name, saved[name] ?? ""]));
}

// The world and the raw hand logs of one data root: the ledgers go to loadWorld (with the saved
// files the page gets), and the hand logs are handed on as they are.
function worldAndLogs(inputs: DataRootInputs, timeZone: string): { world: World; logs: HandLogInput[] } {
  const ledgers = inputs.games.filter((g) => looksLikeLedger(g.text));
  const logs: HandLogInput[] = inputs.games.filter((g) => HAND_LOG_FILE.test(g.relativePath));
  return { world: loadWorld({ timeZone, ledgers, saved: savedForPage(inputs.savedData) }), logs };
}

// Every hand log of one data root, paired with its ledger, read the way the page reads the ledgers.
// A snapshot uses this one: nothing else is waiting while it runs.
export function handWorldFromInputs(inputs: DataRootInputs, timeZone: string): HandWorld {
  const { world, logs } = worldAndLogs(inputs, timeZone);
  return loadHandWorld(world, logs);
}

// The same hand logs as handWorldFromInputs, loaded the way loadHandWorld loads them, with a turn
// after each game is paired. Pairing is most of a load, so the server answers other requests in between.
export async function handWorldInTurns(inputs: DataRootInputs, timeZone: string): Promise<HandWorld> {
  const { world, logs } = worldAndLogs(inputs, timeZone);
  const loaded = loadAllLogs(logs);
  for (const game of world.games) {
    const log = loaded.logs.get(logIdOf(game));
    if (log !== undefined) pairWithLedger(log, game, world.rules);
    await turn();
  }
  return { world, logs: loaded.logs, messages: loaded.messages };
}

// One menu 21 profile, with its one Map (showdownHandClass) as pairs in the Map's own order. Its
// hit & run columns are the ones the console's deepPlaystyle gives (hitrun annotate), from the scope's summaries.
function profileOf(p: Profile, facts: ReadonlyMap<string, HitRunFacts>): HandProfile {
  const { showdownHandClass, ...rest } = p;
  const fact = facts.get(p.normalizedName);
  const annotated =
    fact === undefined
      ? rest
      : { ...rest, hitRun: fact.hitRun, hitRunReliable: fact.hitRunReliable, hitRunTag: fact.hitRunTag, hitRunLine: fact.hitRunLine };
  return { ...annotated, showdownHandClass: [...showdownHandClass] };
}

// The "Hand logs in scope" rows (handlog.cpp printGameSummaries), one per log in the scope.
function nightsOf(hw: HandWorld, view: HandView): HandNight[] {
  return view.logs.map((log) => {
    const seated = new Set<string>();
    let showdowns = 0;
    for (const hand of log.hands) {
      for (const seat of hand.seats) seated.add(seat.playerId);
      if (hand.showdown) showdowns++;
    }
    // The C++ takes the start of the hand with the biggest pot's number (the last one, if a number repeats).
    let at: number | null = null;
    for (const hand of log.hands) {
      if (hand.number === log.biggestPotHand) at = hand.start;
    }
    const hands = log.hands.length;
    return {
      gameId: log.gameId,
      start: log.start,
      folder: log.folder,
      hands,
      hours: log.start === null || log.end === null ? 0 : (log.end - log.start) / 3600,
      players: seated.size,
      showdownPercent: hands === 0 ? 0 : (100 * showdowns) / hands,
      biggestPot: log.biggestPot,
      biggestPotWinner: displayNameAt(log, log.biggestPotWinner, at, hw.world.rules, view.stats),
      biggestPotHand: log.biggestPotHand,
      stackMismatches: log.stackMismatches,
    };
  });
}

// The "Games without a log" lines (main.cpp handLogStats): the newest five games in scope with no
// hand log, newest first, and how many more there are (the console prints "..." for them).
function unloggedOf(hw: HandWorld, view: HandView): { unlogged: UnloggedGame[]; unloggedMore: number } {
  const missing = view.scoped.filter((game) => !hw.logs.has(logIdOf(game))).reverse();
  return {
    unlogged: missing.slice(0, 5).map((game) => ({ id: game.id, start: game.start, folder: game.folder })),
    unloggedMore: Math.max(0, missing.length - 5),
  };
}

// Everything the hand-log pages show for one scope, as plain JSON. The Maps become objects
// (playtime, showdowns) or pairs (a profile's showdownHandClass); the rest is already numbers,
// strings, booleans, nulls and arrays.
export function handScopePayload(hw: HandWorld, scope: Scope, basis: string): HandScopePayload {
  const view = handViewOf(hw, scope);
  const facts = hitRunFacts(view.hitRun.summaries);
  return {
    basis,
    scope: { folder: scope.folder, from: scope.from, to: scope.to },
    games: view.scoped.length,
    logged: view.logs.length,
    hands: view.logs.reduce((n, log) => n + log.hands.length, 0),
    messages: [...hw.messages],
    style: view.style,
    nights: nightsOf(hw, view),
    ...unloggedOf(hw, view),
    profiles: view.profiles.map((p) => profileOf(p, facts)),
    pool: poolAverages(view.profiles),
    hitRun: { summaries: view.hitRun.summaries, nights: view.hitRun.nights, unmeasured: view.hitRun.unmeasured },
    playtime: Object.fromEntries(view.playtime),
    showdowns: Object.fromEntries(
      [...view.stats.keys()].map((name): [string, ShowdownSummary] => [name, beatenAtShowdown(view, name)]),
    ),
    exports: view.exports,
  };
}

// What a snapshot carries: every folder together (key "") and each folder by its name, all
// dates open. A snapshot never writes, so its basis is "".
export function snapshotHandLogs(hw: HandWorld): SnapshotHandLogs {
  const open = (folder: string): Scope => ({ folder, from: null, to: null });
  const keys = ["", ...listFolders(hw.world.games)];
  return Object.fromEntries(keys.map((folder): [string, HandScopePayload] => [folder, handScopePayload(hw, open(folder), "")]));
}

// The longest folder name the query may give, in characters.
export const FOLDER_MAX_CHARS = 200;
// Epoch seconds the query may give: 1970 to 2100.
const EPOCH_MIN = 0;
const EPOCH_MAX = 4_102_444_800;

// A from or to value: a whole number of seconds in range, or null when left out.
function epochOf(value: string | undefined): number | null | "bad" {
  if (value === undefined) return null;
  if (!/^\d{1,10}$/.test(value)) return "bad";
  const n = Number(value);
  return n >= EPOCH_MIN && n <= EPOCH_MAX ? n : "bad";
}

// One name or value of the query, read as a form sends it: a plus sign is a space (URLSearchParams
// writes a space that way), and %2B is a plus sign.
function formPart(text: string): string {
  return decodeURIComponent(text.replace(/\+/g, " "));
}

// The scope a GET /api/handlogs query names (the text after "?"). Only folder, from and to are
// accepted, each once. A folder left out is every folder; a from or to left out is open. Anything
// else is an error, and no error repeats the value it refused.
export function parseHandScope(query: string): { scope: HandScope } | { error: string } {
  const given = new Map<string, string>();
  for (const part of query === "" ? [] : query.split("&")) {
    const eq = part.indexOf("=");
    let key: string;
    let value: string;
    try {
      key = formPart(eq === -1 ? part : part.slice(0, eq));
      value = formPart(eq === -1 ? "" : part.slice(eq + 1));
    } catch {
      return { error: "the query is not valid text" };
    }
    if (key !== "folder" && key !== "from" && key !== "to") return { error: "only folder, from and to can be given" };
    if (given.has(key)) return { error: "each of folder, from and to can be given once" };
    given.set(key, value);
  }
  const folder = given.get("folder") ?? "";
  if (Array.from(folder).length > FOLDER_MAX_CHARS) return { error: "the folder name is longer than 200 characters" };
  const from = epochOf(given.get("from"));
  const to = epochOf(given.get("to"));
  if (from === "bad") return { error: "from must be a whole number of seconds from 1970 to 2100, or left out" };
  if (to === "bad") return { error: "to must be a whole number of seconds from 1970 to 2100, or left out" };
  if (from !== null && to !== null && from > to) return { error: "from is after to" };
  return { scope: { folder, from, to } };
}

// Lets other requests run between the long steps of a load.
function turn(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

// How long the loaded hand logs stay in memory after the last request for them. The timer is
// unref'd, so it never keeps the process alive.
export const HAND_LOG_IDLE_MS = 5 * 60_000;
// How many scope results are kept (the most recently asked for).
export const SCOPE_CACHE_SIZE = 12;

export interface HandLogCacheStatus {
  loads: number; // how many times the hand logs were read and paired
  held: boolean; // whether a loaded set of hand logs is in memory now
  scopes: number; // scope results in memory
}

export interface HandLogCache {
  // The results for one scope under one basis (the data's fingerprint, see dataBasis in api.ts).
  payloadFor(dataRoot: string, timeZone: string, basis: string, scope: Scope): Promise<HandScopePayload>;
  status(): HandLogCacheStatus;
  close(): void; // drops everything and stops the idle timer
}

// Everything kept for one basis. A new basis gets a new slot, which drops the old one.
interface Slot {
  key: string; // the time zone and the basis, as JSON
  hw?: HandWorld; // the loaded hand logs, once they are read
  loading?: Promise<HandWorld>; // while they are read: every caller waits for the same read
  scopes: Map<string, Promise<HandScopePayload>>; // oldest first: the LRU
}

export function createHandLogCache(options: { idleMs?: number } = {}): HandLogCache {
  const idleMs = options.idleMs ?? HAND_LOG_IDLE_MS;
  let slot: Slot | undefined;
  let loads = 0;
  let active = 0; // requests still working: nothing is dropped under them
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Starts the countdown again. When it runs out, everything is dropped, unless a request is
  // still working (its end starts the countdown again).
  function touch(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (active === 0) slot = undefined;
    }, idleMs);
    timer.unref();
  }

  // The loaded hand logs of a slot. Read once; a failed read is not kept, so the next asks read again.
  function loadedIn(s: Slot, dataRoot: string, timeZone: string): Promise<HandWorld> {
    if (s.hw !== undefined) return Promise.resolve(s.hw);
    if (s.loading === undefined) {
      s.loading = (async () => {
        const inputs = await loadDataRoot(dataRoot);
        return handWorldInTurns(inputs, timeZone);
      })().then(
        (hw) => {
          s.hw = hw;
          loads++;
          return hw;
        },
        (err: unknown) => {
          s.loading = undefined;
          throw err;
        },
      );
    }
    return s.loading;
  }

  // The result for one scope, computed once; a failed one is not kept.
  function resultIn(s: Slot, scopeKey: string, dataRoot: string, timeZone: string, scope: Scope, basis: string): Promise<HandScopePayload> {
    const result = loadedIn(s, dataRoot, timeZone).then(async (hw) => {
      await turn();
      return handScopePayload(hw, scope, basis);
    });
    result.catch(() => {
      if (s.scopes.get(scopeKey) === result) s.scopes.delete(scopeKey);
    });
    return result;
  }

  return {
    async payloadFor(dataRoot, timeZone, basis, scope) {
      active++;
      touch();
      try {
        const key = JSON.stringify([timeZone, basis]);
        if (slot === undefined || slot.key !== key) slot = { key, scopes: new Map() };
        const mine = slot;
        const scopeKey = JSON.stringify([scope.folder, scope.from, scope.to]);
        const cached = mine.scopes.get(scopeKey);
        // Asked for again: it becomes the newest. Otherwise it is worked out, and the oldest is dropped past the limit.
        const result = cached ?? resultIn(mine, scopeKey, dataRoot, timeZone, scope, basis);
        mine.scopes.delete(scopeKey);
        mine.scopes.set(scopeKey, result);
        while (mine.scopes.size > SCOPE_CACHE_SIZE) {
          const oldest = mine.scopes.keys().next().value;
          if (oldest === undefined) break;
          mine.scopes.delete(oldest);
        }
        return await result;
      } finally {
        active--;
        touch();
      }
    },
    status() {
      return { loads, held: slot?.hw !== undefined, scopes: slot?.scopes.size ?? 0 };
    },
    close() {
      slot = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

// The cache the server uses: one per process. A test passes its own (ApiConfig.handLogs).
export const handLogCache: HandLogCache = createHandLogCache();
