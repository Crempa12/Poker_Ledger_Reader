#include "ledger.hpp"

#include <algorithm>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <unordered_map>

namespace fs = std::filesystem;
using namespace util;

namespace ledger {

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
            if (isExcludedDir(entry.path().filename().string())) it.disable_recursion_pending();
        } else if (lower(entry.path().extension().string()) == ".csv" && looksLikeLedger(entry.path())) {
            found.push_back(entry.path());
        }
        it.increment(ec);
    }

    std::sort(found.begin(), found.end());
    return found;
}

// One sit-down = one (account, start time) pair. Two files that share one were
// exported from the same game.
static std::string sitDownKey(const LedgerRow& r) {
    return r.playerId + "|" + std::to_string(r.start);
}

// Content fingerprint: every row's account, start, buy-in and net, sorted, so
// row order and file name do not matter.
static std::string fingerprint(const Game& g) {
    std::vector<std::string> parts;
    parts.reserve(g.rows.size());
    for (const LedgerRow& r : g.rows) {
        parts.push_back(sitDownKey(r) + "|" + fixed2(r.buyIn) + "|" + fixed2(r.net));
    }
    std::sort(parts.begin(), parts.end());
    std::string joined;
    for (const std::string& p : parts) joined += p + "\n";
    return joined;
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
    out.id = cleanStem(file.stem().string());   // a second download "ledger_x (1).csv" is still ledger_x
    out.path = fs::absolute(file).string();

    std::error_code ec;
    fs::path rel = fs::relative(file.parent_path(), root, ec);
    out.folder = (ec || rel.empty() || rel == ".") ? "(root)" : rel.generic_string();

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
        // Every row with money is kept, whatever its name: dropping one unbalances the books.
        // A seat with no start time and no money moved was never actually played.
        if (r.start == NO_TIME && r.net > -EPSILON && r.net < EPSILON) {
            out.skippedRows++;
            continue;
        }

        out.totalBuyIn += r.buyIn;
        if (r.start != NO_TIME && (out.start == NO_TIME || r.start < out.start)) out.start = r.start;
        std::int64_t last = r.end != NO_TIME ? r.end : r.start;
        if (last != NO_TIME && (out.end == NO_TIME || last > out.end)) out.end = last;
        out.rows.push_back(r);
    }

    if (out.rows.empty()) {
        error = (out.skippedRows > 0 ? "only never-played seats (no start time, $0 net) in "
                                     : "no player rows in ") + file.string();
        return false;
    }
    return true;
}

// "More complete" export: more sit-downs, then a later last cash-out.
static bool moreComplete(const Game& a, const Game& b) {
    if (a.rows.size() != b.rows.size()) return a.rows.size() > b.rows.size();
    return a.end > b.end;
}

