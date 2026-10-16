// The hand-log results for the scope the page is showing. The server works them out
// (GET /api/handlogs); a snapshot carries them ready-made for all dates. Results are kept per
// data basis and scope, so moving between the pages is instant. Nothing here reads a file.
import { useEffect, useState } from "react";
import type { Scope } from "@plr/core";

import type { Ctx } from "./context.ts";
import { isSnapshot, type Payload } from "./data.ts";
import { entryOf } from "./handformat.ts";
import type { HandScopePayload } from "./handtypes.ts";

export interface HandLogs {
  status: "loading" | "ready" | "error" | "unavailable";
  data?: HandScopePayload; // when ready
  message?: string; // when error or unavailable: one plain sentence for the page
  retry?: () => void; // when error: ask the server again
}

// Results for one data basis (a save changes the basis), by scope, the newest KEEP_SCOPES.
export const KEEP_SCOPES = 12;
const cache = new Map<string, HandScopePayload>();
let cacheBasis: string | null = null;

function keyOf(basis: string, scope: Scope): string {
  return JSON.stringify([basis, scope.folder, scope.from, scope.to]);
}

// The query for GET /api/handlogs: the folder always, the dates only when they are set. Each name is
// percent-encoded, so a space is %20 and a plus sign is %2B.
export function handLogsQuery(scope: Scope): string {
  const parts = [`folder=${encodeURIComponent(scope.folder)}`];
  if (scope.from !== null) parts.push(`from=${scope.from}`);
  if (scope.to !== null) parts.push(`to=${scope.to}`);
  return parts.join("&");
}

// The message for a date range that ends before it starts. The server would refuse that query, so it is not asked.
export const REVERSED_DATES = "The From date is after the To date. Change the dates above.";

// Whether the page's dates name a range that ends before it starts.
export function datesReversed(scope: Scope): boolean {
  return scope.from !== null && scope.to !== null && scope.from > scope.to;
}

// The server reads hand logs for dates from 1970 to 2100 only (server/handlogs.ts parseHandScope).
export const DATES_OUT_OF_RANGE = "Hand logs can only be read for dates from 1970 to 2100. Change the dates above.";
const LAST_SECOND = 4102444800;

export function datesOutOfRange(scope: Scope): boolean {
  const bad = (t: number | null) => t !== null && (t < 0 || t > LAST_SECOND);
  return bad(scope.from) || bad(scope.to);
}

// Why the page's dates cannot be asked for, or null when they can.
function datesProblem(scope: Scope): string | null {
  if (datesReversed(scope)) return REVERSED_DATES;
  if (datesOutOfRange(scope)) return DATES_OUT_OF_RANGE;
  return null;
}

// The results already fetched for this basis and scope, if any.
export function cachedHandLogs(basis: string, scope: Scope): HandScopePayload | undefined {
  return cacheBasis === basis ? cache.get(keyOf(basis, scope)) : undefined;
}

// Asks the server for one scope's results and keeps them. A refusal throws with the server's words.
export async function fetchHandLogs(basis: string, scope: Scope): Promise<HandScopePayload> {
  const res = await fetch(`/api/handlogs?${handLogsQuery(scope)}`, { cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as Partial<HandScopePayload> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `the server answered ${res.status}`);
  if (typeof body.basis !== "string" || typeof body.games !== "number") {
    throw new Error("the server sent hand-log results this page cannot read");
  }
  const data = body as HandScopePayload;
  if (cacheBasis !== data.basis) {
    cache.clear();
    cacheBasis = data.basis;
  }
  cache.set(keyOf(data.basis, scope), data);
  // Keep the newest few scopes, as the server does (each can be half a megabyte).
  for (const old of cache.keys()) {
    if (cache.size <= KEEP_SCOPES) break;
    cache.delete(old);
  }
  return data;
}

// A snapshot holds the results for all dates: each folder under its name, and "" for every folder.
export function fromSnapshot(payload: Payload, scope: Scope): HandLogs {
  if (payload.handlogs === undefined) {
    return { status: "unavailable", message: "This snapshot has no hand-log results. Ask whoever sent it for a new one." };
  }
  if (datesReversed(scope)) return { status: "unavailable", message: REVERSED_DATES };
  if (scope.from !== null || scope.to !== null) {
    return {
      status: "unavailable",
      message: 'A snapshot has the hand-log results for all dates only. Choose "All time" above to see them.',
    };
  }
  const data = entryOf(payload.handlogs, scope.folder);
  if (data === undefined) {
    return { status: "unavailable", message: "This snapshot has no hand-log results for this folder." };
  }
  return { status: "ready", data };
}

// The hand-log results for the page's scope: ready, still loading, or why they cannot be shown.
// The rest of the page never waits for them.
export function useHandLogs(ctx: Ctx): HandLogs {
  const { payload, scope } = ctx;
  const snapshot = isSnapshot(payload);
  const key = keyOf(payload.basis, scope);
  const problem = datesProblem(scope);
  const reversed = problem !== null;
  const [attempt, setAttempt] = useState(0);
  const [fetched, setFetched] = useState<{ key: string; result: HandLogs } | null>(null);

  useEffect(() => {
    if (snapshot || reversed || cachedHandLogs(payload.basis, scope) !== undefined) return;
    // An answer for a scope the page has left is dropped: only the scope on screen may show.
    let current = true;
    setFetched(null);
    fetchHandLogs(payload.basis, scope)
      .then((data) => {
        if (current) setFetched({ key, result: { status: "ready", data } });
      })
      .catch((err: unknown) => {
        if (current) {
          setFetched({
            key,
            result: {
              status: "error",
              message: err instanceof Error ? err.message : String(err),
              retry: () => setAttempt((n) => n + 1),
            },
          });
        }
      });
    return () => {
      current = false;
    };
  }, [key, snapshot, reversed, attempt]);

  if (snapshot) return fromSnapshot(payload, scope);
  if (problem !== null) return { status: "unavailable", message: problem };
  const cached = cachedHandLogs(payload.basis, scope);
  if (cached !== undefined) return { status: "ready", data: cached };
  if (fetched !== null && fetched.key === key) return fetched.result;
  return { status: "loading" };
}
