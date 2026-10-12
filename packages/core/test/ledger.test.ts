import { describe, expect, it } from "vitest";

import {
  describeDuplicates,
  discoverLedgerFiles,
  filterGames,
  type LedgerInput,
  ledgerFolder,
  listFolders,
  loadAllGames,
  logId,
  looksLikeLedger,
  parseLedgerFile,
} from "../src/ledger.ts";
import { scopeContains, scopeDescribe, scopeIsEverything } from "../src/models.ts";
import { parseLocalDate } from "../src/util.ts";

const NEW_YORK = "America/New_York";
const HEADER = "player_nickname,player_id,session_start_at,session_end_at,buy_in,buy_out,stack,net";

// Made-up players and amounts only.
const ALICE = "Alice,p1,2031-05-06T00:10:00.000Z,2031-05-06T03:00:00.000Z,2500,4000,4000,1500";
const BOB = "Bob,p2,2031-05-06T00:20:00.000Z,2031-05-06T02:00:00.000Z,2000,500,500,-1500";
const BOB_SHORT = "Bob,p2,2031-05-06T00:20:00.000Z,2031-05-06T02:00:00.000Z,2000,500,500,-1000";
const CAROL = '"Carol, Jr.",p3,2031-05-06T01:00:00.000Z,2031-05-06T02:30:00.000Z,1000,1000,1000,0';
const DANA = "Dana,p4,2031-05-06T01:30:00.000Z,2031-05-06T04:10:00.000Z,500,500,500,0";

function ledgerText(...rows: string[]): string {
  return [HEADER, ...rows].join("\n") + "\n";
}

function file(relativePath: string, ...rows: string[]): LedgerInput {
  return { relativePath, text: ledgerText(...rows) };
}

// A one-row ledger that starts at the given instant (net 0, so it balances).
function nightAt(id: string, startIso: string): LedgerInput {
  return file(`folder/ledger_${id}.csv`, `Solo${id},p${id},${startIso},,1000,1000,1000,0`);
}

describe("finding ledger files", () => {
  it("keeps .csv files whose first line names player_nickname, in path order", () => {
    const found = discoverLedgerFiles([
      file("b/ledger_pglB.csv", ALICE),
      file("A/ledger_pglA.csv", ALICE),
      file("a b/x.csv", ALICE),
      file("a/x.csv", ALICE),
      { relativePath: "notes.txt", text: HEADER + "\n" },
      { relativePath: "other.csv", text: "name,net\nX,1\n" },
    ]).map((f) => f.relativePath);
    expect(found).toEqual(["A/ledger_pglA.csv", "a/x.csv", "a b/x.csv", "b/ledger_pglB.csv"]);
  });

  it("skips the excluded folders at any depth", () => {
    const found = discoverLedgerFiles([
      file("Saved_Data/x.csv", ALICE),
      file("data/Saved_Data/x.csv", ALICE),
      file("build/x.csv", ALICE),
      file("reports/x.csv", ALICE),
      file(".git/x.csv", ALICE),
      file(".idea/x.csv", ALICE),
      file("cmake-build-debug/x.csv", ALICE),
      file("cmake/x.csv", ALICE),
      file("Saved_Data_old/x.csv", ALICE),
    ]).map((f) => f.relativePath);
    expect(found).toEqual(["Saved_Data_old/x.csv", "cmake/x.csv"]);
  });

  it("accepts any case of .csv, and not a hidden .csv or a .csv.txt", () => {
    const found = discoverLedgerFiles([
      file("UPPER.CSV", ALICE),
      file(".csv", ALICE),
      file("x.csv.txt", ALICE),
    ]).map((f) => f.relativePath);
    expect(found).toEqual(["UPPER.CSV"]);
  });

  it("needs player_nickname in the first line, and an empty file is not a ledger", () => {
    expect(looksLikeLedger(HEADER + "\n")).toBe(true);
    expect(looksLikeLedger("name,net\nplayer_nickname\n")).toBe(false);
    expect(looksLikeLedger("")).toBe(false);
    expect(discoverLedgerFiles([{ relativePath: "empty.csv", text: "" }])).toEqual([]);
  });

  it("names the folder of a file, or (root) for a file at the top", () => {
    expect(ledgerFolder("x.csv")).toBe("(root)");
    expect(ledgerFolder("data_folder_May/x.csv")).toBe("data_folder_May");
    expect(ledgerFolder("a/b/x.csv")).toBe("a/b");
  });
});

