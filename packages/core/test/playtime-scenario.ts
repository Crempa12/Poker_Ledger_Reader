// A made-up set of three game nights for the playtime and showdown tests. Every name and id is
// invented (Alpha, FAKEp1 ...), and every amount is made up. Used by playtime.test.ts and
// showdowns.test.ts, and read by the scratch generator that writes the same data for the C++ driver.
//
//   Game A  (logged, from hand 1): five hands with a 600-second break, a chop, and a player who joins.
//   Game B  (logged, cut short: the log starts at hand 3): the ledger seat time before hand 3 is
//           the estimate; "Echo" is another account of "Alpha" (merge rule echo -> alpha).
//   Game C  (no hand log): ledger seat time only, with an open seat that runs to the game's end.
//   Game D  (logged, one hand): the last hand gets the default 36 seconds.

import type { Game, LedgerRow } from "../src/models.ts";
import type { HandLogInput } from "../src/handlog.ts";
import type { MergeRules } from "../src/players.ts";

const DAY = "2031-05-06";

// Epoch seconds of a clock time on DAY (UTC).
export function epochAt(clock: string): number {
  return Date.parse(`${DAY}T${clock}Z`) / 1000;
}

// One log line and the clock time it was written at.
interface Entry {
  at: string;
  entry: string;
}

// Every line of one hand is written at the hand's clock time.
function hand(clock: string, lines: readonly string[]): Entry[] {
  return lines.map((entry) => ({ at: clock, entry }));
}

