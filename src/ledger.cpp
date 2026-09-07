#include "ledger.hpp"

#include <algorithm>
#include <fstream>
#include <set>
#include <unordered_map>

namespace fs = std::filesystem;
using namespace util;

namespace ledger {

static bool isExcludedDir(const fs::path& p) {
    std::string name = p.filename().string();
    return name == "Saved_Data" || name == ".git" || name == ".idea" || name == "build" ||
           name == "reports" || name.rfind("cmake-build", 0) == 0;
}

static bool looksLikeLedger(const fs::path& file) {
    std::ifstream in(file);
    if (!in.is_open()) return false;
    std::string firstLine;
    if (!std::getline(in, firstLine)) return false;
    return firstLine.find("player_nickname") != std::string::npos;
}

std::vector<fs::path> discoverLedgerFiles(const fs::path& root) {
    std::vector<fs::path> found;
    std::error_code ec;
    fs::recursive_directory_iterator it(root, fs::directory_options::skip_permission_denied, ec);
    fs::recursive_directory_iterator end;

    while (!ec && it != end) {
        const fs::directory_entry& entry = *it;
        if (entry.is_directory(ec)) {
            if (isExcludedDir(entry.path())) it.disable_recursion_pending();
        } else if (lower(entry.path().extension().string()) == ".csv" && looksLikeLedger(entry.path())) {
            found.push_back(entry.path());
        }
        it.increment(ec);
    }

    std::sort(found.begin(), found.end());
    return found;
}

bool parseLedgerFile(const fs::path& file, const fs::path& root, Game& out, std::string& error) {
    std::ifstream in(file);
    if (!in.is_open()) {
        error = "could not open " + file.string();
        return false;
    }

    std::string line;
    if (!std::getline(in, line)) {
        error = "empty file " + file.string();
        return false;
    }

    std::unordered_map<std::string, int> col;
    std::vector<std::string> headers = splitCSVLine(line);
    for (int i = 0; i < static_cast<int>(headers.size()); ++i) col[trim(headers[i])] = i;

    auto has = [&](const char* name) { return col.count(name) > 0; };
    if (!has("player_nickname") || !has("net")) {
        error = "missing player_nickname/net columns in " + file.string();
        return false;
    }

    auto cell = [&](const std::vector<std::string>& row, const char* name) -> std::string {
        auto it = col.find(name);
        if (it == col.end() || it->second >= static_cast<int>(row.size())) return "";
        return row[it->second];
    };

    out = Game{};
    out.id = file.stem().string();
    out.path = fs::absolute(file).string();

    std::error_code ec;
    fs::path rel = fs::relative(file.parent_path(), root, ec);
    std::string folder = (ec || rel.empty() || rel == ".") ? "(root)" : rel.generic_string();
    out.folder = folder;

    while (std::getline(in, line)) {
        if (trim(line).empty()) continue;
        std::vector<std::string> row = splitCSVLine(line);

        LedgerRow r;
        r.nickname = trim(cell(row, "player_nickname"));
        r.playerId = trim(cell(row, "player_id"));
        r.start = parseISO8601UTC(cell(row, "session_start_at"));
        r.end = parseISO8601UTC(cell(row, "session_end_at"));
        r.buyIn = centsToDollars(cell(row, "buy_in"));
        r.buyOut = centsToDollars(cell(row, "buy_out"));
        r.stack = centsToDollars(cell(row, "stack"));
        r.net = centsToDollars(cell(row, "net"));
        if (normalizeName(r.nickname).empty()) continue;

        out.totalBuyIn += r.buyIn;
        if (r.start != NO_TIME && (out.start == NO_TIME || r.start < out.start)) out.start = r.start;
        std::int64_t last = r.end != NO_TIME ? r.end : r.start;
        if (last != NO_TIME && (out.end == NO_TIME || last > out.end)) out.end = last;
        out.rows.push_back(r);
    }

    if (out.rows.empty()) {
        error = "no player rows in " + file.string();
        return false;
    }
    return true;
}

std::vector<Game> loadAllGames(const fs::path& root, std::vector<std::string>& messages) {
    std::vector<Game> games;
    std::set<std::string> seen;

    for (const fs::path& file : discoverLedgerFiles(root)) {
        Game g;
        std::string err;
        if (!parseLedgerFile(file, root, g, err)) {
            messages.push_back("Skipped: " + err);
            continue;
        }
        if (seen.count(g.id)) {
            messages.push_back("Duplicate ledger " + g.id + " in " + g.folder + " ignored (already loaded).");
            continue;
        }
        seen.insert(g.id);
        games.push_back(std::move(g));
    }

    std::sort(games.begin(), games.end(), [](const Game& a, const Game& b) {
        if (a.start != b.start) return a.start < b.start;
        return a.id < b.id;
    });
    return games;
}

std::vector<std::string> listFolders(const std::vector<Game>& games) {
    std::set<std::string> folders;
    for (const Game& g : games) folders.insert(g.folder);
    return std::vector<std::string>(folders.begin(), folders.end());
}

std::vector<const Game*> filterGames(const std::vector<Game>& games, const Scope& scope) {
    std::vector<const Game*> out;
    for (const Game& g : games) {
        if (!scope.folder.empty() && g.folder != scope.folder) continue;
        if (scope.from != NO_TIME && (g.start == NO_TIME || g.start < scope.from)) continue;
        if (scope.to != NO_TIME && (g.start == NO_TIME || g.start > scope.to)) continue;
        out.push_back(&g);
    }
    return out;
}

}  // namespace ledger
