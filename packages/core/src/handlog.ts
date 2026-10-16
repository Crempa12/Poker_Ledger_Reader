// PokerNow hand logs ("poker_now_log_<gameId>.csv"): every hand of a night, with each
// player's actions, the board, the cards shown, the stacks at the start of each hand and
// the admin's chip changes. Port of src/handlog.hpp/.cpp: the reading of the log, its pairing
// with the ledger of the same game, the nickname folding, and the menu 18 playing-style
// table. styleStatsCSV is the export; the screen printing is not ported.
//
// Money is kept two ways, on purpose. The field named as in the C++ (net, collected,
// bounty, pot, amount, stack, netFromLog, ...) holds the double dollars the C++ adds up,
// computed with the same operations in the same order, so sums, the sign of a tiny value
// and the ties the sorts see come out as the C++ has them. The field with a Cents suffix
// holds the same amount as whole cents, for everything that does not need the doubles.
// Where the C++ walks a std::map, this walks the keys in UTF-8 byte order, because the
// order changes the double sums.
//
// Pure: no file is read here. The caller passes each file in as {relativePath, text}.
// Times are whole epoch seconds, or null for "no time" (the C++ NO_TIME).

import type { LedgerInput } from "./ledger.ts";
import { ledgerFolder } from "./ledger.ts";
import { libcppSort } from "./libcpp-sort.ts";
import type { Epoch, Game, PlayerStats } from "./models.ts";
import type { MergeRules } from "./players.ts";
import { personOf, resolveCanonical } from "./players.ts";
import {
  EPSILON_DOLLARS,
  cleanStem,
  compareBytes,
  escapeCSV,
  fixed2,
  isExcludedDir,
  lower,
  normalizeName,
  parseISO8601UTC,
  toDoubleSafe,
  trim,
} from "./util.ts";

// ---- the shapes ---------------------------------------------------------------------------

// One file of the input: a path relative to the data root, and its text.
export interface HandLogInput {
  relativePath: string;
  text: string;
}

export type Street = "preflop" | "flop" | "turn" | "river";
export type ActionKind = "post" | "fold" | "check" | "call" | "bet" | "raise";
// Which blind a "post" was. Only SmallBlind and BigBlind mark the live blinds that anchor a
// table position: a dead or missed blind is posted by someone re-entering, and can appear in
// the same hand as a normal SB/BB pair. "none" on every action that is not a post.
export type PostKind = "none" | "smallBlind" | "bigBlind" | "deadSmallBlind" | "missedBigBlind";
// "rebuy"; "topup" (chips put on the table); "remove" (an admin took chips off); "away" (an admin
// forced away mode) and "kick" (an admin queued a removal). The last two move no chips.
export type StackEventKind = "rebuy" | "topup" | "remove" | "away" | "kick";

export interface Seat {
  seat: number;
  playerId: string;
  nickname: string;
  stack: number; // dollars at the start of the hand (C++ double)
  stackCents: number;
}

export interface Action {
  playerId: string;
  street: Street;
  kind: ActionKind;
  amount: number; // dollars: the "to" amount of a call, bet or raise, or the blind of a post
  amountCents: number;
  allIn: boolean;
  post: PostKind;
  bombPot: boolean; // forced bomb-pot money: real chips, but not a voluntary choice
}

export interface Hand {
  number: number;
  id: string;
  start: Epoch;
  dealerId: string;
  seats: Seat[]; // in seat order
  myCards: string; // "K♦, 9♠": the exporting player's own hole cards
  board: string[]; // up to five cards
  actions: Action[];
  // playerId -> every card they showed, before or after the hand-ended marker ("K♥, K♠" even
  // when shown one at a time). Showing is optional: a showdown loser who mucks has no entry.
  shown: Map<string, string>;
  folded: Set<string>; // playerIds that folded on any street
  // A real showdown: PokerNow named a winning hand, or at least two players still in the hand
  // tabled both cards. One card flashed on its own is a courtesy reveal, not a showdown.
  showdown: boolean;
  bombPot: boolean; // forced-money hand: left out of VPIP, PFR, flop and aggression
  runItTwice: boolean; // set only by the authoritative all-players marker
  rank: Map<string, string>; // playerId -> winning hand name ("Pair, J's"): showdown winners only
  collected: Map<string, number>; // playerId -> total collected from the pot (dollars)
  collectedCents: Map<string, number>;
  // playerId -> collected + returned - contributed + bounty, in dollars.
  net: Map<string, number>;
  netCents: Map<string, number>;
  bounty: Map<string, number>; // 7-2 bounty received (+) or paid (-) (dollars), already in net
  bountyCents: Map<string, number>;
  pot: number; // total collected in the hand (dollars)
  potCents: number;
}

// Chips put on the table between hands, or moved by an admin. `hand` is the index of the first
// hand dealt after the event (it may equal the number of hands).
export interface StackEvent {
  at: Epoch;
  hand: number;
  playerId: string;
  kind: StackEventKind;
  amount: number; // dollars, always positive (0 for "away" and "kick")
  amountCents: number;
}

// One ledger seat on an account: who was really playing it, and when.
export interface SeatWindow {
  start: Epoch;
  end: Epoch; // null = still seated when the ledger was exported
  person: string; // canonical name
}

export interface HandLog {
  gameId: string; // "pgl..." (the ledger's id without the "ledger_" prefix)
  path: string; // the file's relative path
  folder: string; // "(root)" for a file at the top of the data root
  hands: Hand[]; // chronological
  events: StackEvent[]; // chronological
  names: Map<string, string>; // playerId -> last nickname seen
  // playerId -> that account's seats in the paired ledger, with the owners and merge rules
  // applied. Empty until pairWithLedger runs; the nickname then decides who a player is.
  seats: Map<string, SeatWindow[]>;
  start: Epoch;
  end: Epoch;
  biggestPot: number; // dollars
  biggestPotCents: number;
  biggestPotWinner: string; // playerId
  biggestPotHand: number;
  stackMismatches: number; // hands whose money did not reconcile with the next hand's stacks
}

