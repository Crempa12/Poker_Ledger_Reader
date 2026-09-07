#include "players.hpp"

#include <algorithm>
#include <fstream>
#include <iostream>
#include <set>

using namespace util;

namespace players {

// ---------------- merge rules ----------------

std::string resolveCanonical(const MergeRules& rules, const std::string& key) {
    std::string current = key;
    for (int guard = 0; guard < 64; ++guard) {   // guard against accidental cycles
        auto it = rules.find(current);
        if (it == rules.end() || it->second == current) return current;
        current = it->second;
    }
    return current;
}

void flattenMergeRules(MergeRules& rules) {
    for (auto& pair : rules) pair.second = resolveCanonical(rules, pair.second);
}

void addMergeRule(MergeRules& rules, const std::string& alias, const std::string& canonical) {
    if (alias.empty() || canonical.empty() || alias == canonical) return;
    // Anything that pointed at the alias now points at the canonical.
    for (auto& pair : rules) {
        if (pair.second == alias) pair.second = canonical;
    }
    rules[alias] = canonical;
    // If the canonical was itself an alias, un-alias it (the user chose to keep it).
    rules.erase(canonical);
    flattenMergeRules(rules);
}

bool loadMergeRulesCSV(const std::string& filename, MergeRules& rules) {
    std::ifstream file(filename);
    if (!file.is_open()) return false;

    std::string line;
    bool firstLine = true;
    while (std::getline(file, line)) {
        if (trim(line).empty()) continue;
        if (firstLine) { firstLine = false; continue; }

        std::vector<std::string> row = splitCSVLine(line);
        if (row.size() < 2) continue;
        std::string alias = normalizeName(row[0]);
        std::string canonical = normalizeName(row[1]);
        if (!alias.empty() && !canonical.empty() && alias != canonical) rules[alias] = canonical;
    }
    flattenMergeRules(rules);
    return true;
}

bool saveMergeRulesCSV(const std::string& filename, MergeRules& rules) {
    flattenMergeRules(rules);
    std::ofstream out(filename);
    if (!out.is_open()) return false;

    out << "alias_normalized,canonical_normalized\n";
    std::vector<std::pair<std::string, std::string>> list;
    for (const auto& pair : rules) {
        if (pair.first != pair.second) list.push_back(pair);
    }
    std::sort(list.begin(), list.end(), [](const auto& a, const auto& b) {
        if (a.second == b.second) return a.first < b.first;
        return a.second < b.second;
    });
    for (const auto& pair : list) out << escapeCSV(pair.first) << ',' << escapeCSV(pair.second) << '\n';
    return true;
}

// ---------------- aggregation ----------------

std::map<std::string, PlayerStats> aggregate(const std::vector<const Game*>& games, const MergeRules& rules) {
    std::map<std::string, PlayerStats> stats;
    std::map<std::string, std::map<std::string, int>> nicknameCounts;  // canonical -> raw nickname -> count

    for (const Game* game : games) {
        std::map<std::string, GameResult> perGame;

        for (const LedgerRow& row : game->rows) {
            std::string norm = normalizeName(row.nickname);
            if (norm.empty()) continue;
            std::string canonical = resolveCanonical(rules, norm);

            PlayerStats& p = stats[canonical];
            p.normalizedName = canonical;
            p.aliases.insert(norm);
            if (!row.playerId.empty()) p.playerIds.insert(row.playerId);
            nicknameCounts[canonical][row.nickname]++;
            p.buyIns++;
            p.totalNet += row.net;

            GameResult& r = perGame[canonical];
            r.gameId = game->id;
            r.folder = game->folder;
            r.date = game->start;
            r.net += row.net;
            r.buyIns++;
        }

        for (auto& pair : perGame) {
            PlayerStats& p = stats[pair.first];
            const GameResult& r = pair.second;
            p.games++;
            if (r.net > EPSILON) p.totalWon += r.net;
            else if (r.net < -EPSILON) p.totalLost += r.net;
            p.biggestWin = std::max(p.biggestWin, r.net);
            p.biggestLoss = std::min(p.biggestLoss, r.net);
            p.history.push_back(r);
        }
    }

    for (auto& pair : stats) {
        PlayerStats& p = pair.second;
        // Display name = the nickname used most often; ties go to the shorter one.
        std::string best;
        int bestCount = -1;
        for (const auto& nc : nicknameCounts[pair.first]) {
            if (nc.second > bestCount || (nc.second == bestCount && nc.first.size() < best.size())) {
                best = nc.first;
                bestCount = nc.second;
            }
        }
        p.displayName = best.empty() ? pair.first : best;
        std::sort(p.history.begin(), p.history.end(), [](const GameResult& a, const GameResult& b) {
            if (a.date != b.date) return a.date < b.date;
            return a.gameId < b.gameId;
        });
    }
    return stats;
}

std::vector<PlayerStats> sortedByNet(const std::map<std::string, PlayerStats>& stats) {
    std::vector<PlayerStats> list;
    for (const auto& pair : stats) list.push_back(pair.second);
    std::sort(list.begin(), list.end(), [](const PlayerStats& a, const PlayerStats& b) {
        if (a.totalNet != b.totalNet) return a.totalNet > b.totalNet;
        return a.normalizedName < b.normalizedName;
    });
    return list;
}

std::vector<PlayerStats> sortedByName(const std::map<std::string, PlayerStats>& stats) {
    std::vector<PlayerStats> list;
    for (const auto& pair : stats) list.push_back(pair.second);
    return list;  // std::map is already sorted by normalized name
}

const PlayerStats* find(const std::map<std::string, PlayerStats>& stats, const std::string& normalized) {
    auto it = stats.find(normalized);
    return it == stats.end() ? nullptr : &it->second;
}

std::vector<MergeSuggestion> suggestMergesByPlayerId(const std::vector<Game>& games, const MergeRules& rules) {
    std::map<std::string, std::set<std::string>> byId;
    for (const Game& g : games) {
        for (const LedgerRow& row : g.rows) {
            if (row.playerId.empty()) continue;
            std::string norm = normalizeName(row.nickname);
            if (norm.empty()) continue;
            byId[row.playerId].insert(resolveCanonical(rules, norm));
        }
    }
    std::vector<MergeSuggestion> out;
    for (const auto& pair : byId) {
        if (pair.second.size() < 2) continue;
        MergeSuggestion s;
        s.playerId = pair.first;
        s.canonicals.assign(pair.second.begin(), pair.second.end());
        out.push_back(s);
    }
    return out;
}

// ---------------- printing / export ----------------

void printLeaderboard(const std::vector<PlayerStats>& list) {
    const int W = 126;
    double grandTotal = 0.0;
    std::cout << divider(W)
              << padRight("#", 4) << padRight("Player", 18) << padRight("Games", 7) << padRight("Buy-ins", 9)
              << padLeft("Won", 12) << padLeft("Lost", 12) << padLeft("Net", 12) << padLeft("Avg/game", 12)
              << padLeft("Best", 12) << padLeft("Worst", 12) << "  Aliases\n"
              << divider(W);

    for (size_t i = 0; i < list.size(); ++i) {
        const PlayerStats& p = list[i];
        grandTotal += p.totalNet;
        std::string aliases;
        for (const std::string& a : p.aliases) {
            if (a == p.normalizedName || a == normalizeName(p.displayName)) continue;
            aliases += (aliases.empty() ? "" : ", ") + a;
        }
        std::cout << padRight(std::to_string(i + 1), 4) << padRight(p.displayName, 18)
                  << padRight(std::to_string(p.games), 7) << padRight(std::to_string(p.buyIns), 9)
                  << padLeft(money(p.totalWon), 12) << padLeft(money(p.totalLost), 12)
                  << padLeft(moneySigned(p.totalNet), 12) << padLeft(moneySigned(p.averagePerGame()), 12)
                  << padLeft(moneySigned(p.biggestWin), 12) << padLeft(moneySigned(p.biggestLoss), 12)
                  << "  " << aliases << '\n';
    }
    std::cout << divider(W) << "Sum of all nets: " << moneySigned(grandTotal)
              << "  (should be $0.00 when every ledger balances)\n\n";
}

void printCompactList(const std::vector<PlayerStats>& list) {
    std::cout << divider(70)
              << padRight("#", 5) << padRight("Player", 24) << padRight("Normalized", 20) << padLeft("Net", 12) << '\n'
              << divider(70);
    for (size_t i = 0; i < list.size(); ++i) {
        std::cout << padRight(std::to_string(i + 1), 5) << padRight(list[i].displayName, 24)
                  << padRight(list[i].normalizedName, 20) << padLeft(moneySigned(list[i].totalNet), 12) << '\n';
    }
    std::cout << divider(70);
}

void printPlayerHistory(const PlayerStats& p) {
    std::cout << "\nGame history for " << p.displayName << " (" << p.games << " games, "
              << p.buyIns << " buy-ins, net " << moneySigned(p.totalNet) << ")\n";
    std::cout << divider(96)
              << padRight("#", 4) << padRight("Date", 12) << padRight("Folder", 28) << padRight("Ledger", 30)
              << padLeft("Buy-ins", 8) << padLeft("Net", 12) << padLeft("Running", 12) << '\n'
              << divider(96);
    double running = 0.0;
    for (size_t i = 0; i < p.history.size(); ++i) {
        const GameResult& r = p.history[i];
        running += r.net;
        std::cout << padRight(std::to_string(i + 1), 4) << padRight(formatLocalDate(r.date), 12)
                  << padRight(r.folder, 28) << padRight(r.gameId, 30) << padLeft(std::to_string(r.buyIns), 8)
                  << padLeft(moneySigned(r.net), 12) << padLeft(moneySigned(running), 12) << '\n';
    }
    std::cout << divider(96) << '\n';
}

bool exportPlayerSummaryCSV(const std::string& filename, const std::vector<PlayerStats>& list) {
    std::ofstream out(filename);
    if (!out.is_open()) return false;

    out << "rank,display_name,normalized_name,games,buy_ins,total_won,total_lost,total_net,avg_per_game,biggest_win,biggest_loss,aliases\n";
    for (size_t i = 0; i < list.size(); ++i) {
        const PlayerStats& p = list[i];
        std::string aliases;
        for (const std::string& a : p.aliases) aliases += (aliases.empty() ? "" : " | ") + a;
        out << (i + 1) << ',' << escapeCSV(p.displayName) << ',' << escapeCSV(p.normalizedName) << ','
            << p.games << ',' << p.buyIns << ',' << fixed2(p.totalWon) << ',' << fixed2(p.totalLost) << ','
            << fixed2(p.totalNet) << ',' << fixed2(p.averagePerGame()) << ',' << fixed2(p.biggestWin) << ','
            << fixed2(p.biggestLoss) << ',' << escapeCSV(aliases) << '\n';
    }
    return true;
}

}  // namespace players
