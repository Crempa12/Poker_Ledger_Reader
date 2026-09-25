#include "adjustments.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <iostream>

#include "console.hpp"
#include "players.hpp"
#include "ui.hpp"

using namespace util;

namespace adjustments {

bool loadCSV(const std::string& filename, std::vector<Adjustment>& list) {
    std::vector<std::vector<std::string>> rows;
    if (!readCSV(filename, rows)) return false;
    for (const std::vector<std::string>& row : rows) {
        if (row.size() < 4) continue;
        Adjustment a;
        a.group = trim(row[0]);
        a.date = parseLocalDate(row[1], false);
        a.playerNormalized = normalizeName(row[2]);
        a.amount = toDoubleSafe(row[3]);
        a.folder = row.size() > 4 ? trim(row[4]) : "";
        a.note = row.size() > 5 ? trim(row[5]) : "";
        if (a.playerNormalized.empty() || (a.amount > -EPSILON && a.amount < EPSILON)) continue;
        list.push_back(a);
    }
    return true;
}

bool saveCSV(const std::string& filename, const std::vector<Adjustment>& list) {
    std::ofstream out(filename);
    if (!out.is_open()) return false;
    out << "group,date,player_normalized,amount,folder,note\n";
    for (const Adjustment& a : list) {
        out << escapeCSV(a.group) << ',' << formatLocalDate(a.date) << ',' << escapeCSV(a.playerNormalized) << ','
            << fixed2(a.amount) << ',' << escapeCSV(a.folder) << ',' << escapeCSV(a.note) << '\n';
    }
    return true;
}

std::vector<const Adjustment*> filter(const std::vector<Adjustment>& list, const Scope& scope) {
    std::vector<const Adjustment*> out;
    for (const Adjustment& a : list) if (scope.contains(a.folder, a.date)) out.push_back(&a);
    return out;
}

void printList(const std::vector<Adjustment>& list, const std::vector<PlayerStats>& players) {
    const int W = 96;
    std::cout << '\n' << ui::heading("Payments & corrections (every folder and date)", W) << '\n'
              << ui::dim("  They change who owes whom on settlement sheets, never the leaderboard.") << "\n\n";
    if (list.empty()) {
        std::cout << "  none yet\n\n";
        return;
    }
    std::cout << ui::bold(padLeft("#", 4) + "  " + padRight("Date", 12) + padRight("Player", 18) + padLeft("Amount", 12) + "  " +
                          padRight("Folder", 18) + "Note")
              << '\n' << ui::rule(W) << '\n';
    for (size_t i = 0; i < list.size(); ++i) {
        const Adjustment& a = list[i];
        std::cout << padLeft(std::to_string(i + 1), 4) << "  " << padRight(formatLocalDate(a.date), 12)
                  << padRight(players::displayName(players, a.playerNormalized), 18) << padLeft(ui::net(a.amount), 12) << "  "
                  << padRight(a.folder.empty() ? "(all folders)" : a.folder, 18) << padRight(a.note, W - 68) << '\n';
    }
    std::cout << ui::rule(W) << '\n';
}

static std::int64_t askDate() {
    while (true) {
        std::string s = console::askLine("Date YYYY-MM-DD [today]: ");
        if (s.empty()) return parseLocalDate(formatLocalDate(nowEpoch()), false);
        std::int64_t d = parseLocalDate(s, false);
        if (d != NO_TIME) return d;
        std::cout << "Could not read that date.\n";
    }
}

// Group ids must be unique across runs, not just within one: keep bumping the
// suffix until nothing in the saved list uses it.
static std::string newGroup(const std::vector<Adjustment>& list) {
    static int counter = 0;
    while (true) {
        std::string candidate = "adj" + std::to_string(nowEpoch()) + "-" + std::to_string(++counter);
        bool taken = false;
        for (const Adjustment& a : list) if (a.group == candidate) { taken = true; break; }
        if (!taken) return candidate;
    }
}

bool manage(std::vector<Adjustment>& list,
            const std::vector<PlayerStats>& players,
            const Scope& scope,
            const std::string& filename) {
    bool changed = false;
    while (true) {
        printList(list, players);
        std::cout << ui::dim("  New entries go under: " +
                             (scope.folder.empty() ? std::string("all folders (they count only when settling everything)")
                                                   : scope.folder + " (the current folder)")) << "\n\n"
                  << "  1. Money that changed hands outside the ledger (a payment, or a debt let go)\n"
                  << "  2. Correct one player's balance by hand (one-sided)\n"
                  << "  3. Remove an entry\n"
                  << "  0. Back\n";
        int choice = console::askMenuChoice("Choose: ", 0, 3);
        if (choice == 0) return changed;

        if (choice == 1) {
            // Both sides at once, so the books stay balanced: the one who owed owes less,
            // the one who was owed is owed less.
            std::string creditor = console::pickPlayer(players, "Who got the money, or let the debt go? (they were owed)");
            if (creditor.empty()) continue;
            std::string debtor = console::pickPlayer(players, "Who paid it, or was let off? (they owed it)");
            if (debtor.empty() || debtor == creditor) { std::cout << "Cancelled.\n"; continue; }
            double amount = console::askAmount("Amount: ");
            if (amount < EPSILON) continue;
            std::string note = console::askLine("Note [paid]: ");
            if (note.empty()) note = "paid";
            std::int64_t date = askDate();
            std::string group = newGroup(list);
            std::string from = players::displayName(players, debtor), to = players::displayName(players, creditor);
            list.push_back({group, date, debtor, +amount, scope.folder, note + " (to " + to + ")"});
            list.push_back({group, date, creditor, -amount, scope.folder, note + " (from " + from + ")"});
            std::cout << from << " now owes " << money(amount) << " less and " << to << " is owed " << money(amount)
                      << " less. The leaderboard does not change.\n";
            changed = true;
        } else if (choice == 2) {
            std::string who = console::pickPlayer(players, "Which player?");
            if (who.empty()) continue;
            double amount = console::askSignedAmount("Amount to add to their balance (negative to subtract): ");
            if (amount > -EPSILON && amount < EPSILON) continue;
            std::string note = console::askLine("Note: ");
            std::int64_t date = askDate();
            list.push_back({newGroup(list), date, who, amount, scope.folder, note});
            std::cout << ui::yellow("Added. It is one-sided: settlement sheets will be short by " + money(std::fabs(amount)) +
                                    " until the other side is entered.") << '\n';
            changed = true;
        } else if (choice == 3) {
            if (list.empty()) continue;
            int idx = console::askMenuChoice("Entry number to remove (0 to cancel): ", 0, static_cast<int>(list.size()));
            if (idx == 0) continue;
            std::string group = list[idx - 1].group;
            size_t before = list.size();
            list.erase(std::remove_if(list.begin(), list.end(),
                                      [&](const Adjustment& a) { return a.group == group; }),
                       list.end());
            std::cout << "Removed " << (before - list.size()) << " row" << (before - list.size() == 1 ? "" : "s")
                      << (before - list.size() > 1 ? " (both sides of the payment)" : "") << ".\n";
            changed = true;
        }
        if (changed) saveCSV(filename, list);
    }
}

}  // namespace adjustments
