#include "settlement.hpp"

#include <algorithm>
#include <fstream>
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
    auto pay = [&](Balance& from, Balance& to, double amount, const std::string& reason) {
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

    // 2. Pinned preferences, in the order they were added.
    for (const PaymentPreference& pref : prefs) {
        auto payer = balances.find(pref.payerNormalized);
        auto payee = balances.find(pref.payeeNormalized);
        if (payer == balances.end() || payee == balances.end()) continue;
        if (payer->second.amount >= -EPSILON || payee->second.amount <= EPSILON) continue;
        double amount = std::min(-payer->second.amount, payee->second.amount);
        pay(payer->second, payee->second, amount, "preference");
    }

    // 3. Greedy: biggest remaining debt pays biggest remaining credit.
    std::vector<Balance*> losers;
    std::vector<Balance*> winners;
    for (auto& pair : balances) {
        if (pair.second.amount < -EPSILON) losers.push_back(&pair.second);
        else if (pair.second.amount > EPSILON) winners.push_back(&pair.second);
    }
    std::sort(losers.begin(), losers.end(), [](Balance* a, Balance* b) { return a->amount < b->amount; });
    std::sort(winners.begin(), winners.end(), [](Balance* a, Balance* b) { return a->amount > b->amount; });

    size_t i = 0, j = 0;
    while (i < losers.size() && j < winners.size()) {
        double amount = std::min(-losers[i]->amount, winners[j]->amount);
        pay(*losers[i], *winners[j], amount, "auto");
        if (losers[i]->amount >= -EPSILON) ++i;
        if (winners[j]->amount <= EPSILON) ++j;
    }
    return out;
}

// ---------------- output ----------------

void print(const std::vector<SettlementEntry>& entries) {
    std::cout << "\nSettlement sheet:\n" << divider(84);
    if (entries.empty()) {
        std::cout << "No payments needed. Everyone is already settled.\n" << divider(84) << '\n';
        return;
    }
    std::cout << padRight("#", 4) << padRight("From (pays)", 24) << padRight("To (receives)", 24)
              << padLeft("Amount", 12) << "    Why\n" << divider(84);

    std::map<std::string, double> sends, receives;
    for (size_t i = 0; i < entries.size(); ++i) {
        const SettlementEntry& e = entries[i];
        std::cout << padRight(std::to_string(i + 1), 4) << padRight(e.fromDisplay, 24) << padRight(e.toDisplay, 24)
                  << padLeft(money(e.amount), 12) << "    " << e.reason << '\n';
        sends[e.fromDisplay] += e.amount;
        receives[e.toDisplay] += e.amount;
    }
    std::cout << divider(84);

    std::cout << "\nPer-person totals:\n";
    for (const auto& s : sends) std::cout << "  " << padRight(s.first, 24) << " sends    " << money(s.second) << '\n';
    for (const auto& r : receives) std::cout << "  " << padRight(r.first, 24) << " receives " << money(r.second) << '\n';
    std::cout << '\n';
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

static std::string pickPlayer(const std::vector<PlayerStats>& players, const std::string& prompt) {
    std::cout << '\n' << divider(50);
    for (size_t i = 0; i < players.size(); ++i) {
        std::cout << padRight(std::to_string(i + 1), 5) << padRight(players[i].displayName, 24)
                  << padLeft(moneySigned(players[i].totalNet), 12) << '\n';
    }
    std::cout << divider(50);
    int choice = console::askMenuChoice(prompt + " (0 to cancel): ", 0, static_cast<int>(players.size()));
    if (choice == 0) return "";
    return players[choice - 1].normalizedName;
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
            std::string payer = pickPlayer(players, "Who is the PAYER (sends their losses)?");
            if (payer.empty()) continue;
            std::string payee = pickPlayer(players, "Who should " + displayFor(players, payer) + " pay?");
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
            std::string banker = pickPlayer(players, "Who is the banker?");
            if (banker.empty()) continue;
            settings.banker = banker;
            saveSettingsCSV(settingsFile, settings);
            std::cout << "Banker set. Every settlement now routes through " << displayFor(players, banker) << ".\n";
        } else if (choice == 4) {
            settings.banker.clear();
            saveSettingsCSV(settingsFile, settings);
            std::cout << "Banker mode off.\n";
        } else if (choice == 5) {
            std::string me = pickPlayer(players, "Which player is you?");
            if (me.empty()) continue;
            settings.me = me;
            saveSettingsCSV(settingsFile, settings);
            std::cout << "Saved.\n";
        }
    }
}

}  // namespace settlement
