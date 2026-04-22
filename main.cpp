#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <filesystem>
#include <unordered_map>
#include <vector>
#include <algorithm>
#include <cctype>
#include <iomanip>
#include <limits>

namespace fs = std::filesystem;

struct PlayerStats {
    std::string displayName;
    std::string normalizedName;
    double totalNet = 0.0;
    double totalUps = 0.0;
    double totalDowns = 0.0;
    int sessions = 0;
};

struct SettlementEntry {
    std::string from;
    std::string to;
    double amount = 0.0;
};

// -----------------------------
// Utility helpers
// -----------------------------

std::vector<std::string> splitCSVLine(const std::string& line) {
    std::vector<std::string> result;
    std::stringstream ss(line);
    std::string cell;

    while (std::getline(ss, cell, ',')) {
        result.push_back(cell);
    }

    return result;
}

std::string trim(const std::string& s) {
    size_t start = 0;
    while (start < s.size() && std::isspace(static_cast<unsigned char>(s[start]))) {
        ++start;
    }

    size_t end = s.size();
    while (end > start && std::isspace(static_cast<unsigned char>(s[end - 1]))) {
        --end;
    }

    return s.substr(start, end - start);
}

double toDollarAmountFromCents(const std::string& s) {
    if (s.empty()) return 0.0;

    try {
        return std::stod(trim(s)) / 100.0;
    }
    catch (...) {
        return 0.0;
    }
}

std::string normalizeName(const std::string& name) {
    std::string cleaned;

    for (char ch : name) {
        if (std::isalpha(static_cast<unsigned char>(ch))) {
            cleaned += static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
        }
    }

    return cleaned;
}

std::string escapeCSV(const std::string& s) {
    if (s.find(',') != std::string::npos || s.find('"') != std::string::npos) {
        std::string escaped = "\"";
        for (char c : s) {
            if (c == '"') {
                escaped += "\"\"";
            }
            else {
                escaped += c;
            }
        }
        escaped += "\"";
        return escaped;
    }
    return s;
}

char askYesNo(const std::string& prompt) {
    char choice;
    while (true) {
        std::cout << prompt;
        std::cin >> choice;
        choice = static_cast<char>(std::tolower(static_cast<unsigned char>(choice)));

        if (choice == 'y' || choice == 'n') {
            return choice;
        }

        std::cout << "Please enter y or n.\n";
    }
}

void clearInputLine() {
    std::cin.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
}

// -----------------------------
// Reading ledger CSVs
// -----------------------------

void readCSV(const std::string& filename, std::unordered_map<std::string, PlayerStats>& players) {
    std::ifstream file(filename);
    if (!file.is_open()) {
        std::cerr << "Could not open file: " << filename << '\n';
        return;
    }

    std::string line;

    if (!std::getline(file, line)) {
        return;
    }

    std::vector<std::string> headers = splitCSVLine(line);

    int nameIndex = -1;
    int netIndex = -1;

    for (int i = 0; i < static_cast<int>(headers.size()); ++i) {
        std::string header = trim(headers[i]);

        if (header == "player_nickname") {
            nameIndex = i;
        }
        else if (header == "net") {
            netIndex = i;
        }
    }

    if (nameIndex == -1 || netIndex == -1) {
        std::cerr << "Missing required columns in file: " << filename << '\n';
        return;
    }

    while (std::getline(file, line)) {
        if (line.empty()) continue;

        std::vector<std::string> row = splitCSVLine(line);

        if (nameIndex >= static_cast<int>(row.size()) || netIndex >= static_cast<int>(row.size())) {
            continue;
        }

        std::string rawName = trim(row[nameIndex]);
        std::string normalized = normalizeName(rawName);
        double net = toDollarAmountFromCents(row[netIndex]);

        if (normalized.empty()) {
            continue;
        }

        if (players.find(normalized) == players.end()) {
            PlayerStats newPlayer;
            newPlayer.displayName = rawName;
            newPlayer.normalizedName = normalized;
            players[normalized] = newPlayer;
        }

        PlayerStats& player = players[normalized];
        player.sessions++;
        player.totalNet += net;

        if (net > 0) {
            player.totalUps += net;
        }
        else if (net < 0) {
            player.totalDowns += net;
        }
    }
}

