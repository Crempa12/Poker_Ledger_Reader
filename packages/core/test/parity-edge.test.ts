// Parity with the C++ app on the made-up edge cases: the data is fixtures/synthetic-edge and the
// reference is fixtures/synthetic-edge-reference (reference/run.sh on that data, with every menu the
// reference harness covers). The cases: a cut-short log, a browser copy, a log without a ledger, a
// ledger without a log, an empty log, dead buttons, bomb pots, run-it-twice, 7-2 bounties, admin
// stack events, one person on two accounts, one account for two people, and hand logs in three
// folders. Nothing here writes a file: the checks print to the test output only.

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { formatParityReport, runParity } from "../../../tools/parity.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

describe("parity with the C++ app: made-up edge cases", () => {
  it("matches every ledger and hand-log export and printed text", async () => {
    const report = await runParity(
      join(REPO, "fixtures/synthetic-edge-reference"),
      join(REPO, "fixtures/synthetic-edge"),
    );
    expect(report.scenarios.length).toBeGreaterThan(0);
    expect(report.mismatchCount, formatParityReport(report)).toBe(0);
  }, 180_000);
});
