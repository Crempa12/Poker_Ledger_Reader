// Which folder a new game goes in by default, so filing one is a single press. Menu 19 offers the newest
// game's folder; the site does better when the folders are named by month ("Sept 2026", "Oct 2026"): a game
// from a month that already has a folder goes there, and a game from a new month gets that month's name,
// written the way the other folders are.
import { ledger, util, type Game } from "@plr/core";

const FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// The newspaper (AP) way, which is how "Sept 2026" and "Oct 2026" are written.
const AP = ["Jan", "Feb", "March", "April", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type Style = "full" | "ap" | "short";

// "Oct 2026" -> { month: 9, year: 2026, style }, for a folder named by month; null otherwise.
function readMonthFolder(folder: string): { month: number; year: number; style: Style | null } | null {
  const m = /^([A-Za-z]+)\.? (\d{4})$/.exec(folder.trim());
  if (m === null) return null;
  const word = (m[1] ?? "").toLowerCase();
  const year = Number(m[2]);
  for (let i = 0; i < 12; i++) {
    const full = (FULL[i] ?? "").toLowerCase();
    const ap = (AP[i] ?? "").toLowerCase();
    const short = (SHORT[i] ?? "").toLowerCase();
    if (word !== full && word !== ap && word !== short) continue;
    // The style this name shows, where it shows one ("May" is the same in all three).
    const style: Style | null =
      word === full && full !== ap ? "full" : word === ap && ap !== short ? "ap" : word === short && short !== ap ? "short" : null;
    return { month: i, year, style };
  }
  return null;
}

// The month folder's name for an instant, in a style: monthFolder(t, tz, "ap") is "Sept 2026".
export function monthFolder(epochSeconds: number, timeZone: string, style: Style = "ap"): string {
  const w = util.wallClock(epochSeconds, timeZone);
  const names = style === "full" ? FULL : style === "short" ? SHORT : AP;
  return `${names[w.month - 1] ?? ""} ${w.year}`;
}

// The folder to offer for a game that started at start (null: not known), given the games already filed.
export function suggestFolder(games: readonly Game[], start: number | null, timeZone: string): string {
  const folders = ledger.listFolders([...games]).filter((f) => f !== "(root)");
  const newest = [...games].reverse().find((g) => g.folder !== "(root)");
  if (start === null) return newest?.folder ?? "";
  const w = util.wallClock(start, timeZone);
  // A month-named folder that already holds a game from the same month: the newest such game's folder.
  const sameMonth = [...games]
    .reverse()
    .find((g) => g.folder !== "(root)" && g.start !== null && sameMonthOf(g.start, w, timeZone) && readMonthFolder(g.folder) !== null);
  if (sameMonth !== undefined) return sameMonth.folder;
  const named = folders.map(readMonthFolder).filter((x): x is NonNullable<typeof x> => x !== null);
  if (named.length > 0 || folders.length === 0) {
    // The month's own folder, maybe there already with no games in it yet; else made in the folders' style.
    const there = folders.find((f) => {
      const r = readMonthFolder(f);
      return r !== null && r.month === w.month - 1 && r.year === w.year;
    });
    if (there !== undefined) return there;
    const style = named.find((n) => n.style !== null)?.style ?? "ap";
    return monthFolder(start, timeZone, style);
  }
  return newest?.folder ?? "";
}

function sameMonthOf(epoch: number, w: util.WallClock, timeZone: string): boolean {
  const g = util.wallClock(epoch, timeZone);
  return g.year === w.year && g.month === w.month;
}

// When a PokerNow file's game started, from its text: a ledger's earliest sit-down, or a hand log's earliest
// entry (a log lists the newest entry first, so its tail is read). Null when there is none to read.
export function startOfFile(kind: "ledger" | "poker_now_log", text: string): number | null {
  if (kind === "ledger") return ledger.loadAllGames([{ relativePath: "new/ledger.csv", text }]).games[0]?.start ?? null;
  const stamps = text.slice(-4096).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g) ?? [];
  let earliest: number | null = null;
  for (const s of stamps) {
    const t = util.parseISO8601UTC(s);
    if (t !== null && (earliest === null || t < earliest)) earliest = t;
  }
  return earliest;
}
