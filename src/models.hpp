#pragma once
// Plain data structures shared by every module.
#include <cstdint>
#include <set>
#include <string>
#include <vector>

#include "util.hpp"

// One line of a ledger CSV: a single buy-in / sit-down by one player.
struct LedgerRow {
    std::string nickname;
    std::string playerId;
    std::int64_t start = util::NO_TIME;
    std::int64_t end = util::NO_TIME;
    double buyIn = 0.0;
    double buyOut = 0.0;
    double stack = 0.0;
    double net = 0.0;
};

// One ledger file = one game night.
struct Game {
    std::string id;        // file stem, e.g. ledger_pglNZ_e2-7-NOfeh7nJxMonpT
    std::string path;      // absolute path of the CSV
    std::string folder;    // sub-folder relative to the data root, e.g. data_folder_May_1-7
    std::int64_t start = util::NO_TIME;   // earliest sit-down (game night)
    std::int64_t end = util::NO_TIME;     // latest cash-out
    double totalBuyIn = 0.0;
    int skippedRows = 0;   // never-played seats (no start time, zero net) left out
    std::vector<LedgerRow> rows;
};

// A player's result in one game (used for history and charts).
struct GameResult {
    std::string gameId;
    std::string folder;
    std::int64_t date = util::NO_TIME;
    double net = 0.0;
    int buyIns = 0;
    bool adjustment = false;   // true = manual correction, not a game
    std::string note;
};

// A manual correction to one player's total. A forgiven debt is two of these
// sharing a group: +amount for the debtor, -amount for the creditor.
struct Adjustment {
    std::string group;
    std::int64_t date = util::NO_TIME;   // local midnight
    std::string playerNormalized;
    double amount = 0.0;                 // signed dollars
    std::string folder;                  // empty = only counted when no folder scope is chosen
    std::string note;
};

// Aggregated view of a player across every game in the current scope.
struct PlayerStats {
    std::string displayName;
    std::string normalizedName;
    double totalNet = 0.0;
    double totalWon = 0.0;    // sum of winning games
    double totalLost = 0.0;   // sum of losing games (negative)
    double biggestWin = 0.0;
    double biggestLoss = 0.0;
    double adjustments = 0.0; // sum of manual corrections included in totalNet
    int games = 0;
    int buyIns = 0;
    std::vector<GameResult> history;   // sorted by date
    std::set<std::string> aliases;     // normalized names folded into this player
    std::set<std::string> playerIds;   // ledger account ids seen for this player

    double averagePerGame() const { return games == 0 ? 0.0 : totalNet / games; }
};

struct SettlementEntry {
    std::string fromDisplay;
    std::string fromNormalized;
    std::string toDisplay;
    std::string toNormalized;
    double amount = 0.0;
    std::string reason;   // "preference", "banker", or "auto"
};

// "payer always sends their losses to payee" (when payee is owed money).
struct PaymentPreference {
    std::string payerNormalized;
    std::string payeeNormalized;
    std::string note;
    bool oneOff = false;   // true = requested for one sheet only, never written to disk
};

struct SessionBalance {
    std::string sessionId;
    std::string fromDisplay;
    std::string fromNormalized;
    std::string toDisplay;
    std::string toNormalized;
    double originalAmount = 0.0;
    double remainingAmount = 0.0;
    std::string status = "open";  // open, partial, paid
};

// Which games the app is currently looking at.
struct Scope {
    std::string folder;                 // empty = every folder
    std::int64_t from = util::NO_TIME;  // inclusive, local midnight
    std::int64_t to = util::NO_TIME;    // inclusive, local end of day

    bool isEverything() const { return folder.empty() && from == util::NO_TIME && to == util::NO_TIME; }
    std::string describe() const {
        std::string s = folder.empty() ? "all folders" : "folder \"" + folder + "\"";
        if (from != util::NO_TIME || to != util::NO_TIME) {
            s += ", ";
            s += (from == util::NO_TIME ? "start" : util::formatLocalDate(from));
            s += " to ";
            s += (to == util::NO_TIME ? "now" : util::formatLocalDate(to));
        }
        return s;
    }
};

// Persistent user settings (Saved_Data/settings.csv).
struct Settings {
    std::string me;       // normalized name of the person running the app
    std::string banker;   // normalized name; empty = no banker mode
};