function csvField(s: string): string {
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// A PokerNow-style export: newest first, with an order column.
export function logText(entries: readonly Entry[]): string {
  const rows = entries.map((e, i) => {
    const at = new Date(Date.parse(`${DAY}T${e.at}Z`)).toISOString();
    return `${csvField(e.entry)},${at},${i + 1}`;
  });
  return ["entry,at,order", ...rows.reverse()].join("\n") + "\n";
}

// Game A: hands 1 to 5 at 03:00:00, 03:00:20, 03:00:50, 03:20:50 (after a 20-minute break), 03:21:10.
const LOG_A: Entry[] = [
  ...hand("03:00:00", [
    '-- starting hand #1 (id: FAKEh01) (dealer: "Alpha @ FAKEp1")',
    'Player stacks: #1 "Alpha @ FAKEp1" (100.00) | #2 "Bravo @ FAKEp2" (100.00) | #3 "Charlie @ FAKEp3" (100.00)',
    '"Bravo @ FAKEp2" posts a small blind of 0.50',
    '"Charlie @ FAKEp3" posts a big blind of 1.00',
    '"Alpha @ FAKEp1" raises to 3.00',
    '"Bravo @ FAKEp2" folds',
    '"Charlie @ FAKEp3" folds',
    'Uncalled bet of 2.00 returned to "Alpha @ FAKEp1"',
    '"Alpha @ FAKEp1" collected 2.50 from pot',
    "-- ending hand #1 --",
  ]),
  ...hand("03:00:20", [
    '-- starting hand #2 (id: FAKEh02) (dealer: "Bravo @ FAKEp2")',
    'Player stacks: #1 "Alpha @ FAKEp1" (100.00) | #2 "Bravo @ FAKEp2" (100.00) | #3 "Charlie @ FAKEp3" (100.00)',
    '"Charlie @ FAKEp3" posts a small blind of 0.50',
    '"Alpha @ FAKEp1" posts a big blind of 1.00',
    '"Bravo @ FAKEp2" calls 1.00',
    '"Charlie @ FAKEp3" calls 0.50',
    '"Alpha @ FAKEp1" checks',
    "Flop: [A♠, 9♦, 4♣]",
    '"Charlie @ FAKEp3" bets 2.00',
    '"Alpha @ FAKEp1" calls 2.00',
    '"Bravo @ FAKEp2" calls 2.00',
    "Turn: A♠, 9♦, 4♣ [2♥]",
    '"Charlie @ FAKEp3" checks',
    '"Alpha @ FAKEp1" checks',
    '"Bravo @ FAKEp2" checks',
    "River: A♠, 9♦, 4♣, 2♥ [7♠]",
    '"Charlie @ FAKEp3" checks',
    '"Alpha @ FAKEp1" checks',
    '"Bravo @ FAKEp2" checks',
    '"Charlie @ FAKEp3" shows a 9♣, 9♥.',
    '"Charlie @ FAKEp3" collected 9.00 from pot with Three of a Kind, 9\'s (combination: 9♣, 9♥, 9♦)',
    "-- ending hand #2 --",
    '"Alpha @ FAKEp1" shows a A♥, 5♥.',
  ]),
  ...hand("03:00:50", [
    '-- starting hand #3 (id: FAKEh03) (dealer: "Charlie @ FAKEp3")',
    'Player stacks: #1 "Alpha @ FAKEp1" (100.00) | #2 "Bravo @ FAKEp2" (100.00) | #3 "Charlie @ FAKEp3" (100.00)',
    '"Alpha @ FAKEp1" posts a small blind of 0.50',
    '"Bravo @ FAKEp2" posts a big blind of 1.00',
    '"Charlie @ FAKEp3" calls 1.00',
    '"Alpha @ FAKEp1" calls 0.50',
    '"Bravo @ FAKEp2" folds',
    "Flop: [10♠, J♦, Q♣]",
    "Turn: 10♠, J♦, Q♣ [K♥]",
    "River: 10♠, J♦, Q♣, K♥ [A♠]",
    '"Alpha @ FAKEp1" shows a 2♦, 3♣.',
    '"Charlie @ FAKEp3" shows a 4♦, 5♣.',
    '"Alpha @ FAKEp1" collected 1.50 from pot with Straight, Ace high (combination: 10♠, J♦, Q♣, K♥, A♠)',
    '"Charlie @ FAKEp3" collected 1.50 from pot with Straight, Ace high (combination: 10♠, J♦, Q♣, K♥, A♠)',
    "-- ending hand #3 --",
  ]),
  ...hand("03:20:50", [
    '-- starting hand #4 (id: FAKEh04) (dealer: "Alpha @ FAKEp1")',
    'Player stacks: #1 "Alpha @ FAKEp1" (100.00) | #2 "Bravo @ FAKEp2" (100.00) | #3 "Charlie @ FAKEp3" (100.00)',
    '"Bravo @ FAKEp2" posts a small blind of 0.50',
    '"Charlie @ FAKEp3" posts a big blind of 1.00',
    '"Alpha @ FAKEp1" raises to 3.00',
    '"Bravo @ FAKEp2" calls 2.50',
    '"Charlie @ FAKEp3" folds',
    "Flop: [7♥, 7♦, 3♠]",
    '"Bravo @ FAKEp2" checks',
    '"Alpha @ FAKEp1" bets 4.00',
    '"Bravo @ FAKEp2" calls 4.00',
    "Turn: 7♥, 7♦, 3♠ [K♣]",
    "River: 7♥, 7♦, 3♠, K♣ [K♦]",
    '"Bravo @ FAKEp2" checks',
    '"Alpha @ FAKEp1" checks',
    '"Bravo @ FAKEp2" shows a K♠, 4♠.',
    '"Bravo @ FAKEp2" collected 15.00 from pot with Full House, Kings over Sevens (combination: K♠, K♣, K♦, 7♥, 7♦)',
    "-- ending hand #4 --",
    '"Alpha @ FAKEp1" shows a 9♠, 9♥.',
  ]),
  ...hand("03:21:10", [
    '-- starting hand #5 (id: FAKEh05) (dealer: "Charlie @ FAKEp3")',
    'Player stacks: #1 "Alpha @ FAKEp1" (100.00) | #2 "Bravo @ FAKEp2" (100.00) | #3 "Charlie @ FAKEp3" (100.00) | #4 "Delta @ FAKEp4" (100.00)',
    '"Delta @ FAKEp4" posts a small blind of 0.50',
    '"Alpha @ FAKEp1" posts a big blind of 1.00',
    '"Bravo @ FAKEp2" folds',
    '"Charlie @ FAKEp3" calls 1.00',
    '"Delta @ FAKEp4" calls 0.50',
    '"Alpha @ FAKEp1" folds',
    "Flop: [J♣, 8♦, 2♥]",
    '"Delta @ FAKEp4" checks',
    '"Charlie @ FAKEp3" checks',
    "Turn: J♣, 8♦, 2♥ [4♣]",
    '"Delta @ FAKEp4" checks',
    '"Charlie @ FAKEp3" checks',
    "River: J♣, 8♦, 2♥, 4♣ [6♠]",
    '"Delta @ FAKEp4" checks',
    '"Charlie @ FAKEp3" checks',
    '"Delta @ FAKEp4" shows a J♦, J♥.',
    '"Charlie @ FAKEp3" shows a A♣, K♣.',
    '"Delta @ FAKEp4" collected 3.00 from pot with Pair, J\'s (combination: J♦, J♥, J♣)',
    "-- ending hand #5 --",
  ]),
];

// Game B: the log starts at hand 3 (PokerNow cut the first two hands). Echo is Alpha's second account.
const LOG_B: Entry[] = [
  ...hand("04:00:00", [
    '-- starting hand #3 (id: FAKEh03) (dealer: "Echo @ FAKEp5")',
    'Player stacks: #1 "Alpha @ FAKEp1" (100.00) | #2 "Bravo @ FAKEp2" (100.00) | #3 "Echo @ FAKEp5" (100.00)',
    '"Alpha @ FAKEp1" posts a small blind of 0.50',
    '"Bravo @ FAKEp2" posts a big blind of 1.00',
    '"Echo @ FAKEp5" calls 1.00',
    '"Alpha @ FAKEp1" calls 0.50',
    '"Bravo @ FAKEp2" checks',
    "Flop: [A♣, 5♦, 9♥]",
    '"Alpha @ FAKEp1" checks',
    '"Bravo @ FAKEp2" bets 2.00',
    '"Echo @ FAKEp5" calls 2.00',
    '"Alpha @ FAKEp1" calls 2.00',
    "Turn: A♣, 5♦, 9♥ [2♠]",
    "River: A♣, 5♦, 9♥, 2♠ [3♥]",
    '"Bravo @ FAKEp2" shows a A♠, A♦.',
    '"Bravo @ FAKEp2" collected 9.00 from pot with Three of a Kind, A\'s (combination: A♠, A♦, A♣)',
    "-- ending hand #3 --",
    '"Echo @ FAKEp5" shows a J♥, 10♥.',
    '"Alpha @ FAKEp1" shows a K♠, Q♦.',
  ]),
  ...hand("04:00:40", [
    '-- starting hand #4 (id: FAKEh04) (dealer: "Bravo @ FAKEp2")',
    'Player stacks: #1 "Alpha @ FAKEp1" (100.00) | #2 "Bravo @ FAKEp2" (100.00)',
    '"Bravo @ FAKEp2" posts a small blind of 0.50',
    '"Alpha @ FAKEp1" posts a big blind of 1.00',
    '"Bravo @ FAKEp2" calls 0.50',
    '"Alpha @ FAKEp1" checks',
    "Flop: [K♥, K♣, 4♦]",
    '"Bravo @ FAKEp2" checks',
    '"Alpha @ FAKEp1" bets 1.00',
    '"Bravo @ FAKEp2" calls 1.00',
    "Turn: K♥, K♣, 4♦ [2♦]",
    "River: K♥, K♣, 4♦, 2♦ [8♠]",
    '"Bravo @ FAKEp2" checks',
    '"Alpha @ FAKEp1" checks',
    '"Bravo @ FAKEp2" shows a Q♠, Q♥.',
    '"Alpha @ FAKEp1" shows a K♦, 9♠.',
    '"Alpha @ FAKEp1" collected 4.00 from pot with Three of a Kind, K\'s (combination: K♦, K♥, K♣)',
    "-- ending hand #4 --",
  ]),
  ...hand("04:01:10", [
    '-- starting hand #5 (id: FAKEh05) (dealer: "Alpha @ FAKEp1")',
    'Player stacks: #1 "Alpha @ FAKEp1" (100.00) | #2 "Bravo @ FAKEp2" (100.00) | #3 "Echo @ FAKEp5" (100.00)',
    '"Bravo @ FAKEp2" posts a small blind of 0.50',
    '"Echo @ FAKEp5" posts a big blind of 1.00',
    '"Alpha @ FAKEp1" raises to 2.00',
    '"Bravo @ FAKEp2" folds',
    '"Echo @ FAKEp5" folds',
    'Uncalled bet of 1.00 returned to "Alpha @ FAKEp1"',
    '"Alpha @ FAKEp1" collected 2.50 from pot',
    "-- ending hand #5 --",
  ]),
  ...hand("04:01:50", [
    '-- starting hand #6 (id: FAKEh06) (dealer: "Bravo @ FAKEp2")',
    'Player stacks: #1 "Alpha @ FAKEp1" (100.00) | #2 "Bravo @ FAKEp2" (100.00) | #3 "Charlie @ FAKEp3" (100.00)',
    '"Charlie @ FAKEp3" posts a small blind of 0.50',
    '"Alpha @ FAKEp1" posts a big blind of 1.00',
    '"Bravo @ FAKEp2" calls 1.00',
    '"Charlie @ FAKEp3" calls 0.50',
    '"Alpha @ FAKEp1" checks',
    "Flop: [Q♠, J♠, 10♠]",
    "Turn: Q♠, J♠, 10♠ [K♠]",
    "River: Q♠, J♠, 10♠, K♠ [2♣]",
    "All players in hand choose to run it twice",
    '"Alpha @ FAKEp1" shows a A♠, 3♥.',
    '"Charlie @ FAKEp3" shows a 2♦, 3♦.',
    '"Bravo @ FAKEp2" shows a K♣, K♥.',
    '"Alpha @ FAKEp1" collected 1.50 from pot with Royal Flush (combination: A♠, K♠, Q♠, J♠, 10♠)',
    '"Bravo @ FAKEp2" collected 1.50 from pot with Pair, Kings (combination: K♣, K♥, K♠)',
    "-- ending hand #6 --",
    '"Charlie @ FAKEp3" paid 1.00 for the 7-2 bounty to "Bravo @ FAKEp2"',
  ]),
];

// Game C has no hand log.

// Game D: one hand only, so the last hand gets the default length.
const LOG_D: Entry[] = hand("05:10:00", [
  '-- starting hand #1 (id: FAKEh01) (dealer: "Foxtrot @ FAKEp6")',
  'Player stacks: #1 "Alpha @ FAKEp1" (100.00) | #2 "Foxtrot @ FAKEp6" (100.00)',
  '"Alpha @ FAKEp1" posts a small blind of 0.50',
  '"Foxtrot @ FAKEp6" posts a big blind of 1.00',
  '"Alpha @ FAKEp1" folds',
  'Uncalled bet of 0.50 returned to "Foxtrot @ FAKEp6"',
  '"Foxtrot @ FAKEp6" collected 1.00 from pot',
  "-- ending hand #1 --",
]);

export const SCENARIO_GAME_IDS = {
  a: "ledger_FAKEgA",
  b: "ledger_FAKEgB",
  c: "ledger_FAKEgC",
  d: "ledger_FAKEgD",
} as const;

function row(nickname: string, playerId: string, start: string | null, end: string | null): LedgerRow {
  return {
    nickname,
    playerId,
    start: start === null ? null : epochAt(start),
    end: end === null ? null : epochAt(end),
    buyInCents: 10000,
    buyOutCents: 0,
    stackCents: 0,
    netCents: -10000,
    owner: "",
    ownerReviewed: false,
  };
}

function game(id: string, folder: string, start: string, end: string, rows: LedgerRow[]): Game {
  return {
    id,
    path: `${id}.csv`,
    folder,
    start: epochAt(start),
    end: epochAt(end),
    totalBuyInCents: rows.length * 10000,
    skippedRows: 0,
    rows,
  };
}

// The three nights, in the order a caller would pass them (the order of the app's scope).
export const SCENARIO_GAMES: Game[] = [
  game(SCENARIO_GAME_IDS.a, "(root)", "02:59:00", "03:25:00", [
    row("Alpha", "FAKEp1", "02:59:00", "03:25:00"),
    row("Bravo", "FAKEp2", "03:00:00", "03:25:00"),
    row("Charlie", "FAKEp3", "03:00:00", "03:25:00"),
    row("Delta", "FAKEp4", "03:21:00", "03:25:00"),
  ]),
  game(SCENARIO_GAME_IDS.b, "(root)", "03:40:00", "04:30:00", [
    row("Alpha", "FAKEp1", "03:50:00", "04:30:00"),
    row("Bravo", "FAKEp2", "03:40:00", "03:58:00"),
    row("Echo", "FAKEp5", "03:55:00", null),
  ]),
  game(SCENARIO_GAME_IDS.c, "(root)", "04:30:00", "05:00:00", [
    row("Charlie", "FAKEp3", "04:30:00", "05:00:00"),
    row("Foxtrot", "FAKEp6", "04:40:00", null),
    row("Alpha", "FAKEp1", "04:30:00", "04:45:00"),
    row("Alpha", "FAKEp1", "04:40:00", "04:50:00"),
    row("Delta", "FAKEp4", null, null),
  ]),
  game(SCENARIO_GAME_IDS.d, "(root)", "05:09:00", "05:20:00", [
    row("Foxtrot", "FAKEp6", "05:09:00", "05:20:00"),
    row("Alpha", "FAKEp1", "05:09:30", "05:20:00"),
  ]),
];

// The hand logs, by file name. Games C has none.
export const SCENARIO_LOGS: HandLogInput[] = [
  { relativePath: "poker_now_log_FAKEgA.csv", text: logText(LOG_A) },
  { relativePath: "poker_now_log_FAKEgB.csv", text: logText(LOG_B) },
  { relativePath: "poker_now_log_FAKEgD.csv", text: logText(LOG_D) },
];

// Echo is another account of Alpha.
export const SCENARIO_RULES: MergeRules = new Map([["echo", "alpha"]]);