export type ParseHandLogResult = { ok: true; log: HandLog } | { ok: false; error: string };

export interface LoadLogsResult {
  logs: Map<string, HandLog>; // by game id, in byte order
  messages: string[]; // skipped files and ignored duplicates, in the order they were met
}

// Playing-style numbers for one person, over the logs given. Percentages are derived from the
// counts with the functions below, not stored. Money is double dollars (C++ order) with a cents twin.
export interface StyleStats {
  displayName: string;
  normalizedName: string; // canonical (after the merge rules)
  games: number;
  hands: number; // hands dealt in
  handsVoluntary: number; // hands that count for VPIP, PFR and flop: bomb pots left out
  vpip: number; // voluntarily put money in preflop
  pfr: number; // raised preflop
  sawFlop: number;
  courtesyReveals: number; // hands where they showed exactly one card
  showdowns: number; // every hand, bomb pots included: the W$SD denominator
  showdownsVoluntary: number; // bomb pots excluded: the WTSD numerator
  showdownWins: number;
  handsWon: number;
  facedRaise: number; // preflop decisions facing a raise
  foldedToRaise: number;
  bets: number; // postflop only
  raises: number;
  calls: number;
  allIns: number;
  wonTotal: number;
  wonTotalCents: number;
  netFromLog: number; // sum of per-hand nets (equals the ledger net for the same games)
  netFromLogCents: number;
  biggestPotWon: number;
  biggestPotWonCents: number;
  bountiesNet: number; // 7-2 bounties received minus paid (part of netFromLog)
  bountiesNetCents: number;
  // Hit & run, filled in by the hit & run module. -1 = no nights to judge.
  hitRun: number;
  hitRunReliable: boolean;
  hitRunTag: string;
}

// One person's running net through a night, hand by hand (NaN = not seated), all accounts together.
export interface NightSeries {
  person: string; // canonical name
  displayName: string;
  accounts: string[]; // nicknames of the accounts they played on, byte order
  netByHand: number[]; // one entry per hand; NaN where they were not seated
  finalNet: number;
  finalNetCents: number;
}

// ---- small helpers ------------------------------------------------------------------------

// Whole cents of a dollar double, rounded half away from zero, with no -0.
function centsOf(dollars: number): number {
  const v = dollars * 100;
  const r = Math.sign(v) * Math.round(Math.abs(v));
  return r === 0 ? 0 : r;
}

function centsMap(m: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of m) out.set(k, centsOf(v));
  return out;
}

// The keys of a map or set in UTF-8 byte order: the order a std::map or std::set walks.
function inByteOrder(keys: Iterable<string>): string[] {
  return [...keys].sort(compareBytes);
}

function isNumberChar(c: string): boolean {
  return (c >= "0" && c <= "9") || c === ".";
}

// The first number in text at or after `from`: the run of digits and dots found there, read by
// toDoubleSafe. 0 when there is none, or when from is negative (the C++ npos).
function numberAt(text: string, from: number): number {
  if (from < 0) return 0;
  let i = from;
  while (i < text.length && !isNumberChar(text.charAt(i))) i++;
  let j = i;
  while (j < text.length && isNumberChar(text.charAt(j))) j++;
  return i < text.length ? toDoubleSafe(text.slice(i, j)) : 0;
}

// The cards in a comma-separated list, trimmed, without empty items.
function splitCards(s: string): string[] {
  return s
    .split(",")
    .map((c) => trim(c))
    .filter((c) => c !== "");
}

// Adds the cards of one "shows a ..." line to what the account has shown this hand. Players can
// show one card at a time, so the reveals add up; a card shown twice counts once.
function addShown(shown: string, line: string): string {
  let cards = trim(line);
  if (cards.endsWith(".")) cards = cards.slice(0, -1);
  const have = splitCards(shown);
  let out = shown;
  for (const c of splitCards(cards)) {
    if (have.includes(c)) continue;
    out += (out === "" ? "" : ", ") + c;
    have.push(c);
  }
  return out;
}

// The cards inside the last [...] of a board line.
function bracketCards(text: string): string[] {
  const open = text.lastIndexOf("[");
  const close = text.lastIndexOf("]");
  if (open === -1 || close === -1 || close < open) return [];
  return splitCards(text.slice(open + 1, close));
}

// "Q♦, J♣" -> 2 (tabled at showdown); "A♠" -> 1 (flashed voluntarily); "" -> 0.
export function shownCardCount(cards: string): number {
  if (trim(cards) === "") return 0;
  let n = 1;
  for (const c of cards) if (c === ",") n++;
  return n;
}

export function seatOf(hand: Hand, playerId: string): Seat | undefined {
  return hand.seats.find((s) => s.playerId === playerId);
}

// Everyone still in the hand when it reached showdown: every seat that never folded, in seat
// order, then anyone PokerNow named a winner. Empty when the hand did not reach showdown.
export function atShowdown(hand: Hand): string[] {
  const out: string[] = [];
  if (!hand.showdown) return out;
  const add = (pid: string): void => {
    if (!out.includes(pid)) out.push(pid);
  };
  for (const s of hand.seats) if (!hand.folded.has(s.playerId)) add(s.playerId);
  for (const pid of inByteOrder(hand.rank.keys())) add(pid);
  return out;
}

// "Name @ id" starting at pos (the opening quote). The nickname is everything before the last
// " @ " in the quotes, the id is everything after it. Null when the text there is not a player
// reference, or the id is empty.
interface PlayerRef {
  nickname: string;
  id: string;
  next: number; // the position just after the closing quote
}

function readPlayerRef(text: string, pos: number): PlayerRef | null {
  if (pos < 0 || pos >= text.length || text.charAt(pos) !== '"') return null;
  const close = text.indexOf('"', pos + 1);
  if (close === -1) return null;
  const inner = text.slice(pos + 1, close);
  const at = inner.lastIndexOf(" @ ");
  if (at === -1) return null;
  const id = trim(inner.slice(at + 3));
  if (id === "") return null;
  return { nickname: trim(inner.slice(0, at)), id, next: close + 1 };
}