LoadResult loadAllGames(const fs::path& root) {
    LoadResult result;

    std::vector<Game> files;   // every parsed ledger, in path order
    for (const fs::path& file : discoverLedgerFiles(root)) {
        Game g;
        std::string err;
        if (!parseLedgerFile(file, root, g, err)) {
            result.messages.push_back("Skipped: " + err);
            continue;
        }
        files.push_back(std::move(g));
    }

    const size_t n = files.size();
    std::vector<std::string> fps(n);
    std::vector<std::set<std::string>> sitDowns(n);
    for (size_t i = 0; i < n; ++i) {
        fps[i] = fingerprint(files[i]);
        for (const LedgerRow& r : files[i].rows) sitDowns[i].insert(sitDownKey(r));
    }

    std::vector<bool> kept(n, false);
    std::map<std::string, size_t> keptById;   // ledger id -> index of the kept file

    auto note = [&](const char* kind, size_t idx, size_t otherIdx, bool skipped, int shared) {
        DuplicateNote d;
        d.kind = kind;
        d.path = files[idx].path;
        d.folder = files[idx].folder;
        d.otherPath = files[otherIdx].path;
        d.otherFolder = files[otherIdx].folder;
        d.sameFolder = files[idx].folder == files[otherIdx].folder;
        d.skipped = skipped;
        d.sharedRows = shared;
        result.duplicates.push_back(d);
    };

    // Among candidate matches, report the one in the same folder if there is one.
    auto pickMatch = [&](size_t idx, const std::vector<size_t>& matches) -> size_t {
        for (size_t m : matches) if (files[m].folder == files[idx].folder) return m;
        return matches.front();
    };

    for (size_t i = 0; i < n; ++i) {
        // 1. Identical content to any earlier file (kept or not).
        std::vector<size_t> same;
        for (size_t j = 0; j < i; ++j) if (fps[j] == fps[i]) same.push_back(j);
        if (!same.empty()) {
            note("identical", i, pickMatch(i, same), true, static_cast<int>(files[i].rows.size()));
            continue;
        }

        // 2. Same ledger id as a kept file but different content: keep the fuller export.
        auto idIt = keptById.find(files[i].id);
        if (idIt != keptById.end()) {
            size_t k = idIt->second;
            if (moreComplete(files[i], files[k])) {
                note("same-id", k, i, true, 0);
                kept[k] = false;
                kept[i] = true;
                keptById[files[i].id] = i;
            } else {
                note("same-id", i, k, true, 0);
            }
            continue;
        }

        // 3. Different id but shares sit-downs with an earlier file: probably the same game.
        std::vector<size_t> overlapping;
        int bestShared = 0;
        for (size_t j = 0; j < i; ++j) {
            if (files[j].id == files[i].id) continue;
            int shared = 0;
            for (const std::string& key : sitDowns[i]) if (sitDowns[j].count(key)) ++shared;
            if (shared > 0) {
                overlapping.push_back(j);
                bestShared = std::max(bestShared, shared);
            }
        }
        if (!overlapping.empty()) note("overlap", i, pickMatch(i, overlapping), false, bestShared);

        kept[i] = true;
        keptById[files[i].id] = i;
    }

    for (size_t i = 0; i < n; ++i) if (kept[i]) result.games.push_back(std::move(files[i]));

    // Poker is zero-sum: every game's nets must add up to $0.00. PokerNow's own files always do,
    // so a gap here means a damaged or hand-edited ledger, and every total built on it is off.
    for (const Game& g : result.games) {
        double sum = 0.0;
        for (const LedgerRow& r : g.rows) sum += r.net;
        if (sum > EPSILON || sum < -EPSILON) {
            result.messages.push_back("WARNING: " + g.path + " does not balance: its nets sum to " +
                                      moneySigned(sum) + " instead of $0.00.");
        }
    }

    std::sort(result.games.begin(), result.games.end(), [](const Game& a, const Game& b) {
        if (a.start != b.start) return a.start < b.start;
        return a.id < b.id;
    });
    return result;
}

std::vector<std::string> listFolders(const std::vector<Game>& games) {
    std::set<std::string> folders;
    for (const Game& g : games) folders.insert(g.folder);
    return std::vector<std::string>(folders.begin(), folders.end());
}

std::vector<const Game*> filterGames(const std::vector<Game>& games, const Scope& scope) {
    std::vector<const Game*> out;
    for (const Game& g : games) if (scope.contains(g.folder, g.start)) out.push_back(&g);
    return out;
}

std::string logId(const Game& g) {
    return g.id.rfind("ledger_", 0) == 0 ? g.id.substr(7) : g.id;
}

void printDuplicates(const std::vector<DuplicateNote>& duplicates) {
    std::cout << "\nDuplicate ledger check\n" << divider(90);
    if (duplicates.empty()) {
        std::cout << "No duplicate or overlapping ledgers found.\n" << divider(90) << '\n';
        return;
    }
    for (size_t i = 0; i < duplicates.size(); ++i) {
        const DuplicateNote& d = duplicates[i];
        std::cout << (i + 1) << ". ";
        if (d.kind == "identical") {
            std::cout << "IDENTICAL CONTENT" << (d.sameFolder ? " in the same folder" : " across folders") << "\n";
        } else if (d.kind == "same-id") {
            std::cout << "SAME LEDGER ID, DIFFERENT CONTENT" << (d.sameFolder ? " in the same folder" : " across folders")
                      << " (probably an earlier export of the same game)\n";
        } else {
            std::cout << "OVERLAP: " << d.sharedRows << " sit-down" << (d.sharedRows == 1 ? "" : "s")
                      << " also appear in another ledger with a different id"
                      << (d.sameFolder ? " in the same folder" : " across folders") << "\n";
        }
        std::cout << "     " << (d.skipped ? "skipped: " : "kept:    ") << d.path << "\n"
                  << "     matches: " << d.otherPath << "\n";
        if (d.kind == "overlap") {
            std::cout << "     Both files are still counted. If they are the same game, delete the older export.\n";
        }
    }
    std::cout << divider(90) << '\n';
}

}  // namespace ledger
