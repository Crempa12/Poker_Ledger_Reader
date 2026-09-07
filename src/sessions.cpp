#include "sessions.hpp"

#include <algorithm>
#include <fstream>
#include <iostream>
#include <map>

#include "console.hpp"

using namespace util;

namespace sessions {

static std::string makeKey(const std::string& sessionId, const std::string& fromNorm, const std::string& toNorm) {
    return sessionId + "|" + fromNorm + "->" + toNorm;
}

static void updateStatus(SessionBalance& bal) {
    if (bal.remainingAmount <= EPSILON) {
        bal.remainingAmount = 0.0;
        bal.status = "paid";
    } else if (bal.remainingAmount < bal.originalAmount - EPSILON) {
        bal.status = "partial";
    } else {
        bal.status = "open";
    }
}

static bool byKey(const SessionBalance& a, const SessionBalance& b) {
    if (a.sessionId != b.sessionId) return a.sessionId < b.sessionId;
    if (a.fromNormalized != b.fromNormalized) return a.fromNormalized < b.fromNormalized;
    return a.toNormalized < b.toNormalized;
}

bool load(const std::string& filename, Balances& balances) {
    std::ifstream file(filename);
    if (!file.is_open()) return false;

    std::string line;
    bool firstLine = true;
    while (std::getline(file, line)) {
        if (trim(line).empty()) continue;
        if (firstLine) {
            firstLine = false;
            if (line.find("session_id") != std::string::npos) continue;
        }
        std::vector<std::string> row = splitCSVLine(line);
        if (row.size() < 8) continue;

        SessionBalance bal;
        bal.sessionId = trim(row[0]);
        bal.fromDisplay = trim(row[1]);
        bal.fromNormalized = normalizeName(row[2]);
        bal.toDisplay = trim(row[3]);
        bal.toNormalized = normalizeName(row[4]);
        bal.originalAmount = toDoubleSafe(row[5]);
        bal.remainingAmount = toDoubleSafe(row[6]);
        bal.status = trim(row[7]);
        if (bal.sessionId.empty() || bal.fromNormalized.empty() || bal.toNormalized.empty()) continue;

        balances[makeKey(bal.sessionId, bal.fromNormalized, bal.toNormalized)] = bal;
    }
    return true;
}

bool save(const std::string& filename, const Balances& balances) {
    std::ofstream out(filename);
    if (!out.is_open()) return false;

    out << "session_id,from_display,from_normalized,to_display,to_normalized,original_amount,remaining_amount,status\n";
    std::vector<SessionBalance> rows;
    for (const auto& pair : balances) rows.push_back(pair.second);
    std::sort(rows.begin(), rows.end(), byKey);
    for (const SessionBalance& b : rows) {
        out << escapeCSV(b.sessionId) << ',' << escapeCSV(b.fromDisplay) << ',' << escapeCSV(b.fromNormalized) << ','
            << escapeCSV(b.toDisplay) << ',' << escapeCSV(b.toNormalized) << ',' << fixed2(b.originalAmount) << ','
            << fixed2(b.remainingAmount) << ',' << escapeCSV(b.status) << '\n';
    }
    return true;
}

void addSettlementBatch(const std::string& sessionId, const std::vector<SettlementEntry>& entries, Balances& balances) {
    for (const SettlementEntry& e : entries) {
        std::string key = makeKey(sessionId, e.fromNormalized, e.toNormalized);
        auto it = balances.find(key);
        if (it == balances.end()) {
            SessionBalance bal;
            bal.sessionId = sessionId;
            bal.fromDisplay = e.fromDisplay;
            bal.fromNormalized = e.fromNormalized;
            bal.toDisplay = e.toDisplay;
            bal.toNormalized = e.toNormalized;
            bal.originalAmount = e.amount;
            bal.remainingAmount = e.amount;
            bal.status = "open";
            balances[key] = bal;
        } else {
            it->second.originalAmount += e.amount;
            it->second.remainingAmount += e.amount;
            updateStatus(it->second);
        }
    }
}

static std::vector<std::pair<std::string, SessionBalance>> sortedRows(const Balances& balances, bool openOnly) {
    std::vector<std::pair<std::string, SessionBalance>> rows;
    for (const auto& pair : balances) {
        if (!openOnly || pair.second.remainingAmount > EPSILON) rows.push_back(pair);
    }
    std::sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) { return byKey(a.second, b.second); });
    return rows;
}

