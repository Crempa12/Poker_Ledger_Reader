// The page half of the fixes from walking through real use of the site on made-up data: what + Add game says
// after a save, the sheet text for the group chat, Past 30 days that moves with the calendar, a save refused
// over a date the site cannot read, what a read-only copy says, a merged name's link, and saved sheets that
// already cover a night. Rendered with react-dom/server (no browser).
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ledger, loadWorld, type World } from "../../../packages/core/src/index.ts";
import { loadDataRoot } from "../../../tools/load.ts";
import { buildCtx, type Ctx } from "../src/context.ts";
import { EVERYTHING, withDays, type Payload, type ScopeChoice } from "../src/data.ts";
import { afterSaveNotes, sizes } from "../src/pages/AddGame.tsx";
import { Check } from "../src/pages/Check.tsx";
import { Overview } from "../src/pages/Overview.tsx";
import { PlayerPage } from "../src/pages/Player.tsx";
import { Settle } from "../src/pages/Settle.tsx";
import { gameSessionId, unreadableDateMessage, writeSaved } from "../src/saved.ts";
import { copyText } from "../src/settle-sheet.ts";

const TZ = "America/New_York";
const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));

// The page context for the made-up data. saved replaces some Saved_Data files; canWrite false is a phone.
async function pageCtx(opts: { canWrite?: boolean; choice?: ScopeChoice; saved?: Record<string, string> } = {}): Promise<Ctx> {
  const data = await loadDataRoot(SYNTHETIC);
  const ledgers = data.games.filter((g) => ledger.looksLikeLedger(g.text));
  const saved = { ...data.savedData, ...(opts.saved ?? {}) };
  const world: World = loadWorld({ timeZone: TZ, ledgers, saved });
  const payload: Payload = {
    source: "local",
    dataRoot: "fixtures/synthetic",
    timeZone: TZ,
    loadedAt: 0,
    ledgers,
    logs: [],
    saved,
    canWrite: opts.canWrite ?? true,
    consoleOpen: 0,
    basis: "made-up",
  };
  return buildCtx(payload, world, opts.choice ?? EVERYTHING);
}

const show = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

describe("+ Add game, after a save", () => {
  it("says when the Folder at the top hides the game just filed", async () => {
    const data = await loadDataRoot(SYNTHETIC);
    const text = data.games.find((g) => g.relativePath.endsWith("ledger_pglFAKE0001.csv"))?.text ?? "";
    const item = { kind: "ledger" as const, gameId: "pglMadeUpNight01", text };
    const hidden = await pageCtx({ choice: { folder: "Synthetic Winter", from: "", to: "" } });
    expect(afterSaveNotes(hidden, item, "Nov 2026/ledger_pglMadeUpNight01.csv", [])).toEqual([
      "the Folder or Dates choice at the top hides it: pick All folders and All time to see it",
    ]);
    expect(afterSaveNotes(await pageCtx(), item, "Nov 2026/ledger_pglMadeUpNight01.csv", [])).toEqual([]);
    // A night from January is outside a range that starts in March.
    const later = await pageCtx({ choice: { folder: "", from: "2026-03-01", to: "" } });
    expect(afterSaveNotes(later, item, "Nov 2026/ledger_pglMadeUpNight01.csv", [])).toHaveLength(1);
  });

  it("says a hand log's ledger is not filed yet, unless it is filed or on the page", async () => {
    const ctx = await pageCtx();
    const log = { kind: "poker_now_log" as const, gameId: "pglMadeUpNight02", text: "entry,at,order\n" };
    expect(afterSaveNotes(ctx, log, "Nov 2026/poker_now_log_pglMadeUpNight02.csv", [])).toEqual(["its ledger is not filed yet: add that too"]);
    expect(afterSaveNotes(ctx, log, "Nov 2026/poker_now_log_pglMadeUpNight02.csv", [{ kind: "ledger", gameId: "pglMadeUpNight02" }])).toEqual([]);
    const filed = { ...log, gameId: "pglFAKE0001" }; // its ledger is in the data
    expect(afterSaveNotes(ctx, filed, "Synthetic Winter/poker_now_log_pglFAKE0001.csv", [])).toEqual([]);
  });
});

describe("a download bigger than the copy filed", () => {
  it("shows two sizes that differ, in bytes when the KB would read the same", () => {
    expect(sizes(920, 371)).toEqual(["920 bytes", "371 bytes"]);
    expect(sizes(310_000, 12_000)).toEqual(["303 KB", "12 KB"]);
  });
});

describe("the sheet for the group chat", () => {
  it("keeps the page's does-not-balance note", () => {
    const text = copyText("Game on May 2", [], [{ totalCents: -200, effect: "debt-unpaid", amountCents: 200 }]);
    expect(text).toContain("This sheet does not balance");
    expect(text).toContain("$2.00 of debt has nobody to be paid to.");
    expect(copyText("Game on May 2", [])).toBe("Poker settle-up: Game on May 2");
  });
});

