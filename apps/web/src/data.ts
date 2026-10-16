// Where the page gets its data, and the scope the user is looking at. The page asks
// the server for the raw files and does every calculation itself with @plr/core, so
// changing the scope is instant and the numbers are the console app's numbers.
import { loadWorld, parseLocalDate, type Scope, type World, type ledger } from "@plr/core";

import type { SnapshotHandLogs } from "./handtypes.ts";

export interface Payload {
  source: string; // "local": read from the console app's folder on this computer; "snapshot": a shared file
  dataRoot: string;
  timeZone: string;
  loadedAt: number; // ms since the epoch
  ledgers: ledger.LedgerInput[];
  logs: string[]; // paths of the hand logs under the game folder (their text is not sent)
  saved: Record<string, string>;
  canWrite: boolean; // the server can file new game files and rewrite Saved_Data (this computer only)
  consoleOpen: number; // console app windows open when the data was read: 0 none, -1 could not tell (Saved_Data saves wait for 0)
  gamesFolder?: boolean; // whether the data folder has a Games folder (a new game goes there, else at the top); absent in a snapshot
  dataReady?: boolean; // whether the folder read holds the console app's data; absent in a snapshot
  canStartData?: boolean; // whether a new data folder may be started there (it is missing or empty); absent in a snapshot
  basis: string; // the server's token for every input a save depends on; sent back with each save ("" for a snapshot, which never writes)
  handlogs?: SnapshotHandLogs; // a snapshot's hand-log results for all dates (absent in local mode, which asks the server)
}

export interface Loaded {
  payload: Payload;
  world: World;
}

// A snapshot file (server/snapshot.ts) carries its data in this element instead.
function embedded(): Payload | null {
  const el = typeof document === "undefined" ? null : document.getElementById("plr-data");
  return el === null || el.textContent === null ? null : (JSON.parse(el.textContent) as Payload);
}

export function isSnapshot(payload: Payload): boolean {
  return payload.source === "snapshot";
}

export async function loadData(): Promise<Loaded> {
  let payload = embedded();
  if (payload === null) {
    const res = await fetch("/api/data", { cache: "no-store" });
    if (!res.ok) throw new Error(`the data server answered ${res.status}`);
    payload = (await res.json()) as Payload;
  }
  const world = loadWorld({ timeZone: payload.timeZone, ledgers: payload.ledgers, saved: payload.saved });
  return { payload, world };
}

// What the scope bar holds: a folder ("" = every folder) and an optional date range
// as YYYY-MM-DD strings ("" = open).
export interface ScopeChoice {
  folder: string;
  from: string;
  to: string;
}

export const EVERYTHING: ScopeChoice = { folder: "", from: "", to: "" };

export function toScope(choice: ScopeChoice, timeZone: string): Scope {
  return {
    folder: choice.folder,
    from: choice.from === "" ? null : parseLocalDate(choice.from, false, timeZone),
    to: choice.to === "" ? null : parseLocalDate(choice.to, true, timeZone),
  };
}

const STORAGE_KEY = "plr.scope";

export function readSavedScope(): ScopeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return EVERYTHING;
    const v = JSON.parse(raw) as Partial<ScopeChoice>;
    return { folder: v.folder ?? "", from: v.from ?? "", to: v.to ?? "" };
  } catch {
    return EVERYTHING;
  }
}

export function saveScope(choice: ScopeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Private windows can refuse storage; the scope then lasts for this visit only.
  }
}

// Reads from the local server that only this page, on this computer, may make (the Downloads
// folder): the same custom header as postJSON.
export async function getLocalJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "X-PLR": "1" }, cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `the server answered ${res.status}`);
  return data;
}

// Calls to the local server that change files. The custom header lets the server
// refuse anything that did not come from this page.
export async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PLR": "1" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `the server answered ${res.status}`);
  return data;
}