// A CSV read the way the C++ reads it: quotes group commas and newlines, a doubled quote is one
// quote, and carriage returns outside quotes are dropped.
function readCSVRecords(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      records.push(row);
      row = [];
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  return records;
}

// std::stoll on the trimmed text, with the C++ catch that makes a bad number 0: an optional sign
// and digits, the rest ignored, and out of range is 0.
function orderNumber(s: string): number {
  const m = /^[+-]?\d+/.exec(s);
  if (m === null) return 0;
  const v = BigInt(m[0].replace(/^\+/, ""));
  if (v < -(2n ** 63n) || v > 2n ** 63n - 1n) return 0;
  return Number(v);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

function fileNameOf(relativePath: string): string {
  const parts = relativePath.split("/");
  return parts[parts.length - 1] ?? relativePath;
}

// The game id of a log file: "poker_now_log_pglX (1).csv" -> "pglX"; "" for any other name.
export function gameIdFromPath(relativePath: string): string {
  const name = fileNameOf(relativePath);
  const ext = extensionOf(name);
  const stem = cleanStem(ext === "" ? name : name.slice(0, name.length - ext.length));
  const prefix = "poker_now_log_";
  return stem.startsWith(prefix) ? stem.slice(prefix.length) : "";
}

function isLogCandidate(relativePath: string): boolean {
  const parts = relativePath.split("/");
  const name = parts.pop() ?? "";
  if (parts.some((folder) => isExcludedDir(folder))) return false;
  return lower(extensionOf(name)) === ".csv" && gameIdFromPath(relativePath) !== "";
}

// The order std::filesystem::path uses: element by element, each element in byte order.
function comparePaths(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const c = compareBytes(pa[i] ?? "", pb[i] ?? "");
    if (c !== 0) return c;
  }
  if (pa.length === pb.length) return 0;
  return pa.length < pb.length ? -1 : 1;
}

// The hand logs among the files: a .csv outside the excluded folders whose name is
// poker_now_log_<id>.csv. Sorted by path, as the C++ discovery sorts them.
export function discoverHandLogFiles(files: readonly HandLogInput[]): HandLogInput[] {
  return files
    .filter((f) => isLogCandidate(f.relativePath))
    .sort((a, b) => comparePaths(a.relativePath, b.relativePath));
}

function newHand(): Hand {
  return {
    number: 0,
    id: "",
    start: null,
    dealerId: "",
    seats: [],
    myCards: "",
    board: [],
    actions: [],
    shown: new Map(),
    folded: new Set(),
    showdown: false,
    bombPot: false,
    runItTwice: false,
    rank: new Map(),
    collected: new Map(),
    collectedCents: new Map(),
    net: new Map(),
    netCents: new Map(),
    bounty: new Map(),
    bountyCents: new Map(),
    pot: 0,
    potCents: 0,
  };
}

// The money one hand's actions add up to, while it is read.
interface Money {
  committed: Map<string, number>; // this street, live money
  contributed: Map<string, number>; // the whole hand
  won: Map<string, number>;
}

function newMoney(): Money {
  return { committed: new Map(), contributed: new Map(), won: new Map() };
}

// A call, bet or raise: the "to" amount, counted from what is already committed this street.
function live(money: Money, pid: string, to: number): void {
  const prev = money.committed.get(pid) ?? 0;
  const top = to < prev ? prev : to;
  money.contributed.set(pid, (money.contributed.get(pid) ?? 0) + (top - prev));
  money.committed.set(pid, top);
}

const CENTS_ON = "Cents Mode: off » on";
const CENTS_OFF = "Cents Mode: on » off";

// ---- reading one log -----------------------------------------------------------------------

