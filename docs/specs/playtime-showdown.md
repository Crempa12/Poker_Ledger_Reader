# Spec: playtime, "beaten at showdown by", and the hand-log stat fixes

Status: approved 2026-09-25 ("yes, and fix everything"). Written before the code so the
definitions can be checked independently: `tools/validate.py` recomputes every number below
from the raw CSVs and compares it with the app's exports.

Measured on the 21 hand logs in `Games/Sept 2026` (14,281 hands) unless stated otherwise.

---

## 0. Shared rules (unchanged, restated so the checks can mirror them)

- **Pairing.** A hand log `poker_now_log_<id>.csv` belongs to the ledger `ledger_<id>.csv`. Browser
  copies (`... (1).csv`) are cut at the first space. Two logs for one id: the one with more hands
  wins. A log counts only when its ledger game is in scope.
- **Hands.** Entries are sorted by `order`. A hand runs from `-- starting hand #N` to the next
  `-- starting hand`. The lines between `-- ending hand #N --` and the next start (reveals, 7-2
  bounties) belong to hand N. Timestamps are ISO-8601 UTC truncated to whole seconds.
- **Seated.** The accounts listed on the hand's `Player stacks:` line.
- **Person.** Who played account `pid` in a hand that started at `t`: if the paired ledger has seats
  on `pid`, the seat whose `[start, end]` covers `t` (open end = forever), else the nearest one by
  time gap (first in file order on ties); the person is that seat's menu 20 owner, else its
  nickname, after merge rules (an emoji-only nickname is filed as `unnamed<account letters>`).
  Without ledger seats: the account's **last** nickname in the whole log, after merge rules; if that
  normalizes to nothing, the person is `@<pid>`. One person on two accounts in one hand is one
  person in that hand.