static void printRows(const std::vector<std::pair<std::string, SessionBalance>>& rows) {
    const int W = 118;
    std::cout << divider(W)
              << padRight("#", 4) << padRight("Session", 26) << padRight("From", 20) << padRight("To", 20)
              << padLeft("Original", 12) << padLeft("Remaining", 12) << "   Status\n" << divider(W);
    for (size_t i = 0; i < rows.size(); ++i) {
        const SessionBalance& b = rows[i].second;
        std::cout << padRight(std::to_string(i + 1), 4) << padRight(b.sessionId, 26) << padRight(b.fromDisplay, 20)
                  << padRight(b.toDisplay, 20) << padLeft(money(b.originalAmount), 12)
                  << padLeft(money(b.remainingAmount), 12) << "   " << b.status << '\n';
    }
    std::cout << divider(W);
}

void printBalances(const Balances& balances, bool openOnly) {
    std::vector<std::pair<std::string, SessionBalance>> rows = sortedRows(balances, openOnly);
    std::cout << (openOnly ? "\nOpen session balances:\n" : "\nAll session balances:\n");
    if (rows.empty()) {
        std::cout << "  none\n\n";
        return;
    }
    printRows(rows);
    std::cout << '\n';
}

void recordPayment(Balances& balances) {
    std::vector<std::pair<std::string, SessionBalance>> rows = sortedRows(balances, true);
    if (rows.empty()) {
        std::cout << "There are no unpaid session balances.\n";
        return;
    }
    std::cout << "\nOpen session balances:\n";
    printRows(rows);

    int choice = console::askMenuChoice("Choose a balance to update (0 to cancel): ", 0, static_cast<int>(rows.size()));
    if (choice == 0) return;

    SessionBalance& bal = balances[rows[choice - 1].first];
    double amount = console::askAmount("Amount paid (remaining " + money(bal.remainingAmount) + ", Enter 0 to cancel): ");
    if (amount <= 0.0) return;
    bal.remainingAmount = amount >= bal.remainingAmount ? 0.0 : bal.remainingAmount - amount;
    updateStatus(bal);
    std::cout << "Payment recorded. Status is now \"" << bal.status << "\".\n";
}

void printCombinedUnpaid(const Balances& balances) {
    struct Debt {
        std::string from, to;
        double total = 0.0;
    };
    std::map<std::string, Debt> combined;
    for (const auto& pair : balances) {
        const SessionBalance& b = pair.second;
        if (b.remainingAmount <= EPSILON) continue;
        Debt& d = combined[b.fromNormalized + "->" + b.toNormalized];
        d.from = b.fromDisplay;
        d.to = b.toDisplay;
        d.total += b.remainingAmount;
    }

    std::vector<Debt> rows;
    for (const auto& pair : combined) rows.push_back(pair.second);
    std::sort(rows.begin(), rows.end(), [](const Debt& a, const Debt& b) { return a.total > b.total; });

    std::cout << "\nCombined unpaid summary across all sessions:\n" << divider(70);
    if (rows.empty()) {
        std::cout << "No unpaid balances.\n" << divider(70) << '\n';
        return;
    }
    std::cout << padRight("#", 4) << padRight("From", 24) << padRight("To", 24) << padLeft("Still owed", 14) << '\n'
              << divider(70);
    for (size_t i = 0; i < rows.size(); ++i) {
        std::cout << padRight(std::to_string(i + 1), 4) << padRight(rows[i].from, 24) << padRight(rows[i].to, 24)
                  << padLeft(money(rows[i].total), 14) << '\n';
    }
    std::cout << divider(70) << '\n';
}

}  // namespace sessions
