#include "settlement.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>

#include "console.hpp"

using namespace util;

namespace settlement {

// ---------------- persistence ----------------

bool loadPreferencesCSV(const std::string& filename, std::vector<PaymentPreference>& prefs) {
    std::ifstream in(filename);
    if (!in.is_open()) return false;
    std::string line;
    bool first = true;
    while (std::getline(in, line)) {
        if (trim(line).empty()) continue;
        if (first) { first = false; continue; }
        std::vector<std::string> row = splitCSVLine(line);
        if (row.size() < 2) continue;
        PaymentPreference p;
        p.payerNormalized = normalizeName(row[0]);
        p.payeeNormalized = normalizeName(row[1]);
        p.note = row.size() > 2 ? trim(row[2]) : "";
        if (!p.payerNormalized.empty() && !p.payeeNormalized.empty() && p.payerNormalized != p.payeeNormalized) {
            prefs.push_back(p);
        }
    }
    return true;
}

bool savePreferencesCSV(const std::string& filename, const std::vector<PaymentPreference>& prefs) {
    std::ofstream out(filename);
    if (!out.is_open()) return false;
    out << "payer_normalized,payee_normalized,note\n";
    for (const PaymentPreference& p : prefs) {
        out << escapeCSV(p.payerNormalized) << ',' << escapeCSV(p.payeeNormalized) << ',' << escapeCSV(p.note) << '\n';
    }
    return true;
}

bool loadSettingsCSV(const std::string& filename, Settings& settings) {
    std::ifstream in(filename);
    if (!in.is_open()) return false;
    std::string line;
    while (std::getline(in, line)) {
        std::vector<std::string> row = splitCSVLine(line);
        if (row.size() < 2) continue;
        std::string key = lower(trim(row[0]));
        std::string value = trim(row[1]);
        if (key == "me") settings.me = normalizeName(value);
        else if (key == "banker") settings.banker = normalizeName(value);
    }
    return true;
}

bool saveSettingsCSV(const std::string& filename, const Settings& settings) {
    std::ofstream out(filename);
    if (!out.is_open()) return false;
    out << "key,value\n";
    out << "me," << escapeCSV(settings.me) << '\n';
    out << "banker," << escapeCSV(settings.banker) << '\n';
    return true;
}

// ---------------- calculation ----------------

namespace {

struct Balance {
    std::string display;
    std::string normalized;
    double amount = 0.0;   // positive = is owed, negative = owes
};

using Pay = std::function<void(Balance&, Balance&, double, const std::string&)>;

// Settles one self-contained group (its balances sum to zero) with the fewest
// payments, pairing each debt with the smallest credit that can absorb it in
// full. That way a payer sends to a single person whenever one exists, and
// only the biggest debts get split across several recipients.
void settleGroup(std::vector<Balance*> members, const Pay& pay) {
    std::vector<Balance*> losers, winners;
    for (Balance* b : members) {
        if (b->amount < -EPSILON) losers.push_back(b);
        else if (b->amount > EPSILON) winners.push_back(b);
    }
    std::sort(losers.begin(), losers.end(), [](Balance* a, Balance* b) { return a->amount < b->amount; });

    for (Balance* loser : losers) {
        while (loser->amount < -EPSILON) {
            double debt = -loser->amount;
            Balance* best = nullptr;     // smallest credit that covers the whole debt
            Balance* largest = nullptr;  // fallback: biggest credit available
            for (Balance* w : winners) {
                if (w->amount <= EPSILON) continue;
                if (!largest || w->amount > largest->amount) largest = w;
                if (w->amount + EPSILON >= debt && (!best || w->amount < best->amount)) best = w;
            }
            Balance* target = best ? best : largest;
            if (!target) break;   // nothing left to receive (rounding leftovers)
            pay(*loser, *target, std::min(debt, target->amount), "auto");
        }
    }
}

// Depth-first search for a zero-sum subset of exactly `size` unused people.
bool findZeroSubset(const std::vector<std::int64_t>& cents, const std::vector<bool>& used,
                    int size, int start, std::int64_t running, std::vector<int>& picked) {
    if (static_cast<int>(picked.size()) == size) return running == 0;
    const int n = static_cast<int>(cents.size());
    for (int i = start; i < n; ++i) {
        if (used[i]) continue;
        if (n - i < size - static_cast<int>(picked.size())) break;
        picked.push_back(i);
        if (findZeroSubset(cents, used, size, i + 1, running + cents[i], picked)) return true;
        picked.pop_back();
    }
    return false;
}

// Splits the remaining balances into as many zero-sum groups as possible.
// Every group of m people needs m-1 payments, so more groups = fewer
// payments overall. Exact search (bitmask DP) up to DP_LIMIT people; above
// that, peel off the smallest zero-sum subsets first and settle the rest as one group.
constexpr int DP_LIMIT = 20;

std::vector<std::vector<Balance*>> splitIntoGroups(std::vector<Balance*> people) {
    std::vector<std::vector<Balance*>> groups;
    const int n = static_cast<int>(people.size());
    if (n == 0) return groups;

    std::vector<std::int64_t> cents(n);
    for (int i = 0; i < n; ++i) cents[i] = std::llround(people[i]->amount * 100.0);

    if (n <= DP_LIMIT) {
        const std::uint32_t full = (1u << n) - 1;
        std::vector<std::int64_t> sum(full + 1, 0);
        std::vector<int> best(full + 1, 0);
        std::vector<int> removed(full + 1, -1);
        for (std::uint32_t mask = 1; mask <= full; ++mask) {
            int low = 0;
            while (!(mask & (1u << low))) ++low;
            sum[mask] = sum[mask & (mask - 1)] + cents[low];
            int bestSub = -1, bestVal = -1;
            for (int i = 0; i < n; ++i) {
                if (!(mask & (1u << i))) continue;
                int v = best[mask ^ (1u << i)];
                if (v > bestVal) { bestVal = v; bestSub = i; }
            }
            best[mask] = bestVal + (sum[mask] == 0 ? 1 : 0);
            removed[mask] = bestSub;
        }
        // Walk back from the full set; every zero-sum mask on the way closes a group.
        std::vector<Balance*> group;
        std::uint32_t cur = full;
        while (cur) {
            int i = removed[cur];
            group.push_back(people[i]);
            cur ^= (1u << i);
            if (sum[cur] == 0 && !group.empty()) { groups.push_back(group); group.clear(); }
        }
        if (!group.empty()) groups.push_back(group);
        return groups;
    }

    // Peel off the smallest zero-sum subsets first (pairs, then triples, ...).
    // The subset size is capped so the search stays quick for big groups.
    const int maxSize = n <= 40 ? 7 : (n <= 60 ? 5 : 4);
    std::vector<bool> used(n, false);
    for (int size = 2; size <= maxSize; ++size) {
        std::vector<int> picked;
        while (findZeroSubset(cents, used, size, 0, 0, picked)) {
            std::vector<Balance*> g;
            for (int i : picked) { g.push_back(people[i]); used[i] = true; }
            groups.push_back(g);
            picked.clear();
        }
    }
    std::vector<Balance*> rest;
    for (int i = 0; i < n; ++i) if (!used[i]) rest.push_back(people[i]);
    if (!rest.empty()) groups.push_back(rest);
    return groups;
}

}  // namespace

std::vector<SettlementEntry> calculate(const std::vector<PlayerStats>& players,
                                       const std::vector<PaymentPreference>& prefs,
                                       const std::string& bankerNormalized) {
    std::map<std::string, Balance> balances;
    for (const PlayerStats& p : players) {
        if (p.totalNet > EPSILON || p.totalNet < -EPSILON) {
            balances[p.normalizedName] = Balance{p.displayName, p.normalizedName, p.totalNet};
        }
    }

    std::vector<SettlementEntry> out;
    Pay pay = [&](Balance& from, Balance& to, double amount, const std::string& reason) {
        if (amount <= EPSILON) return;
        out.push_back({from.display, from.normalized, to.display, to.normalized, amount, reason});
        from.amount += amount;   // debtor's negative balance moves toward zero
        to.amount -= amount;     // creditor's positive balance moves toward zero
    };

    // 1. Banker: everyone settles through one person.
    if (!bankerNormalized.empty()) {
        std::string bankerDisplay = bankerNormalized;
        for (const PlayerStats& p : players) {
            if (p.normalizedName == bankerNormalized) bankerDisplay = p.displayName;
        }
        Balance& banker = balances[bankerNormalized];
        if (banker.normalized.empty()) banker = Balance{bankerDisplay, bankerNormalized, 0.0};

        for (auto& pair : balances) {
            Balance& b = pair.second;
            if (b.normalized == bankerNormalized) continue;
            if (b.amount < -EPSILON) pay(b, banker, -b.amount, "banker");
        }
        for (auto& pair : balances) {
            Balance& b = pair.second;
            if (b.normalized == bankerNormalized) continue;
            if (b.amount > EPSILON) pay(banker, b, b.amount, "banker");
        }
        return out;
    }

    // 2. Pinned preferences and one-off requests, in order.
    for (const PaymentPreference& pref : prefs) {
        auto payer = balances.find(pref.payerNormalized);
        auto payee = balances.find(pref.payeeNormalized);
        if (payer == balances.end() || payee == balances.end()) continue;
        if (payer->second.amount >= -EPSILON || payee->second.amount <= EPSILON) continue;
        double amount = std::min(-payer->second.amount, payee->second.amount);
        pay(payer->second, payee->second, amount, pref.oneOff ? "requested" : "preference");
    }

    // 3. Fewest payments for whatever is left: split into zero-sum groups,
    //    then settle each group with best-fit pairing.
    std::vector<Balance*> remaining;
    for (auto& pair : balances) {
        if (pair.second.amount < -EPSILON || pair.second.amount > EPSILON) remaining.push_back(&pair.second);
    }
    for (std::vector<Balance*>& group : splitIntoGroups(remaining)) settleGroup(group, pay);

    // Reconciliation. settleGroup gives up with `break` when no credit is left to pay a
    // debt into, which happens whenever the balances handed to it do not sum to zero -
    // a one-sided correction from menu 17 is enough to cause it. Without this check the
    // abandoned money simply never appears on the sheet and nobody is told.
    double unpaidDebt = 0.0, unpaidCredit = 0.0;
    for (const auto& pair : balances) {
        if (pair.second.amount < -EPSILON) unpaidDebt += -pair.second.amount;
        else if (pair.second.amount > EPSILON) unpaidCredit += pair.second.amount;
    }
    if (unpaidDebt > EPSILON || unpaidCredit > EPSILON) {
        std::cout << "\n  !! This sheet does not balance. " << util::money(unpaidDebt)
                  << " of debt and " << util::money(unpaidCredit) << " of credit could not be paired.\n"
                  << "     The totals in scope do not sum to zero, which normally means a one-sided\n"
                  << "     adjustment (menu 17). Fix the adjustment or the sheet will be short.\n";
    }
    return out;
}

// ---------------- output ----------------

namespace {
std::string tagFor(const std::string& reason) {
    if (reason == "preference") return "[pinned]";
    if (reason == "requested") return "[requested]";
    if (reason == "banker") return "[banker]";
    return "";
}
}  // namespace

void print(const std::vector<SettlementEntry>& entries) {
    const int W = 84;
    if (entries.empty()) {
        std::cout << "\nSettlement sheet\n" << divider(W)
                  << "No payments needed. Everyone is already settled.\n" << divider(W) << '\n';
        return;
    }

    // Group lines by payer, biggest total sender first, keeping sheet order within a payer.
    struct Payer { std::string name; double total = 0.0; std::vector<const SettlementEntry*> lines; };
    std::vector<Payer> payers;
    std::map<std::string, std::vector<std::string>> receivedFrom;
    std::map<std::string, double> received;
    for (const SettlementEntry& e : entries) {
        auto it = std::find_if(payers.begin(), payers.end(), [&](const Payer& p) { return p.name == e.fromNormalized; });
        if (it == payers.end()) { payers.push_back({e.fromNormalized, 0.0, {}}); it = payers.end() - 1; }
        it->total += e.amount;
        it->lines.push_back(&e);
        received[e.toDisplay] += e.amount;
        receivedFrom[e.toDisplay].push_back(e.fromDisplay);
    }
    std::stable_sort(payers.begin(), payers.end(), [](const Payer& a, const Payer& b) { return a.total > b.total; });

    std::cout << "\nSettlement sheet: " << entries.size() << " payment" << (entries.size() == 1 ? "" : "s")
              << ", " << payers.size() << " sender" << (payers.size() == 1 ? "" : "s")
              << ", " << received.size() << " receiver" << (received.size() == 1 ? "" : "s") << '\n'
              << divider(W);

    for (const Payer& p : payers) {
        for (size_t i = 0; i < p.lines.size(); ++i) {
            const SettlementEntry& e = *p.lines[i];
            std::cout << "  " << padRight(i == 0 ? e.fromDisplay : "", 22) << " ---> "
                      << padRight(e.toDisplay, 22) << padLeft(money(e.amount), 12)
                      << "   " << tagFor(e.reason) << '\n';
        }
        if (p.lines.size() > 1) {
            std::cout << "  " << padRight("", 22) << "       sends " << money(p.total) << " total to "
                      << p.lines.size() << " people\n";
        }
        std::cout << '\n';
    }
    std::cout << divider(W) << "Who receives what:\n";
    for (const auto& r : received) {
        std::cout << "  " << padRight(r.first, 22) << " <--- " << padLeft(money(r.second), 12) << "   from ";
        const std::vector<std::string>& from = receivedFrom[r.first];
        for (size_t i = 0; i < from.size(); ++i) std::cout << (i ? ", " : "") << from[i];
        std::cout << '\n';
    }
    std::cout << divider(W) << '\n';
}

bool exportCSV(const std::string& filename, const std::vector<SettlementEntry>& entries) {
    std::ofstream out(filename);
    if (!out.is_open()) return false;
    out << "from,to,amount,reason,from_normalized,to_normalized\n";
    for (const SettlementEntry& e : entries) {
        out << escapeCSV(e.fromDisplay) << ',' << escapeCSV(e.toDisplay) << ',' << fixed2(e.amount) << ','
            << e.reason << ',' << escapeCSV(e.fromNormalized) << ',' << escapeCSV(e.toNormalized) << '\n';
    }
    return true;
}

// ---------------- interactive editor ----------------

static std::string displayFor(const std::vector<PlayerStats>& players, const std::string& normalized) {
    for (const PlayerStats& p : players) {
        if (p.normalizedName == normalized) return p.displayName;
    }
    return normalized.empty() ? "(none)" : normalized;
}

void managePreferences(std::vector<PaymentPreference>& prefs,
                       Settings& settings,
                       const std::vector<PlayerStats>& players,
                       const std::string& prefsFile,
                       const std::string& settingsFile) {
    while (true) {
        std::cout << "\nPayment preferences\n" << divider(60);
        if (prefs.empty()) {
            std::cout << "  (no pinned payer -> payee preferences)\n";
        }
        for (size_t i = 0; i < prefs.size(); ++i) {
            std::cout << "  " << (i + 1) << ". " << displayFor(players, prefs[i].payerNormalized)
                      << " always pays " << displayFor(players, prefs[i].payeeNormalized)
                      << (prefs[i].note.empty() ? "" : "   [" + prefs[i].note + "]") << '\n';
        }
        std::cout << "  Banker: " << displayFor(players, settings.banker)
                  << (settings.banker.empty() ? "  (off: preferences + automatic matching are used)"
                                              : "  (on: everyone settles through this person)") << '\n';
        std::cout << "  Me:     " << displayFor(players, settings.me) << "  (used for \"my winnings\" views)\n";
        std::cout << divider(60)
                  << "1. Add a pinned preference (someone always pays someone)\n"
                  << "2. Remove a pinned preference\n"
                  << "3. Set the banker\n"
                  << "4. Turn banker mode off\n"
                  << "5. Set who \"me\" is\n"
                  << "0. Back\n";
        int choice = console::askMenuChoice("Choose: ", 0, 5);

        if (choice == 0) return;

        if (choice == 1) {
            std::string payer = console::pickPlayer(players, "Who is the PAYER (sends their losses)?");
            if (payer.empty()) continue;
            std::string payee = console::pickPlayer(players, "Who should " + displayFor(players, payer) + " pay?");
            if (payee.empty()) continue;
            if (payer == payee) { std::cout << "A player cannot pay themselves.\n"; continue; }
            std::string note = console::askLine("Optional note (e.g. 'Venmo only'): ");
            prefs.push_back({payer, payee, note});
            savePreferencesCSV(prefsFile, prefs);
            std::cout << "Added.\n";
        } else if (choice == 2) {
            if (prefs.empty()) { std::cout << "Nothing to remove.\n"; continue; }
            int idx = console::askMenuChoice("Preference number to remove (0 to cancel): ", 0,
                                             static_cast<int>(prefs.size()));
            if (idx == 0) continue;
            prefs.erase(prefs.begin() + (idx - 1));
            savePreferencesCSV(prefsFile, prefs);
            std::cout << "Removed.\n";
        } else if (choice == 3) {
            std::string banker = console::pickPlayer(players, "Who is the banker?");
            if (banker.empty()) continue;
            settings.banker = banker;
            saveSettingsCSV(settingsFile, settings);
            std::cout << "Banker set. Every settlement now routes through " << displayFor(players, banker) << ".\n";
        } else if (choice == 4) {
            settings.banker.clear();
            saveSettingsCSV(settingsFile, settings);
            std::cout << "Banker mode off.\n";
        } else if (choice == 5) {
            std::string me = console::pickPlayer(players, "Which player is you?");
            if (me.empty()) continue;
            settings.me = me;
            saveSettingsCSV(settingsFile, settings);
            std::cout << "Saved.\n";
        }
    }
}

}  // namespace settlement
