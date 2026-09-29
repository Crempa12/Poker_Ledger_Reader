#pragma once
// Playtime: how long each person was actually at the table (docs/specs/playtime-showdown.md).
//
// The hand log is the measure. A ledger seat stays open while its player sits out, walks away or
// waits for the game to break, so over the 248 player-nights the September logs deal, the ledger
// shows 1,343 hours where the players were dealt in for 787: a median 1.34x, and 4.8x at the 90th
// percentile. So a hand's length is the time until the next hand starts, and a person's time is
// the length of every hand they were dealt.
//
// Where there is no log to measure (a night without one, or the start of a night whose log
// PokerNow cut short), the ledger's seat times stand in, marked as an estimate.
#include <map>
#include <string>
#include <vector>

#include "handlog.hpp"
#include "models.hpp"
#include "players.hpp"

namespace playtime {

// --- Tunables (see playtime.cpp for why each value) --------------------------
extern const double kMaxHandSeconds;       // a longer gap between two hands is a break, not a hand
extern const double kDefaultHandSeconds;   // a hand's length when the night gives nothing to go on

// One person's time on one night.
struct Night {
    std::string gameId;
    std::string person;              // canonical name (the key the leaderboard uses)
    bool logged = false;             // the night has a hand log
    int hands = 0;                   // hands dealt to them in the log
    double secondsDealt = 0.0;       // the length of those hands
    double secondsEstimated = 0.0;   // ledger seat time the log cannot measure
};

// Every person's time on every game given. Games with a hand log are measured hand by hand;
// games without one fall back on the ledger's seat times.
std::vector<Night> nights(const std::vector<const Game*>& games,
                          const std::map<std::string, handlog::HandLog>& logs,
                          const players::MergeRules& rules);

// The nights added up per person.
std::map<std::string, PlayTime> summarize(const std::vector<Night>& nights);

// nights() then summarize().
std::map<std::string, PlayTime> collect(const std::vector<const Game*>& games,
                                        const std::map<std::string, handlog::HandLog>& logs,
                                        const players::MergeRules& rules);

// "12.4 h", or "~12.4 h" when any of it is an estimate.
std::string hoursText(const PlayTime& t);

// The "At the table" block under a player's history (menu 3). `t` may be null.
void printPlayer(const PlayerStats& p, const PlayTime* t);

}  // namespace playtime
