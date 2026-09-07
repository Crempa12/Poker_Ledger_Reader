#pragma once
// Turning games into per-player statistics, plus the name-merge rule system.
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

#include "models.hpp"

namespace players {

// alias (normalized) -> canonical (normalized)
using MergeRules = std::unordered_map<std::string, std::string>;

std::string resolveCanonical(const MergeRules& rules, const std::string& key);
void flattenMergeRules(MergeRules& rules);
void addMergeRule(MergeRules& rules, const std::string& alias, const std::string& canonical);
bool loadMergeRulesCSV(const std::string& filename, MergeRules& rules);
bool saveMergeRulesCSV(const std::string& filename, MergeRules& rules);

// Builds player stats from the given games, folding aliases with the merge rules.
std::map<std::string, PlayerStats> aggregate(const std::vector<const Game*>& games, const MergeRules& rules);

std::vector<PlayerStats> sortedByNet(const std::map<std::string, PlayerStats>& stats);
std::vector<PlayerStats> sortedByName(const std::map<std::string, PlayerStats>& stats);

const PlayerStats* find(const std::map<std::string, PlayerStats>& stats, const std::string& normalized);

// Groups of names that share a ledger player_id but are not merged yet.
struct MergeSuggestion {
    std::string playerId;
    std::vector<std::string> canonicals;   // normalized names, all distinct after rules
};
std::vector<MergeSuggestion> suggestMergesByPlayerId(const std::vector<Game>& games, const MergeRules& rules);

void printLeaderboard(const std::vector<PlayerStats>& list);
void printCompactList(const std::vector<PlayerStats>& list);
void printPlayerHistory(const PlayerStats& p);
bool exportPlayerSummaryCSV(const std::string& filename, const std::vector<PlayerStats>& list);

}  // namespace players