// Reads one PokerNow hand log. Rows are newest first in the file and are put in order by their
// `order` column. Errors: an unreadable file, no entries, or no hands.
export function parseHandLog(file: HandLogInput): ParseHandLogResult {
  const log: HandLog = {
    gameId: gameIdFromPath(file.relativePath),
    path: file.relativePath,
    folder: ledgerFolder(file.relativePath),
    hands: [],
    events: [],
    names: new Map(),
    seats: new Map(),
    start: null,
    end: null,
    biggestPot: 0,
    biggestPotCents: 0,
    biggestPotWinner: "",
    biggestPotHand: 0,
    stackMismatches: 0,
  };

  const records = readCSVRecords(file.text);
  if (records.length === 0) return { ok: false, error: `could not read ${file.relativePath}` };

  // Header: entry,at,order. The first record is skipped when it is the header.
  interface Rec {
    entry: string;
    at: Epoch;
    order: number;
  }
  const recs: Rec[] = [];
  records.forEach((r, i) => {
    if (r.length < 3 || (i === 0 && lower(r[0] ?? "") === "entry")) return;
    recs.push({
      entry: r[0] ?? "",
      at: parseISO8601UTC(trim(r[1] ?? "")),
      order: orderNumber(trim(r[2] ?? "")),
    });
  });
  if (recs.length === 0) return { ok: false, error: `no log entries in ${file.relativePath}` };
  recs.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));

  // Amounts are logged in cents until "Cents Mode" is switched on. Hands only start once it is,
  // but seat requests and rebuys can come before, so the factor follows the config changes.
  let centsFactor = 1.0;
  for (const rec of recs) {
    if (rec.entry.includes(CENTS_ON)) {
      centsFactor = 0.01;
      break;
    }
    if (rec.entry.includes(CENTS_OFF)) break;
  }
  const pendingRebuy = new Map<string, number>(); // playerId -> the amount asked for, until "rebought"

  let hand: Hand = newHand();
  let inHand = false;
  let street: Street = "preflop";
  let money: Money = newMoney();

  const finish = (): void => {
    if (!inHand) return;
    for (const [pid, c] of money.contributed) hand.net.set(pid, (hand.net.get(pid) ?? 0) - c);
    for (const [pid, w] of money.won) hand.net.set(pid, (hand.net.get(pid) ?? 0) + w);
    for (const s of hand.seats) if (!hand.net.has(s.playerId)) hand.net.set(s.playerId, 0);
    for (const [pid, b] of hand.bounty) hand.net.set(pid, (hand.net.get(pid) ?? 0) + b);
    for (const pid of inByteOrder(hand.collected.keys())) hand.pot += hand.collected.get(pid) ?? 0;
    // A hand reached showdown if PokerNow named a winning hand (it only prints "collected N from
    // pot with <Rank>" at showdown), or if at least two players still in the hand tabled both cards.
    // Cards shown after the hand ended are added later, so they do not count here.
    let tabled = 0;
    for (const [pid, cards] of hand.shown) {
      if (!hand.folded.has(pid) && shownCardCount(cards) >= 2) tabled++;
    }
    hand.showdown = hand.rank.size > 0 || tabled >= 2;
    log.hands.push(hand);
    inHand = false;
  };

  for (const rec of recs) {
    const e = rec.entry;
    if (log.start === null || (rec.at !== null && rec.at < log.start)) log.start = rec.at;
    if (rec.at !== null && rec.at > (log.end ?? -1)) log.end = rec.at;

    if (e.startsWith("-- starting hand")) {
      finish();
      hand = newHand();
      money = newMoney();
      street = "preflop";
      inHand = true;
      hand.number = Math.trunc(numberAt(e, e.indexOf("#")));
      const idPos = e.indexOf("(id: ");
      if (idPos !== -1) {
        const close = e.indexOf(")", idPos);
        hand.id = trim(close === -1 ? e.slice(idPos + 5) : e.slice(idPos + 5, close));
      }
      hand.start = rec.at;
      const d = e.indexOf("(dealer: ");
      if (d !== -1) {
        const ref = readPlayerRef(e, d + 9);
        if (ref !== null) hand.dealerId = ref.id;
      }
      continue;
    }
    if (e.startsWith("-- ending hand")) {
      finish();
      continue;
    }

    // 7-2 bounties: "\"A @ id\" paid 1.00 for the 7-2 bounty to \"B @ id\"". Paid in chips, but
    // logged after the hand-ended marker, so they belong to the hand that just finished.
    if (e.charAt(0) === '"' && e.includes(" paid ") && e.includes("bounty")) {
      const first = readPlayerRef(e, 0);
      if (first === null) continue;
      const n = numberAt(e, first.next);
      const q = e.indexOf(' to "', first.next);
      if (q === -1) continue;
      const second = readPlayerRef(e, q + 4);
      if (second === null) continue;
      log.names.set(first.id, first.nickname);
      log.names.set(second.id, second.nickname);
      const target: Hand | undefined = inHand ? hand : log.hands[log.hands.length - 1];
      if (target === undefined) continue;
      target.bounty.set(first.id, (target.bounty.get(first.id) ?? 0) - n);
      target.bounty.set(second.id, (target.bounty.get(second.id) ?? 0) + n);
      if (!inHand) {
        target.net.set(first.id, (target.net.get(first.id) ?? 0) - n);
        target.net.set(second.id, (target.net.get(second.id) ?? 0) + n);
      }
      continue;
    }

    if (e.includes("Cents Mode: ")) {
      if (e.includes(CENTS_ON)) centsFactor = 1.0;
      else if (e.includes(CENTS_OFF)) centsFactor = 0.01;
      continue;
    }

    // Chips put on the table between hands: "requested a rebuy of 40.00" then "rebought. New stack
    // 40.00.", or "The admin updated the player \"A @ id\" stack from 1.27 to 51.27.". They take
    // effect at the next hand.
    if (e.startsWith('The player "') || e.startsWith('The admin updated the player "')) {
      const ref = readPlayerRef(e, e.indexOf('"'));
      if (ref === null) continue;
      const rest = e.slice(ref.next);
      const handIndex = log.hands.length + (inHand ? 1 : 0);
      if (rest.startsWith(" requested a rebuy of ")) {
        pendingRebuy.set(ref.id, numberAt(rest, 22) * centsFactor);
        continue;
      }
      let kind: StackEventKind;
      let amount: number;
      if (rest.startsWith(" rebought.")) {
        const asked = pendingRebuy.get(ref.id);
        kind = "rebuy";
        if (asked !== undefined) {
          amount = asked;
          pendingRebuy.delete(ref.id);
        } else {
          amount = numberAt(rest, rest.indexOf("stack")) * centsFactor;
        }
      } else if (rest.startsWith(" stack from ")) {
        const to = rest.indexOf(" to ", 12);
        if (to === -1) continue;
        const diff = (numberAt(rest, to + 4) - numberAt(rest, 12)) * centsFactor;
        kind = diff >= 0 ? "topup" : "remove";
        amount = Math.abs(diff);
      } else {
        continue; // joins, stand-ups, seat requests: the ledger already has the seats
      }
      if (amount > EPSILON_DOLLARS) {
        log.events.push({
          at: rec.at,
          hand: handIndex,
          playerId: ref.id,
          kind,
          amount,
          amountCents: centsOf(amount),
        });
      }
      continue;
    }
    // The admin taking someone out of play: "The admin \"A @ id\" forced the player \"B @ id\" to
    // away mode in the next hand." or "... enqueued the removal of the player \"B @ id\"." No chips
    // move, but when B stops being dealt in right after, leaving was not B's choice.
    if (e.startsWith('The admin "')) {
      const admin = readPlayerRef(e, e.indexOf('"'));
      if (admin === null) continue;
      let kind: StackEventKind = "away";
      let p = e.indexOf(' forced the player "', admin.next);
      if (p === -1) {
        kind = "kick";
        p = e.indexOf(' enqueued the removal of the player "', admin.next);
      }
      if (p === -1) continue;
      const ref = readPlayerRef(e, e.indexOf('"', p));
      if (ref === null) continue;
      log.events.push({
        at: rec.at,
        hand: log.hands.length + (inHand ? 1 : 0),
        playerId: ref.id,
        kind,
        amount: 0,
        amountCents: 0,
      });
      continue;
    }
    if (!inHand) {
      // Cards shown after the hand-ended marker belong to the hand that just finished: a showdown
      // loser often mucks, then turns the cards over once the pot is pushed.
      const last = log.hands[log.hands.length - 1];
      if (e.charAt(0) === '"' && last !== undefined) {
        const ref = readPlayerRef(e, 0);
        if (ref !== null) {
          const rest = trim(e.slice(ref.next));
          if (rest.startsWith("shows a ")) last.shown.set(ref.id, addShown(last.shown.get(ref.id) ?? "", rest.slice(8)));
        }
      }
      continue;
    }

    if (e.startsWith("Player stacks:")) {
      let p = 0;
      for (;;) {
        p = e.indexOf("#", p);
        if (p === -1) break;
        const seatNumber = Math.trunc(numberAt(e, p));
        const q = e.indexOf('"', p);
        if (q === -1) break;
        const ref = readPlayerRef(e, q);
        if (ref === null) break;
        const stack = numberAt(e, ref.next);
        hand.seats.push({ seat: seatNumber, playerId: ref.id, nickname: ref.nickname, stack, stackCents: centsOf(stack) });
        log.names.set(ref.id, ref.nickname);
        p = ref.next;
      }
      continue;
    }
    if (e.startsWith("Your hand is ")) {
      hand.myCards = trim(e.slice(13));
      continue;
    }
    if (e.startsWith("Flop")) {
      street = "flop";
      money.committed.clear();
      if (hand.board.length === 0) hand.board = bracketCards(e);
      continue;
    }
    if (e.startsWith("Turn")) {
      street = "turn";
      money.committed.clear();
      if (hand.board.length === 3) hand.board.push(...bracketCards(e));
      continue;
    }
    if (e.startsWith("River")) {
      street = "river";
      money.committed.clear();
      if (hand.board.length === 4) hand.board.push(...bracketCards(e));
      continue;
    }
    if (e.startsWith("Uncalled bet of ")) {
      const amount = numberAt(e, 16);
      const ref = readPlayerRef(e, e.indexOf('"'));
      if (ref !== null) money.won.set(ref.id, (money.won.get(ref.id) ?? 0) + amount);
      continue;
    }
    // The authoritative run-it-twice marker. Unquoted, so it is read before the guard below drops
    // every line that does not start with a player reference.
    if (e.startsWith("All players in hand choose to run it twice")) {
      hand.runItTwice = true;
      continue;
    }

    if (e.charAt(0) !== '"') continue; // joins, rebuys, config changes ...
    const ref = readPlayerRef(e, 0);
    if (ref === null) continue;
    const pid = ref.id;
    log.names.set(pid, ref.nickname);
    const rest = trim(e.slice(ref.next));
    const allIn = rest.includes("all in");
    // Bomb pots force every seat to put money in before the cards are dealt. The chips are real,
    // but the decision is not the player's, so this money does not count toward VPIP, PFR or
    // aggression.
    const bomb = rest.includes("(bomb pot bet)");
    if (bomb) hand.bombPot = true;
    const currentStreet = street;
    const act = (kind: ActionKind, amount: number, post: PostKind = "none"): void => {
      hand.actions.push({
        playerId: pid,
        street: currentStreet,
        kind,
        amount,
        amountCents: centsOf(amount),
        allIn,
        post,
        bombPot: bomb,
      });
    };

    if (rest.startsWith("folds")) {
      act("fold", 0);
      hand.folded.add(pid);
    } else if (rest.startsWith("checks")) {
      act("check", 0);
    } else if (rest.startsWith("calls ")) {
      const n = numberAt(rest, 6);
      live(money, pid, n);
      act("call", n);
    } else if (rest.startsWith("bets ")) {
      const n = numberAt(rest, 5);
      live(money, pid, n);
      act("bet", n);
    } else if (rest.startsWith("raises to ")) {
      const n = numberAt(rest, 10);
      live(money, pid, n);
      act("raise", n);
    } else if (rest.startsWith("posts ")) {
      const of = rest.indexOf(" of ");
      const n = numberAt(rest, of === -1 ? 6 : of);
      // The dead and missed variants are tested before the plain ones: a catch-up post contains
      // "small blind" or "big blind" as a substring too, and can occur in the same hand as a
      // normal live pair. Only the live pair may anchor a table position.
      const dead = rest.includes("missing small blind");
      let post: PostKind = "none";
      if (dead) post = "deadSmallBlind";
      else if (rest.includes("missed big blind")) post = "missedBigBlind";
      else if (rest.includes("small blind")) post = "smallBlind";
      else if (rest.includes("big blind")) post = "bigBlind";
      if (dead) money.contributed.set(pid, (money.contributed.get(pid) ?? 0) + n); // dead money: not live toward a call
      else live(money, pid, n);
      act("post", n, post);
    } else if (rest.startsWith("shows a ")) {
      // Whether this was a real showdown is decided in finish(): one flashed card is a courtesy reveal.
      hand.shown.set(pid, addShown(hand.shown.get(pid) ?? "", rest.slice(8)));
    } else if (rest.startsWith("collected ") && !rest.includes("bounty")) {
      const n = numberAt(rest, 10);
      hand.collected.set(pid, (hand.collected.get(pid) ?? 0) + n);
      money.won.set(pid, (money.won.get(pid) ?? 0) + n);
      const w = rest.indexOf(" from pot with ");
      if (w !== -1) {
        const named = rest.slice(w + 15);
        const comb = named.indexOf(" (combination");
        hand.rank.set(pid, trim(comb === -1 ? named : named.slice(0, comb)));
      }
    }
    // The per-player '"X" chooses to run it twice.' line records one player's agreement only, so
    // it is not read: the unquoted marker above is the authoritative one.
  }
  finish();

  if (log.hands.length === 0) return { ok: false, error: `no hands in ${file.relativePath}` };

  // Chips the admin took off a stack between two hands, keyed by the hand dealt next and the
  // account, so the check below does not call that a mismatch.
  const removedBefore = new Map<string, number>();
  const keyOf = (hand: number, pid: string): string => JSON.stringify([hand, pid]);
  for (const ev of log.events) {
    if (ev.kind !== "remove") continue;
    const key = keyOf(ev.hand, ev.playerId);
    removedBefore.set(key, (removedBefore.get(key) ?? 0) + ev.amount);
  }

  // Biggest pot, and a check of the money against the next hand's stacks.
  for (let h = 0; h < log.hands.length; h++) {
    const hd = log.hands[h];
    if (hd === undefined) continue;
    if (hd.pot > log.biggestPot) {
      log.biggestPot = hd.pot;
      log.biggestPotHand = hd.number;
      let best = -1;
      for (const pid of inByteOrder(hd.collected.keys())) {
        const c = hd.collected.get(pid) ?? 0;
        if (c > best) {
          best = c;
          log.biggestPotWinner = pid;
        }
      }
    }
    const next = log.hands[h + 1];
    if (next === undefined) continue;
    for (const s of hd.seats) {
      const ns = seatOf(next, s.playerId);
      if (ns === undefined) continue;
      const net = hd.net.get(s.playerId) ?? 0;
      const removed = removedBefore.get(keyOf(h + 1, s.playerId)) ?? 0;
      const expected = s.stack + net - removed;
      // A stack above the expected value is a top-up; below it means the money did not add up.
      if (ns.stack < expected - 0.011) {
        log.stackMismatches++;
        break;
      }
    }
  }

  for (const h of log.hands) {
    h.potCents = centsOf(h.pot);
    h.collectedCents = centsMap(h.collected);
    h.netCents = centsMap(h.net);
    h.bountyCents = centsMap(h.bounty);
  }
  log.biggestPotCents = centsOf(log.biggestPot);
  return { ok: true, log };
}

