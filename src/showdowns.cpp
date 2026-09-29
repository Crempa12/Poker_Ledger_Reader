#include "showdowns.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <iostream>
#include <set>

#include "ui.hpp"
#include "util.hpp"

namespace showdowns {

using handlog::Hand;
using handlog::HandLog;
using util::EPSILON;

// As asked for: the five people who beat them most.
const int kTopRivals = 5;

std::map<std::string, Record> compute(const std::vector<const HandLog*>& logs,
                                      const players::MergeRules& rules,
                                      const std::map<std::string, PlayerStats>& ledgerStats) {
    std::map<std::string, Record> records;
    std::map<std::string, std::map<std::string, Rival>> beaten;   // loser -> winner -> tally
    std::map<std::string, std::string> displayOf;                 // person -> name to show

    for (const HandLog* log : logs) {
        for (const Hand& hand : log->hands) {
            if (!hand.showdown) continue;
            // Accounts are resolved to people hand by hand, since a shared account can change hands mid-night.
            std::map<std::string, std::string> keyOf;
            auto person = [&](const std::string& pid) -> const std::string& {
                auto c = keyOf.find(pid);
                if (c == keyOf.end()) {
                    std::string k = handlog::personAt(*log, pid, hand.start, rules);
                    if (k.empty()) k = "@" + pid;   // a nickname with no letters or digits, as in the style table
                    if (!displayOf.count(k)) displayOf[k] = handlog::displayNameAt(*log, pid, hand.start, rules, ledgerStats);
                    c = keyOf.emplace(pid, k).first;
                }
                return c->second;
            };

            std::set<std::string> atShowdown, winners;
            for (const std::string& pid : hand.atShowdown()) atShowdown.insert(person(pid));
            for (const auto& r : hand.rank) winners.insert(person(r.first));

            // Each person's result in the hand without the 7-2 bounty, and what each winner took.
            std::map<std::string, double> result, collected;
            for (const auto& n : hand.net) {
                auto b = hand.bounty.find(n.first);
                result[person(n.first)] += n.second - (b == hand.bounty.end() ? 0.0 : b->second);
            }
            for (const auto& c : hand.collected) collected[person(c.first)] += c.second;
            double taken = 0.0;
            for (const std::string& w : winners) taken += collected[w];

            for (const std::string& k : atShowdown) {
                Record& r = records[k];
                r.person = k;
                ++r.showdowns;
                if (winners.count(k)) { ++r.won; continue; }
                ++r.lost;
                const double loss = std::max(0.0, -result[k]);
                r.lostAmount += loss;
                for (const std::string& w : winners) {
                    const double share = taken > EPSILON ? collected[w] / taken : 1.0 / static_cast<double>(winners.size());
                    Rival& v = beaten[k][w];
                    v.person = w;
                    ++v.times;
                    v.amount += loss * share;
                }
            }
        }
    }

    for (auto& [k, r] : records) {
        auto ls = ledgerStats.find(k);
        r.displayName = ls != ledgerStats.end() ? ls->second.displayName : displayOf[k];
        for (auto& [w, v] : beaten[k]) {
            auto wl = ledgerStats.find(w);
            v.displayName = wl != ledgerStats.end() ? wl->second.displayName : displayOf[w];
            r.beatenBy.push_back(v);
        }
        std::sort(r.beatenBy.begin(), r.beatenBy.end(), [](const Rival& a, const Rival& b) {
            if (a.times != b.times) return a.times > b.times;
            if (std::fabs(a.amount - b.amount) > EPSILON) return a.amount > b.amount;
            return a.displayName < b.displayName;
        });
    }
    return records;
}

void printPlayer(const std::string& displayName, const Record* r, int logged, int nights) {
    using util::padLeft;
    using util::padRight;
    const int W = 97;
    std::cout << '\n' << ui::heading("Beaten at showdown by", W) << '\n';
    if (logged == 0) {
        std::cout << "  None of the " << nights << " game" << (nights == 1 ? "" : "s")
                  << " in scope has a hand log, so there are no showdowns to read.\n";
        return;
    }
    const std::string cover = std::to_string(logged) + " of " + std::to_string(nights) + " game" + (nights == 1 ? "" : "s") +
                              " in scope " + (logged == 1 ? "has" : "have") + " a hand log";
    if (!r || r->showdowns == 0) {
        std::cout << "  " << displayName << " reached no showdowns (" << cover << ").\n";
        return;
    }
    const int pct = static_cast<int>(100.0 * r->won / r->showdowns + 0.5);
    std::cout << "  Reached showdown " << r->showdowns << " time" << (r->showdowns == 1 ? "" : "s") << ": won " << r->won
              << " (" << pct << "%), lost " << r->lost << ", losing " << util::money(r->lostAmount) << " in those hands.\n"
              << ui::dim("  " + cover + "; these numbers come from those nights only.") << "\n\n";
    if (r->beatenBy.empty()) {
        std::cout << "  Nobody has beaten them at showdown yet.\n";
        return;
    }
    std::cout << ui::bold("  " + padLeft("#", 3) + "  " + padRight("Player", 20) + padLeft("Times", 7) + padLeft("Lost to them", 15))
              << '\n' << "  " << ui::rule(47) << '\n';
    const size_t shown = std::min(r->beatenBy.size(), static_cast<size_t>(kTopRivals));
    for (size_t i = 0; i < shown; ++i) {
        const Rival& v = r->beatenBy[i];
        std::cout << "  " << padLeft(std::to_string(i + 1), 3) << "  " << padRight(v.displayName, 20)
                  << padLeft(std::to_string(v.times), 7) << padLeft(ui::red(util::money(v.amount)), 15) << '\n';
    }
    if (r->beatenBy.size() > shown)
        std::cout << ui::dim("  ... and " + std::to_string(r->beatenBy.size() - shown) + " more (menu 12 exports them all).") << '\n';
    std::cout << ui::dim("  Times = showdowns they won that " + displayName +
                         " lost. Lost to them = what " + displayName + " lost in those hands,\n"
                         "  shared between the winners by what each collected (7-2 bounties left out). A chop is no loss.")
              << '\n';
}

bool exportCSV(const std::string& filename, const std::map<std::string, Record>& records) {
    std::ofstream out(filename);
    if (!out.is_open()) return false;
    out << "loser,loser_normalized,winner,winner_normalized,times,amount\n";
    for (const auto& [k, r] : records) {
        std::vector<Rival> rows = r.beatenBy;
        std::sort(rows.begin(), rows.end(), [](const Rival& a, const Rival& b) {
            return a.times != b.times ? a.times > b.times : a.person < b.person;
        });
        for (const Rival& v : rows) {
            out << util::escapeCSV(r.displayName) << ',' << util::escapeCSV(k) << ',' << util::escapeCSV(v.displayName) << ','
                << util::escapeCSV(v.person) << ',' << v.times << ',' << util::fixed2(v.amount) << '\n';
        }
    }
    return true;
}

}  // namespace showdowns
