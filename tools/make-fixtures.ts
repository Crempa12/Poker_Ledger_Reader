// Writes the made-up ledger and Saved_Data files used by the reference harness and the tests.
// Every number is fixed and the random numbers come from a fixed seed, so each run writes the
// same bytes. All names and ids are invented (FAKEid..., ledger_pglFAKE...). Run: npm run fixtures
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "synthetic");

// mulberry32: a small seeded generator, the same sequence on every machine.
let seed = 20260101;
function rng(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

type Who = readonly [nick: string, acct: string];
type Day = readonly [year: number, month: number, day: number];
type Net = number | "r" | "b";   // explicit cents, random, or the balancing seat

interface SeatIn {
  who: Who;
  start: string | null;   // "19:02", "23:40+1" (next day), "01:20@-4" (own UTC offset); null = never played
  end: string | null;
  buyIn: number;          // cents
  net: Net;
}

interface Row {
  nick: string;
  acct: string;
  start: string | null;
  end: string | null;
  buyIn: number;
  buyOut: number;
  net: number;
}

interface GameIn {
  id: string;            // file stem, which is also the ledger id
  folder: string;        // Games/<folder>/
  date: string;          // local game night, YYYY-MM-DD
  off: number;           // UTC offset on the game night (-5 = EST, -4 = EDT)
  copyFrom?: { id: string; idx: number[] };   // seats copied exactly from an earlier game (overlap test)
  seats: SeatIn[];
  unbalancedBy?: number; // cents the nets are deliberately off by
}

function s(who: Who, start: string | null, end: string | null, buyIn: number, net: Net): SeatIn {
  return { who, start, end, buyIn, net };
}

// ---------------------------------------------------------------- people (all invented)

const PL = {
  zaqvin: ["Zaqvin", "FAKEid0001"],
  plenkor: ["Plenkor", "FAKEid0002"],
  mirtavo: ["Mirtavo", "FAKEid0003"],
  quelzit: ["Quelzit", "FAKEid0004"],
  vorndal: ["Vorndal", "FAKEid0005"],
  hespyre: ["Hespyre", "FAKEid0006"],
  jolwick: ["Jolwick", "FAKEid0007"],
  kaxtun: ["Kaxtun", "FAKEid0008"],
  fenquor: ["Fenquor", "FAKEid0009"],
  ombrix: ["Ombrix", "FAKEid0010"],
  tarvelle: ["Tarvelle", "FAKEid0011"],
  dulvane: ["Dulvane", "FAKEid0012"],
  rixmoot: ["Rixmoot", "FAKEid0013"],
  sybnari: ["Sybnari", "FAKEid0014"],
  wexlorn: ["Wexlorn", "FAKEid0015"],
  pindrel: ["Pindrel", "FAKEid0016"],
  lumqat: ["Lumqat", "FAKEid0017"],
  gorvast: ["Gorvast", "FAKEid0018"],
  ylmande: ["Ylmande", "FAKEid0019"],   // exactly 4 games, total $0.50
  bexrunn: ["Bexrunn", "FAKEid0020"],   // exactly 4 games, total $1.50
  cavlorn: ["Cavlorn", "FAKEid0021"],   // exactly 8 games, total $5.00
  hiltrex: ["Hiltrex", "FAKEid0022"],
  nuvrask: ["Nuvrask", "FAKEid0023"],
  ostrelin: ["Ostrelin", "FAKEid0024"],
  ekvarto: ["Ekvarto", "FAKEid0025"],
  frymoss: ["Frymoss", "FAKEid0026"],
  frymossTwo: ["Frymoss Two", "FAKEid0026"],  // a name never seen elsewhere, on an old account
  rixmootTwo: ["Rixmoot", "FAKEid0027"],      // same person as Rixmoot, on a second account
  hespyreShared: ["Hespyre", "FAKEid0040"],   // account 0040 is used by two people
  ombrixShared: ["Ombrix", "FAKEid0040"],
  digits: ["707070", "FAKEid0050"],           // digits-only nickname
  emojiCards: ["\u{1F0CF}\u{1F0CF}", "FAKEid0051"],   // emoji-only nickname
  emojiFlower: ["\u{1F3B4}", "FAKEid0052"],           // emoji-only, letters of its account match 0051
  quorin: ["Quorin", "FAKEid0060"],     // sorts differently in UTF-8 and UTF-16
  brask: ["\u{1F3B2}Brask", "FAKEid0061"],
  harlo: ["Harlo, Dromm", "FAKEid0062"],      // comma inside the quoted nickname
  quinn: ['Quinn "Q" Varn', "FAKEid0063"],    // doubled quotes inside the quoted nickname
  vextorQ: ["Vextor Q", "FAKEid0070"],        // one person, three names: merge_rules chain
  vextor: ["Vextor", "FAKEid0070"],
  vextorion: ["Vextorion", "FAKEid0070"],
  marisol: ["Marisol Quenby", "FAKEid0071"],  // one person, two names
  mari: ["Mari Quenby", "FAKEid0071"],
  emptySeat: ["Empty Seat", "FAKEid0030"],
  // Players of the two hand-log nights (0014 and 0015). New names, so no older total changes.
  tovrin: ["Tovrin", "FAKEid0081"],
  ysolde: ["Ysolde", "FAKEid0082"],
  morvak: ["Morvak", "FAKEid0083"],
  pethra: ["Pethra", "FAKEid0084"],
  dorrig: ["Dorrig", "FAKEid0085"],
  vexlor: ["Vexlor", "FAKEid0086"],
  ostravan: ["Ostravan", "FAKEid0087"],
  sorrel: ["Sorrel", "FAKEid0088"],
  kelvane: ["Kelvane", "FAKEid0089"],
  ulvane: ["Ulvane", "FAKEid0090"],
  wenrick: ["Wenrick", "FAKEid0091"],
  quillan: ["Quillan", "FAKEid0092"],
} as const satisfies Record<string, Who>;

// Merge rules as the app stores them (alias -> canonical). The chain vextorQ -> vextor -> vextorion
// is kept as two rows; the app flattens it.
const MERGE_ROWS: [string, string][] = [
  ["mariquenby", "marisolquenby"],
  ["vextorq", "vextor"],
  ["vextor", "vextorion"],
];
const MERGE: Record<string, string> = Object.fromEntries(MERGE_ROWS);

// ---------------------------------------------------------------- the games

const BIG: Who[] = [
  PL.zaqvin, PL.plenkor, PL.mirtavo, PL.quelzit, PL.vorndal, PL.hespyre, PL.jolwick, PL.kaxtun,
  PL.fenquor, PL.ombrix, PL.rixmoot, PL.sybnari, PL.wexlorn, PL.pindrel, PL.lumqat, PL.gorvast,
  PL.hiltrex, PL.nuvrask, PL.ostrelin, PL.ekvarto, PL.frymoss, PL.quorin, PL.brask, PL.harlo,
];
const BUY_INS = [2000, 3000, 4000, 5000, 6000, 10000];
const pad2 = (n: number): string => String(n).padStart(2, "0");
const bigSeats: SeatIn[] = BIG.map((who, i) =>
  s(who, `19:${pad2((i * 7) % 60)}`, `23:${pad2(30 + (i % 25))}`, BUY_INS[i % BUY_INS.length] ?? 2000,
    who === PL.pindrel ? "b" : "r"));

const GAMES: GameIn[] = [
  { id: "ledger_pglFAKE0001", folder: "Synthetic Winter", date: "2026-01-14", off: -5, seats: [
    s(PL.zaqvin, "19:02", "23:20", 5000, "r"),
    s(PL.plenkor, "19:05", "23:25", 3000, "r"),
    s(PL.plenkor, "21:40", "23:25", 2000, "r"),          // rebuy: same account, later sit-down
    s(PL.mirtavo, "19:10", "23:30", 4000, "b"),
    s(PL.quelzit, "19:10", "23:30", 2000, "r"),
    s(PL.hespyreShared, "19:15", "23:00", 2000, "r"),    // the "name is right" seat on the shared account
    s(PL.ylmande, "19:20", "23:00", 2000, 20),
    s(PL.cavlorn, "19:25", "23:10", 2000, 100),
  ] },
  { id: "ledger_pglFAKE0002", folder: "Synthetic Winter", date: "2026-01-28", off: -5, seats: [
    s(PL.digits, "19:35", "23:40", 3000, "r"),
    s(PL.frymoss, "19:31", "23:44", 2000, "r"),
    s(PL.quelzit, "19:40", "23:45", 2000, "r"),
    s(PL.pindrel, "19:33", "23:10", 5000, "r"),
    s(PL.bexrunn, "19:35", "23:30", 2000, 50),
    s(PL.cavlorn, "19:36", "23:30", 2000, -50),
    s(PL.emptySeat, null, null, 0, 0),                   // never played: no start, no money
    s(PL.sybnari, "19:50", "23:45", 4000, "b"),
  ] },
  { id: "ledger_pglFAKE0003", folder: "Synthetic Winter", date: "2026-02-11", off: -5, seats: [
    s(PL.zaqvin, "19:02", "23:50", 5000, "r"),
    s(PL.zaqvin, "21:30", "23:50", 3000, "r"),           // rebuy
    s(PL.ekvarto, "19:05", "23:40", 4000, "r"),
    s(PL.frymossTwo, "19:08", "23:20", 2000, "r"),       // the new name on account 0026
    s(PL.ylmande, "19:20", "23:20", 2000, 10),
    s(PL.cavlorn, "19:22", "23:30", 2000, 75),
    s(PL.digits, "19:30", "23:50", 2000, "r"),
    s(PL.wexlorn, "19:40", "23:10", 3000, "r"),
    s(PL.gorvast, "19:50", "23:50", 4000, "b"),
  ] },
  { id: "ledger_pglFAKE0004", folder: "Synthetic Winter", date: "2026-02-25", off: -5, seats: [
    // Tie case: two losers at exactly -$30.00 who play no other game. The nets add up to 0 with no balancer.
    s(PL.jolwick, "19:10", "23:20", 2000, 4500),
    s(PL.kaxtun, "19:12", "23:15", 1000, 1500),
    s(PL.tarvelle, "19:11", "23:20", 5000, -3000),
    s(PL.dulvane, "19:13", "23:18", 5000, -3000),
    s(PL.fenquor, "19:15", "23:10", 2000, 0),
    s(PL.ostrelin, "19:20", "23:05", 2000, 0),
  ] },
  { id: "ledger_pglFAKE0005", folder: "Synthetic Spring", date: "2026-03-14", off: -4, seats: [
    // Starts 23:40 on the 14th and ends after midnight, local time.
    s(PL.bexrunn, "23:41", "00:20+1", 2000, -100),
    s(PL.mirtavo, "23:40", "00:25+1", 4000, "r"),
    s(PL.plenkor, "23:42", "00:24+1", 3000, "r"),
    s(PL.quelzit, "23:45", "00:10+1", 2000, "r"),
    s(PL.cavlorn, "23:40", "00:25+1", 2000, 25),
    s(PL.kaxtun, "23:50", "00:25+1", 3000, "r"),
    s(PL.wexlorn, "23:55", "00:15+1", 2000, "r"),
    s(PL.pindrel, "23:48", "00:25+1", 2000, "r"),
    s(PL.hiltrex, "23:49", "00:05+1", 2000, "r"),
    s(PL.lumqat, "23:40", "00:25+1", 6000, "b"),
  ] },
  { id: "ledger_pglFAKE0006", folder: "Synthetic Spring", date: "2026-04-04", off: -4, unbalancedBy: 500, seats: [
    // Deliberately unbalanced: the nets add up to +$5.00.
    s(PL.brask, "19:20", "23:40", 2000, "r"),
    s(PL.quorin, "19:21", "23:30", 3000, "r"),
    s(PL.emojiCards, "19:25", "23:35", 2000, "r"),
    s(PL.hespyreShared, "19:30", "23:00", 2000, "r"),
    s(PL.cavlorn, "19:35", "23:35", 2000, -100),
    s(PL.harlo, "19:40", "23:40", 2000, "r"),
    s(PL.nuvrask, "19:30", "23:40", 3000, "b"),
  ] },
  { id: "ledger_pglFAKE0007", folder: "Synthetic Spring", date: "2026-04-18", off: -4, seats: [
    s(PL.ombrixShared, "19:05", "23:20", 2000, "r"),     // reviewed nowhere: the app flags it
    s(PL.ylmande, "19:10", "23:00", 2000, -5),
    s(PL.brask, "19:15", "23:55", 2000, "r"),
    s(PL.harlo, "19:20", "23:30", 3000, "r"),
    s(PL.quinn, "19:25", "23:50", 2000, "r"),
    s(PL.digits, "19:30", "23:10", 2000, "r"),
    s(PL.frymoss, "19:35", "23:15", 2000, "r"),
    s(PL.gorvast, "19:40", "23:40", 2000, "r"),
    s(PL.cavlorn, "19:22", "23:40", 2000, 200),
    s(PL.zaqvin, "19:00", "23:55", 4000, "b"),
  ] },
  { id: "ledger_pglFAKE0008", folder: "Synthetic Spring", date: "2026-05-02", off: -4, seats: [
    // Rixmoot sits on two accounts at the same time.
    s(PL.rixmoot, "19:10", "22:40", 4000, "r"),
    s(PL.rixmootTwo, "19:30", "22:20", 3000, "r"),
    s(PL.bexrunn, "19:25", "23:35", 2000, 200),
    s(PL.plenkor, "19:45", "23:00", 3000, "r"),          // shared sit-downs, copied into ledger 0009
    s(PL.kaxtun, "19:50", "23:30", 2000, "r"),
    s(PL.mirtavo, "19:55", "23:35", 4000, "r"),
    s(PL.quelzit, "19:20", "23:00", 3000, "r"),
    s(PL.sybnari, "19:30", "23:20", 2000, "r"),
    s(PL.cavlorn, "19:30", "23:30", 2000, 50),
    s(PL.hiltrex, "19:35", "23:35", 5000, "b"),
  ] },
  { id: "ledger_pglFAKE0009", folder: "Synthetic Spring", date: "2026-05-02", off: -4, copyFrom: { id: "ledger_pglFAKE0008", idx: [3, 4, 5] }, seats: [
    // Another export of the same night: three sit-downs match ledger 0008, the rest do not.
    s(PL.ostrelin, "19:05", "23:10", 2000, "r"),
    s(PL.frymoss, "19:08", "22:50", 3000, "r"),
    s(PL.wexlorn, "19:10", "22:30", 2000, "r"),
    s(PL.ekvarto, "19:15", "23:00", 2000, "r"),
    s(PL.emojiFlower, "19:20", "23:10", 3000, "r"),
    s(PL.gorvast, "19:30", "23:10", 4000, "b"),
  ] },
  { id: "ledger_pglFAKE0010", folder: "Synthetic Autumn", date: "2026-10-03", off: -4, seats: [
    s(PL.ombrixShared, "19:03", "23:20", 2000, "r"),     // reassigned to Hespyre in seat_owners.csv
    s(PL.hespyreShared, "19:04", "23:25", 3000, "r"),
    s(PL.ylmande, "19:10", "23:00", 2000, 25),
    s(PL.cavlorn, "19:15", "23:20", 2000, 200),
    s(PL.vextorQ, "19:20", "23:10", 2000, "r"),
    s(PL.vextor, "19:25", "23:00", 2000, "r"),
    s(PL.vextorion, "19:30", "23:25", 3000, "r"),
    s(PL.marisol, "19:35", "23:30", 2000, "r"),
    s(PL.mari, "19:40", "23:15", 2000, "r"),
    s(PL.jolwick, "19:45", "23:00", 2000, "r"),
    s(PL.quelzit, "19:50", "23:30", 4000, "b"),
  ] },
  { id: "ledger_pglFAKE0011", folder: "Synthetic Autumn", date: "2026-10-24", off: -4, seats: [
    // The big night: 24 different people, every balance non-zero.
    ...bigSeats,
  ] },
  { id: "ledger_pglFAKE0012", folder: "Synthetic Autumn", date: "2026-11-01", off: -5, seats: [
    // The clocks go back at 2:00 EDT on this date: two sit-downs at 01:20, one EDT and one EST.
    s(PL.zaqvin, "19:05", "23:50", 3000, "r"),
    s(PL.plenkor, "19:10", "23:40", 2000, "r"),
    s(PL.nuvrask, "01:20@-4", "23:30", 2000, "r"),
    s(PL.mirtavo, "01:20@-5", "23:45", 4000, "r"),
    s(PL.bexrunn, "19:20", "23:30", 2000, 0),
    s(PL.jolwick, "19:30", "23:20", 3000, "r"),
    s(PL.quelzit, "19:40", "23:00", 2000, "r"),
    s(PL.vorndal, "19:45", "23:55", 4000, "r"),
    s(PL.frymoss, "19:50", "23:59", 2000, "b"),
  ] },
  // Two nights with hand logs (written by handLogs below). Appended, so the earlier nights keep their
  // random numbers. Their seats are explicit, not random.
  { id: "ledger_pglFAKE0014", folder: "Synthetic Autumn", date: "2026-10-17", off: -4, seats: [
    // The log is cut short at 21:25. Pethra busts at 20:45 and rebuys at 20:50; Morvak busts at 21:18
    // in an all-in that runs twice; Dorrig leaves at 21:10 while the sheet has her up.
    s(PL.sorrel, "19:02", "23:40", 3000, "b"),
    s(PL.tovrin, "19:00", "23:40", 4000, 2500),
    s(PL.ysolde, "19:04", "22:45", 3000, -1200),
    s(PL.morvak, "19:05", "21:20", 3000, -3000),
    s(PL.pethra, "19:10", "20:45", 2000, -2000),
    s(PL.pethra, "20:50", "23:40", 2000, 800),
    s(PL.dorrig, "19:20", "21:10", 2000, 1000),
  ] },
  { id: "ledger_pglFAKE0015", folder: "Synthetic Autumn", date: "2026-10-31", off: -4, seats: [
    // The complete night: a bomb pot, a 7-2 bounty, and Ulvane leaves at 22:00 while up.
    s(PL.wenrick, "19:00", "23:30", 2500, "b"),
    s(PL.vexlor, "19:05", "23:30", 3000, 2000),
    s(PL.ostravan, "19:10", "23:30", 2000, -1000),
    s(PL.kelvane, "19:15", "23:30", 4000, -1500),
    s(PL.ulvane, "19:20", "22:00", 2000, 500),
    s(PL.quillan, "19:00", "23:30", 2000, 0),
  ] },
];

// The one-night file that holds only seats never played. The app skips it with a message.
const NEVER_PLAYED_ONLY = { id: "ledger_pglFAKE0013", folder: "Synthetic Winter", date: "2026-01-21", off: -5 };

// ---------------------------------------------------------------- building rows

function dayOf(date: string): Day {
  const [y = 0, m = 0, d = 0] = date.split("-").map(Number);
  return [y, m, d];
}

// "23:40+1" is the next day; "01:20@-4" uses its own offset. Returns UTC ISO with milliseconds.
function isoAt(day: Day, spec: string, defaultOff: number, millis: number): string {
  const m = /^(\d{2}):(\d{2})(\+1)?(?:@(-\d+))?$/.exec(spec);
  if (!m) throw new Error(`bad time: ${spec}`);
  const off = m[4] === undefined ? defaultOff : Number(m[4]);
  const nextDay = m[3] === undefined ? 0 : 1;
  const utc = Date.UTC(day[0], day[1] - 1, day[2] + nextDay, Number(m[1]), Number(m[2])) - off * 3_600_000 + millis;
  return new Date(utc).toISOString();
}

function buildRows(g: GameIn, built: Map<string, Row[]>): Row[] {
  const day = dayOf(g.date);
  const rows: Row[] = [];
  if (g.copyFrom) {
    const src = built.get(g.copyFrom.id);
    if (!src) throw new Error(`copy source missing: ${g.copyFrom.id}`);
    for (const i of g.copyFrom.idx) {
      const r = src[i];
      if (!r) throw new Error(`no row ${i} in ${g.copyFrom.id}`);
      rows.push({ ...r });
    }
  }

  let balancer = -1;
  for (const seat of g.seats) {
    if (seat.start === null) {
      rows.push({ nick: seat.who[0], acct: seat.who[1], start: null, end: null, buyIn: 0, buyOut: 0, net: 0 });
      continue;
    }
    let net: number;
    if (seat.net === "b") {
      balancer = rows.length;
      net = 0;   // set once every other seat is known
    } else if (seat.net === "r") {
      net = Math.round(seat.buyIn * (rng() * 1.8 - 0.9));
      if (net === 0) net = 100;
    } else {
      net = seat.net;
    }
    const start = isoAt(day, seat.start, g.off, Math.floor(rng() * 1000));
    const end = isoAt(day, seat.end ?? seat.start, g.off, Math.floor(rng() * 1000));
    rows.push({ nick: seat.who[0], acct: seat.who[1], start, end, buyIn: seat.buyIn, buyOut: seat.buyIn + net, net });
  }

  const others = rows.reduce((sum, r, i) => (i === balancer ? sum : sum + r.net), 0);
  const target = -others + (g.unbalancedBy ?? 0);
  if (balancer >= 0) {
    const row = rows[balancer];
    if (!row) throw new Error(`balancer missing in ${g.id}`);
    row.net = target;
    row.buyOut = row.buyIn + target;
    if (row.buyOut < 0) {   // a cash-out cannot be negative: raise the buy-in instead
      row.buyIn = -target;
      row.buyOut = 0;
    }
  } else if (target !== 0) {
    throw new Error(`${g.id} has no balancer but its nets sum to ${others}`);
  }
  return rows;
}

// Mirrors the app's escapeCSV: quote when a field has a comma, quote, or newline.
function esc(text: string): string {
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function ledgerCsv(rows: Row[]): string {
  const lines = ["player_nickname,player_id,session_start_at,session_end_at,buy_in,buy_out,stack,nit_escrow,net"];
  for (const r of rows) {
    lines.push([
      `"${r.nick.replace(/"/g, '""')}"`,       // PokerNow quotes every nickname
      r.acct,
      r.start ?? "",
      r.end ?? "",
      String(r.buyIn),
      String(r.buyOut),
      String(r.buyOut),                        // stack = cash-out
      "0",
      String(r.net),
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- hand logs (made up, PokerNow form)

const dollarText = (cents: number): string => (cents / 100).toFixed(2);

// Writes a PokerNow hand log. It plays the hands out with the chips in cents: a call, a bet or a
// raise names the level the player has put in on this street, and the stacks, the pots and the
// returned bets follow from it, so every stack line and pot is one the table could have printed.
// The scripts below say who does what. The amounts come from the table.
class LogWriter {
  rows: { at: string; text: string }[] = [];
  private readonly day: Day;
  private readonly off: number; // the night's UTC offset in hours (-4 is Eastern daylight time)
  private readonly prefix: string; // the hand id stem: "FAKEh14" gives "FAKEh1401"
  private secs = 0; // local seconds after midnight, for the next entry
  private seats: string[] = []; // account ids at the table, in seat order
  private stacks = new Map<string, number>(); // cents
  private nicks = new Map<string, string>(); // account id -> nickname
  private hands = 0;
  private board: string[] = [];
  private committed = new Map<string, number>(); // this street: the level each player has put in
  private contributed = new Map<string, number>(); // this hand: money put in
  private returned = new Map<string, number>(); // this hand: uncalled bets handed back

  constructor(day: Day, off: number, prefix: string) {
    this.day = day;
    this.off = off;
    this.prefix = prefix;
  }

  // Sits a player down with a stack, at the end of the seats.
  sit(who: Who, cents: number): void {
    const [nick, acct] = who;
    this.nicks.set(acct, nick);
    this.stacks.set(acct, cents);
    if (!this.seats.includes(acct)) this.seats.push(acct);
  }

  // Sets the clock for the next entries: "HH:MM" or "HH:MM:SS", local time.
  at(clock: string): void {
    const [h = 0, m = 0, s = 0] = clock.split(":").map(Number);
    this.secs = h * 3600 + m * 60 + s;
  }

  private say(text: string): void {
    const utc = Date.UTC(this.day[0], this.day[1] - 1, this.day[2]) + this.secs * 1000 - this.off * 3_600_000;
    this.rows.push({ at: new Date(utc).toISOString(), text });
    this.secs += 3;
  }

  private who(acct: string): string {
    return `"${this.nicks.get(acct) ?? acct} @ ${acct}"`;
  }

  // Puts money in until the player has put in `level` on this street.
  private put(acct: string, level: number): void {
    const add = level - (this.committed.get(acct) ?? 0);
    const stack = this.stacks.get(acct) ?? 0;
    if (add < 0 || add > stack) throw new Error(`${acct}: cannot put in ${add} from a stack of ${stack}`);
    this.stacks.set(acct, stack - add);
    this.contributed.set(acct, (this.contributed.get(acct) ?? 0) + add);
    this.committed.set(acct, level);
  }

  startHand(dealer: string, clock: string): void {
    this.at(clock);
    this.hands++;
    this.board = [];
    this.committed = new Map();
    this.contributed = new Map();
    this.returned = new Map();
    const id = `${this.prefix}${String(this.hands).padStart(2, "0")}`;
    this.say(`-- starting hand #${this.hands} (id: ${id}) (dealer: ${this.who(dealer)})`);
    const stacks = this.seats.map((acct, i) => `#${i + 1} ${this.who(acct)} (${dollarText(this.stacks.get(acct) ?? 0)})`);
    this.say(`Player stacks: ${stacks.join(" | ")}`);
  }

  blind(acct: string, kind: "small" | "big", cents: number): void {
    this.put(acct, cents);
    this.say(`${this.who(acct)} posts a ${kind} blind of ${dollarText(cents)}`);
  }

  // A bomb pot: the first player bets, the others call, all before the cards.
  bomb(acct: string, cents: number, first: boolean): void {
    this.put(acct, cents);
    this.say(`${this.who(acct)} ${first ? "bets" : "calls"} ${dollarText(cents)} (bomb pot bet)`);
  }

  raiseTo(acct: string, level: number, allIn = false): void {
    this.put(acct, level);
    this.say(`${this.who(acct)} raises to ${dollarText(level)}${allIn ? " and go all in" : ""}`);
  }

  betTo(acct: string, level: number, allIn = false): void {
    this.put(acct, level);
    this.say(`${this.who(acct)} bets ${dollarText(level)}${allIn ? " and go all in" : ""}`);
  }

  callTo(acct: string, level: number, allIn = false): void {
    this.put(acct, level);
    this.say(`${this.who(acct)} calls ${dollarText(level)}${allIn ? " and go all in" : ""}`);
  }

  check(acct: string): void {
    this.say(`${this.who(acct)} checks`);
  }

  fold(acct: string): void {
    this.say(`${this.who(acct)} folds`);
  }

  // The level a player's whole stack takes them to on this street.
  allInLevel(acct: string): number {
    return (this.committed.get(acct) ?? 0) + (this.stacks.get(acct) ?? 0);
  }

  committedOf(acct: string): number {
    return this.committed.get(acct) ?? 0;
  }

  // Cards out: three for the flop, then one for the turn and one for the river.
  dealt(cards: string[]): void {
    this.board.push(...cards);
    this.committed = new Map();
    const list = (xs: string[]): string => `[${xs.join(", ")}]`;
    if (this.board.length === 3) this.say(`Flop: ${list(this.board)}`);
    else if (this.board.length === 4) this.say(`Turn: ${list(this.board.slice(0, 3))} ${list(this.board.slice(3))}`);
    else if (this.board.length === 5) this.say(`River: ${list(this.board.slice(0, 4))} ${list(this.board.slice(4))}`);
    else throw new Error(`a board of ${this.board.length} cards is not one the table can show`);
  }

  runTwice(): void {
    this.say("All players in hand choose to run it twice");
  }

  uncalled(acct: string, cents: number): void {
    this.stacks.set(acct, (this.stacks.get(acct) ?? 0) + cents);
    this.returned.set(acct, (this.returned.get(acct) ?? 0) + cents);
    this.say(`Uncalled bet of ${dollarText(cents)} returned to ${this.who(acct)}`);
  }

  // The pot to one player: everything put in, less what was handed back.
  award(acct: string, showdown?: { rank: string; cards: string }): void {
    let pot = 0;
    for (const v of this.contributed.values()) pot += v;
    for (const v of this.returned.values()) pot -= v;
    this.stacks.set(acct, (this.stacks.get(acct) ?? 0) + pot);
    const won = showdown === undefined ? "" : ` with ${showdown.rank} (combination: ${showdown.cards})`;
    this.say(`${this.who(acct)} collected ${dollarText(pot)} from pot${won}`);
  }

  shows(acct: string, cards: string): void {
    this.say(`${this.who(acct)} shows a ${cards}.`);
  }

  // The end of a hand. A player with no chips left is out of the game.
  endHand(): void {
    this.say(`-- ending hand #${this.hands} --`);
    this.seats = this.seats.filter((acct) => (this.stacks.get(acct) ?? 0) > 0);
  }

  // A 7-2 bounty, paid after the hand it belongs to.
  bounty(payer: string, payee: string, cents: number): void {
    this.stacks.set(payer, (this.stacks.get(payer) ?? 0) - cents);
    this.stacks.set(payee, (this.stacks.get(payee) ?? 0) + cents);
    this.say(`${this.who(payer)} paid ${dollarText(cents)} for the 7-2 bounty to ${this.who(payee)}`);
  }

  // A player who busted buys back in between hands: the two lines the app reads as a rebuy.
  rebuy(acct: string, cents: number, clock: string): void {
    this.at(clock);
    this.say(`The player ${this.who(acct)} requested a rebuy of ${dollarText(cents)}.`);
    this.stacks.set(acct, cents);
    if (!this.seats.includes(acct)) this.seats.push(acct);
    this.say(`The player ${this.who(acct)} rebought. New stack ${dollarText(cents)}.`);
  }

  // A player leaves the table between hands.
  leave(acct: string, clock: string): void {
    this.at(clock);
    this.say(`${this.who(acct)} quits the game with a stack of ${dollarText(this.stacks.get(acct) ?? 0)}.`);
    this.seats = this.seats.filter((x) => x !== acct);
  }
}

// The file: the header, then the entries newest first, each with its order (the first entry is 1).
function handLogCsv(rows: { at: string; text: string }[]): string {
  const lines = rows.map((r, i) => `${esc(r.text)},${r.at},${i + 1}`);
  return ["entry,at,order", ...lines.reverse()].join("\n") + "\n";
}

// Night 0014. The log stops at 21:25 in the middle of a hand. Pethra busts at 20:44 and rebuys at
// 20:50; Dorrig leaves at 21:10 while up; Morvak busts at 21:18 in an all-in that runs twice.
function script0014(w: LogWriter): void {
  const a = (k: keyof typeof PL): string => PL[k][1];
  w.sit(PL.sorrel, 3000);
  w.sit(PL.tovrin, 4000);
  w.sit(PL.ysolde, 3000);
  w.sit(PL.morvak, 3000);
  w.sit(PL.pethra, 2000);
  w.sit(PL.dorrig, 2000);

  // 19:12. Morvak raises, everyone folds to Ysolde, and her flop bet is not called.
  w.startHand(a("sorrel"), "19:12:00");
  w.blind(a("tovrin"), "small", 25);
  w.blind(a("ysolde"), "big", 50);
  w.raiseTo(a("morvak"), 150);
  w.fold(a("pethra"));
  w.fold(a("dorrig"));
  w.fold(a("sorrel"));
  w.fold(a("tovrin"));
  w.callTo(a("ysolde"), 150);
  w.dealt(["K♥", "7♣", "2♦"]);
  w.betTo(a("ysolde"), 200);
  w.fold(a("morvak"));
  w.uncalled(a("ysolde"), 200);
  w.award(a("ysolde"));
  w.endHand();

  // 19:16. Two pair at showdown: Sorrel's fours and nines beat Pethra's pair of nines.
  w.startHand(a("ysolde"), "19:16:20");
  w.blind(a("morvak"), "small", 25);
  w.blind(a("pethra"), "big", 50);
  w.fold(a("dorrig"));
  w.callTo(a("sorrel"), 50);
  w.fold(a("tovrin"));
  w.fold(a("ysolde"));
  w.callTo(a("morvak"), 50);
  w.check(a("pethra"));
  w.dealt(["9♠", "9♦", "3♣"]);
  w.check(a("morvak"));
  w.check(a("pethra"));
  w.check(a("sorrel"));
  w.dealt(["6♥"]);
  w.betTo(a("pethra"), 100);
  w.callTo(a("sorrel"), 100);
  w.fold(a("morvak"));
  w.dealt(["A♣"]);
  w.check(a("pethra"));
  w.check(a("sorrel"));
  w.shows(a("pethra"), "2♠, 5♣");
  w.shows(a("sorrel"), "4♣, 4♠");
  w.award(a("sorrel"), { rank: "Two Pair, 9's and 4's", cards: "9♠, 9♦, 4♣, 4♠, A♣" });
  w.endHand();

  // 19:24. Tovrin raises, Dorrig calls and folds to the flop bet, and the unmatched bet goes back.
  w.startHand(a("morvak"), "19:24:40");
  w.blind(a("pethra"), "small", 25);
  w.blind(a("dorrig"), "big", 50);
  w.callTo(a("sorrel"), 50);
  w.raiseTo(a("tovrin"), 300);
  w.fold(a("ysolde"));
  w.fold(a("morvak"));
  w.fold(a("pethra"));
  w.fold(a("sorrel"));
  w.callTo(a("dorrig"), 300);
  w.dealt(["A♠", "8♦", "4♣"]);
  w.check(a("dorrig"));
  w.betTo(a("tovrin"), 400);
  w.fold(a("dorrig"));
  w.uncalled(a("tovrin"), 400);
  w.award(a("tovrin"));
  w.endHand();

  // 19:33. An uncontested pot after a flop check and a turn bet.
  w.startHand(a("dorrig"), "19:33:10");
  w.blind(a("sorrel"), "small", 25);
  w.blind(a("tovrin"), "big", 50);
  w.raiseTo(a("ysolde"), 200);
  w.fold(a("morvak"));
  w.fold(a("pethra"));
  w.fold(a("dorrig"));
  w.fold(a("sorrel"));
  w.callTo(a("tovrin"), 200);
  w.dealt(["J♥", "10♠", "2♣"]);
  w.check(a("tovrin"));
  w.check(a("ysolde"));
  w.dealt(["5♦"]);
  w.betTo(a("tovrin"), 300);
  w.fold(a("ysolde"));
  w.uncalled(a("tovrin"), 300);
  w.award(a("tovrin"));
  w.endHand();

  // 19:48. Morvak bets the flop, Sorrel calls, and Morvak loses the showdown.
  w.startHand(a("pethra"), "19:48:05");
  w.blind(a("dorrig"), "small", 25);
  w.blind(a("sorrel"), "big", 50);
  w.fold(a("tovrin"));
  w.callTo(a("ysolde"), 50);
  w.raiseTo(a("morvak"), 150);
  w.fold(a("pethra"));
  w.fold(a("dorrig"));
  w.callTo(a("sorrel"), 150);
  w.fold(a("ysolde"));
  w.dealt(["7♠", "7♣", "Q♦"]);
  w.check(a("sorrel"));
  w.betTo(a("morvak"), 200);
  w.callTo(a("sorrel"), 200);
  w.dealt(["K♣"]);
  w.check(a("sorrel"));
  w.check(a("morvak"));
  w.dealt(["3♥"]);
  w.check(a("sorrel"));
  w.check(a("morvak"));
  w.shows(a("morvak"), "Q♠, J♠");
  w.shows(a("sorrel"), "7♥, 2♠");
  w.award(a("sorrel"), { rank: "Three of a Kind, 7's", cards: "7♥, 7♠, 7♣, K♣, Q♦" });
  w.endHand();

  // 20:44. Pethra goes all in preflop, Tovrin calls, and Pethra busts out.
  w.startHand(a("sorrel"), "20:44:30");
  w.blind(a("tovrin"), "small", 25);
  w.blind(a("ysolde"), "big", 50);
  w.fold(a("morvak"));
  w.raiseTo(a("pethra"), w.allInLevel(a("pethra")), true);
  w.fold(a("dorrig"));
  w.fold(a("sorrel"));
  w.callTo(a("tovrin"), w.committedOf(a("pethra")));
  w.fold(a("ysolde"));
  w.dealt(["A♥", "7♣", "2♦"]);
  w.dealt(["9♠"]);
  w.dealt(["Q♥"]);
  w.shows(a("pethra"), "4♣, 4♦");
  w.shows(a("tovrin"), "A♠, K♦");
  w.award(a("tovrin"), { rank: "Pair, A's", cards: "A♥, A♠, Q♥, 9♠, 7♣" });
  w.endHand();

  // 20:50. Pethra buys back in, and the next hand is dealt to her.
  w.rebuy(a("pethra"), 2000, "20:50:10");
  w.startHand(a("ysolde"), "20:58:00");
  w.blind(a("morvak"), "small", 25);
  w.blind(a("pethra"), "big", 50);
  w.fold(a("dorrig"));
  w.fold(a("sorrel"));
  w.fold(a("tovrin"));
  w.fold(a("ysolde"));
  w.callTo(a("morvak"), 50);
  w.check(a("pethra"));
  w.dealt(["2♠", "5♥", "9♣"]);
  w.check(a("morvak"));
  w.check(a("pethra"));
  w.dealt(["9♥"]);
  w.check(a("morvak"));
  w.check(a("pethra"));
  w.dealt(["Q♣"]);
  w.check(a("morvak"));
  w.check(a("pethra"));
  w.shows(a("morvak"), "8♠, 6♠");
  w.shows(a("pethra"), "J♦, J♣");
  w.award(a("pethra"), { rank: "Two Pair, J's and 9's", cards: "J♦, J♣, 9♣, 9♥, Q♣" });
  w.endHand();

  // 21:10. Dorrig leaves while up.
  w.leave(a("dorrig"), "21:10:00");

  // 21:18. Morvak shoves, Tovrin calls, and the two all-in players run the board twice. Morvak busts.
  w.startHand(a("pethra"), "21:18:20");
  w.blind(a("sorrel"), "small", 25);
  w.blind(a("tovrin"), "big", 50);
  w.fold(a("ysolde"));
  w.raiseTo(a("morvak"), w.allInLevel(a("morvak")), true);
  w.fold(a("pethra"));
  w.fold(a("sorrel"));
  w.callTo(a("tovrin"), w.committedOf(a("morvak")));
  w.runTwice();
  w.dealt(["J♣", "8♦", "4♠"]);
  w.dealt(["5♥"]);
  w.dealt(["7♣"]);
  w.shows(a("morvak"), "2♣, 2♥");
  w.shows(a("tovrin"), "K♠, K♦");
  w.award(a("tovrin"), { rank: "Pair, K's", cards: "K♠, K♦, J♣, 8♦, 7♣" });
  w.endHand();

  // 21:25. The log stops here, in the middle of this hand.
  w.startHand(a("sorrel"), "21:25:00");
  w.blind(a("tovrin"), "small", 25);
  w.blind(a("ysolde"), "big", 50);
  w.raiseTo(a("pethra"), 150);
}

// Night 0015. The complete night: a bomb pot, a 7-2 bounty, and Ulvane leaves at 22:00 while up.
function script0015(w: LogWriter): void {
  const a = (k: keyof typeof PL): string => PL[k][1];
  w.sit(PL.wenrick, 2500);
  w.sit(PL.vexlor, 3000);
  w.sit(PL.ostravan, 2000);
  w.sit(PL.kelvane, 4000);
  w.sit(PL.ulvane, 2000);
  w.sit(PL.quillan, 2000);

  // 19:12. Kelvane raises, nobody calls, and the unmatched part of the raise goes back.
  w.startHand(a("wenrick"), "19:12:00");
  w.blind(a("vexlor"), "small", 25);
  w.blind(a("ostravan"), "big", 50);
  w.raiseTo(a("kelvane"), 150);
  w.fold(a("ulvane"));
  w.fold(a("quillan"));
  w.fold(a("wenrick"));
  w.fold(a("vexlor"));
  w.fold(a("ostravan"));
  w.uncalled(a("kelvane"), 100);
  w.award(a("kelvane"));
  w.endHand();

  // 19:20. A bomb pot: everyone puts in before the cards. Kelvane's full house takes the pot.
  w.startHand(a("vexlor"), "19:20:00");
  w.bomb(a("ostravan"), 100, true);
  w.bomb(a("kelvane"), 100, false);
  w.bomb(a("ulvane"), 100, false);
  w.bomb(a("quillan"), 100, false);
  w.bomb(a("wenrick"), 100, false);
  w.bomb(a("vexlor"), 100, false);
  w.dealt(["9♠", "9♦", "3♣"]);
  w.betTo(a("kelvane"), 200);
  w.callTo(a("vexlor"), 200);
  w.fold(a("wenrick"));
  w.fold(a("ostravan"));
  w.fold(a("ulvane"));
  w.fold(a("quillan"));
  w.dealt(["6♥"]);
  w.check(a("vexlor"));
  w.check(a("kelvane"));
  w.dealt(["K♦"]);
  w.check(a("vexlor"));
  w.check(a("kelvane"));
  w.shows(a("kelvane"), "K♠, K♥");
  w.shows(a("vexlor"), "Q♣, 2♦");
  w.award(a("kelvane"), { rank: "Full House, K's over 9's", cards: "K♠, K♥, K♦, 9♠, 9♦" });
  w.endHand();

  // 19:31. Ostravan holds 7-2 and wins at showdown with a pair of twos. Three players pay the bounty.
  w.startHand(a("kelvane"), "19:31:00");
  w.blind(a("ulvane"), "small", 25);
  w.blind(a("quillan"), "big", 50);
  w.callTo(a("wenrick"), 50);
  w.fold(a("vexlor"));
  w.callTo(a("ostravan"), 50);
  w.fold(a("kelvane"));
  w.callTo(a("ulvane"), 50);
  w.check(a("quillan"));
  w.dealt(["8♥", "5♦", "J♣"]);
  w.fold(a("ulvane"));
  w.check(a("quillan"));
  w.check(a("wenrick"));
  w.betTo(a("ostravan"), 100);
  w.fold(a("quillan"));
  w.callTo(a("wenrick"), 100);
  w.dealt(["K♥"]);
  w.check(a("wenrick"));
  w.check(a("ostravan"));
  w.dealt(["2♣"]);
  w.check(a("wenrick"));
  w.check(a("ostravan"));
  w.shows(a("ostravan"), "7♠, 2♦");
  w.shows(a("wenrick"), "A♥, 3♣");
  w.award(a("ostravan"), { rank: "Pair, 2's", cards: "2♦, 2♣, K♥, J♣, 8♥" });
  w.endHand();
  w.bounty(a("kelvane"), a("ostravan"), 100);
  w.bounty(a("vexlor"), a("ostravan"), 100);
  w.bounty(a("ulvane"), a("ostravan"), 100);

  // 19:40. Vexlor raises to 2.00 and everyone folds: the 1.50 that nobody called goes back.
  w.startHand(a("ostravan"), "19:40:00");
  w.blind(a("kelvane"), "small", 25);
  w.blind(a("ulvane"), "big", 50);
  w.fold(a("quillan"));
  w.fold(a("wenrick"));
  w.raiseTo(a("vexlor"), 200);
  w.fold(a("ostravan"));
  w.fold(a("kelvane"));
  w.fold(a("ulvane"));
  w.uncalled(a("vexlor"), 150);
  w.award(a("vexlor"));
  w.endHand();

  // 20:05. Vexlor bets the flop, and everyone else folds.
  w.startHand(a("wenrick"), "20:05:00");
  w.blind(a("vexlor"), "small", 25);
  w.blind(a("ostravan"), "big", 50);
  w.fold(a("kelvane"));
  w.callTo(a("ulvane"), 50);
  w.fold(a("quillan"));
  w.fold(a("wenrick"));
  w.callTo(a("vexlor"), 50);
  w.check(a("ostravan"));
  w.dealt(["Q♠", "7♦", "2♥"]);
  w.betTo(a("vexlor"), 100);
  w.fold(a("ostravan"));
  w.fold(a("ulvane"));
  w.uncalled(a("vexlor"), 100);
  w.award(a("vexlor"));
  w.endHand();

  // 20:30. Kelvane bets the flop and takes it down.
  w.startHand(a("vexlor"), "20:30:00");
  w.blind(a("ostravan"), "small", 25);
  w.blind(a("kelvane"), "big", 50);
  w.fold(a("ulvane"));
  w.fold(a("quillan"));
  w.fold(a("wenrick"));
  w.fold(a("vexlor"));
  w.callTo(a("ostravan"), 50);
  w.check(a("kelvane"));
  w.dealt(["4♣", "4♦", "9♥"]);
  w.check(a("ostravan"));
  w.betTo(a("kelvane"), 200);
  w.fold(a("ostravan"));
  w.uncalled(a("kelvane"), 200);
  w.award(a("kelvane"));
  w.endHand();

  // 22:00. Ulvane leaves while up.
  w.leave(a("ulvane"), "22:00:00");

  // 23:15. A quiet last hand: Wenrick bets the turn and Quillan folds.
  w.startHand(a("kelvane"), "23:15:00");
  w.blind(a("quillan"), "small", 25);
  w.blind(a("wenrick"), "big", 50);
  w.fold(a("vexlor"));
  w.fold(a("ostravan"));
  w.fold(a("kelvane"));
  w.callTo(a("quillan"), 50);
  w.check(a("wenrick"));
  w.dealt(["5♣", "6♠", "Q♥"]);
  w.check(a("quillan"));
  w.check(a("wenrick"));
  w.dealt(["A♣"]);
  w.betTo(a("wenrick"), 100);
  w.fold(a("quillan"));
  w.uncalled(a("wenrick"), 100);
  w.award(a("wenrick"));
  w.endHand();
}

// The two made-up hand logs, named for the ledger ids they pair with.
function handLogFor(date: string, off: number, prefix: string, script: (w: LogWriter) => void): string {
  const w = new LogWriter(dayOf(date), off, prefix);
  script(w);
  return handLogCsv(w.rows);
}

// ---------------------------------------------------------------- Saved_Data inputs

// Seat owners: a seat played under someone else's name or account, or a seat someone checked.
interface OwnerIn { game: string; acct: string; nick: string; owner: string; note: string; from: string }
const OWNERS: OwnerIn[] = [
  { game: "ledger_pglFAKE0010", acct: "FAKEid0040", nick: "Ombrix", owner: "hespyre",
    note: 'bought under "Ombrix" on account FAKEid0040', from: "ledger_pglFAKE0010" },
  { game: "ledger_pglFAKE0001", acct: "FAKEid0040", nick: "Hespyre", owner: "hespyre",
    note: "checked: name was right", from: "ledger_pglFAKE0001" },
  // A saved entry for a ledger that is not in the data: the app shows it as "(not loaded)".
  { game: "ledger_pglFAKE0099", acct: "FAKEid0031", nick: "Ghostly", owner: "zaqvin",
    note: 'bought under "Ghostly" on account FAKEid0031', from: "" },
];

// A payment (a pair sharing a group) or a one-sided correction. Amount in cents, signed.
const ADJUSTMENTS = [
  { group: "pay-0001", date: "2026-03-20", who: "brask", cents: 2500, folder: "Synthetic Spring", note: "paid (to Quorin)" },
  { group: "pay-0001", date: "2026-03-20", who: "quorin", cents: -2500, folder: "Synthetic Spring", note: "paid (from Brask)" },
  { group: "let-0002", date: "2026-06-01", who: "vextorion", cents: 1250, folder: "", note: "debt let go (to Zaqvin)" },
  { group: "let-0002", date: "2026-06-01", who: "zaqvin", cents: -1250, folder: "", note: "debt let go (from Vextorion)" },
  { group: "adj-0003", date: "2026-09-05", who: "marisolquenby", cents: -700, folder: "", note: "typo fix" },
];

const SESSION_ROWS = [
  ["Winter 2026 sheet", "Jolwick", "jolwick", "Kaxtun", "kaxtun", "15.00", "0.00", "paid"],
  ["Winter 2026 sheet", "Mirtavo", "mirtavo", "Zaqvin", "zaqvin", "25.00", "10.00", "partial"],
  ["Winter 2026 sheet", "Zaqvin", "zaqvin", "Plenkor", "plenkor", "40.00", "40.00", "open"],
];

// ---------------------------------------------------------------- main

function normalizeName(name: string): string {
  const letters = name.replace(/[^A-Za-z]/g, "").toLowerCase();
  const digits = name.replace(/[^0-9]/g, "");
  return letters === "" ? digits : letters;
}

function resolve(key: string): string {
  let cur = key;
  for (let i = 0; i < 64; i++) {
    const next = MERGE[cur];
    if (next === undefined || next === cur) return cur;
    cur = next;
  }
  return cur;
}

function main(): void {
  rmSync(OUT, { recursive: true, force: true });

  const built = new Map<string, Row[]>();
  for (const g of GAMES) built.set(g.id, buildRows(g, built));

  // Checks the generator promises: seat counts, zero sums, and the special totals.
  for (const g of GAMES) {
    const rows = built.get(g.id) ?? [];
    if (rows.length < 6 || rows.length > 25) throw new Error(`${g.id} has ${rows.length} seats`);
    const sum = rows.reduce((t, r) => t + r.net, 0);
    if (sum !== (g.unbalancedBy ?? 0)) throw new Error(`${g.id} nets sum to ${sum}`);
  }

  const owners = new Map<string, string>();
  for (const o of OWNERS) owners.set(`${o.game}|${o.acct}|${o.nick}`, o.owner);

  const ownerStart = (o: OwnerIn): string => {
    const row = (built.get(o.from) ?? []).find((r) => r.acct === o.acct && r.nick === o.nick);
    if (!row?.start) throw new Error(`no seat for owner entry ${o.game} ${o.nick}`);
    return row.start.replace(/\.\d{3}Z$/, "Z");   // the app writes seat owners to the second
  };

  // The name a row is filed under, as the app works it out (owners, then nickname, then the account).
  const personOf = (game: string, r: Row): string => {
    const owner = owners.get(`${game}|${r.acct}|${r.nick}`) ?? "";
    const name = owner || normalizeName(r.nick) || normalizeName(`unnamed ${r.acct}`);
    return resolve(name);
  };

  const balance = new Map<string, number>();
  const games = new Map<string, Set<string>>();
  for (const g of GAMES) {
    for (const r of built.get(g.id) ?? []) {
      if (r.start === null) continue;
      const who = personOf(g.id, r);
      balance.set(who, (balance.get(who) ?? 0) + r.net);
      if (!games.has(who)) games.set(who, new Set());
      games.get(who)?.add(g.id);
    }
  }
  for (const a of ADJUSTMENTS) {
    const who = resolve(a.who);
    balance.set(who, (balance.get(who) ?? 0) + a.cents);
  }

  const expect = (who: string, cents: number, nGames: number): void => {
    const got = balance.get(who) ?? 0;
    const n = games.get(who)?.size ?? 0;
    if (got !== cents || n !== nGames) throw new Error(`${who}: ${got} cents in ${n} games, want ${cents} in ${nGames}`);
  };
  expect("ylmande", 50, 4);
  expect("bexrunn", 150, 4);
  expect("cavlorn", 500, 8);
  expect("tarvelle", -3000, 1);
  expect("dulvane", -3000, 1);

  const big = BIG.map((who) => resolve(normalizeName(who[0]))).filter((who) => (balance.get(who) ?? 0) !== 0);
  if (new Set(big).size < 22) throw new Error(`only ${new Set(big).size} big-game players have a balance`);

  // Pinned payments: the biggest loser pays the biggest winner (applies), and a winner "pays" another winner (ignored).
  const ranked = [...balance.entries()].sort((a, b) => a[1] - b[1]);
  const payer = ranked[0];
  const payee = ranked[ranked.length - 1];
  if (!payer || !payee || payer[1] >= 0 || payee[1] <= 0) throw new Error("no loser and winner to pin");
  const winners = ranked.filter((e) => e[1] > 0).reverse();
  const second = winners[1];
  if (!second) throw new Error("need two winners");

  // Write everything.
  for (const g of GAMES) {
    writeText(`Games/${g.folder}/${g.id}.csv`, ledgerCsv(built.get(g.id) ?? []));
  }
  const autumnCopy = GAMES.find((g) => g.id === "ledger_pglFAKE0004");
  if (!autumnCopy) throw new Error("ledger 0004 missing");
  writeText("Games/Synthetic Autumn/ledger_pglFAKE0004.csv", ledgerCsv(built.get("ledger_pglFAKE0004") ?? []));
  // A browser copy "(1)" of ledger 0005 with the last three sit-downs missing: less complete, so the app keeps the fuller file.
  writeText("Games/Synthetic Spring/ledger_pglFAKE0005 (1).csv", ledgerCsv((built.get("ledger_pglFAKE0005") ?? []).slice(0, -3)));
  writeText(`Games/${NEVER_PLAYED_ONLY.folder}/${NEVER_PLAYED_ONLY.id}.csv`, ledgerCsv([
    { nick: PL.emptySeat[0], acct: PL.emptySeat[1], start: null, end: null, buyIn: 0, buyOut: 0, net: 0 },
    { nick: PL.emptySeat[0], acct: PL.emptySeat[1], start: null, end: null, buyIn: 0, buyOut: 0, net: 0 },
  ]));

  // The two hand logs, next to their ledgers (the file name is poker_now_log_<ledger id without ledger_>.csv).
  writeText("Games/Synthetic Autumn/poker_now_log_pglFAKE0014.csv", handLogFor("2026-10-17", -4, "FAKEh14", script0014));
  writeText("Games/Synthetic Autumn/poker_now_log_pglFAKE0015.csv", handLogFor("2026-10-31", -4, "FAKEh15", script0015));

  writeText("Saved_Data/merge_rules.csv", "alias_normalized,canonical_normalized\n" +
    MERGE_ROWS.map(([a, c]) => `${a},${c}`).join("\n") + "\n");
  writeText("Saved_Data/payment_preferences.csv", "payer_normalized,payee_normalized,note\n" +
    `${payer[0]},${payee[0]},Venmo only\n${second[0]},${payee[0]},\n`);
  writeText("Saved_Data/settings.csv", "key,value\nme,zaqvin\nbanker,\ndisplay,fancy\n");
  writeText("Saved_Data/adjustments.csv", "group,date,player_normalized,amount,folder,note\n" +
    ADJUSTMENTS.map((a) => `${a.group},${a.date},${a.who},${(a.cents / 100).toFixed(2)},${a.folder},${esc(a.note)}`).join("\n") + "\n");
  writeText("Saved_Data/seat_owners.csv", "ledger_id,player_id,session_start_at,nickname,owner_normalized,note\n" +
    OWNERS.map((o) => `${o.game},${o.acct},${o.from ? ownerStart(o) : "2026-07-07T19:00:00Z"},${esc(o.nick)},${o.owner},${esc(o.note)}`).join("\n") + "\n");
  writeText("Saved_Data/session_balances.csv", "session_id,from_display,from_normalized,to_display,to_normalized,original_amount,remaining_amount,status\n" +
    SESSION_ROWS.map((r) => r.join(",")).join("\n") + "\n");

  const seats = GAMES.reduce((t, g) => t + (built.get(g.id) ?? []).length, 0);
  console.log(`wrote ${GAMES.length} game ledgers (${seats} seat rows), 2 hand logs, 3 folders, 2 copies, 1 never-played-only file, 6 Saved_Data files under fixtures/synthetic`);
}

function writeText(rel: string, text: string): void {
  const path = join(OUT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

main();