describe("parsing one ledger", () => {
  it("reads quoted nicknames, sit-downs and money in cents", () => {
    const r = parseLedgerFile(file("data_folder_May/ledger_pglA.csv", ALICE, CAROL));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = r.game;
    expect(g.id).toBe("ledger_pglA");
    expect(g.folder).toBe("data_folder_May");
    expect(g.path).toBe("data_folder_May/ledger_pglA.csv");
    expect(g.rows.map((row) => row.nickname)).toEqual(["Alice", "Carol, Jr."]);
    expect(g.rows[0]).toMatchObject({
      playerId: "p1",
      buyInCents: 2500,
      buyOutCents: 4000,
      stackCents: 4000,
      netCents: 1500,
      owner: "",
      ownerReviewed: false,
    });
    expect(g.start).toBe(Date.parse("2031-05-06T00:10:00Z") / 1000);
    expect(g.end).toBe(Date.parse("2031-05-06T03:00:00Z") / 1000);
    expect(g.totalBuyInCents).toBe(3500);
    expect(g.skippedRows).toBe(0);
  });

  it("names a browser copy after its ledger, not the copy", () => {
    const r = parseLedgerFile(file("ledger_pglA (1).csv", ALICE, BOB));
    expect(r.ok && r.game.id).toBe("ledger_pglA");
    expect(r.ok && r.game.folder).toBe("(root)");
  });

  it("leaves out never-played seats and keeps any row that moved money", () => {
    const r = parseLedgerFile(
      file("ledger_pglS.csv", ALICE, ",p8,,,0,0,0,0", "Ghost,p9,,,0,0,0,0", "Trail,p10,,,0,0,300,300"),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.game.rows.map((row) => row.nickname)).toEqual(["Alice", "Trail"]);
    expect(r.game.skippedRows).toBe(2);
    expect(r.game.rows[1]).toMatchObject({ start: null, end: null, netCents: 300 });
    expect(r.game.start).toBe(Date.parse("2031-05-06T00:10:00Z") / 1000);
  });

  it("explains why a file cannot be used", () => {
    expect(parseLedgerFile({ relativePath: "x/empty.csv", text: "" })).toEqual({
      ok: false,
      error: "empty file empty.csv",
    });
    expect(parseLedgerFile({ relativePath: "nonet.csv", text: "player_nickname,buy_in\nA,1\n" })).toEqual({
      ok: false,
      error: "missing player_nickname/net columns in nonet.csv",
    });
    expect(parseLedgerFile(file("onlyskips.csv", ",p15,,,0,0,0,0"))).toEqual({
      ok: false,
      error: "only never-played seats (no start time, $0 net) in onlyskips.csv",
    });
    expect(parseLedgerFile({ relativePath: "norows.csv", text: HEADER + "\n" })).toEqual({
      ok: false,
      error: "no player rows in norows.csv",
    });
  });

  it("reads CRLF line endings", () => {
    const text = ledgerText(ALICE, BOB).replace(/\n/g, "\r\n");
    const r = parseLedgerFile({ relativePath: "crlf.csv", text });
    expect(r.ok && r.game.rows.map((row) => row.nickname)).toEqual(["Alice", "Bob"]);
  });
});

