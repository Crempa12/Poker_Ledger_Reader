// One person on two accounts in one hand: what the playstyle rules count.
//
// The spec (docs/specs/playtime-showdown.md, section 0) says one person on two accounts in one
// hand is one person in that hand. The C++ app (src/playstyle.cpp) and this port compare accounts
// in the preflop "facing a raise" and "facing a three-bet" rules, and in the per-seat VPIP position
// buckets. The C++ reference (fixtures/synthetic-edge-reference, checked byte for byte by
// parity-edge.test.ts) matches the account rule, so the port keeps it. The spec wording is an open
// decision for the owner: either the spec changes to the account rule, or the C++ app and this
// port change together. The it.todo below records the spec's reading until that is decided.
//
// Made-up data only: the names and ids here are invented (FAKEq ids).

import { describe, expect, it } from "vitest";

import { parseHandLog, type HandLog } from "../src/handlog.ts";
import { analyze, type Profile } from "../src/playstyle.ts";

// A hand log from entries in time order, written the way PokerNow writes it, read back by the parser.
function logOf(entries: readonly string[], gameId = "pglTWO01"): HandLog {
  const field = (s: string): string => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const base = Date.UTC(2031, 4, 6, 3, 0, 0);
  const rows = entries.map((e, i) => `${field(e)},${new Date(base + i * 1000).toISOString()},${i + 1}`);
  const text = ["entry,at,order", ...rows.reverse()].join("\n") + "\n";
  const parsed = parseHandLog({ relativePath: `poker_now_log_${gameId}.csv`, text });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.log;
}

// Four seats. Ada is on the button, Bo posts the small blind, and "Rixa" sits on two accounts:
// FAKEq03 (big blind) and FAKEq04 (seat 4, first to act). Both accounts carry the nickname Rixa,
// so they are one person under the merge rules. FAKEq04 raises first, and FAKEq03 calls the raise.
const TWO_ACCOUNTS: readonly string[] = [
  `-- starting hand #1 (id: FAKEq10) (dealer: "Ada @ FAKEq01")`,
  `Player stacks: #1 "Ada @ FAKEq01" (100.00) | #2 "Bo @ FAKEq02" (100.00) | #3 "Rixa @ FAKEq03" (100.00) | #4 "Rixa @ FAKEq04" (100.00)`,
  `"Bo @ FAKEq02" posts a small blind of 0.50`,
  `"Rixa @ FAKEq03" posts a big blind of 1.00`,
  `"Rixa @ FAKEq04" raises to 3.00`,
  `"Ada @ FAKEq01" folds`,
  `"Bo @ FAKEq02" folds`,
  `"Rixa @ FAKEq03" calls 2.00`,
  `"Rixa @ FAKEq04" collected 6.50 from pot`,
  `-- ending hand #1 --`,
];

function rowFor(rows: readonly Profile[], name: string): Profile {
  const row = rows.find((r) => r.normalizedName === name);
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
}

const ROWS = analyze([logOf(TWO_ACCOUNTS)], new Map(), new Map());

describe("one person on two accounts in one hand", () => {
  it("counts the person once in the hands and in the VPIP and PFR rates", () => {
    const rixa = rowFor(ROWS, "rixa");
    expect(ROWS.filter((r) => r.normalizedName === "rixa")).toHaveLength(1);
    expect(rixa.hands).toBe(1);
    expect(rixa.handsVoluntary).toBe(1);
    expect(rixa.vpip).toEqual({ made: 1, opportunities: 1 });
    expect(rixa.pfr).toEqual({ made: 1, opportunities: 1 });
  });

  it("counts the second account's call as facing the first account's raise, as the C++ app does", () => {
    // playstyle.cpp: raiseCount == 1 && a.playerId != lastRaiser. FAKEq03 is not FAKEq04, so the
    // call is a three-bet and fold-to-open chance for Rixa, and the call is not a fold.
    const rixa = rowFor(ROWS, "rixa");
    expect(rixa.threeBet).toEqual({ made: 0, opportunities: 1 });
    expect(rixa.foldToOpen).toEqual({ made: 0, opportunities: 1 });
  });

  it("gives Ada's fold to that raise to Ada, not to Rixa", () => {
    // Ada faces the single raise like any seat does: a three-bet chance (not taken) and a fold.
    const ada = rowFor(ROWS, "ada");
    expect(ada.foldToOpen).toEqual({ made: 1, opportunities: 1 });
    expect(ada.threeBet).toEqual({ made: 0, opportunities: 1 });
  });

  it("keeps the first raise with the account that made it (the open and steal chances)", () => {
    const rixa = rowFor(ROWS, "rixa");
    expect(rixa.openRaise).toEqual({ made: 1, opportunities: 1 });
    expect(rixa.steal).toEqual({ made: 1, opportunities: 1 });
    expect(rixa.limp).toEqual({ made: 0, opportunities: 1 });
  });

  it("counts a seat per account in the VPIP position buckets, as the C++ app does", () => {
    // The C++ loop runs over seats, so the two Rixa seats (big blind and cutoff) each open a
    // bucket. The spec's one-person rule would count the person once; the open decision above.
    const rixa = rowFor(ROWS, "rixa");
    expect(rixa.vpipBlinds).toEqual({ made: 1, opportunities: 1 });
    expect(rixa.vpipLate).toEqual({ made: 1, opportunities: 1 });
    expect(rixa.vpipEarly).toEqual({ made: 0, opportunities: 0 });
  });

  it.todo(
    "spec section 0 (open decision): one person on two accounts is one person, so Rixa's own call is not a three-bet or fold-to-open chance (both 0)",
  );
});
