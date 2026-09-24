#pragma once
// Buy-ins made under someone else's name or account. A seat can be handed to
// the person whose money it really was; every total, settlement and chart then
// counts it for them instead of for the nickname on the ledger.
#include <map>
#include <string>
#include <vector>

#include "models.hpp"
#include "players.hpp"

namespace seats {

bool loadCSV(const std::string& filename, std::vector<SeatOwner>& list);
bool saveCSV(const std::string& filename, const std::vector<SeatOwner>& list);

// Sets LedgerRow::owner / ownerReviewed on every row that has a saved entry.
// Returns how many saved entries matched no row (their ledger is not loaded).
int apply(std::vector<Game>& games, const std::vector<SeatOwner>& list, const players::MergeRules& rules);

// A seat that looks like it was bought by someone other than the name on it.
struct Flag {
    const Game* game = nullptr;
    size_t row = 0;
    std::string usualOwner;                     // who normally uses this account, when that is someone else
    std::vector<std::string> overlapAccounts;   // other accounts the same person sat on at the same time
};

// Menu 4's "different people" answer: every unchecked seat on `account` played under one of
// `people` is saved as "checked: name was right", exactly as menu 20 records it. Saves and applies.
int confirmNames(std::vector<Game>& games, std::vector<SeatOwner>& list, const players::MergeRules& rules,
                 const std::string& account, const std::vector<std::string>& people, const std::string& filename);

// Seats not yet reviewed where the account usually belongs to someone else, or
// the same person is seated on two accounts at the same time.
std::vector<Flag> findSuspicious(const std::vector<Game>& games, const players::MergeRules& rules);

// Interactive editor (menu 20). Saves after every change. Returns true if anything changed.
bool manage(std::vector<Game>& games,
            std::vector<SeatOwner>& list,
            const players::MergeRules& rules,
            const std::string& filename);

}  // namespace seats
