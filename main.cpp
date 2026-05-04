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

using namespace std;
namespace fs = std::filesystem;

struct PlayerStats {
    string displayName;
    string normalizedName;
    double totalNet = 0.0;
    double totalUps = 0.0;
    double totalDowns = 0.0;
    int sessions = 0;
};

struct SettlementEntry {
    string from;
    string to;
    double amount = 0.0;
};

struct SessionBalance {
    string sessionId;
    string fromDisplay;
    string fromNormalized;
    string toDisplay;
    string toNormalized;
    double originalAmount = 0.0;
    double remainingAmount = 0.0;
    string status = "open"; // open, partial, paid
};

// --------------------------------------------------
// Utility
// --------------------------------------------------

vector<string> splitCSVLine(const string& line) {
    vector<string> result;
    string current;
    bool inQuotes = false;

    for (size_t i = 0; i < line.size(); ++i) {
        char c = line[i];

        if (c == '"') {
            if (inQuotes && i + 1 < line.size() && line[i + 1] == '"') {
                current += '"';
                ++i;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (c == ',' && !inQuotes) {
            result.push_back(current);
            current.clear();
        } else {
            current += c;
        }
    }

    result.push_back(current);
    return result;
}

string trim(const string& s) {
    size_t start = 0;
    while (start < s.size() && isspace(static_cast<unsigned char>(s[start]))) {
        ++start;
    }

    size_t end = s.size();
    while (end > start && isspace(static_cast<unsigned char>(s[end - 1]))) {
        --end;
    }

    return s.substr(start, end - start);
}

string normalizeName(const string& name) {
    string cleaned;
    for (char ch : name) {
        if (isalpha(static_cast<unsigned char>(ch))) {
            cleaned += static_cast<char>(tolower(static_cast<unsigned char>(ch)));
        }
    }
    return cleaned;
}

double toDollarAmountFromCents(const string& s) {
    if (s.empty()) return 0.0;
    try {
        return stod(trim(s)) / 100.0;
    } catch (...) {
        return 0.0;
    }
}

double toDoubleSafe(const string& s) {
    if (s.empty()) return 0.0;
    try {
        return stod(trim(s));
    } catch (...) {
        return 0.0;
    }
}

string escapeCSV(const string& s) {
    if (s.find(',') != string::npos || s.find('"') != string::npos) {
        string escaped = "\"";
        for (char c : s) {
            if (c == '"') escaped += "\"\"";
            else escaped += c;
        }
        escaped += "\"";
        return escaped;
    }
    return s;
}

string moneyString(double value) {
    ostringstream oss;
    oss << fixed << setprecision(2) << value;
    return "$" + oss.str();
}

void printDivider(int width = 100, char ch = '=') {
    cout << string(width, ch) << '\n';
}

char askYesNo(const string& prompt) {
    char choice;
    while (true) {
        cout << prompt;
        cin >> choice;
        choice = static_cast<char>(tolower(static_cast<unsigned char>(choice)));

        if (choice == 'y' || choice == 'n') {
            cin.ignore(numeric_limits<streamsize>::max(), '\n');
            return choice;
        }

        cout << "Please enter y or n.\n";
        cin.clear();
        cin.ignore(numeric_limits<streamsize>::max(), '\n');
    }
}

int askMenuChoice(const string& prompt, int minChoice, int maxChoice) {
    int choice;
    while (true) {
        cout << prompt;
        if (cin >> choice && choice >= minChoice && choice <= maxChoice) {
            cin.ignore(numeric_limits<streamsize>::max(), '\n');
            return choice;
        }

        cout << "Invalid choice. Please try again.\n";
        cin.clear();
        cin.ignore(numeric_limits<streamsize>::max(), '\n');
    }
}

double askAmount(const string& prompt) {
    double amount;
    while (true) {
        cout << prompt;
        if (cin >> amount && amount >= 0.0) {
            cin.ignore(numeric_limits<streamsize>::max(), '\n');
            return amount;
        }

        cout << "Invalid amount. Please enter a non-negative number.\n";
        cin.clear();
        cin.ignore(numeric_limits<streamsize>::max(), '\n');
    }
}

string askLine(const string& prompt) {
    cout << prompt;
    string input;
    getline(cin, input);
    return trim(input);
}

// --------------------------------------------------
// Ledger loading
// --------------------------------------------------

void readCSV(const string& filename, unordered_map<string, PlayerStats>& players) {
    ifstream file(filename);
    if (!file.is_open()) {
        cerr << "Could not open file: " << filename << '\n';
        return;
    }

    string line;
    if (!getline(file, line)) return;

    vector<string> headers = splitCSVLine(line);

    int nameIndex = -1;
    int netIndex = -1;

    for (int i = 0; i < static_cast<int>(headers.size()); ++i) {
        string header = trim(headers[i]);
        if (header == "player_nickname") nameIndex = i;
        else if (header == "net") netIndex = i;
    }

    if (nameIndex == -1 || netIndex == -1) {
        cerr << "Missing required columns in file: " << filename << '\n';
        return;
    }

    while (getline(file, line)) {
        if (line.empty()) continue;

        vector<string> row = splitCSVLine(line);
        if (nameIndex >= static_cast<int>(row.size()) || netIndex >= static_cast<int>(row.size())) {
            continue;
        }

        string rawName = trim(row[nameIndex]);
        string normalized = normalizeName(rawName);
        double net = toDollarAmountFromCents(row[netIndex]);

        if (normalized.empty()) continue;

        if (players.find(normalized) == players.end()) {
            PlayerStats newPlayer;
            newPlayer.displayName = rawName;
            newPlayer.normalizedName = normalized;
            players[normalized] = newPlayer;
        }

        PlayerStats& player = players[normalized];
        player.sessions++;
        player.totalNet += net;

        if (net > 0) player.totalUps += net;
        else if (net < 0) player.totalDowns += net;
    }
}

// --------------------------------------------------
// Sorting / printing players
// --------------------------------------------------

vector<PlayerStats> sortPlayersByName(const unordered_map<string, PlayerStats>& players) {
    vector<PlayerStats> sortedPlayers;
    sortedPlayers.reserve(players.size());

    for (const auto& pair : players) {
        sortedPlayers.push_back(pair.second);
    }

    sort(sortedPlayers.begin(), sortedPlayers.end(),
         [](const PlayerStats& a, const PlayerStats& b) {
             return a.normalizedName < b.normalizedName;
         });

    return sortedPlayers;
}

void printCompactPlayerList(const vector<PlayerStats>& players) {
    printDivider(82);
    cout << left
         << setw(5)  << "#"
         << setw(28) << "Player"
         << setw(22) << "Normalized"
         << setw(15) << "Net"
         << '\n';
    printDivider(82);

    for (size_t i = 0; i < players.size(); ++i) {
        cout << left
             << setw(5)  << (i + 1)
             << setw(28) << players[i].displayName
             << setw(22) << players[i].normalizedName
             << setw(15) << moneyString(players[i].totalNet)
             << '\n';
    }

    printDivider(82);
}

void printPlayerTable(const vector<PlayerStats>& players) {
    double grandTotal = 0.0;

    printDivider(112);
    cout << left
         << setw(5)  << "#"
         << setw(24) << "Player"
         << setw(22) << "Normalized"
         << setw(10) << "Buyins"
         << setw(16) << "Total Ups"
         << setw(16) << "Total Downs"
         << setw(16) << "Total Net"
         << '\n';
    printDivider(112);

    for (size_t i = 0; i < players.size(); ++i) {
        const PlayerStats& p = players[i];
        grandTotal += p.totalNet;

        cout << left
             << setw(5)  << (i + 1)
             << setw(24) << p.displayName
             << setw(22) << p.normalizedName
             << setw(10) << p.sessions
             << setw(16) << moneyString(p.totalUps)
             << setw(16) << moneyString(p.totalDowns)
             << setw(16) << moneyString(p.totalNet)
             << '\n';
    }

    printDivider(112);
    cout << "Grand Total: " << moneyString(grandTotal) << "\n\n";
}

// --------------------------------------------------
// Merge rule system
// --------------------------------------------------

string resolveCanonical(const unordered_map<string, string>& mergeRules, const string& key) {
    string current = key;
    while (true) {
        auto it = mergeRules.find(current);
        if (it == mergeRules.end() || it->second == current) {
            return current;
        }
        current = it->second;
    }
}

void flattenMergeRules(unordered_map<string, string>& mergeRules) {
    for (auto& pair : mergeRules) {
        pair.second = resolveCanonical(mergeRules, pair.second);
    }
}

void mergeTwoPlayers(unordered_map<string, PlayerStats>& players,
                     unordered_map<string, string>& mergeRules,
                     const string& keepKey,
                     const string& removeKey) {
    if (keepKey == removeKey) return;
    if (players.find(keepKey) == players.end()) return;
    if (players.find(removeKey) == players.end()) return;

    PlayerStats& keepPlayer = players[keepKey];
    PlayerStats& removePlayer = players[removeKey];

    keepPlayer.totalNet += removePlayer.totalNet;
    keepPlayer.totalUps += removePlayer.totalUps;
    keepPlayer.totalDowns += removePlayer.totalDowns;
    keepPlayer.sessions += removePlayer.sessions;

    if (removePlayer.displayName.size() < keepPlayer.displayName.size()) {
        keepPlayer.displayName = removePlayer.displayName;
    }

    players.erase(removeKey);
    mergeRules[removeKey] = keepKey;

    for (auto& pair : mergeRules) {
        if (resolveCanonical(mergeRules, pair.second) == removeKey) {
            pair.second = keepKey;
        }
    }

    flattenMergeRules(mergeRules);
}

void applySavedMergeRules(unordered_map<string, PlayerStats>& players,
                          unordered_map<string, string>& mergeRules) {
    flattenMergeRules(mergeRules);

    vector<pair<string, string>> rules;
    for (const auto& pair : mergeRules) {
        rules.push_back(pair);
    }

    for (const auto& pair : rules) {
        string alias = pair.first;
        string canonical = resolveCanonical(mergeRules, pair.second);
        if (alias == canonical) continue;

        auto aliasIt = players.find(alias);
        if (aliasIt == players.end()) continue;

        auto canonicalIt = players.find(canonical);

        if (canonicalIt == players.end()) {
            PlayerStats moved = aliasIt->second;
            moved.normalizedName = canonical;
            players[canonical] = moved;
            players.erase(aliasIt);
        } else {
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

bool loadMergeRulesFromCSV(const string& filename, unordered_map<string, string>& mergeRules) {
    ifstream file(filename);
    if (!file.is_open()) return false;

    string line;
    bool firstLine = true;

    while (getline(file, line)) {
        if (line.empty()) continue;

        if (firstLine) {
            firstLine = false;
            continue; // skip header no matter what it says
        }

        vector<string> row = splitCSVLine(line);
        if (row.size() < 2) continue;

        string aliasRaw = trim(row[0]);
        string canonicalRaw = trim(row[1]);

        string alias = normalizeName(aliasRaw);
        string canonical = normalizeName(canonicalRaw);

        if (!alias.empty() && !canonical.empty() && alias != canonical) {
            mergeRules[alias] = canonical;
        }
    }

    flattenMergeRules(mergeRules);
    return true;
}

bool saveMergeRulesToCSV(const string& filename, unordered_map<string, string>& mergeRules) {
    flattenMergeRules(mergeRules);

    ofstream out(filename);
    if (!out.is_open()) return false;

    out << "alias_normalized,canonical_normalized\n";

    vector<pair<string, string>> rules;
    for (const auto& pair : mergeRules) {
        if (pair.first != pair.second) {
            rules.push_back(pair);
        }
    }

    sort(rules.begin(), rules.end(),
         [](const auto& a, const auto& b) {
             if (a.second == b.second) return a.first < b.first;
             return a.second < b.second;
         });

    for (const auto& pair : rules) {
        out << escapeCSV(pair.first) << ',' << escapeCSV(pair.second) << '\n';
    }

    return true;
}

void manuallyMergePlayers(unordered_map<string, PlayerStats>& players,
                          unordered_map<string, string>& mergeRules) {
    while (true) {
        vector<PlayerStats> sortedPlayers = sortPlayersByName(players);

        cout << "\nCurrent player list:\n";
        printCompactPlayerList(sortedPlayers);

        char choice = askYesNo("Would you like to merge any names? (y/n): ");
        if (choice == 'n') break;

        size_t keepIndex, mergeIndex;

        cout << "Enter the number of the player you want to KEEP: ";
        cin >> keepIndex;
        cout << "Enter the number of the player you want to MERGE INTO that player: ";
        cin >> mergeIndex;
        cin.ignore(numeric_limits<streamsize>::max(), '\n');

        if (keepIndex < 1 || keepIndex > sortedPlayers.size() ||
            mergeIndex < 1 || mergeIndex > sortedPlayers.size()) {
            cout << "Invalid selection.\n";
            continue;
        }

        if (keepIndex == mergeIndex) {
            cout << "You cannot merge a player into themselves.\n";
            continue;
        }

        string keepKey = sortedPlayers[keepIndex - 1].normalizedName;
        string removeKey = sortedPlayers[mergeIndex - 1].normalizedName;

        cout << "Merging \"" << sortedPlayers[mergeIndex - 1].displayName
             << "\" into \"" << sortedPlayers[keepIndex - 1].displayName << "\"...\n";

        mergeTwoPlayers(players, mergeRules, keepKey, removeKey);
        cout << "Merge complete.\n";
    }
}

// --------------------------------------------------
// Export summary
// --------------------------------------------------

bool exportPlayerSummaryCSV(const string& filename, const vector<PlayerStats>& players) {
    ofstream out(filename);
    if (!out.is_open()) return false;

    out << "display_name,normalized_name,sessions,total_ups,total_downs,total_net\n";
    out << fixed << setprecision(2);

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

// --------------------------------------------------
// Settlement calculation
// --------------------------------------------------

vector<SettlementEntry> calculateSettlements(const vector<PlayerStats>& players) {
    struct Balance {
        string name;
        string normalized;
        double amount;
    };

    vector<Balance> winners;
    vector<Balance> losers;
    vector<SettlementEntry> settlements;

    const double EPSILON = 0.009;

    for (const PlayerStats& player : players) {
        if (player.totalNet > EPSILON) {
            winners.push_back({player.displayName, player.normalizedName, player.totalNet});
        } else if (player.totalNet < -EPSILON) {
            losers.push_back({player.displayName, player.normalizedName, -player.totalNet});
        }
    }

    sort(winners.begin(), winners.end(),
         [](const Balance& a, const Balance& b) {
             return a.amount > b.amount;
         });

    sort(losers.begin(), losers.end(),
         [](const Balance& a, const Balance& b) {
             return a.amount > b.amount;
         });

    size_t i = 0;
    size_t j = 0;

    while (i < losers.size() && j < winners.size()) {
        double payment = min(losers[i].amount, winners[j].amount);

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

void printSettlements(const vector<SettlementEntry>& settlements) {
    cout << "\nSettlement instructions:\n";
    printDivider(74);

    if (settlements.empty()) {
        cout << "No payments needed. Everyone is already settled.\n";
        printDivider(74);
        cout << '\n';
        return;
    }

    cout << left
         << setw(28) << "From"
         << setw(28) << "To"
         << setw(18) << "Amount"
         << '\n';
    printDivider(74);

    for (const SettlementEntry& s : settlements) {
        cout << left
             << setw(28) << s.from
             << setw(28) << s.to
             << setw(18) << moneyString(s.amount)
             << '\n';
    }

    printDivider(74);
    cout << '\n';
}

bool exportSettlementsCSV(const string& filename, const vector<SettlementEntry>& settlements) {
    ofstream out(filename);
    if (!out.is_open()) return false;

    out << "from,to,amount\n";
    out << fixed << setprecision(2);

    for (const SettlementEntry& s : settlements) {
        out << escapeCSV(s.from) << ','
            << escapeCSV(s.to) << ','
            << s.amount << '\n';
    }

    return true;
}

// --------------------------------------------------
// Session balances
// --------------------------------------------------

string makeSessionBalanceKey(const string& sessionId,
                             const string& fromNorm,
                             const string& toNorm) {
    return sessionId + "|" + fromNorm + "->" + toNorm;
}

void updateBalanceStatus(SessionBalance& bal) {
    const double EPSILON = 0.009;

    if (bal.remainingAmount <= EPSILON) {
        bal.remainingAmount = 0.0;
        bal.status = "paid";
    } else if (bal.remainingAmount < bal.originalAmount) {
        bal.status = "partial";
    } else {
        bal.status = "open";
    }
}

bool loadSessionBalancesCSV(const string& filename,
                            unordered_map<string, SessionBalance>& balances) {
    ifstream file(filename);
    if (!file.is_open()) return false;

    string line;
    bool firstLine = true;

    while (getline(file, line)) {
        if (line.empty()) continue;

        if (firstLine) {
            firstLine = false;
            if (line.find("session_id") != string::npos) {
                continue;
            }
        }

        vector<string> row = splitCSVLine(line);
        if (row.size() < 8) continue;

        SessionBalance bal;
        bal.sessionId = trim(row[0]);
        bal.fromDisplay = trim(row[1]);
        bal.fromNormalized = normalizeName(trim(row[2]));
        bal.toDisplay = trim(row[3]);
        bal.toNormalized = normalizeName(trim(row[4]));
        bal.originalAmount = toDoubleSafe(row[5]);
        bal.remainingAmount = toDoubleSafe(row[6]);
        bal.status = trim(row[7]);

        if (bal.sessionId.empty() || bal.fromNormalized.empty() || bal.toNormalized.empty()) {
            continue;
        }

        string key = makeSessionBalanceKey(bal.sessionId, bal.fromNormalized, bal.toNormalized);
        balances[key] = bal;
    }

    return true;
}

bool saveSessionBalancesCSV(const string& filename,
                            const unordered_map<string, SessionBalance>& balances) {
    ofstream out(filename);
    if (!out.is_open()) return false;

    out << "session_id,from_display,from_normalized,to_display,to_normalized,original_amount,remaining_amount,status\n";
    out << fixed << setprecision(2);

    vector<SessionBalance> rows;
    for (const auto& pair : balances) {
        rows.push_back(pair.second);
    }

    sort(rows.begin(), rows.end(),
         [](const SessionBalance& a, const SessionBalance& b) {
             if (a.sessionId == b.sessionId) {
                 if (a.fromNormalized == b.fromNormalized) {
                     return a.toNormalized < b.toNormalized;
                 }
                 return a.fromNormalized < b.fromNormalized;
             }
             return a.sessionId < b.sessionId;
         });

    for (const auto& b : rows) {
        out << escapeCSV(b.sessionId) << ','
            << escapeCSV(b.fromDisplay) << ','
            << escapeCSV(b.fromNormalized) << ','
            << escapeCSV(b.toDisplay) << ','
            << escapeCSV(b.toNormalized) << ','
            << b.originalAmount << ','
            << b.remainingAmount << ','
            << escapeCSV(b.status) << '\n';
    }

    return true;
}

void addSettlementBatchToSession(
    const string& sessionId,
    const vector<SettlementEntry>& settlements,
    const unordered_map<string, PlayerStats>& playersByNorm,
    unordered_map<string, SessionBalance>& balances)
{
    unordered_map<string, string> displayToNorm;
    for (const auto& pair : playersByNorm) {
        displayToNorm[pair.second.displayName] = pair.second.normalizedName;
    }

    for (const SettlementEntry& s : settlements) {
        auto fromIt = displayToNorm.find(s.from);
        auto toIt = displayToNorm.find(s.to);

        if (fromIt == displayToNorm.end() || toIt == displayToNorm.end()) {
            continue;
        }

        string fromNorm = fromIt->second;
        string toNorm = toIt->second;
        string key = makeSessionBalanceKey(sessionId, fromNorm, toNorm);

        if (balances.find(key) == balances.end()) {
            SessionBalance bal;
            bal.sessionId = sessionId;
            bal.fromDisplay = s.from;
            bal.fromNormalized = fromNorm;
            bal.toDisplay = s.to;
            bal.toNormalized = toNorm;
            bal.originalAmount = s.amount;
            bal.remainingAmount = s.amount;
            bal.status = "open";
            balances[key] = bal;
        } else {
            balances[key].originalAmount += s.amount;
            balances[key].remainingAmount += s.amount;
            balances[key].status = "open";
        }
    }
}

vector<pair<string, SessionBalance>> getOpenSessionBalanceRows(
    const unordered_map<string, SessionBalance>& balances) {
    vector<pair<string, SessionBalance>> rows;

    for (const auto& pair : balances) {
        if (pair.second.remainingAmount > 0.009) {
            rows.push_back(pair);
        }
    }

    sort(rows.begin(), rows.end(),
         [](const auto& a, const auto& b) {
             if (a.second.sessionId == b.second.sessionId) {
                 if (a.second.fromNormalized == b.second.fromNormalized) {
                     return a.second.toNormalized < b.second.toNormalized;
                 }
                 return a.second.fromNormalized < b.second.fromNormalized;
             }
             return a.second.sessionId < b.second.sessionId;
         });

    return rows;
}

void printSessionBalances(const unordered_map<string, SessionBalance>& balances, bool openOnly = false) {
    vector<SessionBalance> rows;

    for (const auto& pair : balances) {
        if (!openOnly || pair.second.remainingAmount > 0.009) {
            rows.push_back(pair.second);
        }
    }

    sort(rows.begin(), rows.end(),
         [](const SessionBalance& a, const SessionBalance& b) {
             if (a.sessionId == b.sessionId) {
                 if (a.fromNormalized == b.fromNormalized) {
                     return a.toNormalized < b.toNormalized;
                 }
                 return a.fromNormalized < b.fromNormalized;
             }
             return a.sessionId < b.sessionId;
         });

    cout << "\nSession balances:\n";
    printDivider(132);

    if (rows.empty()) {
        cout << "No session balances found.\n";
        printDivider(132);
        cout << '\n';
        return;
    }

    cout << left
         << setw(5)  << "#"
         << setw(24) << "Session"
         << setw(22) << "From"
         << setw(22) << "To"
         << setw(16) << "Original"
         << setw(16) << "Remaining"
         << setw(12) << "Status"
         << '\n';
    printDivider(132);

    for (size_t i = 0; i < rows.size(); ++i) {
        cout << left
             << setw(5)  << (i + 1)
             << setw(24) << rows[i].sessionId
             << setw(22) << rows[i].fromDisplay
             << setw(22) << rows[i].toDisplay
             << setw(16) << moneyString(rows[i].originalAmount)
             << setw(16) << moneyString(rows[i].remainingAmount)
             << setw(12) << rows[i].status
             << '\n';
    }

    printDivider(132);
    cout << '\n';
}

void recordPaymentBySession(unordered_map<string, SessionBalance>& balances) {
    vector<pair<string, SessionBalance>> rows = getOpenSessionBalanceRows(balances);

    if (rows.empty()) {
        cout << "There are no unpaid session balances.\n";
        return;
    }

    cout << "\nOpen session balances:\n";
    printDivider(132);
    cout << left
         << setw(5)  << "#"
         << setw(24) << "Session"
         << setw(22) << "From"
         << setw(22) << "To"
         << setw(16) << "Original"
         << setw(16) << "Remaining"
         << setw(12) << "Status"
         << '\n';
    printDivider(132);

    for (size_t i = 0; i < rows.size(); ++i) {
        const SessionBalance& b = rows[i].second;
        cout << left
             << setw(5)  << (i + 1)
             << setw(24) << b.sessionId
             << setw(22) << b.fromDisplay
             << setw(22) << b.toDisplay
             << setw(16) << moneyString(b.originalAmount)
             << setw(16) << moneyString(b.remainingAmount)
             << setw(12) << b.status
             << '\n';
    }

    printDivider(132);

    int choice = askMenuChoice("Choose a session balance to update (0 to cancel): ",
                               0, static_cast<int>(rows.size()));
    if (choice == 0) return;

    double amount = askAmount("Enter amount paid: ");

    string key = rows[choice - 1].first;
    SessionBalance& bal = balances[key];

    if (amount >= bal.remainingAmount) {
        bal.remainingAmount = 0.0;
    } else {
        bal.remainingAmount -= amount;
    }

    updateBalanceStatus(bal);
    cout << "Payment recorded.\n";
}

void printCombinedUnpaidSummary(const unordered_map<string, SessionBalance>& balances) {
    struct CombinedDebt {
        string fromDisplay;
        string fromNormalized;
        string toDisplay;
        string toNormalized;
        double totalRemaining = 0.0;
    };

    unordered_map<string, CombinedDebt> combined;

    for (const auto& pair : balances) {
        const SessionBalance& bal = pair.second;
        if (bal.remainingAmount <= 0.009) continue;

        string key = bal.fromNormalized + "->" + bal.toNormalized;

        if (combined.find(key) == combined.end()) {
            CombinedDebt debt;
            debt.fromDisplay = bal.fromDisplay;
            debt.fromNormalized = bal.fromNormalized;
            debt.toDisplay = bal.toDisplay;
            debt.toNormalized = bal.toNormalized;
            debt.totalRemaining = bal.remainingAmount;
            combined[key] = debt;
        } else {
            combined[key].totalRemaining += bal.remainingAmount;
        }
    }

    vector<CombinedDebt> rows;
    for (const auto& pair : combined) {
        rows.push_back(pair.second);
    }

    sort(rows.begin(), rows.end(),
         [](const CombinedDebt& a, const CombinedDebt& b) {
             if (a.totalRemaining == b.totalRemaining) {
                 if (a.fromNormalized == b.fromNormalized) {
                     return a.toNormalized < b.toNormalized;
                 }
                 return a.fromNormalized < b.fromNormalized;
             }
             return a.totalRemaining > b.totalRemaining;
         });

    cout << "\nCombined unpaid summary across all sessions:\n";
    printDivider(90);

    if (rows.empty()) {
        cout << "No unpaid balances.\n";
        printDivider(90);
        cout << '\n';
        return;
    }

    cout << left
         << setw(5)  << "#"
         << setw(28) << "From"
         << setw(28) << "To"
         << setw(20) << "Total Remaining"
         << '\n';
    printDivider(90);

    for (size_t i = 0; i < rows.size(); ++i) {
        cout << left
             << setw(5)  << (i + 1)
             << setw(28) << rows[i].fromDisplay
             << setw(28) << rows[i].toDisplay
             << setw(20) << moneyString(rows[i].totalRemaining)
             << '\n';
    }

    printDivider(90);
    cout << '\n';
}

// --------------------------------------------------
// Main menu
// --------------------------------------------------

void printMainMenu() {
    printDivider(72);
    cout << "POKER LEDGER MENU\n";
    printDivider(72);
    cout << "1. View player summary\n";
    cout << "2. Merge player names manually\n";
    cout << "3. Save merge rules\n";
    cout << "4. Export player summary CSV\n";
    cout << "5. Calculate settlements for current loaded ledger\n";
    cout << "6. Save current settlements as a session\n";
    cout << "7. View all session balances\n";
    cout << "8. View only open session balances\n";
    cout << "9. Record a payment for a specific session balance\n";
    cout << "10. View combined unpaid summary across all sessions\n";
    cout << "11. Export current settlements CSV\n";
    cout << "12. Save session balances now\n";
    cout << "0. Exit\n";
    printDivider(72);
}

// --------------------------------------------------
// Main
// --------------------------------------------------

int main() {
    fs::path projectRoot = "C:\\Users\\Camer\\CLionProjects\\Poker_Ledger_Reader";
    fs::path dataFolder = projectRoot / "SingleGameSettlement";
    fs::path savedDataFolder = projectRoot / "Saved_Data";

    fs::create_directories(savedDataFolder);

    fs::path mergeRulesFile = savedDataFolder / "merge_rules.csv";
    fs::path summaryFile = savedDataFolder / "player_summary.csv";
    fs::path settlementFile = savedDataFolder / "settlements.csv";
    fs::path sessionBalancesFile = savedDataFolder / "session_balances.csv";

    unordered_map<string, PlayerStats> players;
    unordered_map<string, string> mergeRules;
    unordered_map<string, SessionBalance> sessionBalances;
    vector<SettlementEntry> currentSettlements;

    try {
        for (const auto& entry : fs::directory_iterator(dataFolder)) {
            if (entry.path().extension() == ".csv") {
                readCSV(entry.path().string(), players);
            }
        }
    } catch (const exception& e) {
        cerr << "Error reading directory: " << e.what() << '\n';
        return 1;
    }

    cout << "\nLoaded " << players.size() << " normalized players from ledger files.\n";

    if (fs::exists(mergeRulesFile)) {
        if (askYesNo("Found merge_rules.csv in Saved_data. Load saved merge rules? (y/n): ") == 'y') {
            if (loadMergeRulesFromCSV(mergeRulesFile.string(), mergeRules)) {
                applySavedMergeRules(players, mergeRules);
                cout << "Saved merge rules applied.\n";
            } else {
                cout << "Could not load merge rules file.\n";
            }
        }
    }

    if (fs::exists(sessionBalancesFile)) {
        if (loadSessionBalancesCSV(sessionBalancesFile.string(), sessionBalances)) {
            cout << "Loaded session balances from " << sessionBalancesFile.string() << ".\n";
        }
    }

    bool running = true;

    while (running) {
        vector<PlayerStats> sortedPlayers = sortPlayersByName(players);

        printMainMenu();
        int choice = askMenuChoice("Choose an option: ", 0, 12);

        switch (choice) {
            case 1: {
                cout << "\nPlayer summary:\n";
                printPlayerTable(sortedPlayers);
                break;
            }

            case 2: {
                manuallyMergePlayers(players, mergeRules);
                currentSettlements.clear();
                cout << "Player names updated.\n";
                break;
            }

            case 3: {
                if (saveMergeRulesToCSV(mergeRulesFile.string(), mergeRules)) {
                    cout << "Merge rules saved to " << mergeRulesFile.string() << '\n';
                } else {
                    cout << "Could not save merge rules.\n";
                }
                break;
            }

            case 4: {
                if (exportPlayerSummaryCSV(summaryFile.string(), sortedPlayers)) {
                    cout << "Player summary exported to " << summaryFile.string() << '\n';
                } else {
                    cout << "Could not export player summary.\n";
                }
                break;
            }

            case 5: {
                currentSettlements = calculateSettlements(sortedPlayers);
                printSettlements(currentSettlements);
                break;
            }

            case 6: {
                if (currentSettlements.empty()) {
                    cout << "No current settlements are loaded. Calculate settlements first.\n";
                } else {
                    string sessionId = askLine("Enter a session ID (example: 2026-04-04_to_2026-04-21): ");
                    if (sessionId.empty()) {
                        cout << "Session ID cannot be empty.\n";
                    } else {
                        addSettlementBatchToSession(sessionId, currentSettlements, players, sessionBalances);
                        if (saveSessionBalancesCSV(sessionBalancesFile.string(), sessionBalances)) {
                            cout << "Session balances saved to " << sessionBalancesFile.string() << '\n';
                        } else {
                            cout << "Session balances updated in memory, but could not save the file.\n";
                        }
                    }
                }
                break;
            }

            case 7: {
                printSessionBalances(sessionBalances, false);
                break;
            }

            case 8: {
                printSessionBalances(sessionBalances, true);
                break;
            }

            case 9: {
                recordPaymentBySession(sessionBalances);
                if (saveSessionBalancesCSV(sessionBalancesFile.string(), sessionBalances)) {
                    cout << "Session balances saved to " << sessionBalancesFile.string() << '\n';
                } else {
                    cout << "Payment updated in memory, but could not save the file.\n";
                }
                break;
            }

            case 10: {
                printCombinedUnpaidSummary(sessionBalances);
                break;
            }

            case 11: {
                if (currentSettlements.empty()) {
                    cout << "No current settlements are loaded. Calculate settlements first.\n";
                } else {
                    if (exportSettlementsCSV(settlementFile.string(), currentSettlements)) {
                        cout << "Settlements exported to " << settlementFile.string() << '\n';
                    } else {
                        cout << "Could not export settlements.\n";
                    }
                }
                break;
            }

            case 12: {
                if (saveSessionBalancesCSV(sessionBalancesFile.string(), sessionBalances)) {
                    cout << "Session balances saved to " << sessionBalancesFile.string() << '\n';
                } else {
                    cout << "Could not save session balances.\n";
                }
                break;
            }

            case 0: {
                saveMergeRulesToCSV(mergeRulesFile.string(), mergeRules);
                saveSessionBalancesCSV(sessionBalancesFile.string(), sessionBalances);
                cout << "Saved merge rules and session balances.\n";
                cout << "Done.\n";
                running = false;
                break;
            }
        }
    }

    return 0;
}