// Every log among the files, keyed by game id. A game with two logs keeps the one with more hands
// (the first met on a tie); each ignored one gets a message. Unreadable files get a message too.
export function loadAllLogs(files: readonly HandLogInput[]): LoadLogsResult {
  const messages: string[] = [];
  const byId = new Map<string, HandLog>();
  for (const file of discoverHandLogFiles(files)) {
    const parsed = parseHandLog(file);
    if (!parsed.ok) {
      messages.push("Skipped hand log: " + parsed.error);
      continue;
    }
    const log = parsed.log;
    const existing = byId.get(log.gameId);
    if (existing !== undefined) {
      // Keep the more complete export of the same game.
      if (log.hands.length <= existing.hands.length) {
        messages.push("Duplicate hand log ignored: " + log.path);
        continue;
      }
      messages.push("Duplicate hand log ignored: " + existing.path);
    }
    byId.set(log.gameId, log);
  }
  const logs = new Map<string, HandLog>();
  for (const id of inByteOrder(byId.keys())) {
    const log = byId.get(id);
    if (log !== undefined) logs.set(id, log);
  }
  return { logs, messages };
}

// The game id a hand log is paired by: the ledger's id without its "ledger_" prefix (the C++ logId).
// A hand log named poker_now_log_<id>.csv belongs to the game whose logIdOf is <id>.
export function logIdOf(game: Game): string {
  return game.id.startsWith("ledger_") ? game.id.slice(7) : game.id;
}

