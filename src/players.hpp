#pragma once
// Turning games into per-player statistics, plus the name-merge rule system.
#include <map>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

#include "models.hpp"

namespace players {

// alias (normalized) -> canonical (normalized)
using MergeRules = std::unordered_map<std::string, std::string>;

std::string resolveCanonical(const MergeRules& rules, const std::string& key);
void flattenMergeRules(MergeRules& rules);
// Who a ledger row really belongs to: its reassigned owner if it has one, else its nickname, after merge rules.
std::string personOf(const MergeRules& rules, const LedgerRow& row);
void addMergeRule(MergeRules& rules, const std::string& alias, const std::string& canonical);
// Undo: the alias counts as its own player again. Rules are kept flat, so nothing else moves.
void removeMergeRule(MergeRules& rules, const std::string& alias);
bool loadMergeRulesCSV(const std::string& filename, MergeRules& rules);
bool saveMergeRulesCSV(const std::string& filename, MergeRules& rules);

// Builds player stats from the given games (plus manual adjustments), folding aliases with the merge rules.
std::map<std::string, PlayerStats> aggregate(const std::vector<const Game*>& games,
                                             const MergeRules& rules,
                                             const std::vector<const Adjustment*>& adjustments = {});

std::vector<PlayerStats> sortedByNet(const std::map<std::string, PlayerStats>& stats);
std::vector<PlayerStats> sortedByName(const std::map<std::string, PlayerStats>& stats);

const PlayerStats* find(const std::map<std::string, PlayerStats>& stats, const std::string& normalized);

// The name to show for a normalized name (or any of its aliases): the player's display name,
// else the name itself, or "(none)" when empty.
std::string displayName(const std::vector<PlayerStats>& list, const std::string& normalized);

// Every PokerNow account (player_id) each person has played on. Reassigned seats are left
// out: they were played on someone else's account and say nothing about the person.
std::map<std::string, std::set<std::string>> accountsByPerson(const std::vector<Game>& games, const MergeRules& rules);

// An account played under a name that has never been seen anywhere else, next to other
// names: probably a new nickname ("24242424242424" on Kobe's account), worth one question.
// Accounts shared by people who each have their own accounts too are a borrowed phone, not
// a new name, and are left to menu 20. Seats confirmed there ("the name is right") count as answered.
struct MergeSuggestion {
    std::string playerId;
    std::vector<std::string> canonicals;   // every person on the account, normalized, sorted
    std::vector<std::string> newNames;     // the ones never seen on any other account, not yet confirmed
};
std::vector<MergeSuggestion> suggestMergesByPlayerId(const std::vector<Game>& games, const MergeRules& rules);

void printLeaderboard(const std::vector<PlayerStats>& list);
void printCompactList(const std::vector<PlayerStats>& list);
void printPlayerHistory(const PlayerStats& p);
bool exportPlayerSummaryCSV(const std::string& filename, const std::vector<PlayerStats>& list);

}  // namespace players