// -----------------------------
// Sorting / printing
// -----------------------------

std::vector<PlayerStats> sortPlayersByName(const std::unordered_map<std::string, PlayerStats>& players) {
    std::vector<PlayerStats> sortedPlayers;
    sortedPlayers.reserve(players.size());

    for (const auto& pair : players) {
        sortedPlayers.push_back(pair.second);
    }

    std::sort(sortedPlayers.begin(), sortedPlayers.end(),
        [](const PlayerStats& a, const PlayerStats& b) {
            return a.normalizedName < b.normalizedName;
        });

    return sortedPlayers;
}

void printDivider(int width = 104) {
    std::cout << std::string(width, '=') << '\n';
}

void printPlayerTable(const std::vector<PlayerStats>& players) {
    std::cout << std::fixed << std::setprecision(2);

    printDivider();
    std::cout << std::left
              << std::setw(5)  << "#"
              << std::setw(24) << "Player"
              << std::setw(22) << "Normalized"
              << std::setw(10) << "Sessions"
              << std::setw(14) << "Total Ups"
              << std::setw(14) << "Total Downs"
              << std::setw(14) << "Total Net"
              << '\n';
    printDivider();

    double grandTotal = 0.0;

    for (size_t i = 0; i < players.size(); ++i) {
        const PlayerStats& p = players[i];
        grandTotal += p.totalNet;

        std::cout << std::left
                  << std::setw(5)  << (i + 1)
                  << std::setw(24) << p.displayName
                  << std::setw(22) << p.normalizedName
                  << std::setw(10) << p.sessions
                  << std::setw(14) << p.totalUps
                  << std::setw(14) << p.totalDowns
                  << std::setw(14) << p.totalNet
                  << '\n';
    }

    printDivider();
    std::cout << "Grand Total: $" << grandTotal << "\n\n";
}

void printCompactPlayerList(const std::vector<PlayerStats>& players) {
    std::cout << std::fixed << std::setprecision(2);

    printDivider(78);
    std::cout << std::left
              << std::setw(5)  << "#"
              << std::setw(28) << "Player"
              << std::setw(22) << "Normalized"
              << std::setw(12) << "Net"
              << '\n';
    printDivider(78);

    for (size_t i = 0; i < players.size(); ++i) {
        std::cout << std::left
                  << std::setw(5)  << (i + 1)
                  << std::setw(28) << players[i].displayName
                  << std::setw(22) << players[i].normalizedName
                  << std::setw(12) << players[i].totalNet
                  << '\n';
    }

    printDivider(78);
}

// -----------------------------
// Merge rule system
// alias -> canonical
// Example: "yadenfr" -> "yaden"
// -----------------------------

std::string resolveCanonical(const std::unordered_map<std::string, std::string>& mergeRules,
                             const std::string& key) {
    std::string current = key;

    while (true) {
        auto it = mergeRules.find(current);
        if (it == mergeRules.end() || it->second == current) {
            return current;
        }
        current = it->second;
    }
}

void flattenMergeRules(std::unordered_map<std::string, std::string>& mergeRules) {
    for (auto& pair : mergeRules) {
        pair.second = resolveCanonical(mergeRules, pair.second);
    }
}

