// Where the page gets its data, and the scope the user is looking at. The page asks
// the server for the raw files and does every calculation itself with @plr/core, so
// changing the scope is instant and the numbers are the console app's numbers.
import { loadWorld, parseLocalDate, type Scope, type World, type ledger } from "@plr/core";

export interface Payload {
  source: string; // "local": read from the console app's folder on this computer
  dataRoot: string;
  timeZone: string;
  loadedAt: number; // ms since the epoch
  ledgers: ledger.LedgerInput[];
  saved: Record<string, string>;
}

export interface Loaded {
  payload: Payload;
  world: World;
}

export async function loadData(): Promise<Loaded> {
  const res = await fetch("/api/data", { cache: "no-store" });
  if (!res.ok) throw new Error(`the data server answered ${res.status}`);
  const payload = (await res.json()) as Payload;
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
