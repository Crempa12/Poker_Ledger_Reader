#pragma once
// PokerNow hand logs ("poker_now_log_<gameId>.csv"): every hand of a night with
// each player's actions, the board, showdown cards, and the stacks at the start
// of every hand. Paired with the ledger of the same game id.
#include <cstdint>
#include <filesystem>
#include <map>
#include <string>
#include <vector>

#include "models.hpp"
#include "players.hpp"

namespace handlog {

struct Seat {
    int seat = 0;
    std::string playerId;
    std::string nickname;
    double stack = 0.0;     // at the start of the hand
};

struct Action {
    std::string playerId;
    std::string street;     // preflop, flop, turn, river
    std::string kind;       // post, fold, check, call, bet, raise
    double amount = 0.0;    // "to" amount for call/bet/raise, blind size for post
    bool allIn = false;
};

struct Hand {
    int number = 0;
    std::string id;
    std::int64_t start = util::NO_TIME;
    std::string dealerId;
    std::vector<Seat> seats;                    // in seat order
    std::string myCards;                        // "K♦, 9♠" (the exporting player's hole cards)
    std::vector<std::string> board;             // up to 5 cards
    std::vector<Action> actions;
    std::map<std::string, std::string> shown;   // playerId -> cards shown at showdown
    std::map<std::string, double> collected;    // playerId -> total collected from the pot
    std::map<std::string, double> net;          // playerId -> collected + returned - contributed
    std::map<std::string, std::string> rank;    // playerId -> winning hand name ("Pair, J's")
    std::map<std::string, double> bounty;       // playerId -> 7-2 bounty received (+) or paid (-), already included in net
    bool showdown = false;
    bool runItTwice = false;
    double pot = 0.0;                           // total collected in the hand

    const Seat* seatOf(const std::string& playerId) const;
};

struct HandLog {
    std::string gameId;                         // "pgl..." (the ledger's id without the "ledger_" prefix)
    std::string path;
    std::string folder;
    std::vector<Hand> hands;                    // chronological
    std::map<std::string, std::string> names;   // playerId -> last nickname seen
    std::map<std::string, std::string> owners;  // playerId -> real owner when the ledger seats were reassigned (menu 20)
    std::int64_t start = util::NO_TIME;
    std::int64_t end = util::NO_TIME;
    double biggestPot = 0.0;
    std::string biggestPotWinner;               // playerId
    int biggestPotHand = 0;
    int stackMismatches = 0;                    // hands whose computed net did not match the next stack (after buy-ins)
};

// Recursively finds every poker_now_log_*.csv under root (same exclusions as ledgers).
std::vector<std::filesystem::path> discoverLogFiles(const std::filesystem::path& root);

bool parseLogFile(const std::filesystem::path& file, const std::filesystem::path& root, HandLog& out, std::string& error);

// Loads every log under root, keyed by game id. Messages report unreadable files.
std::map<std::string, HandLog> loadAllLogs(const std::filesystem::path& root, std::vector<std::string>& messages);

// Playing-style numbers for one player, aggregated over the logs given.
struct StyleStats {
    std::string displayName;
    std::string normalizedName;     // canonical (after merge rules)
    int games = 0;
    int hands = 0;                  // hands dealt in
    int vpip = 0;                   // voluntarily put money in preflop
    int pfr = 0;                    // raised preflop
    int sawFlop = 0;
    int showdowns = 0;
    int showdownWins = 0;
    int handsWon = 0;
    int facedRaise = 0;             // preflop decisions facing a raise
    int foldedToRaise = 0;
    int bets = 0, raises = 0, calls = 0;   // postflop only
    int allIns = 0;
    double wonTotal = 0.0;          // sum collected
    double netFromLog = 0.0;        // sum of per-hand nets (should equal the ledger net for the same games)
    double biggestPotWon = 0.0;
    double bountiesNet = 0.0;       // 7-2 bounties received minus paid (part of netFromLog)

    double pct(int part, int whole) const { return whole == 0 ? 0.0 : 100.0 * part / whole; }
    double vpipPct() const { return pct(vpip, hands); }
    double pfrPct() const { return pct(pfr, hands); }
    double sawFlopPct() const { return pct(sawFlop, hands); }
    double wtsdPct() const { return pct(showdowns, sawFlop); }
    double wsdPct() const { return pct(showdownWins, showdowns); }
    double foldToRaisePct() const { return pct(foldedToRaise, facedRaise); }
    double aggression() const { return calls == 0 ? (bets + raises > 0 ? 99.0 : 0.0) : double(bets + raises) / calls; }
    std::string styleLabel() const;
};

// Folds nicknames with the merge rules so the same person is one row.
std::vector<StyleStats> computeStyle(const std::vector<const HandLog*>& logs,
                                     const players::MergeRules& rules,
                                     const std::map<std::string, PlayerStats>& ledgerStats);

// One player's running net through a night, hand by hand (NaN = not seated).
struct NightSeries {
    std::string playerId;
    std::string displayName;
    std::vector<double> netByHand;   // size = hands
    double finalNet = 0.0;
};
std::vector<NightSeries> nightSeries(const HandLog& log,
                                     const players::MergeRules& rules,
                                     const std::map<std::string, PlayerStats>& ledgerStats);

// Card text with suit symbols swapped for letters, for consoles that cannot show them.
std::string asciiCards(const std::string& cards);

void printStyleTable(const std::vector<StyleStats>& rows);
void printGameSummaries(const std::vector<const HandLog*>& logs);
bool exportStyleCSV(const std::string& filename, const std::vector<StyleStats>& rows);

}  // namespace handlog
