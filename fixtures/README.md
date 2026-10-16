# Fixtures

`synthetic/` is made-up data in the same layout as the real folders (`Games/` and `Saved_Data/`).
Every name and id is invented: nicknames are `Zaqvin`-style words, ids are `FAKEid0001` and up,
ledger ids are `ledger_pglFAKE0001` and up. Write it again with `npm run fixtures`. The output is
the same every time (fixed seed, no clock).

The ids (`pglFAKE0001`) are shorter than the 10 characters after `pgl` the site asks of a
PokerNow id, so + Add game does not take these files from Downloads or a link. To try
that page, copy one under a longer made-up id (`ledger_pglMadeUpNight01.csv`).

`synthetic-reference/` is what the C++ app prints and writes for `synthetic/`
(`reference/run.sh`). Both are committed; see `reference/README.md`.

## Edge cases and where they are

| Case | Where |
| --- | --- |
| 3 folders | `Games/Synthetic Winter`, `Synthetic Spring`, `Synthetic Autumn` |
| 14 game ledgers | `ledger_pglFAKE0001` to `0015` (`0013` holds only never-played seats, so it is skipped) |
| Two nights with hand logs | `Games/Synthetic Autumn/poker_now_log_pglFAKE0014.csv` (cut short at 21:25, mid-hand) and `poker_now_log_pglFAKE0015.csv` (complete) |
| Hand-log specials | `0014`: a rebuy (Pethra), a bust-out (Morvak) in an all-in that runs twice, a player who leaves while up (Dorrig). `0015`: a bomb pot, a 7-2 bounty paid by three players, a player who leaves while up (Ulvane) |
| 6 to 25 seats per game | 6 seats in `0004`, 24 in `0011` (every seat counts, including never-played ones) |
| 22+ non-zero balances in one game | `0011`: 24 people, each with a non-zero total (the settlement's larger-group path) |
| Rebuys (several rows per player) | `0001` (Plenkor twice), `0003` (Zaqvin twice) |
| Alias chain a to b to c | `Saved_Data/merge_rules.csv`: `vextorq` to `vextor` to `vextorion` (account `FAKEid0070`) |
| Alias on a different spelling | `mariquenby` to `marisolquenby` (account `FAKEid0071`) |
| Digits-only nickname | `707070` (account `FAKEid0050`) |
| Emoji-only nicknames | `🃏🃏` (`FAKEid0051`) and `🎴` (`FAKEid0052`): the letters of both accounts are the same, so the app files them under one name |
| Same person on two accounts at once | `Rixmoot` on `FAKEid0013` and `FAKEid0027`, overlapping, in `0008` |
| One account, two people | `FAKEid0040`: Hespyre (usual) and Ombrix. `seat_owners.csv` has a reassigned Ombrix seat (`0010`), a "name is right" Hespyre seat (`0001`), and a saved entry for a ledger that is not loaded. The unchecked Ombrix seat in `0007` is flagged |
| Never-played seats | `Empty Seat` in `0002` (skipped, counted as a skipped row); `Games/Synthetic Winter/ledger_pglFAKE0013.csv` holds only those (the file is skipped with a message) |
| Identical duplicate in another folder | `Games/Synthetic Autumn/ledger_pglFAKE0004.csv` is the same as the Winter copy |
| Browser copy with less content | `Games/Synthetic Spring/ledger_pglFAKE0005 (1).csv` (the last three sit-downs missing) |
| Two ids sharing sit-downs | `0008` and `0009` (three identical sit-downs; both kept, flagged as overlap) |
| Game crossing local midnight | `0005`: starts 23:40 on 2026-03-14, ends 00:25 on 2026-03-15 (Eastern) |
| Game on the clock-change night | `0012`: 2026-11-01, sit-downs at 01:20 EDT and 01:20 EST (Eastern) |
| Deliberately unbalanced game | `0006`: nets add up to +$5.00 |
| Ties | two losers at exactly -$30.00 who play only `0004`: Tarvelle and Dulvane |
| Averages that land on a cent boundary | Ylmande (4 games, $0.50), Bexrunn (4 games, $1.50), Cavlorn (8 games, $5.00) |
| Name order in UTF-8 vs UTF-16 | `Quorin` and `🎲Brask` both paid on 2026-03-20 (sorted differently by bytes and by code units) |
| Commas and quotes in nicknames | `Harlo, Dromm` and `Quinn "Q" Varn` |
| New nickname on an old account | `Frymoss Two` on `FAKEid0026` |
| Payments and corrections | `Saved_Data/adjustments.csv`: a paired payment tagged with a folder, a paired one untagged, and a one-sided untagged correction |
| Pinned payments | `payment_preferences.csv`: one applies (biggest loser to biggest winner), one does not apply |
| Settings | `settings.csv`: `me` is `zaqvin`, no banker |
| Saved sheets | `session_balances.csv`: one open, one partial, one paid balance |

The two hand logs are made up as well. `tools/make-fixtures.ts` plays their hands out with the chips in
cents, so every stack line, pot and bounty adds up within the log (the parser counts no stack
mismatch). The log's stacks and pots are not the ledger's cash-outs, though: the logs test the code
paths (rebuy, bust-out, run it twice, bomb pot, bounty, cut-short night), not the money. The hand-log
exports (menus 18, 21, 22, and the playstyle tool) are written for `Synthetic Autumn` only, the one
folder with logs; the other two folders have none.
