// The Help page: the weekly routine on the computer that runs the site, and only how to
// read it in a snapshot (where nothing can be changed). Made-up data.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ledger, loadWorld } from "../../../packages/core/src/index.ts";
import { loadDataRoot } from "../../../tools/load.ts";
import { buildCtx, type Ctx } from "../src/context.ts";
import { EVERYTHING, type Payload } from "../src/data.ts";
import { Help } from "../src/pages/Help.tsx";

const TZ = "America/New_York";
const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));

async function helpCtx(source: "local" | "snapshot"): Promise<Ctx> {
  const data = await loadDataRoot(SYNTHETIC);
  const ledgers = data.games.filter((g) => ledger.looksLikeLedger(g.text));
  const world = loadWorld({ timeZone: TZ, ledgers, saved: data.savedData });
  const payload: Payload = {
    source,
    dataRoot: "synthetic",
    timeZone: TZ,
    loadedAt: Date.UTC(2031, 4, 2, 16) /* made-up: May 2, 2031 */,
    ledgers,
    logs: [],
    saved: data.savedData,
    canWrite: source === "local",
    consoleOpen: 0,
    basis: source === "local" ? "made-up" : "",
  };
  return buildCtx(payload, world, EVERYTHING);
}

describe("the Help page", () => {
  it("walks through a week on the computer that runs the site, and names the console menus", async () => {
    const out = renderToStaticMarkup(createElement(Help, { ctx: await helpCtx("local") }));
    for (const step of ["+ Add game", "Checks", "Settle up", "Who owes", "Make a snapshot", "0. Save and exit", "Refresh"]) {
      expect(out, step).toContain(step);
    }
    for (const path of ["#/add", "#/check", "#/settle", "#/owed", "#/settings", "#/style", "#/adjust"]) {
      expect(out, path).toContain(`href="${path}"`);
    }
    expect(out).toContain("Console menu");
  });

  it("in a snapshot, says how to read it and offers nothing that changes data", async () => {
    const out = renderToStaticMarkup(createElement(Help, { ctx: await helpCtx("snapshot") }));
    expect(out).toContain("How to read this");
    expect(out).toContain("May 2, 2031");
    for (const gone of ["#/add", "#/settings", "#/adjust", "Save sheet", "Paid…", "Console menu"]) {
      expect(out, gone).not.toContain(gone);
    }
  });
});
