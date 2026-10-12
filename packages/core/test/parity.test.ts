// Parity with the C++ app. The made-up run is committed and runs everywhere (CI
// included). The real-data run reads local/reference-real and the real data root,
// so it runs only with PARITY_REAL=1 (npm run parity:real). Nothing here writes a
// file: the checks print to the test output only.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { formatParityReport, runParity } from "../../../tools/parity.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

// The real data root is the C++ repo's folder, which holds Games/ and Saved_Data/.
// It sits beside this repo; PARITY_DATA overrides it.
const REAL_DATA = process.env.PARITY_DATA ?? join(REPO, "..", "Poker_Ledger_Reader");

describe("parity with the C++ app: made-up data", () => {
  it("matches every ledger export and printed text", async () => {
    const report = await runParity(join(REPO, "fixtures/synthetic-reference"), join(REPO, "fixtures/synthetic"));
    expect(report.scenarios.length).toBeGreaterThan(0);
    expect(report.mismatchCount, formatParityReport(report)).toBe(0);
  }, 120_000);
});

describe.skipIf(process.env.PARITY_REAL !== "1")("parity with the C++ app: real data (local only)", () => {
  it("matches every ledger export and printed text", async () => {
    const reference = join(REPO, "local/reference-real");
    expect(existsSync(reference), "run the real reference first (see reference/README.md)").toBe(true);
    const report = await runParity(reference, REAL_DATA);
    expect(report.mismatchCount, formatParityReport(report)).toBe(0);
  }, 600_000);
});