void mergeTwoPlayers(std::unordered_map<std::string, PlayerStats>& players,
                     std::unordered_map<std::string, std::string>& mergeRules,
                     const std::string& keepKey,
                     const std::string& removeKey) {
    if (keepKey == removeKey) return;
    if (players.find(keepKey) == players.end()) return;
    if (players.find(removeKey) == players.end()) return;

    PlayerStats& keepPlayer = players[keepKey];
    PlayerStats& removePlayer = players[removeKey];

    keepPlayer.totalNet += removePlayer.totalNet;
    keepPlayer.totalUps += removePlayer.totalUps;
    keepPlayer.totalDowns += removePlayer.totalDowns;
    keepPlayer.sessions += removePlayer.sessions;

    // Prefer shorter display name if it looks cleaner
    if (removePlayer.displayName.size() < keepPlayer.displayName.size()) {
        keepPlayer.displayName = removePlayer.displayName;
    }

    players.erase(removeKey);

    // Record merge rule
    mergeRules[removeKey] = keepKey;

    // Redirect any old rules that pointed to removeKey
    for (auto& pair : mergeRules) {
        if (resolveCanonical(mergeRules, pair.second) == removeKey) {
            pair.second = keepKey;
        }
    }

    flattenMergeRules(mergeRules);
}

void applySavedMergeRules(std::unordered_map<std::string, PlayerStats>& players,
                          std::unordered_map<std::string, std::string>& mergeRules) {
    flattenMergeRules(mergeRules);

    std::vector<std::pair<std::string, std::string>> rules;
    for (const auto& pair : mergeRules) {
        rules.push_back(pair);
    }

    for (const auto& pair : rules) {
        std::string alias = pair.first;
        std::string canonical = resolveCanonical(mergeRules, pair.second);

        if (alias == canonical) continue;

        auto aliasIt = players.find(alias);
        if (aliasIt == players.end()) {
            continue;
        }

        auto canonicalIt = players.find(canonical);

        if (canonicalIt == players.end()) {
            PlayerStats moved = aliasIt->second;
            moved.normalizedName = canonical;
            players[canonical] = moved;
            players.erase(aliasIt);
        }
        else {
            PlayerStats& keepPlayer = players[canonical];
            PlayerStats& removePlayer = players[alias];

            keepPlayer.totalNet += removePlayer.totalNet;
            keepPlayer.totalUps += removePlayer.totalUps;
            keepPlayer.totalDowns += removePlayer.totalDowns;
            keepPlayer.sessions += removePlayer.sessions;

            if (removePlayer.displayName.size() < keepPlayer.displayName.size()) {
                keepPlayer.displayName = removePlayer.displayName;
            }

            players.erase(alias);
        }
    }
}

bool loadMergeRulesFromCSV(const std::string& filename,
                           std::unordered_map<std::string, std::string>& mergeRules) {
    std::ifstream file(filename);
    if (!file.is_open()) {
        return false;
    }

    std::string line;
    bool firstLine = true;

    while (std::getline(file, line)) {
        if (line.empty()) continue;

        // Skip header if present
        if (firstLine) {
            firstLine = false;
            if (line.find("alias_normalized") != std::string::npos) {
                continue;
            }
        }

        std::vector<std::string> row = splitCSVLine(line);
        if (row.size() < 2) continue;

        std::string alias = normalizeName(trim(row[0]));
        std::string canonical = normalizeName(trim(row[1]));

        if (!alias.empty() && !canonical.empty() && alias != canonical) {
            mergeRules[alias] = canonical;
        }
    }

    flattenMergeRules(mergeRules);
    return true;
}

bool saveMergeRulesToCSV(const std::string& filename,
                         std::unordered_map<std::string, std::string>& mergeRules) {
    flattenMergeRules(mergeRules);

    std::ofstream out(filename);
    if (!out.is_open()) {
        return false;
    }

    out << "alias_normalized,canonical_normalized\n";

    std::vector<std::pair<std::string, std::string>> rules;
    for (const auto& pair : mergeRules) {
        if (pair.first != pair.second) {
            rules.push_back(pair);
        }
    }

    std::sort(rules.begin(), rules.end(),
        [](const auto& a, const auto& b) {
            if (a.second == b.second) return a.first < b.first;
            return a.second < b.second;
        });

    for (const auto& pair : rules) {
        out << escapeCSV(pair.first) << ',' << escapeCSV(pair.second) << '\n';
    }

    return true;
}