// Fills log.seats from the ledger of the same game. Call it again whenever the seat owners or the
// merge rules change.
export function pairWithLedger(log: HandLog, game: Game, rules: MergeRules): void {
  log.seats.clear();
  for (const row of game.rows) {
    if (row.playerId === "") continue;
    const list = log.seats.get(row.playerId) ?? [];
    list.push({ start: row.start, end: row.end, person: personOf(rules, row) });
    log.seats.set(row.playerId, list);
  }
}

// Who was really playing an account at a moment: the owner of the ledger seat on that account
// covering the time (or the nearest one), else the log nickname after the merge rules.
export function personAt(log: HandLog, playerId: string, at: Epoch, rules: MergeRules): string {
  const windows = log.seats.get(playerId);
  if (windows !== undefined && windows.length > 0) {
    let best: SeatWindow | undefined;
    let bestGap = 0;
    for (const w of windows) {
      let gap = 0;
      if (at !== null && w.start !== null && at < w.start) gap = w.start - at;
      else if (at !== null && w.end !== null && at > w.end) gap = at - w.end;
      if (best === undefined || gap < bestGap) {
        best = w;
        bestGap = gap;
      }
    }
    if (best !== undefined) return best.person;
  }
  const nickname = log.names.get(playerId) ?? playerId;
  return resolveCanonical(rules, normalizeName(nickname));
}

interface Identity {
  key: string; // canonical name ("@<account>" for a nickname with no letters)
  display: string;
}

function identify(
  log: HandLog,
  pid: string,
  at: Epoch,
  rules: MergeRules,
  ledgerStats: ReadonlyMap<string, PlayerStats>,
): Identity {
  let key = personAt(log, pid, at, rules);
  const nickname = log.names.get(pid) ?? pid;
  if (key === "") key = "@" + pid;
  const stats = ledgerStats.get(key);
  let display: string;
  if (stats !== undefined) {
    display = stats.displayName; // their leaderboard name
  } else if (resolveCanonical(rules, normalizeName(nickname)) === key || key.charAt(0) === "@") {
    display = nickname;
  } else {
    // A seat handed to someone with no ledger stats in scope: the key, capitalized.
    display = key.replace(/^[a-z]/, (c) => c.toUpperCase());
  }
  return { key, display };
}

// The name to show for that person: their leaderboard name when they have one.
export function displayNameAt(
  log: HandLog,
  playerId: string,
  at: Epoch,
  rules: MergeRules,
  ledgerStats: ReadonlyMap<string, PlayerStats>,
): string {
  return identify(log, playerId, at, rules, ledgerStats).display;
}

// ---- playing-style statistics -------------------------------------------------------------

export function newStyleStats(): StyleStats {
  return {
    displayName: "",
    normalizedName: "",
    games: 0,
    hands: 0,
    handsVoluntary: 0,
    vpip: 0,
    pfr: 0,
    sawFlop: 0,
    courtesyReveals: 0,
    showdowns: 0,
    showdownsVoluntary: 0,
    showdownWins: 0,
    handsWon: 0,
    facedRaise: 0,
    foldedToRaise: 0,
    bets: 0,
    raises: 0,
    calls: 0,
    allIns: 0,
    wonTotal: 0,
    wonTotalCents: 0,
    netFromLog: 0,
    netFromLogCents: 0,
    biggestPotWon: 0,
    biggestPotWonCents: 0,
    bountiesNet: 0,
    bountiesNetCents: 0,
    hitRun: -1,
    hitRunReliable: false,
    hitRunTag: "",
  };
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : (100 * part) / whole;
}

