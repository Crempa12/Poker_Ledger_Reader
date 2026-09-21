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

// Chips put on the table between hands: a rebuy after busting, or an admin top-up.
struct StackEvent {
    std::int64_t at = util::NO_TIME;
    int hand = 0;             // index of the first hand dealt after it (may equal hands.size())
    std::string playerId;
    std::string kind;         // "rebuy", "topup", or "remove" (an admin took chips off)
    double amount = 0.0;      // dollars, always positive
};

// One ledger seat on an account: who was really playing it, and when.
struct SeatWindow {
    std::int64_t start = util::NO_TIME;
    std::int64_t end = util::NO_TIME;   // NO_TIME = still seated when the ledger was exported
    std::string person;                 // canonical name
};

struct HandLog {
    std::string gameId;                         // "pgl..." (the ledger's id without the "ledger_" prefix)
    std::string path;
    std::string folder;
    std::vector<Hand> hands;                    // chronological
    std::vector<StackEvent> events;             // chronological
    std::map<std::string, std::string> names;   // playerId -> last nickname seen
    // playerId -> that account's seats in the paired ledger, with menu 20 owners and merge rules applied.
    // Empty when the ledger is not loaded; the nickname then decides who a player is.
    std::map<std::string, std::vector<SeatWindow>> seats;
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

// Fills log.seats from the ledger of the same game (call again whenever seat owners or merge rules change).
void pairWithLedger(HandLog& log, const Game& game, const players::MergeRules& rules);

// Who was really playing an account at a moment: the owner of the ledger seat on that
// account covering the time (or the nearest one), else the log nickname after merge rules.
std::string personAt(const HandLog& log, const std::string& playerId, std::int64_t at, const players::MergeRules& rules);

// The name to show for that person: their leaderboard name when they have one.
std::string displayNameAt(const HandLog& log, const std::string& playerId, std::int64_t at,
                          const players::MergeRules& rules,
                          const std::map<std::string, PlayerStats>& ledgerStats);

// One row per person: every account they played on is folded in, and a shared account
// is split by who held each seat.
std::vector<StyleStats> computeStyle(const std::vector<const HandLog*>& logs,
                                     const players::MergeRules& rules,
                                     const std::map<std::string, PlayerStats>& ledgerStats);

// One person's running net through a night, hand by hand (NaN = not seated), all accounts combined.
struct NightSeries {
    std::string person;                  // canonical name
    std::string displayName;
    std::vector<std::string> accounts;   // nicknames of the accounts they played on
    std::vector<double> netByHand;       // size = hands
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
