// The website's Vite config keeps local/ (Saved_Data backups, snapshots, real-data runs) out of
// Vite's /@fs/ route. The deny pattern is checked with Vite's own matcher, on the paths Vite
// compares: forward slashes, also for a Windows drive path, and a folder name may hold glob
// characters such as parentheses. Made-up paths only.
import { createServer } from "vite";
import { describe, expect, it } from "vitest";

import { denyPatternFor } from "../server/fsdeny.ts";

// Whether Vite's fs.deny (built from these patterns, as vite.config.ts builds it) denies the file.
async function deniedBy(folder: string, file: string): Promise<boolean> {
  const server = await createServer({
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, fs: { deny: [denyPatternFor(folder)] } },
  });
  try {
    return (server.config as unknown as { fsDenyGlob: (path: string) => boolean }).fsDenyGlob(file);
  } finally {
    await server.close();
  }
}

describe("the deny pattern for local/", () => {
  it("denies the files in it on a Mac or Linux path, and nothing beside it", async () => {
    const local = "/Users/u/Poker_Ledger_Web/local";
    expect(await deniedBy(local, `${local}/backups/2031-05-01_settings.csv`)).toBe(true);
    expect(await deniedBy(local, `${local}/snapshots/poker-ledger-2031-05-01.html`)).toBe(true);
    expect(await deniedBy(local, "/Users/u/Poker_Ledger_Web/src/App.tsx")).toBe(false);
    expect(await deniedBy(local, "/Users/u/Poker_Ledger_Web/localx/a.csv")).toBe(false);
  });

  it("denies the files in it on a Windows path, which Vite compares with forward slashes", async () => {
    // Windows paths arrive with backslashes; Vite's check sees "C:/..." (slash() applied first).
    const local = "C:\\Users\\u\\Poker_Ledger_Web\\local";
    expect(await deniedBy(local, "C:/Users/u/Poker_Ledger_Web/local/backups/2031-05-01_settings.csv")).toBe(true);
    expect(await deniedBy(local, "C:/Users/u/Poker_Ledger_Web/local/snapshots/poker-ledger-2031-05-01.html")).toBe(true);
    expect(await deniedBy(local, "C:/Users/u/Poker_Ledger_Web/src/App.tsx")).toBe(false);
  });

  it("denies the files in a folder whose path has glob characters in it", async () => {
    const local = "/Users/u/Poker (copy) [2]/local";
    expect(await deniedBy(local, `${local}/backups/2031-05-01_settings.csv`)).toBe(true);
    expect(await deniedBy(local, "/Users/u/Poker (copy) [2]/src/App.tsx")).toBe(false);
  });
});
