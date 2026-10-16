// Pages rendered from made-up data (react-dom/server, no browser). A folder with no games says which
// folder the site looked in; a snapshot does not offer the request card that changes the sheet on
// screen; Add game says when the console app is open that it lists a new game only after a restart.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ledger, loadWorld } from "../../../packages/core/src/index.ts";
import { loadDataRoot } from "../../../tools/load.ts";
import { buildCtx, type Ctx } from "../src/context.ts";
import { EVERYTHING, type Payload } from "../src/data.ts";
import { AddGame } from "../src/pages/AddGame.tsx";
import { Overview } from "../src/pages/Overview.tsx";
import { Settle } from "../src/pages/Settle.tsx";

const TZ = "America/New_York";
const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));

// A page context from the given ledgers and saved files, as the page gets them.
function ctxFor(
  ledgers: ledger.LedgerInput[],
  saved: Record<string, string>,
  overrides: Partial<Payload> = {},
): Ctx {
  const world = loadWorld({ timeZone: TZ, ledgers, saved });
  const payload: Payload = {
    source: "local",
    dataRoot: "Poker_Ledger_Reader",
    timeZone: TZ,
    loadedAt: 0,
    ledgers,
    logs: [],
    saved,
    canWrite: true,
    consoleOpen: 0,
    basis: "made-up",
    ...overrides,
  };
  return buildCtx(payload, world, EVERYTHING);
}

async function syntheticCtx(overrides: Partial<Payload> = {}): Promise<Ctx> {
  const data = await loadDataRoot(SYNTHETIC);
  const ledgers = data.games.filter((g) => ledger.looksLikeLedger(g.text));
  return ctxFor(ledgers, data.savedData, overrides);
}

describe("a data folder with no games", () => {
  it("says which folder the site looked in, and where it has to be", () => {
    const out = renderToStaticMarkup(createElement(Overview, { ctx: ctxFor([], {}) }));
    expect(out).toContain("No games were found in");
    expect(out).toContain("Poker_Ledger_Reader");
    expect(out).toContain("next to this one");
  });

  it("still says that a scope with no games has none, when the folder does have games", async () => {
    const ctx = await syntheticCtx();
    const emptyScope = buildCtx(ctx.payload, ctx.world, { folder: "No such folder", from: "", to: "" });
    const out = renderToStaticMarkup(createElement(Overview, { ctx: emptyScope }));
    expect(out).toContain("No games in this scope.");
    expect(out).not.toContain("No games were found in");
  });
});

describe("the request card on Settle up", () => {
  it("is offered on a computer that runs the site", async () => {
    const out = renderToStaticMarkup(createElement(Settle, { ctx: await syntheticCtx(), gameId: "", onSaved: () => {} }));
    expect(out).toContain("Anyone want to send their money to a specific person?");
  });

  it("is not offered in a snapshot, where nothing can be changed", async () => {
    const ctx = await syntheticCtx({ source: "snapshot", canWrite: false, basis: "" });
    const out = renderToStaticMarkup(createElement(Settle, { ctx, gameId: "", onSaved: () => {} }));
    expect(out).not.toContain("Anyone want to send their money to a specific person?");
    expect(out).toContain("Settle up");
  });
});

describe("adding a game while the console app is open", () => {
  it("says the game is filed now and the console app lists it after a restart", async () => {
    const ctx = await syntheticCtx({ consoleOpen: 1 });
    const out = renderToStaticMarkup(createElement(AddGame, { ctx, onSaved: () => {} }));
    expect(out).toContain("lists it only after it is restarted");
    expect(out).not.toContain("will not save");
  });

  it("says nothing about the console when it is closed", async () => {
    const out = renderToStaticMarkup(createElement(AddGame, { ctx: await syntheticCtx(), onSaved: () => {} }));
    expect(out).not.toContain("lists it only after it is restarted");
  });
});