void manuallyMergePlayers(std::unordered_map<std::string, PlayerStats>& players,
                          std::unordered_map<std::string, std::string>& mergeRules) {
    while (true) {
        std::vector<PlayerStats> sortedPlayers = sortPlayersByName(players);

        std::cout << "\nCurrent player list:\n";
        printCompactPlayerList(sortedPlayers);

        char choice = askYesNo("Would you like to merge any names? (y/n): ");
        if (choice == 'n') {
            break;
        }

        size_t keepIndex;
        size_t mergeIndex;

        std::cout << "Enter the number of the player you want to KEEP: ";
        std::cin >> keepIndex;

        std::cout << "Enter the number of the player you want to MERGE INTO that player: ";
        std::cin >> mergeIndex;

        if (keepIndex < 1 || keepIndex > sortedPlayers.size() ||
            mergeIndex < 1 || mergeIndex > sortedPlayers.size()) {
            std::cout << "Invalid selection.\n";
            continue;
        }

        if (keepIndex == mergeIndex) {
            std::cout << "You cannot merge a player into themselves.\n";
            continue;
        }

        std::string keepKey = sortedPlayers[keepIndex - 1].normalizedName;
        std::string removeKey = sortedPlayers[mergeIndex - 1].normalizedName;

        std::cout << "Merging \""
                  << sortedPlayers[mergeIndex - 1].displayName
                  << "\" into \""
                  << sortedPlayers[keepIndex - 1].displayName
                  << "\"...\n";

        mergeTwoPlayers(players, mergeRules, keepKey, removeKey);

        std::cout << "Merge complete.\n";
    }
}

// -----------------------------
// Summary CSV export
// -----------------------------

bool exportPlayerSummaryCSV(const std::string& filename, const std::vector<PlayerStats>& players) {
    std::ofstream out(filename);
    if (!out.is_open()) {
        return false;
    }

    out << "display_name,normalized_name,sessions,total_ups,total_downs,total_net\n";
    out << std::fixed << std::setprecision(2);

    for (const PlayerStats& p : players) {
        out << escapeCSV(p.displayName) << ','
            << escapeCSV(p.normalizedName) << ','
            << p.sessions << ','
            << p.totalUps << ','
            << p.totalDowns << ','
            << p.totalNet << '\n';
    }

    return true;
}

// -----------------------------
// Settlements
// -----------------------------

std::vector<SettlementEntry> calculateSettlements(const std::vector<PlayerStats>& players) {
    struct Balance {
        std::string name;
        double amount;
    };

    std::vector<Balance> winners;
    std::vector<Balance> losers;
    std::vector<SettlementEntry> settlements;

    const double EPSILON = 0.009;

    for (const PlayerStats& player : players) {
        if (player.totalNet > EPSILON) {
            winners.push_back({player.displayName, player.totalNet});
        }
        else if (player.totalNet < -EPSILON) {
            losers.push_back({player.displayName, -player.totalNet});
        }
    }

    std::sort(winners.begin(), winners.end(),
        [](const Balance& a, const Balance& b) {
            return a.amount > b.amount;
        });

    std::sort(losers.begin(), losers.end(),
        [](const Balance& a, const Balance& b) {
            return a.amount > b.amount;
        });

    size_t i = 0; // loser
    size_t j = 0; // winner

    while (i < losers.size() && j < winners.size()) {
        double payment = std::min(losers[i].amount, winners[j].amount);

        if (payment > EPSILON) {
            settlements.push_back({losers[i].name, winners[j].name, payment});
        }

        losers[i].amount -= payment;
        winners[j].amount -= payment;

        if (losers[i].amount <= EPSILON) ++i;
        if (winners[j].amount <= EPSILON) ++j;
    }

    return settlements;
}

void printSettlements(const std::vector<SettlementEntry>& settlements) {
    std::cout << std::fixed << std::setprecision(2);

    std::cout << "\nSettlement instructions:\n";
    printDivider(70);

    if (settlements.empty()) {
        std::cout << "No payments needed. Everyone is already settled.\n";
        printDivider(70);
        return;
    }

    std::cout << std::left
              << std::setw(24) << "From"
              << std::setw(24) << "To"
              << std::setw(12) << "Amount"
              << '\n';
    printDivider(70);

    for (const SettlementEntry& s : settlements) {
        std::cout << std::left
                  << std::setw(24) << s.from
                  << std::setw(24) << s.to
                  << ('$' + static_cast<std::ostringstream&&>(std::ostringstream() << std::fixed << std::setprecision(2) << s.amount).str())
                  << '\n';
    }

    printDivider(70);
    std::cout << '\n';
}

