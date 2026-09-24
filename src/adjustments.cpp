#include "adjustments.hpp"

#include <algorithm>
#include <fstream>
#include <iostream>

#include "console.hpp"
#include "players.hpp"

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
    std::cout << "\nAdjustments (all folders and dates)\n" << divider(100);
    if (list.empty()) {
        std::cout << "  none\n" << divider(100) << '\n';
        return;
    }
    std::cout << padRight("#", 4) << padRight("Date", 12) << padRight("Player", 20) << padLeft("Amount", 12)
              << "  " << padRight("Folder", 26) << "Note\n" << divider(100);
    for (size_t i = 0; i < list.size(); ++i) {
        const Adjustment& a = list[i];
        std::cout << padRight(std::to_string(i + 1), 4) << padRight(formatLocalDate(a.date), 12)
                  << padRight(players::displayName(players, a.playerNormalized), 20) << padLeft(moneySigned(a.amount), 12)
                  << "  " << padRight(a.folder.empty() ? "(any)" : a.folder, 26) << a.note << '\n';
    }
    std::cout << divider(100) << '\n';
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
        std::cout << "New adjustments are tagged with the current folder scope: "
                  << (scope.folder.empty() ? "(any folder)" : scope.folder) << "\n" << divider(60)
                  << "1. Forgive a debt (someone lets someone off part of what they owe)\n"
                  << "2. Add or subtract from one player's total (one-sided correction)\n"
                  << "3. Remove an adjustment\n"
                  << "0. Back\n";
        int choice = console::askMenuChoice("Choose: ", 0, 3);
        if (choice == 0) return changed;

        if (choice == 1) {
            std::string creditor = console::pickPlayer(players, "Who is letting the money go (the person owed)?");
            if (creditor.empty()) continue;
            std::string debtor = console::pickPlayer(players, "Who owed it?");
            if (debtor.empty() || debtor == creditor) { std::cout << "Cancelled.\n"; continue; }
            double amount = console::askAmount("Amount forgiven: ");
            if (amount < EPSILON) continue;
            std::string note = console::askLine("Note [forgiven]: ");
            if (note.empty()) note = "forgiven";
            std::int64_t date = askDate();
            std::string group = newGroup(list);
            list.push_back({group, date, debtor, +amount, scope.folder, note + " (by " + players::displayName(players, creditor) + ")"});
            list.push_back({group, date, creditor, -amount, scope.folder, note + " (for " + players::displayName(players, debtor) + ")"});
            std::cout << players::displayName(players, debtor) << " +" << money(amount) << ", " << players::displayName(players, creditor)
                      << " -" << money(amount) << ". Totals still sum to zero.\n";
            changed = true;
        } else if (choice == 2) {
            std::string who = console::pickPlayer(players, "Which player?");
            if (who.empty()) continue;
            double amount = console::askSignedAmount("Amount to add (negative to subtract): ");
            if (amount > -EPSILON && amount < EPSILON) continue;
            std::string note = console::askLine("Note: ");
            std::int64_t date = askDate();
            list.push_back({newGroup(list), date, who, amount, scope.folder, note});
            std::cout << "Added. This is one-sided, so the leaderboard total will no longer be $0.00.\n";
            changed = true;
        } else if (choice == 3) {
            if (list.empty()) continue;
            int idx = console::askMenuChoice("Adjustment number to remove (0 to cancel): ", 0, static_cast<int>(list.size()));
            if (idx == 0) continue;
            std::string group = list[idx - 1].group;
            size_t before = list.size();
            list.erase(std::remove_if(list.begin(), list.end(),
                                      [&](const Adjustment& a) { return a.group == group; }),
                       list.end());
            std::cout << "Removed " << (before - list.size()) << " row" << (before - list.size() == 1 ? "" : "s")
                      << (before - list.size() > 1 ? " (both halves of the forgiven debt)" : "") << ".\n";
            changed = true;
        }
        if (changed) saveCSV(filename, list);
    }
}

}  // namespace adjustments