- **Folded.** An account folded in a hand if it has a `folds` action on any street.
- **Bomb pot.** A hand with any `(bomb pot bet)` line.
- **Position.** The seated accounts sorted by seat number give each a seat **index** 0..n-1 (the
  arithmetic below is on these indexes, mod n, never on PokerNow's seat numbers, which have gaps);
  a seat number listed twice leaves the whole hand unknown. The button is the dealer's index when
  the dealer is seated; else, heads-up, the index of the account that posted the live small blind;
  else the live big blind's index minus 2 (heads-up: the other index, see #8); else the live small
  blind's index minus 1; else unknown. Live blinds are `posts a small blind` / `posts a big blind`,
  never `missing small blind` or `missed big blind`; bomb pots post no blinds at all. With
  offset = (index - button index) mod n, checked in this order: heads-up 0 = BTN, 1 = BB;
  otherwise 0 = BTN, 1 = SB, 2 = BB, n-1 = CO, 3 = UTG, anything else MP. (All 174 dead-button
  hands in this corpus are 3+ handed and resolve through the big-blind branch.)

## 1. Showdowns (fixes review findings #1, #2, #9)

**The bug.** A player counted as "at showdown" only if they tabled both cards before the end
marker. Losers who muck, or who show after `-- ending hand`, were never counted: 2,264 of 9,062
showdown seats (25%, about half of all showdown losers). Pool-wide W$SD read 68.4%; the true value
is 51.3%.

**Definitions.**

- A hand **reached showdown** when PokerNow names a winning hand (`collected N from pot with ...`),
  or when at least two accounts that never folded tabled both their cards before the end marker.
  (In this corpus every such hand also names a winner.)
- **At showdown**: every seated account that never folded, in a hand that reached showdown. As a
  person: anyone with at least one such account.
- **Showdown winner**: an account with a `collected N from pot with ...` line (either run, either
  board, any pot). As a person: anyone with at least one.
- **Shown cards** accumulate per account across every `shows a ...` line of the hand, before and
  after the end marker ("shows a K♥." then "shows a K♠." is two cards). Duplicate cards count once.
- **Courtesy reveal**: an account whose accumulated shown cards for the hand total exactly one.
  Counted once per person per hand.
- **Tabled at showdown**: a person at showdown with an account whose accumulated shown cards total
  two or more.

**Stats that change.**

| Stat | Numerator | Denominator |
|---|---|---|
| WTSD (menus 18, 21) | at showdown, non-bomb-pot hands | saw the flop, non-bomb-pot hands |
| W$SD (menus 18, 21) | showdown winner | at showdown (every hand, bomb pots included) |

Bomb pots stay out of WTSD because they are already out of "saw the flop" (finding #2: 59
bomb-pot showdowns were counted on top of a denominator that excluded them). They stay in W$SD: a
showdown is a showdown.

## 2. Preflop and flop situational rates (fixes #3, #4, #5, #6)

All of these skip bomb-pot hands entirely. "Voluntary action" = fold, check, call, bet or raise
(never a post). "First decision" = a person's first voluntary action of the hand on that street.

- **Unopened pot**: no voluntary call, bet or raise has happened yet preflop (posts do not open it).
- **Limp** (finding #3): opportunity = a first preflop decision made while the pot is unopened;
  made = it is a call. Before the fix, spots after someone had already limped and the big blind's
  option were counted as opportunities.
- **Open raise** (finding #3): same opportunities; made = it is a raise. Raises over limpers are no
  longer "raised first in".
- **Steal**: same opportunities, restricted to CO, BTN and SB; made = raise. (Unchanged.)
- **3-bet, fold to open, blind defend, fold to 3-bet**: unchanged.
- **C-bet** (finding #5): the preflop aggressor is the last preflop raiser, and must see the flop.
  Opportunity = the aggressor's first flop action happens before anyone has bet the flop; made =
  it is a bet. A raiser who is bet into first (a donk bet) had no c-bet chance.
- **Donk bet** (finding #6): opportunity = a flop player other than the aggressor whose first flop
  action comes before the aggressor's first flop action, with no bet yet on the flop; made = it is
  a bet. (Before: the bet itself added no opportunity, and bets made after the raiser checked
  counted as donks.) Only in hands with an aggressor who saw the flop.
- **Fold to c-bet**: unchanged.
- **Check-raise** (finding #4): on each of the flop, turn and river, opportunity = a person acts
  again (fold, call or raise) on a street after checking on it (which only happens when someone bet
  behind them: no account ever checks twice on one street in this corpus), counted once per person
  per street; made = that action is a raise. Before: every check was an opportunity.

## 3. Smaller parse fixes (#7, #8)

- **#7 Stack check.** The "did this hand reconcile" check (`*N` in menu 18) expects the next
  hand's stack to be at least this hand's stack plus its net. It now also subtracts chips the admin
  removed between the two hands ("updated the player ... stack from 60.00 to 20.00"). There are 9
  such removals in this corpus; each used to flag a correct hand.
- **#8 Heads-up position.** With no dealer named and no small-blind post in a two-handed hand, the
  button is the seat that is **not** the big blind (was: the big blind itself).

## 4. Playtime

**Why the hand log.** Over 248 logged player-nights: time dealt into hands 787 h, first to last
hand 1,070 h, ledger seat time 1,343 h. A ledger seat stays open while its player sits out: the
ledger shows a median 1.34x, and at the 90th percentile 4.8x, the time the player was actually
dealt in.

**A hand's length** = seconds from its start to the next hand's start, capped at
`kMaxHandSeconds = 600` (10 of 14,260 gaps are longer: breaks, not play). The last hand of a night
gets the median of that night's gaps between consecutive hands (the mean of the two middle values
for an even count), capped the same way; a night of one hand gets `kDefaultHandSeconds = 36` (the
corpus median gap).

**Per person per logged night:**
- `hands_dealt` = hands where they were seated (once per hand, however many accounts).
- `seconds_dealt` = sum of those hands' lengths.
- `seconds_estimated` = for a log that starts late (its first hand number is above 1), the time
  the person was seated in the ledger before the log's first hand: the union of their ledger seat
  windows (open end = forever) clipped to end at the first logged hand's start. Otherwise 0.

**Per person per night without a hand log:** `seconds_estimated` = the length of the union of
their ledger seat windows. A seat with no start time is skipped; a seat with no end time ends at
the game's end (the latest end time, or start time when it has none, across the ledger's rows).

**Per person in scope:** the sums of the above; `nights_logged` = nights with a log where they
were dealt at least one hand; `hours` = (`seconds_dealt` + `seconds_estimated`) / 3600;
`per_hour` = poker net (the leaderboard's total, no payments or corrections) / `hours`, blank when
there is under a second of time. On screen, hours that include any estimate are marked `~`.

## 5. Beaten at showdown by

For every hand that reached showdown (bomb pots included):

- **Losers** = people at showdown who are not showdown winners.
- Each loser was **beaten by** each winner in that hand, once.
- **Money in a hand.** Call, bet and raise amounts are what the player has in on that street in
  total, so each adds only the step up from what they already had in; live blinds work the same
  way (a returning player who posts the small blind and then a missed big blind is in for the big
  blind, not both); a dead small blind ("posts a missing small blind") is extra money that does not
  count toward calling. Checked against the next hand's stacks.
- **Amount** = the loser's loss in the hand, not counting 7-2 bounties
  (`-(net - bounty)` summed over their accounts, floored at 0), split between the winners in
  proportion to what each collected in the hand (`collected N from pot`, all lines).
- A person never beats themselves (two accounts, one wins and one loses: no pair).
- Chops, and run-it-twice or double-board hands where both players collect something, have no
  loser between those players.
- **Known limit:** a player who wins a side pot but loses the main pot is a winner, so they are not
  recorded as beaten by the main-pot winner (at most 28 of 4,310 showdowns in this corpus).
  PokerNow words side pots and chops identically (`collected N from pot with ...`, never "side
  pot"), and only the second run or board is labelled, so the pot structure cannot be read from
  the text; the split by what each winner collected does not need it. In 108 of 271 run-it-twice or
  two-board showdowns the two runs have different winners.

**Ranking:** the rivals who beat a player most often, then by amount, then by name;
`kTopRivals = 5` are shown.

## 6. Where it shows

- **Menu 3 (player history)**, under the chart: "At the table" (hours, per night, hands, $/hour,
  how many nights are measured from a hand log and how much is estimated) and "Beaten at showdown
  by" (the top `kTopRivals` with times and amount, plus showdowns won and lost in scope).
- **Menu 12** writes `player_summary.csv` with six columns appended:
  `hands_dealt,nights_logged,seconds_dealt,seconds_estimated,hours,per_hour`
  (`seconds_*` and `hours` to 2 decimals, `per_hour` to 2 decimals or blank), and a new
  `Saved_Data/showdown_rivals.csv`:
  `loser,loser_normalized,winner,winner_normalized,times,amount`, one row per pair with
  `times >= 1`, sorted by `loser_normalized`, then times descending, then `winner_normalized`
  (the keys, not the display names, so the order never changes when a nickname does).
- **Menu 18** `style_stats.csv` gains five count columns at the end:
  `saw_flop,showdowns,showdowns_voluntary,showdown_wins,courtesy_reveals`.
- **Menu 21** `playstyle.csv` gains a `normalized` column at the end (the person key), so rows can
  be matched without relying on display names.
- **HTML report**: the leaderboard table gains Hours and $/hr columns.

## 7. Knobs

| Name | Value | Where | Why |
|---|---|---|---|
| `kMaxHandSeconds` | 600 | playtime.cpp | a longer gap is a break; 10 of 14,260 gaps exceed it |
| `kDefaultHandSeconds` | 36 | playtime.cpp | the corpus median gap between hands |
| `kTopRivals` | 5 | showdowns.cpp | as requested |

## 8. Checks (`tools/validate.py`, section 9)

Recomputed from the raw logs, ledgers, merge rules and seat owners, for the whole-corpus scope:

1. `style_stats.csv`: every person's `saw_flop`, `showdowns`, `showdowns_voluntary`,
   `showdown_wins`, `courtesy_reveals` exactly; pool W$SD printed (expected about 51%).
2. `playstyle.csv`: every person's limp, open, steal, c-bet, donk, check-raise, WTSD and W$SD made
   and opportunity counts exactly (made = round(pct x n / 100)).
3. `showdown_rivals.csv`: every pair's `times` exactly and `amount` within a cent (a loss split
   between winners is a fraction of a cent per share); no pair missing or extra.
4. `player_summary.csv`: `hands_dealt` and `nights_logged` exactly, `seconds_dealt` and
   `seconds_estimated` within 1 second, `per_hour` within $0.01.
