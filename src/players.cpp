#include "players.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <iostream>
#include <set>

#include "ui.hpp"

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

// The name a row is filed under before merge rules: its reassigned owner, else its nickname.
// A nickname with neither letters nor digits (emoji only) still has money on it: it is filed
// under its account ("unnamed" + the account's letters), so two such players never share a row.
static std::string rowName(const LedgerRow& row) {
    std::string name = row.owner.empty() ? normalizeName(row.nickname) : row.owner;
    return name.empty() ? normalizeName("unnamed " + row.playerId) : name;
}

std::string personOf(const MergeRules& rules, const LedgerRow& row) {
    return resolveCanonical(rules, rowName(row));
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

void removeMergeRule(MergeRules& rules, const std::string& alias) { rules.erase(alias); }

bool loadMergeRulesCSV(const std::string& filename, MergeRules& rules) {
    std::vector<std::vector<std::string>> rows;
    if (!readCSV(filename, rows)) return false;
    for (const std::vector<std::string>& row : rows) {
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
            std::string canonical = personOf(rules, row);

            PlayerStats& p = stats[canonical];
            p.normalizedName = canonical;
            p.aliases.insert(rowName(row));
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
        p.adjustments += a->amount;   // counts on settlement sheets, not in the poker result
        GameResult r;
        r.gameId = "adjustment";
        r.folder = a->folder.empty() ? "(all folders)" : a->folder;
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

std::string displayName(const std::vector<PlayerStats>& list, const std::string& normalized) {
    if (normalized.empty()) return "(none)";
    for (const PlayerStats& p : list) {
        if (p.normalizedName == normalized || p.aliases.count(normalized)) return p.displayName;
    }
    return normalized;
}

std::map<std::string, std::set<std::string>> accountsByPerson(const std::vector<Game>& games, const MergeRules& rules) {
    std::map<std::string, std::set<std::string>> out;
    for (const Game& g : games) {
        for (const LedgerRow& row : g.rows) {
            if (!row.playerId.empty() && row.owner.empty()) out[personOf(rules, row)].insert(row.playerId);
        }
    }
    return out;
}

std::vector<MergeSuggestion> suggestMergesByPlayerId(const std::vector<Game>& games, const MergeRules& rules) {
    std::map<std::string, std::set<std::string>> accounts = accountsByPerson(games, rules);
    std::map<std::string, std::set<std::string>> people;   // account -> everyone seen on it
    std::set<std::string> unchecked;                       // "account|person" with a seat nobody has confirmed
    for (const Game& g : games) {
        for (const LedgerRow& row : g.rows) {
            if (row.playerId.empty() || !row.owner.empty()) continue;
            std::string person = personOf(rules, row);
            people[row.playerId].insert(person);
            if (!row.ownerReviewed) unchecked.insert(row.playerId + "|" + person);
        }
    }
    std::vector<MergeSuggestion> out;
    for (const auto& [account, names] : people) {
        if (names.size() < 2) continue;
        MergeSuggestion s{account, {names.begin(), names.end()}, {}};
        for (const std::string& n : names) {
            if (accounts[n].size() == 1 && unchecked.count(account + "|" + n)) s.newNames.push_back(n);
        }
        if (!s.newNames.empty()) out.push_back(s);
    }
    return out;
}

// ---------------- printing / export ----------------

void printLeaderboard(const std::vector<PlayerStats>& list) {
    const int W = 100;   // the header's "Last 10 nights" is the widest part
    std::cout << ui::bold(" " + padLeft("#", 3) + "  " + padRight("Player", 18) + padLeft("Nights", 7) + padLeft("Up-Dn", 8) +
                          padLeft("Net", 12) + padLeft("Avg/night", 11) + padLeft("Best", 11) + padLeft("Worst", 11) +
                          "  Last 10 nights") << '\n' << ui::rule(W) << '\n';

    double pokerSum = 0.0;
    int rank = 0;
    for (const PlayerStats& p : list) {
        pokerSum += p.totalNet;
        if (p.games == 0) continue;   // only payments or corrections in scope: listed below the table
        std::vector<double> nights;
        int up = 0, down = 0;
        for (const GameResult& r : p.history) {
            if (r.adjustment) continue;
            nights.push_back(r.net);
            if (r.net > EPSILON) ++up;
            else if (r.net < -EPSILON) ++down;
        }
        if (nights.size() > 10) nights.erase(nights.begin(), nights.end() - 10);
        std::string place = padLeft(std::to_string(++rank), 3);
        std::cout << " " << (rank <= 3 ? ui::yellow(ui::bold(place)) : ui::dim(place)) << "  " << padRight(p.displayName, 18)
                  << padLeft(std::to_string(p.games), 7) << padLeft(std::to_string(up) + "-" + std::to_string(down), 8)
                  << padLeft(ui::bold(ui::net(p.totalNet)), 12) << padLeft(ui::net(p.averagePerGame()), 11)
                  << padLeft(ui::net(p.biggestWin), 11) << padLeft(ui::net(p.biggestLoss), 11)
                  << "  " << ui::sparkline(nights) << '\n';
    }
    std::cout << ui::rule(W) << '\n';
    if (pokerSum > -EPSILON && pokerSum < EPSILON) {
        std::cout << " Poker nets add up to $0.00  " << ui::green(ui::sym("✓ balanced", "(balanced)")) << '\n';
    } else {
        std::cout << ui::red(" " + std::string(ui::sym("✗ ", "!! ")) + "The games are off by " + moneySigned(pokerSum) +
                             ": a ledger does not balance (see the warning at startup).") << '\n';
    }

    // Payments and corrections change who owes whom, not who won at the table.
    struct Entry { std::int64_t date; std::string name; double amount; std::string note; };
    std::vector<Entry> entries;
    double entrySum = 0.0;
    for (const PlayerStats& p : list) {
        for (const GameResult& r : p.history) {
            if (!r.adjustment) continue;
            entries.push_back({r.date, p.displayName, r.net, r.note});
            entrySum += r.net;
        }
    }
    if (!entries.empty()) {
        std::sort(entries.begin(), entries.end(), [](const Entry& a, const Entry& b) {
            return a.date != b.date ? a.date < b.date : a.name < b.name;
        });
        std::cout << "\n " << ui::bold("Payments & corrections") << ui::dim("  (menu 17) not in the table; settlement sheets count them")
                  << '\n';
        for (const Entry& e : entries) {
            std::cout << "   " << padRight(formatLocalDate(e.date), 12) << padRight(e.name, 18) << padLeft(ui::net(e.amount), 12)
                      << "   " << padRight(e.note, W - 48) << '\n';
        }
        if (entrySum > -EPSILON && entrySum < EPSILON) {
            std::cout << ui::dim("   They cancel out: every payment is on both sides.") << '\n';
        } else {
            std::cout << ui::yellow("   One-sided: they add up to " + moneySigned(entrySum) +
                                    ", so a settlement sheet will be short by that much.") << '\n';
        }
    }
    std::cout << ui::dim("\n Nights = games played   Up-Dn = nights won-lost   Last 10: oldest to newest   Nicknames: menu 4")
              << "\n\n";
}

void printCompactList(const std::vector<PlayerStats>& list) {
    std::cout << ui::bold(" " + padLeft("#", 3) + "  " + padRight("Player", 22) + padLeft("Nights", 7) + padLeft("Net", 13)) << '\n'
              << ui::rule(47) << '\n';
    for (size_t i = 0; i < list.size(); ++i) {
        std::cout << " " << padLeft(std::to_string(i + 1), 3) << "  " << padRight(list[i].displayName, 22)
                  << padLeft(std::to_string(list[i].games), 7) << padLeft(ui::net(list[i].totalNet), 13) << '\n';
    }
    std::cout << ui::rule(47) << '\n';
}

void printPlayerHistory(const PlayerStats& p) {
    const int W = 97;
    std::cout << '\n' << ui::heading(p.displayName + ", night by night", W) << "\n  " << p.games << " nights, " << p.buyIns
              << " buy-ins, poker net " << ui::bold(ui::net(p.totalNet));
    if (p.adjustments > EPSILON || p.adjustments < -EPSILON) {
        std::cout << "   payments & corrections " << ui::net(p.adjustments) << "   balance " << ui::net(p.balance());
    }
    std::cout << "\n\n"
              << ui::bold(padLeft("#", 4) + "  " + padRight("Date", 12) + padRight("Folder", 20) + padLeft("Buy-ins", 8) +
                          padLeft("Net", 12) + padLeft("Running", 12) + "  Game")
              << '\n' << ui::rule(W) << '\n';
    double running = 0.0;   // poker only, like the leaderboard
    for (size_t i = 0; i < p.history.size(); ++i) {
        const GameResult& r = p.history[i];
        if (!r.adjustment) running += r.net;
        std::string game = r.adjustment ? "adjustment" : (r.gameId.rfind("ledger_", 0) == 0 ? r.gameId.substr(7) : r.gameId);
        std::string where = r.adjustment ? r.note : r.folder;   // a payment shows its note, dimmed
        std::cout << padLeft(std::to_string(i + 1), 4) << "  " << padRight(formatLocalDate(r.date), 12)
                  << (r.adjustment ? ui::dim(padRight(where, 20)) : padRight(where, 20))
                  << padLeft(r.adjustment ? "-" : std::to_string(r.buyIns), 8) << padLeft(ui::net(r.net), 12)
                  << padLeft(ui::net(running), 12) << "  " << ui::dim(game) << '\n';
    }
    std::cout << ui::rule(W) << '\n';
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