bool exportSettlementsCSV(const std::string& filename, const std::vector<SettlementEntry>& settlements) {
    std::ofstream out(filename);
    if (!out.is_open()) {
        return false;
    }

    out << "from,to,amount\n";
    out << std::fixed << std::setprecision(2);

    for (const SettlementEntry& s : settlements) {
        out << escapeCSV(s.from) << ','
            << escapeCSV(s.to) << ','
            << s.amount << '\n';
    }

    return true;
}

// -----------------------------
// Main
// -----------------------------

int main() {
    std::string dataFolder = "/Users/cameron/CLionProjects/Poker_Ledger_Reader/data_folder";
    std::string mergeRulesFile = "merge_rules.csv";
    std::string summaryFile = "player_summary.csv";
    std::string settlementFile = "settlements.csv";

    std::unordered_map<std::string, PlayerStats> players;
    std::unordered_map<std::string, std::string> mergeRules;

    try {
        for (const auto& entry : fs::directory_iterator(dataFolder)) {
            if (entry.path().extension() == ".csv") {
                readCSV(entry.path().string(), players);
            }
        }
    }
    catch (const std::exception& e) {
        std::cerr << "Error reading directory: " << e.what() << '\n';
        return 1;
    }

    std::cout << "\nLoaded " << players.size() << " normalized players from ledger files.\n";

    if (fs::exists(mergeRulesFile)) {
        char loadChoice = askYesNo("Found merge_rules.csv. Load saved merge rules? (y/n): ");
        if (loadChoice == 'y') {
            if (loadMergeRulesFromCSV(mergeRulesFile, mergeRules)) {
                applySavedMergeRules(players, mergeRules);
                std::cout << "Saved merge rules applied.\n";
            }
            else {
                std::cout << "Could not load merge rules file.\n";
            }
        }
    }

    char manualMergeChoice = askYesNo("Would you like to manually merge player names now? (y/n): ");
    if (manualMergeChoice == 'y') {
        manuallyMergePlayers(players, mergeRules);
    }

    std::vector<PlayerStats> sortedPlayers = sortPlayersByName(players);

    std::cout << "\nFinal player summary:\n";
    printPlayerTable(sortedPlayers);

    char saveRulesChoice = askYesNo("Would you like to save these merge rules for next time? (y/n): ");
    if (saveRulesChoice == 'y') {
        if (saveMergeRulesToCSV(mergeRulesFile, mergeRules)) {
            std::cout << "Merge rules saved to " << mergeRulesFile << '\n';
        }
        else {
            std::cout << "Could not save merge rules.\n";
        }
    }

    char exportSummaryChoice = askYesNo("Would you like to export the player summary to CSV? (y/n): ");
    if (exportSummaryChoice == 'y') {
        if (exportPlayerSummaryCSV(summaryFile, sortedPlayers)) {
            std::cout << "Player summary exported to " << summaryFile << '\n';
        }
        else {
            std::cout << "Could not export player summary.\n";
        }
    }

    char settlementChoice = askYesNo("Would you like to calculate who should pay whom? (y/n): ");
    if (settlementChoice == 'y') {
        std::vector<SettlementEntry> settlements = calculateSettlements(sortedPlayers);
        printSettlements(settlements);

        char exportSettlementChoice = askYesNo("Would you like to export settlements to CSV? (y/n): ");
        if (exportSettlementChoice == 'y') {
            if (exportSettlementsCSV(settlementFile, settlements)) {
                std::cout << "Settlements exported to " << settlementFile << '\n';
            }
            else {
                std::cout << "Could not export settlements.\n";
            }
        }
    }

    std::cout << "\nDone.\n";
    return 0;
}