// The folder a new game is offered by default (folders.ts): the month's folder when the folders are named by
// month, written the way they are; the newest game's folder (menu 19's choice) when they are not.
import { describe, expect, it } from "vitest";

import type { Game } from "../../../packages/core/src/index.ts";
import { monthFolder, startOfFile, suggestFolder } from "../src/folders.ts";

const TZ = "America/New_York";
const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
// Only folder and start matter here.
const game = (folder: string, iso: string): Game => ({ folder, start: at(iso) }) as unknown as Game;

describe("the folder a new game is offered", () => {
  it("is the month's folder when the folders are named by month, in their style", () => {
    const games = [game("Sept 2026", "2026-09-12T23:00:00Z"), game("Oct 2026", "2026-10-10T23:00:00Z")];
    expect(suggestFolder(games, at("2026-10-24T23:00:00Z"), TZ)).toBe("Oct 2026");
    expect(suggestFolder(games, at("2026-11-07T23:00:00Z"), TZ)).toBe("Nov 2026");
    expect(suggestFolder(games, at("2026-09-26T23:00:00Z"), TZ)).toBe("Sept 2026");
    // A game that ends after midnight UTC on the 1st is still the last night of the month where it was played.
    expect(suggestFolder(games, at("2026-11-01T01:30:00Z"), TZ)).toBe("Oct 2026");
    const long = [game("September 2026", "2026-09-12T23:00:00Z")];
    expect(suggestFolder(long, at("2026-10-24T23:00:00Z"), TZ)).toBe("October 2026");
    const short = [game("Sep 2026", "2026-09-12T23:00:00Z")];
    expect(suggestFolder(short, at("2027-03-06T23:00:00Z"), TZ)).toBe("Mar 2027");
  });

  it("is the newest game's folder when the folders are not named by month, as menu 19 offers", () => {
    const games = [game("Spring league", "2026-04-12T23:00:00Z"), game("Post Summer 2026", "2026-09-10T23:00:00Z")];
    expect(suggestFolder(games, at("2026-11-07T23:00:00Z"), TZ)).toBe("Post Summer 2026");
    expect(suggestFolder(games, null, TZ)).toBe("Post Summer 2026");
  });

  it("is the month's name for a group with no folders yet", () => {
    expect(suggestFolder([], at("2026-09-12T23:00:00Z"), TZ)).toBe("Sept 2026");
    expect(suggestFolder([], null, TZ)).toBe("");
    expect(monthFolder(at("2026-06-06T23:00:00Z"), TZ)).toBe("June 2026");
  });
});

describe("when a downloaded file's game started", () => {
  it("reads a hand log's earliest entry (the log lists the newest first)", () => {
    const log = [
      "entry,at,order",
      '"-- ending hand #2 --",2026-10-24T23:41:00.000Z,3',
      '"-- starting hand #2 --",2026-10-24T23:30:00.000Z,2',
      '"-- starting hand #1 --",2026-10-24T23:05:00.000Z,1',
      "",
    ].join("\n");
    expect(startOfFile("poker_now_log", log)).toBe(at("2026-10-24T23:05:00Z"));
    expect(startOfFile("poker_now_log", "entry,at,order\n")).toBeNull();
  });
});