export function vpipPct(s: StyleStats): number {
  return pct(s.vpip, s.handsVoluntary);
}

export function pfrPct(s: StyleStats): number {
  return pct(s.pfr, s.handsVoluntary);
}

export function sawFlopPct(s: StyleStats): number {
  return pct(s.sawFlop, s.handsVoluntary);
}

export function wtsdPct(s: StyleStats): number {
  return pct(s.showdownsVoluntary, s.sawFlop);
}

export function wsdPct(s: StyleStats): number {
  return pct(s.showdownWins, s.showdowns);
}

export function foldToRaisePct(s: StyleStats): number {
  return pct(s.foldedToRaise, s.facedRaise);
}

// Postflop aggression: (bets + raises) / calls. 99 when there are bets or raises and no calls.
export function aggression(s: StyleStats): number {
  if (s.calls === 0) return s.bets + s.raises > 0 ? 99 : 0;
  return (s.bets + s.raises) / s.calls;
}

// The style label, from VPIP and aggression. Needs 30 hands.
export function styleLabel(s: StyleStats): string {
  if (s.hands < 30) return "(few hands)";
  const v = vpipPct(s);
  const af = aggression(s);
  const loose = v >= 32;
  const tight = v <= 20;
  const aggro = af >= 2.5;
  const passive = af < 1.2;
  if (tight && aggro) return "Tight-aggressive";
  if (loose && aggro) return "Loose-aggressive";
  if (tight && passive) return "Tight-passive";
  if (loose && passive) return "Loose-passive (calls a lot)";
  if (aggro) return "Aggressive";
  if (passive) return "Passive";
  if (loose) return "Loose";
  if (tight) return "Tight";
  return "Balanced";
}