describe("Past 30 days", () => {
  it("starts 30 days before today, worked out each time", () => {
    const preset: ScopeChoice = { folder: "", from: "", to: "", days: 30 };
    expect(withDays(preset, TZ, Date.UTC(2026, 9, 16, 16)).from).toBe("2026-09-16");
    expect(withDays(preset, TZ, Date.UTC(2026, 10, 15, 16)).from).toBe("2026-10-16");
    // An evening in the hour a clock change moves: still 30 calendar days back.
    expect(withDays(preset, TZ, Date.UTC(2026, 10, 16, 4, 30)).from).toBe("2026-10-16");
    const typed: ScopeChoice = { folder: "", from: "2026-01-01", to: "2026-02-01" };
    expect(withDays(typed, TZ, Date.UTC(2026, 10, 15, 16))).toBe(typed);
  });
});

describe("a save over a date the site cannot read", () => {
  it("is refused before anything is sent, naming the row", async () => {
    const data = await loadDataRoot(SYNTHETIC);
    const seatOwners = (data.savedData["seat_owners.csv"] ?? "").replace("2026-10-03T23:03:00Z", "2026-10-03 23:03:00");
    const ctx = await pageCtx({ saved: { "seat_owners.csv": seatOwners } });
    expect(ctx.world.warnings.some((w) => w.source === "seat_owners.csv" && w.code === "bad-date")).toBe(true);
    await expect(writeSaved(ctx, "seat_owners.csv", seatOwners)).rejects.toThrow(/^Row 1 of seat_owners\.csv has a date or time the site cannot read/);
    expect(unreadableDateMessage("adjustments.csv", [2, 5])).toContain("Rows 2, 5 of adjustments.csv have dates or times");
    expect(unreadableDateMessage("adjustments.csv", [2])).toContain("saving would write it as unknown");
    expect(unreadableDateMessage("adjustments.csv", [])).toBe("");
  });
});

describe("a save over the console app's own unknown date", () => {
  it("goes through: unknown is how the console writes no date, and it is written back the same", async () => {
    const text = "group,date,player_normalized,amount,folder,note\ng1,unknown,della,12.50,,paid\ng2,2026-13-45,ozzie,5.00,,typo\n";
    const ctx = await pageCtx({ saved: { "adjustments.csv": text } });
    expect(ctx.world.warnings.filter((w) => w.source === "adjustments.csv" && w.code === "bad-date").map((w) => w.row)).toEqual([1, 2]);
    // Only the typed date that cannot be read holds the save.
    await expect(writeSaved(ctx, "adjustments.csv", text)).rejects.toThrow(/^Row 2 of adjustments\.csv/);
    const unknownOnly = await pageCtx({ saved: { "adjustments.csv": "group,date,player_normalized,amount,folder,note\ng1,unknown,della,12.50,,paid\n" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ saved: "adjustments.csv" }), { status: 200 })));
    try {
      await expect(writeSaved(unknownOnly, "adjustments.csv", "x")).resolves.toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a read-only copy (a phone, a snapshot)", () => {
  it("names whose net the tile is, and says where answers are made", async () => {
    const phone = await pageCtx({ canWrite: false });
    const overview = show(createElement(Overview, { ctx: phone }));
    expect(overview).toContain("Zaqvin's net");
    expect(overview).not.toContain("Your net");
    expect(show(createElement(Overview, { ctx: await pageCtx() }))).toContain("Your net");
    expect(show(createElement(Check, { ctx: phone, onSaved: () => undefined }))).toContain("This copy is read-only");
  });
});

describe("a name merged into another", () => {
  it("opens the merged person's page", async () => {
    const ctx = await pageCtx();
    // merge_rules.csv in the made-up data: vextorq -> vextor -> vextorion.
    const out = show(createElement(PlayerPage, { ctx, normalized: "vextorq" }));
    expect(out).not.toContain("No player by that name.");
    expect(show(createElement(PlayerPage, { ctx, normalized: "nobody-made-up" }))).toContain("No player by that name.");
  });
});

describe("saving a sheet that saved sheets already cover", () => {
  it("is pointed out on the folder's sheet when a night has a sheet of its own", async () => {
    const plain = await pageCtx();
    const night = plain.world.games[0];
    if (night === undefined) throw new Error("the made-up data has no games");
    const header = "session_id,from_display,from_normalized,to_display,to_normalized,original_amount,remaining_amount,status\n";
    const balances = `${header}${gameSessionId(night, TZ)},Jolwick,jolwick,Kaxtun,kaxtun,15.00,15.00,open\n`;
    const ctx = await pageCtx({ saved: { "session_balances.csv": balances } });
    const out = show(createElement(Settle, { ctx, gameId: "", onSaved: () => undefined }));
    expect(out).toContain(`The saved sheet "${gameSessionId(night, TZ)}" may already cover some of these games.`);
    expect(show(createElement(Settle, { ctx: plain, gameId: "", onSaved: () => undefined }))).not.toContain("may already cover");
  });
});
