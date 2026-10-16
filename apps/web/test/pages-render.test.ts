// The Saved_Data pages rendered from made-up data (react-dom/server, no browser): the
// banker note and the menu 5 hint on Settle, and the folder banner on Payments &
// corrections, show as they should, and each page builds without an error.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ledger, loadWorld, type World } from "../../../packages/core/src/index.ts";
import { loadDataRoot } from "../../../tools/load.ts";
import { buildCtx, type Ctx } from "../src/context.ts";
import { EVERYTHING, type Payload, type ScopeChoice } from "../src/data.ts";
import { lossMessage, writeSaved } from "../src/saved.ts";
import { Adjust } from "../src/pages/Adjust.tsx";
import { Settings } from "../src/pages/Settings.tsx";
import { Settle } from "../src/pages/Settle.tsx";

const TZ = "America/New_York";
const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
const MAY: ScopeChoice = { folder: "May games", from: "2031-05-01", to: "2031-05-31" };
// One payment saved under all folders: both of its sides count (as the console counts rows).
const PAYMENT = "group,date,player_normalized,amount,folder,note\nadj1-1,2031-05-10,della,20.00,,paid\nadj1-1,2031-05-10,ozzie,-20.00,,paid\n";
// A made-up balance row with too few fields: the site cannot read it, and a save would leave it out.
const SHORT_BALANCE = "session_id,from_display,from_normalized,to_display,to_normalized,original_amount,remaining_amount,status\nnight_one,Della,della\n";
const CLEAN_BALANCE = "session_id,from_display,from_normalized,to_display,to_normalized,original_amount,remaining_amount,status\n";

// The page context for the made-up data, with some Saved_Data files changed.
async function pageCtx(saved: Record<string, string>, choice: ScopeChoice = EVERYTHING): Promise<Ctx> {
  const data = await loadDataRoot(SYNTHETIC);
  const ledgers = data.games.filter((g) => ledger.looksLikeLedger(g.text));
  const files = { ...data.savedData, ...saved };
  const world: World = loadWorld({ timeZone: TZ, ledgers, saved: files });
  const payload: Payload = {
    source: "local",
    dataRoot: "fixtures/synthetic",
    timeZone: TZ,
    loadedAt: 0,
    ledgers,
    logs: [],
    saved: files,
    canWrite: true,
    consoleOpen: 0,
    basis: "made-up",
  };
  return buildCtx(payload, world, choice);
}

describe("the Saved_Data pages with made-up data", () => {
  it("Settle: a banker in Settings is shown as on, with no per-sheet checkbox", async () => {
    const ctx = await pageCtx({ "settings.csv": "key,value\nbanker,quinn\n" });
    const out = renderToStaticMarkup(createElement(Settle, { ctx, gameId: "", onSaved: () => {} }));
    expect(out).toContain("Banker mode is on: everyone settles through quinn");
    expect(out).toContain('change it in <a href="#/settings">Settings</a>');
    expect(out).not.toContain('type="checkbox"');
  });

  it("Settle: with a folder chosen, the payments saved under all folders that are left off this sheet are counted", async () => {
    const ctx = await pageCtx({ "adjustments.csv": PAYMENT }, MAY);
    const out = renderToStaticMarkup(createElement(Settle, { ctx, gameId: "", onSaved: () => {} }));
    expect(out).toContain("Not on this sheet: 2 payments/corrections saved under all folders");
  });

  it("Settle: nothing is left off when every folder is in scope", async () => {
    const ctx = await pageCtx({ "adjustments.csv": PAYMENT });
    const out = renderToStaticMarkup(createElement(Settle, { ctx, gameId: "", onSaved: () => {} }));
    expect(out).not.toContain("Not on this sheet");
  });

  it("Payments & corrections: a folder in scope is a highlighted warning, and every folder is a muted note", async () => {
    const inFolder = renderToStaticMarkup(createElement(Adjust, { ctx: await pageCtx({ "adjustments.csv": PAYMENT }, MAY), onSaved: () => {} }));
    expect(inFolder).toContain('<p class="banner">New entries go under:');
    expect(inFolder).toContain("<strong>May games</strong>");

    const everyFolder = renderToStaticMarkup(createElement(Adjust, { ctx: await pageCtx({ "adjustments.csv": PAYMENT }), onSaved: () => {} }));
    expect(everyFolder).toContain("New entries go under:");
    expect(everyFolder).not.toContain('class="banner"');
  });

  it("Settings: builds with a pin that now pays the same person", async () => {
    const ctx = await pageCtx({
      "merge_rules.csv": "alias_normalized,canonical_normalized\nozzie,della\n",
      "payment_preferences.csv": "payer_normalized,payee_normalized,note\nozzie,della,\n",
    });
    const out = renderToStaticMarkup(createElement(Settings, { ctx, onSaved: () => {} }));
    expect(out).toContain("Pinned payments");
  });

  it("Settings: the snapshot warning names everything the snapshot holds", async () => {
    const out = renderToStaticMarkup(createElement(Settings, { ctx: await pageCtx({}), onSaved: () => {} }));
    // The apostrophe is escaped in markup, so the sentence is checked from "results" on.
    expect(out).toContain("results, names, notes, PokerNow account ids and saved sheets: send it only to people who may see");
  });
});

describe("a save from the page that would leave out rows it could not read", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks first, and writes nothing when the answer is no", async () => {
    const ctx = await pageCtx({ "session_balances.csv": SHORT_BALANCE });
    const asked: string[] = [];
    const sent = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("window", {
      confirm: (text: string) => {
        asked.push(text);
        return false;
      },
    });
    vi.stubGlobal("fetch", sent);
    expect(await writeSaved(ctx, "session_balances.csv", CLEAN_BALANCE)).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("1 row in session_balances.csv could not be read");
    expect(sent).not.toHaveBeenCalled();
  });

  it("saves once the person says yes", async () => {
    const ctx = await pageCtx({ "session_balances.csv": SHORT_BALANCE });
    const sent = vi.fn(async () => new Response(JSON.stringify({ saved: "session_balances.csv" }), { status: 200 }));
    vi.stubGlobal("window", { confirm: () => true });
    vi.stubGlobal("fetch", sent);
    expect(await writeSaved(ctx, "session_balances.csv", CLEAN_BALANCE)).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("does not ask when the file reads cleanly", async () => {
    const ctx = await pageCtx({ "session_balances.csv": CLEAN_BALANCE });
    const sent = vi.fn(async () => new Response(JSON.stringify({ saved: "session_balances.csv" }), { status: 200 }));
    vi.stubGlobal("window", {
      confirm: () => {
        throw new Error("should not ask");
      },
    });
    vi.stubGlobal("fetch", sent);
    expect(await writeSaved(ctx, "session_balances.csv", CLEAN_BALANCE)).toBe(true);
  });

  it("says how many rows, and that the old file is kept", () => {
    expect(lossMessage("adjustments.csv", 0)).toBe("");
    expect(lossMessage("adjustments.csv", 1)).toContain("1 row in adjustments.csv could not be read");
    expect(lossMessage("adjustments.csv", 3)).toContain("3 rows in adjustments.csv could not be read");
    expect(lossMessage("adjustments.csv", 3)).toContain("local/backups/");
  });
});