// The money of one person's accounts, added the way the C++ adds them.
function bump(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

// One row per person: every account they played on is folded in, and a shared account is split
// by who held each seat. Rows come out in the C++ order: byte order of the name, then hands
// (most first), then display name.
export function computeStyle(
  logs: readonly HandLog[],
  rules: MergeRules,
  ledgerStats: ReadonlyMap<string, PlayerStats>,
): StyleStats[] {
  const rows = new Map<string, StyleStats>();
  const gamesOf = new Map<string, Set<string>>();
  const rowFor = (k: string): StyleStats => {
    let r = rows.get(k);
    if (r === undefined) {
      r = newStyleStats();
      rows.set(k, r);
    }
    return r;
  };

  for (const log of logs) {
    for (const hand of log.hands) {
      // Accounts are resolved to people hand by hand, since a shared account can change hands mid-night.
      const keyOf = new Map<string, string>(); // playerId -> person
      const person = (pid: string): string => {
        const cached = keyOf.get(pid);
        if (cached !== undefined) return cached;
        const id = identify(log, pid, hand.start, rules, ledgerStats);
        const row = rowFor(id.key);
        if (row.normalizedName === "") {
          row.normalizedName = id.key;
          row.displayName = id.display;
        }
        keyOf.set(pid, id.key);
        return id.key;
      };

      // Someone holding two seats in one hand was still dealt one hand.
      const seated = new Set<string>();
      for (const s of hand.seats) seated.add(person(s.playerId));
      for (const k of inByteOrder(seated)) {
        const r = rowFor(k);
        r.hands++;
        if (!hand.bombPot) r.handsVoluntary++;
        let games = gamesOf.get(k);
        if (games === undefined) {
          games = new Set();
          gamesOf.set(k, games);
        }
        games.add(log.gameId);
      }

      const vpip = new Set<string>();
      const pfr = new Set<string>();
      const faced = new Set<string>();
      const foldedPre = new Set<string>(); // accounts, not people
      let raisedPre = false;
      let lastRaiser = "";
      for (const a of hand.actions) {
        const k = person(a.playerId);
        const r = rowFor(k);
        if (a.allIn) r.allIns++;
        if (a.street === "preflop") {
          // Forced bomb-pot money is not a voluntary choice.
          if (!a.bombPot && (a.kind === "call" || a.kind === "bet" || a.kind === "raise")) vpip.add(k);
          if (raisedPre && lastRaiser !== k && !faced.has(k) && (a.kind === "fold" || a.kind === "call" || a.kind === "raise")) {
            faced.add(k);
            r.facedRaise++;
            if (a.kind === "fold") r.foldedToRaise++;
          }
          if (a.kind === "raise") {
            if (!a.bombPot) pfr.add(k);
            raisedPre = true;
            lastRaiser = k;
          }
          if (a.kind === "fold") foldedPre.add(a.playerId);
        } else if (a.kind === "bet") {
          r.bets++;
        } else if (a.kind === "raise") {
          r.raises++;
        } else if (a.kind === "call") {
          r.calls++;
        }
      }
      if (!hand.bombPot) {
        for (const k of vpip) rowFor(k).vpip++;
        for (const k of pfr) rowFor(k).pfr++;
        if (hand.board.length >= 3) {
          const sawFlop = new Set<string>();
          for (const s of hand.seats) if (!foldedPre.has(s.playerId)) sawFlop.add(person(s.playerId));
          for (const k of sawFlop) rowFor(k).sawFlop++;
        }
      }
      // Everyone still in the hand at showdown counts, whether they tabled their cards or mucked.
      const atShow = new Set<string>();
      const winners = new Set<string>();
      const flashed = new Set<string>();
      for (const pid of atShowdown(hand)) atShow.add(person(pid));
      for (const pid of inByteOrder(hand.rank.keys())) winners.add(person(pid));
      // A single card shown, before or after the hand ended, is a courtesy reveal.
      for (const pid of inByteOrder(hand.shown.keys())) {
        if (shownCardCount(hand.shown.get(pid) ?? "") === 1) flashed.add(person(pid));
      }
      for (const k of flashed) rowFor(k).courtesyReveals++;
      for (const k of atShow) {
        const r = rowFor(k);
        r.showdowns++;
        if (!hand.bombPot) r.showdownsVoluntary++; // WTSD's flops leave bomb pots out too
        if (winners.has(k)) r.showdownWins++;
      }

      // Collected money per person, summed in account order.
      const collected = new Map<string, number>();
      for (const pid of inByteOrder(hand.collected.keys())) {
        bump(collected, person(pid), hand.collected.get(pid) ?? 0);
      }
      for (const k of inByteOrder(collected.keys())) {
        const c = collected.get(k) ?? 0;
        const r = rowFor(k);
        if (c > EPSILON_DOLLARS) r.handsWon++;
        r.wonTotal += c;
        r.biggestPotWon = r.biggestPotWon < c ? c : r.biggestPotWon;
      }
      for (const pid of inByteOrder(hand.net.keys())) {
        rowFor(person(pid)).netFromLog += hand.net.get(pid) ?? 0;
      }
      for (const pid of inByteOrder(hand.bounty.keys())) {
        rowFor(person(pid)).bountiesNet += hand.bounty.get(pid) ?? 0;
      }
    }
  }

  const out: StyleStats[] = [];
  for (const k of inByteOrder(rows.keys())) {
    const r = rows.get(k);
    if (r === undefined) continue;
    r.games = gamesOf.get(k)?.size ?? 0;
    r.wonTotalCents = centsOf(r.wonTotal);
    r.biggestPotWonCents = centsOf(r.biggestPotWon);
    r.netFromLogCents = centsOf(r.netFromLog);
    r.bountiesNetCents = centsOf(r.bountiesNet);
    out.push(r);
  }
  libcppSort(out, 0, out.length, (a, b) => {
    if (a.hands !== b.hands) return a.hands > b.hands;
    return compareBytes(a.displayName, b.displayName) < 0;
  });
  return out;
}

// One person's running net through a night, hand by hand, all accounts together.
export function nightSeries(
  log: HandLog,
  rules: MergeRules,
  ledgerStats: ReadonlyMap<string, PlayerStats>,
): NightSeries[] {
  const index = new Map<string, number>();
  const series: NightSeries[] = [];
  const running: number[] = [];
  const accounts: Set<string>[] = [];
  const n = log.hands.length;

  const seriesOf = (pid: string, at: Epoch): number => {
    const id = identify(log, pid, at, rules, ledgerStats);
    let i = index.get(id.key);
    if (i === undefined) {
      i = series.length;
      index.set(id.key, i);
      series.push({
        person: id.key,
        displayName: id.display,
        accounts: [],
        netByHand: new Array<number>(n).fill(Number.NaN),
        finalNet: 0,
        finalNetCents: 0,
      });
      running.push(0);
      accounts.push(new Set());
    }
    return i;
  };

  log.hands.forEach((hand, h) => {
    for (const pid of inByteOrder(hand.net.keys())) {
      const i = seriesOf(pid, hand.start);
      running[i] = (running[i] ?? 0) + (hand.net.get(pid) ?? 0);
    }
    for (const s of hand.seats) {
      const i = seriesOf(s.playerId, hand.start);
      const si = series[i];
      if (si !== undefined) si.netByHand[h] = running[i] ?? 0;
      accounts[i]?.add(s.nickname);
    }
  });
  series.forEach((s, i) => {
    s.finalNet = running[i] ?? 0;
    s.finalNetCents = centsOf(s.finalNet);
    s.accounts = inByteOrder(accounts[i] ?? []);
  });
  libcppSort(series, 0, series.length, (a, b) => a.finalNet > b.finalNet);
  return series;
}

// Card text with the suit symbols swapped for letters (s h d c), for consoles that cannot show them.
export function asciiCards(cards: string): string {
  let out = "";
  for (const ch of cards) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x2640 && cp <= 0x267f) {
      out += cp === 0x2660 ? "s" : cp === 0x2665 ? "h" : cp === 0x2666 ? "d" : cp === 0x2663 ? "c" : "?";
    } else {
      out += ch;
    }
  }
  return out;
}

// ---- the export ---------------------------------------------------------------------------

export const STYLE_CSV_HEADER =
  "player,normalized,games,hands,vpip_pct,pfr_pct,saw_flop_pct,wtsd_pct,wsd_pct,fold_to_raise_pct," +
  "aggression,hands_won,biggest_pot_won,net_from_log,bounties_net,all_ins,style," +
  "hit_run,hit_run_reliable,hit_run_tag,saw_flop,showdowns,showdowns_voluntary,showdown_wins,courtesy_reveals";

// The menu 18 export (Saved_Data/style_stats.csv): the header and one line per row, each ending in
// a newline. Money and percentages use two decimals, as printf writes them.
export function styleStatsCSV(rows: readonly StyleStats[]): string {
  let out = STYLE_CSV_HEADER + "\n";
  for (const r of rows) {
    const fields = [
      escapeCSV(r.displayName),
      escapeCSV(r.normalizedName),
      String(r.games),
      String(r.hands),
      fixed2(vpipPct(r)),
      fixed2(pfrPct(r)),
      fixed2(sawFlopPct(r)),
      fixed2(wtsdPct(r)),
      fixed2(wsdPct(r)),
      fixed2(foldToRaisePct(r)),
      fixed2(aggression(r)),
      String(r.handsWon),
      fixed2(r.biggestPotWon),
      fixed2(r.netFromLog),
      fixed2(r.bountiesNet),
      String(r.allIns),
      escapeCSV(styleLabel(r)),
      r.hitRun < 0 ? "" : fixed2(r.hitRun),
      r.hitRunReliable ? "yes" : "no",
      escapeCSV(r.hitRunTag),
      String(r.sawFlop),
      String(r.showdowns),
      String(r.showdownsVoluntary),
      String(r.showdownWins),
      String(r.courtesyReveals),
    ];
    out += fields.join(",") + "\n";
  }
  return out;
}