describe("loading all ledgers and the duplicate rules", () => {
  it("keeps identical content once, whatever the file name or folder", () => {
    const copy: LedgerInput = {
      relativePath: "data_folder_May/ledger_pglA (1).csv",
      text: ledgerText(CAROL, BOB, ALICE).replace(/\n/g, "\r\n"),
    };
    const result = loadAllGames([file("data_folder_May/ledger_pglA.csv", ALICE, BOB, CAROL), copy]);
    expect(result.games.map((g) => g.path)).toEqual(["data_folder_May/ledger_pglA (1).csv"]);
    expect(result.duplicates).toEqual([
      {
        kind: "identical",
        path: "data_folder_May/ledger_pglA.csv",
        folder: "data_folder_May",
        otherPath: "data_folder_May/ledger_pglA (1).csv",
        otherFolder: "data_folder_May",
        sameFolder: true,
        skipped: true,
        sharedRows: 3,
      },
    ]);
  });

  it("keeps the fuller of two exports that share a ledger id", () => {
    const result = loadAllGames([file("a/ledger_pglX.csv", ALICE, BOB), file("b/ledger_pglX.csv", ALICE, BOB, CAROL)]);
    expect(result.games.map((g) => [g.path, g.rows.length])).toEqual([["b/ledger_pglX.csv", 3]]);
    expect(result.duplicates).toEqual([
      {
        kind: "same-id",
        path: "a/ledger_pglX.csv",
        folder: "a",
        otherPath: "b/ledger_pglX.csv",
        otherFolder: "b",
        sameFolder: false,
        skipped: true,
        sharedRows: 0,
      },
    ]);
  });

  it("skips a less complete export that shares a ledger id", () => {
    const result = loadAllGames([file("a/ledger_pglX.csv", ALICE, BOB), file("b/ledger_pglX.csv", CAROL)]);
    expect(result.games.map((g) => [g.path, g.rows.length])).toEqual([["a/ledger_pglX.csv", 2]]);
    expect(result.duplicates.map((d) => [d.kind, d.path, d.skipped])).toEqual([["same-id", "b/ledger_pglX.csv", true]]);
  });

  it("keeps both of two different ids that share a sit-down, and flags the overlap", () => {
    const result = loadAllGames([file("x/ledger_pglOne.csv", ALICE, BOB), file("y/ledger_pglTwo.csv", ALICE, CAROL, DANA)]);
    expect(result.games.map((g) => g.id)).toEqual(["ledger_pglOne", "ledger_pglTwo"]);
    expect(result.duplicates).toEqual([
      {
        kind: "overlap",
        path: "y/ledger_pglTwo.csv",
        folder: "y",
        otherPath: "x/ledger_pglOne.csv",
        otherFolder: "x",
        sameFolder: false,
        skipped: false,
        sharedRows: 1,
      },
    ]);
    expect(describeDuplicates(result.duplicates)).toEqual([
      {
        number: 1,
        headline: "OVERLAP: 1 sit-down also appear in another ledger with a different id across folders",
        skipped: false,
        path: "y/ledger_pglTwo.csv",
        matchPath: "x/ledger_pglOne.csv",
        hint: "Both files are still counted. If they are the same game, delete the older export.",
      },
    ]);
  });

  it("says when a game does not balance, and when a file is skipped", () => {
    const result = loadAllGames([
      file("ledger_pglU.csv", ALICE, BOB_SHORT),
      { relativePath: "bad/nonet.csv", text: "player_nickname,buy_in\nA,1\n" },
    ]);
    expect(result.messages).toEqual([
      "Skipped: missing player_nickname/net columns in nonet.csv",
      "WARNING: ledger_pglU.csv does not balance: its nets sum to +$5.00 instead of $0.00.",
    ]);
  });

  it("sorts games by start, with a game that has no start first, then by id", () => {
    const result = loadAllGames([
      file("late/ledger_pglL.csv", "Solo,p11,2031-05-08T00:00:00.000Z,2031-05-08T01:00:00.000Z,1000,1000,1000,0"),
      file("early/ledger_pglE.csv", ALICE, BOB),
      file("nostart/ledger_pglN.csv", "Trail,p12,,,0,0,300,300"),
    ]);
    expect(result.games.map((g) => g.id)).toEqual(["ledger_pglN", "ledger_pglE", "ledger_pglL"]);
  });

  it("returns nothing for no files", () => {
    expect(loadAllGames([])).toEqual({ games: [], messages: [], duplicates: [] });
  });
});

