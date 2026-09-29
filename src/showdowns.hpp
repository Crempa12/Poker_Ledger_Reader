#pragma once
// Who beats whom at showdown (docs/specs/playtime-showdown.md, section 5).
//
// In every hand that reached showdown, the people still in it split into winners (PokerNow named
// their hand when they collected) and losers (everyone else still in, whether they tabled their
// cards or mucked). Each loser was beaten by each winner once, and lost to them their loss in the
// hand, split between the winners by what each collected. A chop, or a run-it-twice or two-board
// hand where both players collect, has no loser between them.
//
// Known limit: a player who wins a side pot but loses the main pot is a winner, so they are not
// counted as beaten by the main-pot winner (at most 28 of 4,310 showdowns in the September logs).
#include <map>
#include <string>
#include <vector>

#include "handlog.hpp"
#include "models.hpp"
#include "players.hpp"

namespace showdowns {

extern const int kTopRivals;   // rivals shown on a player's page

struct Rival {
    std::string person;         // canonical name
    std::string displayName;
    int times = 0;              // showdowns they won that this player lost
    double amount = 0.0;        // dollars this player lost to them in those hands
};

struct Record {
    std::string person;
    std::string displayName;
    int showdowns = 0;          // hands they reached showdown in (bomb pots included, as in W$SD)
    int won = 0;                // ... and collected at
    int lost = 0;               // ... and collected nothing at
    double lostAmount = 0.0;    // dollars lost in the hands they lost at showdown
    std::vector<Rival> beatenBy;   // most times first, then most money, then name
};

// One record per person who reached a showdown in the logs given.
std::map<std::string, Record> compute(const std::vector<const handlog::HandLog*>& logs,
                                      const players::MergeRules& rules,
                                      const std::map<std::string, PlayerStats>& ledgerStats);

// "Beaten at showdown by" under a player's history (menu 3). `r` may be null.
// `logged` / `nights` = games in scope with a hand log / all games in scope.
void printPlayer(const std::string& displayName, const Record* r, int logged, int nights);

// Every (loser, winner) pair: loser,loser_normalized,winner,winner_normalized,times,amount.
bool exportCSV(const std::string& filename, const std::map<std::string, Record>& records);

}  // namespace showdowns
