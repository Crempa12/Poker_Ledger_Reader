#include "players.hpp"

#include <algorithm>
#include <cctype>
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

std::string personOf(const MergeRules& rules, const LedgerRow& row) {
    return resolveCanonical(rules, row.owner.empty() ? normalizeName(row.nickname) : row.owner);
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

std::map<std::string, PlayerStats> aggregate(const std::vector<const Game*>& games,
                                             const MergeRules& rules,
                                             const std::vector<const Adjustment*>& adjustments) {
    std::map<std::string, PlayerStats> stats;
    std::map<std::string, std::map<std::string, int>> nicknameCounts;  // canonical -> raw nickname -> count

    for (const Game* game : games) {
        std::map<std::string, GameResult> perGame;

        for (const LedgerRow& row : game->rows) {
            std::string norm = row.owner.empty() ? normalizeName(row.nickname) : row.owner;
            if (norm.empty()) continue;
            std::string canonical = resolveCanonical(rules, norm);

            PlayerStats& p = stats[canonical];
            p.normalizedName = canonical;
            p.aliases.insert(norm);
            // A reassigned seat was played under someone else's name or account, so
            // neither that nickname nor that account says anything about this player.
            if (row.owner.empty()) {
                if (!row.playerId.empty()) p.playerIds.insert(row.playerId);
                nicknameCounts[canonical][row.nickname]++;
            }
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
            if (p.games == 1) {
                p.biggestWin = r.net;
                p.biggestLoss = r.net;
            } else {
                p.biggestWin = std::max(p.biggestWin, r.net);
                p.biggestLoss = std::min(p.biggestLoss, r.net);
            }
            p.history.push_back(r);
        }
    }

    for (const Adjustment* a : adjustments) {
        std::string canonical = resolveCanonical(rules, a->playerNormalized);
        PlayerStats& p = stats[canonical];
        p.normalizedName = canonical;
        p.aliases.insert(a->playerNormalized);
        p.totalNet += a->amount;
        p.adjustments += a->amount;
        GameResult r;
        r.gameId = "adjustment";
        r.folder = a->folder.empty() ? "(any folder)" : a->folder;
        r.date = a->date;
        r.net = a->amount;
        r.adjustment = true;
        r.note = a->note;
        p.history.push_back(r);
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
        if (best.empty()) {   // only reassigned seats or adjustments in scope: no nickname of their own to show
            best = pair.first;
            if (!best.empty()) best[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(best[0])));
        }
        p.displayName = best;
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
            if (row.playerId.empty() || !row.owner.empty()) continue;
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

namespace {
// Prints comma-separated items, wrapping so no line exceeds `width`, with every
// continuation line indented to `indent` columns.
void printWrapped(const std::vector<std::string>& items, size_t indent, size_t width) {
    size_t col = indent;
    for (size_t i = 0; i < items.size(); ++i) {
        std::string piece = items[i] + (i + 1 < items.size() ? "," : "");
        if (col > indent && col + 1 + piece.size() > width) {
            std::cout << '\n' << std::string(indent, ' ');
            col = indent;
        } else if (col > indent) {
            std::cout << ' ';
            ++col;
        }
        std::cout << piece;
        col += piece.size();
    }
    std::cout << '\n';
}
}  // namespace

void printLeaderboard(const std::vector<PlayerStats>& list) {
    bool anyAdjust = false;
    for (const PlayerStats& p : list) {
        if (p.adjustments > EPSILON || p.adjustments < -EPSILON) anyAdjust = true;
    }
    const size_t NAME = 22;
    const int W = anyAdjust ? 122 : 112;
    double grandTotal = 0.0;
    double adjustmentTotal = 0.0;

    std::cout << divider(W)
              << padRight("#", 4) << padRight("Player", NAME) << padLeft("Games", 6) << padLeft("Buy-ins", 8)
              << padLeft("Won", 12) << padLeft("Lost", 12) << (anyAdjust ? padLeft("Adjust", 10) : "")
              << padLeft("Net", 12) << padLeft("Avg/game", 12) << padLeft("Best", 12) << padLeft("Worst", 12) << '\n'
              << divider(W);

    for (size_t i = 0; i < list.size(); ++i) {
        const PlayerStats& p = list[i];
        grandTotal += p.totalNet;
        adjustmentTotal += p.adjustments;
        bool hasAdjust = p.adjustments > EPSILON || p.adjustments < -EPSILON;
        std::cout << padRight(std::to_string(i + 1), 4) << padRight(p.displayName, NAME)
                  << padLeft(std::to_string(p.games), 6) << padLeft(std::to_string(p.buyIns), 8)
                  << padLeft(money(p.totalWon), 12) << padLeft(money(p.totalLost), 12)
                  << (anyAdjust ? padLeft(hasAdjust ? moneySigned(p.adjustments) : "-", 10) : "")
                  << padLeft(moneySigned(p.totalNet), 12) << padLeft(moneySigned(p.averagePerGame()), 12)
                  << padLeft(moneySigned(p.biggestWin), 12) << padLeft(moneySigned(p.biggestLoss), 12) << '\n';
    }
    std::cout << divider(W) << "Sum of all nets: " << moneySigned(grandTotal);
    if (adjustmentTotal > EPSILON || adjustmentTotal < -EPSILON) {
        std::cout << "  (includes " << moneySigned(adjustmentTotal) << " of one-sided adjustments)";
    } else {
        std::cout << "  (should be $0.00 when every ledger balances)";
    }
    std::cout << "\n\n";

    // Aliases live in their own section so long lists never break the table.
    bool anyAlias = false;
    for (const PlayerStats& p : list) {
        std::vector<std::string> aliases;
        for (const std::string& a : p.aliases) {
            if (a == p.normalizedName || a == normalizeName(p.displayName)) continue;
            aliases.push_back(a);
        }
        if (aliases.empty()) continue;
        if (!anyAlias) {
            std::cout << "Merged names (menu 4 to change)\n" << divider(W, '-');
            anyAlias = true;
        }
        std::cout << "  " << padRight(p.displayName, NAME) << "  also: ";
        printWrapped(aliases, 2 + NAME + 8, static_cast<size_t>(W));
    }
    if (anyAlias) std::cout << divider(W, '-') << '\n';
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
    std::cout << divider(100)
              << padRight("#", 4) << padRight("Date", 12) << padRight("Folder", 28) << padRight("Ledger", 34)
              << padLeft("Buy-ins", 8) << padLeft("Net", 12) << padLeft("Running", 12) << '\n'
              << divider(100);
    double running = 0.0;
    for (size_t i = 0; i < p.history.size(); ++i) {
        const GameResult& r = p.history[i];
        running += r.net;
        std::cout << padRight(std::to_string(i + 1), 4) << padRight(formatLocalDate(r.date), 12)
                  << padRight(r.folder, 28) << padRight(r.adjustment ? "adjustment: " + r.note : r.gameId, 34)
                  << padLeft(r.adjustment ? "-" : std::to_string(r.buyIns), 8)
                  << padLeft(moneySigned(r.net), 12) << padLeft(moneySigned(running), 12) << '\n';
    }
    std::cout << divider(100) << '\n';
}

bool exportPlayerSummaryCSV(const std::string& filename, const std::vector<PlayerStats>& list) {
    std::ofstream out(filename);
    if (!out.is_open()) return false;

    out << "rank,display_name,normalized_name,games,buy_ins,total_won,total_lost,adjustments,total_net,avg_per_game,biggest_win,biggest_loss,aliases\n";
    for (size_t i = 0; i < list.size(); ++i) {
        const PlayerStats& p = list[i];
        std::string aliases;
        for (const std::string& a : p.aliases) aliases += (aliases.empty() ? "" : " | ") + a;
        out << (i + 1) << ',' << escapeCSV(p.displayName) << ',' << escapeCSV(p.normalizedName) << ','
            << p.games << ',' << p.buyIns << ',' << fixed2(p.totalWon) << ',' << fixed2(p.totalLost) << ','
            << fixed2(p.adjustments) << ',' << fixed2(p.totalNet) << ',' << fixed2(p.averagePerGame()) << ',' << fixed2(p.biggestWin) << ','
            << fixed2(p.biggestLoss) << ',' << escapeCSV(aliases) << '\n';
    }
    return true;
}

}  // namespace players