describe("folders, scopes and ids", () => {
  it("lists the folders in byte order", () => {
    const games = [
      parseLedgerFile(file("b/ledger_1.csv", ALICE, BOB)),
      parseLedgerFile(file("a b/ledger_2.csv", ALICE, BOB)),
      parseLedgerFile(file("a/ledger_3.csv", ALICE, BOB)),
      parseLedgerFile(file("ledger_4.csv", ALICE, BOB)),
    ].flatMap((r) => (r.ok ? [r.game] : []));
    expect(listFolders(games)).toEqual(["(root)", "a", "a b", "b"]);
  });

  it("gives the id a hand log is filed under", () => {
    const r = parseLedgerFile(file("ledger_pglEX1.csv", ALICE, BOB));
    expect(r.ok && logId(r.game)).toBe("pglEX1");
  });

  it("keeps the games of a folder, and a game night belongs to the local date it starts on", () => {
    const games = loadAllGames([
      file("data_folder_May/ledger_pglA.csv", ALICE, BOB),
      file("data_folder_June/ledger_pglB.csv", "Erin,p5,2031-05-06T12:00:00.000Z,2031-05-06T14:00:00.000Z,1000,1000,1000,0"),
    ]).games;
    const may = { folder: "data_folder_May", from: null, to: null };
    expect(filterGames(games, may).map((g) => g.id)).toEqual(["ledger_pglA"]);

    // 00:10Z on May 6 is 8:10 pm on May 5 in New York.
    const may5 = { folder: "", from: parseLocalDate("2031-05-05", false, NEW_YORK), to: parseLocalDate("2031-05-05", true, NEW_YORK) };
    const may6 = { folder: "", from: parseLocalDate("2031-05-06", false, NEW_YORK), to: parseLocalDate("2031-05-06", true, NEW_YORK) };
    expect(filterGames(games, may5).map((g) => g.id)).toEqual(["ledger_pglA"]);
    expect(filterGames(games, may6).map((g) => g.id)).toEqual(["ledger_pglB"]);
  });

  it("keeps the whole 2026-11-01 day in New York, across the change to standard time", () => {
    const games = loadAllGames([
      nightAt("G1", "2026-10-31T03:59:59.000Z"), // 23:59:59 on Oct 31 (EDT)
      nightAt("G2", "2026-11-01T04:00:00.000Z"), // 00:00 on Nov 1 (EDT)
      nightAt("G3", "2026-11-01T04:30:00.000Z"), // 00:30 on Nov 1 (EDT)
      nightAt("G4", "2026-11-02T04:59:59.000Z"), // 23:59:59 on Nov 1 (EST)
      nightAt("G5", "2026-11-02T05:00:00.000Z"), // 00:00 on Nov 2 (EST)
    ]).games;
    const scope = {
      folder: "",
      from: parseLocalDate("2026-11-01", false, NEW_YORK),
      to: parseLocalDate("2026-11-01", true, NEW_YORK),
    };
    expect(filterGames(games, scope).map((g) => g.id)).toEqual(["ledger_G2", "ledger_G3", "ledger_G4"]);
  });

  it("describes and tests scopes", () => {
    const everything = { folder: "", from: null, to: null };
    expect(scopeIsEverything(everything)).toBe(true);
    expect(scopeDescribe(everything, NEW_YORK)).toBe("all folders");

    const may = {
      folder: "May",
      from: parseLocalDate("2031-05-01", false, NEW_YORK),
      to: parseLocalDate("2031-05-31", true, NEW_YORK),
    };
    expect(scopeIsEverything(may)).toBe(false);
    expect(scopeDescribe(may, NEW_YORK)).toBe('folder "May", 2031-05-01 to 2031-05-31');
    expect(scopeDescribe({ folder: "", from: null, to: may.to }, NEW_YORK)).toBe("all folders, start to 2031-05-31");

    expect(scopeContains(may, "May", null)).toBe(false);
    expect(scopeContains({ folder: "", from: null, to: null }, "any", null)).toBe(true);
  });
});
