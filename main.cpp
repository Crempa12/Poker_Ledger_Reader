// Poker Ledger Reader
//
// Reads every poker-ledger CSV under the project folder (recursively), builds
// per-player and per-game statistics, produces settlement sheets (who pays
// whom, honoring pinned preferences or a banker), tracks payments across
// sessions, and generates charts in the terminal and as an HTML report.
//
// Usage:
//   Poker_Ledger_Reader                      interactive menu
//   Poker_Ledger_Reader --root /path         use a different data root
//   Poker_Ledger_Reader --folder NAME        start scoped to one sub-folder
//   Poker_Ledger_Reader --from 2026-05-01 --to 2026-05-31
//   Poker_Ledger_Reader --report [file.html] write the HTML report and exit

#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "adjustments.hpp"
#include "console.hpp"
#include "handlog.hpp"
#include "ledger.hpp"
#include "models.hpp"
#include "players.hpp"
#include "playstyle.hpp"
#include "report.hpp"
#include "seats.hpp"
#include "sessions.hpp"
#include "settlement.hpp"
#include "util.hpp"

namespace fs = std::filesystem;
using namespace util;

namespace {

struct App {
    fs::path root;
    fs::path savedDir;
    fs::path reportsDir;
    fs::path dataDir;                                // where the ledgers and hand logs live

    std::vector<Game> games;
    std::vector<ledger::DuplicateNote> duplicates;
    players::MergeRules rules;
    std::vector<PaymentPreference> prefs;
    std::vector<Adjustment> adjustmentList;
    std::vector<SeatOwner> seatOwners;               // buy-ins that belonged to someone other than the name on them
    Settings settings;
    sessions::Balances balances;
    std::map<std::string, handlog::HandLog> logs;    // hand logs by game id

    Scope scope;
    std::vector<const Game*> scoped;                 // games matching the scope
    std::map<std::string, PlayerStats> stats;        // aggregated for the scope
    std::vector<SettlementEntry> currentSettlements;
    Scope settledScope;                              // what currentSettlements was built for
    std::string settledLabel;                        // folder name or game_<date>_<id>

    fs::path file(const char* name) const { return savedDir / name; }

    void refresh() {
        // Saved names can predate a merge (a pin to "jahan" after jahan was merged into jjj
        // silently never applied): point them at the name each player is filed under now.
        for (PaymentPreference& p : prefs) {
            p.payerNormalized = players::resolveCanonical(rules, p.payerNormalized);
            p.payeeNormalized = players::resolveCanonical(rules, p.payeeNormalized);
        }
        settings.me = players::resolveCanonical(rules, settings.me);
        settings.banker = players::resolveCanonical(rules, settings.banker);
        seats::apply(games, seatOwners, rules);
        for (const Game& g : games) {
            auto log = logs.find(ledger::logId(g));
            if (log != logs.end()) handlog::pairWithLedger(log->second, g, rules);
        }
        scoped = ledger::filterGames(games, scope);
        stats = players::aggregate(scoped, rules, adjustments::filter(adjustmentList, scope));
        currentSettlements.clear();
        settledLabel.clear();
    }

    void saveAll() {
        players::saveMergeRulesCSV(file("merge_rules.csv").string(), rules);
        settlement::savePreferencesCSV(file("payment_preferences.csv").string(), prefs);
        settlement::saveSettingsCSV(file("settings.csv").string(), settings);
        adjustments::saveCSV(file("adjustments.csv").string(), adjustmentList);
        seats::saveCSV(file("seat_owners.csv").string(), seatOwners);
        sessions::save(file("session_balances.csv").string(), balances);
    }

    std::string focusPlayer() const {
        if (!settings.me.empty() && stats.count(settings.me)) return settings.me;
        std::vector<PlayerStats> byNet = players::sortedByNet(stats);
        return byNet.empty() ? "" : byNet.front().normalizedName;
    }
};

// ---------------------------------------------------------------- scope menu

void chooseScope(App& app) {
    while (true) {
        std::vector<std::string> folders = ledger::listFolders(app.games);
        std::cout << "\nCurrent scope: " << app.scope.describe() << " (" << app.scoped.size() << " of "
                  << app.games.size() << " games)\n" << divider(60)
                  << "1. Use every folder\n"
                  << "2. Pick one folder\n"
                  << "3. Set a date range\n"
                  << "4. Last N days\n"
                  << "5. Clear the date range\n"
                  << "0. Back\n";
        int choice = console::askMenuChoice("Choose: ", 0, 5);
        if (choice == 0) return;

        if (choice == 1) {
            app.scope.folder.clear();
        } else if (choice == 2) {
            std::cout << '\n';
            for (size_t i = 0; i < folders.size(); ++i) {
                Scope probe;
                probe.folder = folders[i];
                size_t count = ledger::filterGames(app.games, probe).size();
                std::cout << "  " << (i + 1) << ". " << padRight(folders[i], 34) << count << " game" << (count == 1 ? "" : "s") << '\n';
            }
            int f = console::askMenuChoice("Folder number (0 to cancel): ", 0, static_cast<int>(folders.size()));
            if (f > 0) app.scope.folder = folders[f - 1];
        } else if (choice == 3) {
            std::string from = console::askLine("Start date YYYY-MM-DD (blank = no start): ");
            std::string to = console::askLine("End date YYYY-MM-DD (blank = no end): ");
            app.scope.from = from.empty() ? NO_TIME : parseLocalDate(from, false);
            app.scope.to = to.empty() ? NO_TIME : parseLocalDate(to, true);
            if ((!from.empty() && app.scope.from == NO_TIME) || (!to.empty() && app.scope.to == NO_TIME)) {
                std::cout << "Could not read one of those dates. Use YYYY-MM-DD.\n";
                app.scope.from = app.scope.to = NO_TIME;
            }
        } else if (choice == 4) {
            int days = console::askMenuChoice("How many days back? ", 1, 3650);
            app.scope.from = nowEpoch() - static_cast<std::int64_t>(days) * 86400;
            app.scope.to = NO_TIME;
        } else if (choice == 5) {
            app.scope.from = app.scope.to = NO_TIME;
        }
        app.refresh();
        std::cout << "Scope is now: " << app.scope.describe() << " (" << app.scoped.size() << " games, "
                  << app.stats.size() << " players)\n";
    }
}

// ---------------------------------------------------------------- player names (menu 4)

// Merges `others` into `keep` for good, saves, and recounts.
void mergeInto(App& app, const std::string& keep, const std::vector<std::string>& others) {
    std::vector<PlayerStats> byName = players::sortedByName(app.stats);
    std::string names;
    for (const std::string& o : others) {
        if (o == keep) continue;
        players::addMergeRule(app.rules, o, keep);
        names += (names.empty() ? "\"" : ", \"") + players::displayName(byName, o) + "\"";
    }
    players::saveMergeRulesCSV(app.file("merge_rules.csv").string(), app.rules);
    app.refresh();
    std::cout << "Merged " << names << " into \"" << players::displayName(byName, keep) << "\". Saved.\n";
}

// One question per name never seen anywhere else that turned up on an account someone else
// uses ("24242424242424" on Kobe's account). Each answer is saved, so it is asked once, and
// it only ever changes that one name: everyone else on the account is who they say.
void reviewNewNames(App& app) {
    std::set<std::string> later;   // "account|name" skipped for now
    while (true) {
        struct Question { players::MergeSuggestion account; std::string name; };
        std::vector<Question> pending;
        for (const auto& s : players::suggestMergesByPlayerId(app.games, app.rules))
            for (const std::string& n : s.newNames)
                if (!later.count(s.playerId + "|" + n)) pending.push_back({s, n});
        if (pending.empty()) return;

        const Question& q = pending.front();
        const std::vector<std::string>& newNames = q.account.newNames;
        std::vector<std::string> others;   // the possible answers: everyone else on the account
        for (const std::string& c : q.account.canonicals) if (c != q.name) others.push_back(c);
        std::vector<PlayerStats> byName = players::sortedByName(app.stats);
        auto line = [&](const std::string& name) {
            const PlayerStats* p = players::find(app.stats, name);
            return padRight(players::displayName(byName, name), 22) + padLeft(p ? moneySigned(p->totalNet) : "", 12);
        };

        std::cout << "\nNew name to check (" << pending.size() << " left)\n"
                  << "    " << line(q.name) << "   never seen before\n"
                  << "  has only ever played on account " << q.account.playerId << ", which is also used by:\n";
        for (size_t i = 0; i < others.size(); ++i) {
            bool alsoNew = std::find(newNames.begin(), newNames.end(), others[i]) != newNames.end();
            std::cout << "    " << (i + 1) << ". " << line(others[i]) << (alsoNew ? "   (also new)" : "") << '\n';
        }
        std::cout << "  The same person under a new nickname?  Type their number.\n"
                  << "  A different person (the name is right)?  Type d.\n"
                  << "  Not sure yet?  Press Enter.\n";
        while (true) {
            std::string answer = lower(console::askLine("  Answer: "));
            std::vector<int> pick = parseNumbers(answer);
            if (answer.empty()) { later.insert(q.account.playerId + "|" + q.name); break; }
            if (answer == "d") {
                seats::confirmNames(app.games, app.seatOwners, app.rules, q.account.playerId, {q.name},
                                    app.file("seat_owners.csv").string());
                app.refresh();
                std::cout << "Saved: a different person. This will not be asked again.\n";
                break;
            }
            if (pick.size() == 1 && pick[0] >= 1 && pick[0] <= static_cast<int>(others.size())) {
                mergeInto(app, others[pick[0] - 1], {q.name});
                break;
            }
            std::cout << "  Type a number from the list, d, or press Enter.\n";
        }
    }
}

// Any names at all, the one to keep first. Warns when nothing but the name links them.
void mergeByHand(App& app) {
    std::vector<PlayerStats> list = players::sortedByName(app.stats);
    std::cout << '\n';
    for (size_t i = 0; i < list.size(); ++i) {
        std::cout << "  " << padRight(std::to_string(i + 1), 5) << padRight(list[i].displayName, 24)
                  << padLeft(moneySigned(list[i].totalNet), 12) << '\n';
    }
    std::string typed = console::askLine(
        "Numbers of the names that are ONE person, the name to keep first (e.g. 12,5), Enter = back: ");
    std::vector<int> pick = parseNumbers(typed);
    if (!typed.empty() && pick.empty()) { std::cout << "Type numbers from the list, like 12,5.\n"; return; }
    std::vector<std::string> names;
    for (int n : pick) {
        if (n < 1 || n > static_cast<int>(list.size())) { std::cout << "No player number " << n << ".\n"; return; }
        if (std::find(names.begin(), names.end(), list[n - 1].normalizedName) == names.end())
            names.push_back(list[n - 1].normalizedName);
    }
    if (names.size() < 2) { if (!pick.empty()) std::cout << "Pick at least two different names.\n"; return; }

    // A shared account is real evidence; a matching name alone is not ("last", "fish" ...).
    std::map<std::string, std::set<std::string>> accounts = players::accountsByPerson(app.games, app.rules);
    std::string unlinked;
    for (size_t i = 1; i < names.size(); ++i) {
        bool shared = false;
        for (const std::string& a : accounts[names[i]]) if (accounts[names[0]].count(a)) shared = true;
        if (!shared) unlinked += (unlinked.empty() ? "" : ", ") + players::displayName(list, names[i]);
    }
    if (!unlinked.empty()) {
        std::cout << "Heads-up: " << unlinked << " never played on the same PokerNow account as "
                  << players::displayName(list, names[0]) << ",\nso only you know they are one person. "
                  << "Anyone who uses that name later will count for them too.\n";
        if (console::askYesNo("Merge anyway? (y/n): ") == 'n') return;
    }
    mergeInto(app, names[0], names);
}

// Every merge group, with a way to split one name back out.
void splitName(App& app) {
    std::map<std::string, std::vector<std::string>> groups;   // canonical -> aliases (sorted by the map below)
    for (const auto& [alias, canonical] : app.rules) groups[canonical].push_back(alias);
    std::vector<PlayerStats> byName = players::sortedByName(app.stats);
    std::vector<std::string> keys;
    std::cout << "\nMerged names (each line counts as one person)\n" << divider(90, '-');
    for (auto& [canonical, aliases] : groups) {
        std::sort(aliases.begin(), aliases.end());
        keys.push_back(canonical);
        // Every name in the group except the one it is shown as ("sack" is filed under "isaac").
        std::string display = players::displayName(byName, canonical), list;
        std::set<std::string> names(aliases.begin(), aliases.end());
        names.insert(canonical);
        names.erase(normalizeName(display));
        size_t shown = 0;
        for (const std::string& n : names) if (++shown <= 8) list += (shown > 1 ? ", " : "") + n;
        if (shown > 8) list += ", +" + std::to_string(shown - 8) + " more";
        std::cout << "  " << padRight(std::to_string(keys.size()) + ".", 5) << padRight(display, 20)
                  << (list.empty() ? "" : "also: " + list) << '\n';
    }
    std::cout << divider(90, '-');
    if (keys.empty()) { std::cout << "  none yet\n"; return; }
    int g = console::askMenuChoice("Split a name out of which person? (0 = back): ", 0, static_cast<int>(keys.size()));
    if (g == 0) return;
    const std::vector<std::string>& aliases = groups[keys[g - 1]];
    for (size_t i = 0; i < aliases.size(); ++i) std::cout << "    " << (i + 1) << ". " << aliases[i] << '\n';
    int a = console::askMenuChoice("Which name is really someone else? (0 = cancel): ", 0, static_cast<int>(aliases.size()));
    if (a == 0) return;
    std::string alias = aliases[a - 1];
    players::removeMergeRule(app.rules, alias);
    players::saveMergeRulesCSV(app.file("merge_rules.csv").string(), app.rules);
    app.refresh();
    std::cout << "\"" << alias << "\" counts as its own player again. Saved.\n";
}

void playerNames(App& app) {
    std::cout << "\nPlayer names\n" << divider(90)
              << "Same person under different nicknames (\"Kobe\", \"Kober\", \"Mamba\")? Merge them here.\n"
              << "A seat played by someone other than the name on it? That is menu 20: it moves that\n"
              << "one seat's money and leaves both names alone.\n";
    reviewNewNames(app);
    while (true) {
        std::cout << divider(90, '-')
                  << "1. Merge names by hand\n"
                  << "2. See merged names / split one back out\n"
                  << "0. Back\n";
        int choice = console::askMenuChoice("Choose: ", 0, 2);
        if (choice == 0) return;
        if (choice == 1) mergeByHand(app);
        else splitName(app);
    }
}

// ---------------------------------------------------------------- data loading

// Games live under <root>/Games when that folder exists (the recommended layout),
// otherwise anywhere under the root itself.
void locateData(App& app) {
    app.dataDir = fs::exists(app.root / "Games") ? app.root / "Games" : app.root;
    app.savedDir = app.root / "Saved_Data";
    app.reportsDir = app.savedDir / "reports";
}

// (Re)loads every ledger and hand log. Returns false if no ledgers were found.
bool loadData(App& app) {
    ledger::LoadResult loaded = ledger::loadAllGames(app.dataDir);
    app.games = std::move(loaded.games);
    app.duplicates = std::move(loaded.duplicates);
    for (const std::string& m : loaded.messages) std::cout << m << '\n';
    if (!app.duplicates.empty()) {
        size_t skipped = 0;
        for (const ledger::DuplicateNote& d : app.duplicates) if (d.skipped) ++skipped;
        std::cout << "WARNING: " << app.duplicates.size() << " duplicate/overlapping ledger"
                  << (app.duplicates.size() == 1 ? "" : "s") << " found (" << skipped
                  << " skipped so nothing is counted twice). Menu 16 shows the details.\n";
    }
    std::vector<std::string> logMessages;
    app.logs = handlog::loadAllLogs(app.dataDir, logMessages);
    for (const std::string& m : logMessages) std::cout << m << '\n';
    return !app.games.empty();
}

// Hand logs for the games in scope, oldest first.
std::vector<const handlog::HandLog*> logsInScope(const App& app) {
    std::vector<const handlog::HandLog*> out;
    for (const Game* g : app.scoped) {
        auto it = app.logs.find(ledger::logId(*g));
        if (it != app.logs.end()) out.push_back(&it->second);
    }
    return out;
}

// Reminds the user about new nicknames (menu 4) and seats that look like someone else's (menu 20).
void warnUnchecked(const App& app) {
    size_t names = players::suggestMergesByPlayerId(app.games, app.rules).size();
    if (names > 0) {
        std::cout << "WARNING: " << names << " account" << (names == 1 ? " has" : "s have")
                  << " a name never seen before. Menu 4 asks whether it is someone's new nickname.\n";
    }
    size_t flagged = seats::findSuspicious(app.games, app.rules).size();
    if (flagged > 0) {
        std::cout << "WARNING: " << flagged << " buy-in" << (flagged == 1 ? "" : "s")
                  << " look like they were made on someone else's account or under someone else's name.\n"
                  << "         They count for the name on the seat until you check them in menu 20.\n";
    }
}

// ---------------------------------------------------------------- hand logs

void handLogStats(App& app) {
    std::vector<const handlog::HandLog*> logs = logsInScope(app);
    std::cout << "\nHand-log statistics for " << app.scope.describe() << ": " << logs.size() << " of " << app.scoped.size()
              << " games have a log.\n";
    if (logs.size() < app.scoped.size()) {
        std::cout << "Games without a log (download \"poker_now_log_<id>.csv\" from PokerNow and drop it next to the ledger):\n";
        int shown = 0;
        for (auto it = app.scoped.rbegin(); it != app.scoped.rend() && shown < 5; ++it) {
            if (app.logs.count(ledger::logId(**it))) continue;
            std::cout << "  " << formatLocalDate((*it)->start) << "  " << (*it)->folder << "  " << (*it)->id << '\n';
            ++shown;
        }
        if (app.scoped.size() - logs.size() > 5) std::cout << "  ...\n";
    }
    if (logs.empty()) return;
    std::cout << '\n';
    handlog::printGameSummaries(logs, app.rules, app.stats);
    std::vector<handlog::StyleStats> style = handlog::computeStyle(logs, app.rules, app.stats);
    handlog::printStyleTable(style);
    if (console::askYesNo("Export this table to Saved_Data/style_stats.csv? (y/n): ") == 'y') {
        fs::path out = app.file("style_stats.csv");
        std::cout << (handlog::exportStyleCSV(out.string(), style) ? "Exported to " : "Could not write ") << out.string() << '\n';
    }
}

// ------------------------------------------------------------- deep playstyle profiles

void deepPlaystyle(App& app) {
    std::vector<const handlog::HandLog*> logs = logsInScope(app);
    if (logs.empty()) {
        std::cout << "\nNo hand logs in scope. Download \"poker_now_log_<id>.csv\" from PokerNow\n"
                  << "and drop it next to the matching ledger, then use menu 19 to import.\n";
        return;
    }
    std::size_t hands = 0;
    for (const handlog::HandLog* l : logs) hands += l->hands.size();
    std::cout << "\nDeep playstyle for " << app.scope.describe() << ": " << logs.size() << " of "
              << app.scoped.size() << " games have a log, " << hands << " hands analysed.\n";
    if (logs.size() < app.scoped.size())
        std::cout << "NOTE: " << (app.scoped.size() - logs.size())
                  << " games in scope have no hand log, so these reads cover only part of the money.\n";

    std::vector<playstyle::Profile> profiles = playstyle::analyze(logs, app.rules, app.stats);
    playstyle::printProfiles(profiles);

    while (console::askYesNo("Show the long read for one player? (y/n): ") == 'y') {
        std::string name = console::askLine("Player name (blank to stop): ");
        if (name.empty()) break;
        const std::string want = normalizeName(name);
        bool found = false;
        for (const playstyle::Profile& p : profiles)
            if (p.normalizedName == want || normalizeName(p.displayName) == want) {
                playstyle::printOnePlayer(p, profiles);
                found = true;
            }
        if (!found) std::cout << "No player matching \"" << name << "\" in these logs.\n";
    }
    if (console::askYesNo("Export these profiles to Saved_Data/playstyle.csv? (y/n): ") == 'y') {
        fs::path out = app.file("playstyle.csv");
        std::cout << (playstyle::exportCSV(out.string(), profiles) ? "Exported to " : "Could not write ")
                  << out.string() << '\n';
    }
}

// ---------------------------------------------------------------- import from Downloads

fs::path downloadsDir() {
#if defined(_WIN32)
    const char* home = std::getenv("USERPROFILE");
#else
    const char* home = std::getenv("HOME");
#endif
    return home ? fs::path(home) / "Downloads" : fs::path();
}

void importDownloads(App& app) {
    fs::path dl = downloadsDir();
    std::error_code ec;
    if (dl.empty() || !fs::exists(dl, ec)) { std::cout << "Could not find a Downloads folder.\n"; return; }

    struct Incoming { fs::path ledger; fs::path log; };
    std::map<std::string, Incoming> found;   // game id -> files
    for (const fs::directory_entry& entry : fs::directory_iterator(dl, ec)) {
        if (!entry.is_regular_file(ec) || lower(entry.path().extension().string()) != ".csv") continue;
        std::string stem = cleanStem(entry.path().stem().string());
        if (stem.rfind("ledger_", 0) == 0) found[stem.substr(7)].ledger = entry.path();
        else if (stem.rfind("poker_now_log_", 0) == 0) found[stem.substr(14)].log = entry.path();
    }
    if (found.empty()) {
        std::cout << "No ledger_*.csv or poker_now_log_*.csv files in " << dl.string() << ".\n";
        return;
    }

    std::set<std::string> knownLedgers;
    for (const Game& g : app.games) knownLedgers.insert(ledger::logId(g));

    std::cout << "\nPokerNow files in " << dl.string() << ":\n" << divider(90, '-');
    int newFiles = 0;
    for (const auto& pair : found) {
        const std::string& id = pair.first;
        const Incoming& f = pair.second;
        std::cout << "  " << padRight(id, 30);
        if (!f.ledger.empty()) {
            bool known = knownLedgers.count(id) > 0;
            std::cout << "ledger" << (known ? " (already loaded)" : "") << "  ";
            if (!known) ++newFiles;
        }
        if (!f.log.empty()) {
            bool known = app.logs.count(id) > 0;
            std::cout << "hand log" << (known ? " (already loaded)" : "");
            if (!known) ++newFiles;
        }
        std::cout << '\n';
    }
    std::cout << divider(90, '-');
    if (newFiles == 0) { std::cout << "Everything there is already loaded. Nothing to do.\n"; return; }

    std::vector<std::string> folders = ledger::listFolders(app.games);
    std::string suggested = app.games.empty() ? "" : app.games.back().folder;
    std::cout << "Where should the " << newFiles << " new file" << (newFiles == 1 ? "" : "s") << " go?\n";
    for (size_t i = 0; i < folders.size(); ++i) {
        std::cout << "  " << (i + 1) << ". " << folders[i] << (folders[i] == suggested ? "   (most recent)" : "") << '\n';
    }
    std::cout << "  " << (folders.size() + 1) << ". A new folder\n";
    int pick = console::askMenuChoice("Folder number (0 to cancel): ", 0, static_cast<int>(folders.size()) + 1);
    if (pick == 0) return;
    std::string folder;
    if (pick == static_cast<int>(folders.size()) + 1) {
        folder = console::askLine("New folder name (e.g. \"Fall 2026\"): ");
        if (folder.empty()) return;
    } else {
        folder = folders[pick - 1];
    }
    fs::path dest = folder == "(root)" ? app.dataDir : app.dataDir / folder;
    fs::create_directories(dest, ec);

    int moved = 0;
    auto place = [&](const fs::path& src, const std::string& id, bool known) {
        if (src.empty()) return;
        if (known) { std::cout << "  Left in Downloads (already loaded): " << src.filename().string() << '\n'; return; }
        fs::path target = dest / (cleanStem(src.stem().string()) + ".csv");
        if (fs::exists(target, ec)) { std::cout << "  Already in " << folder << ": " << target.filename().string() << '\n'; return; }
        fs::rename(src, target, ec);
        if (ec) {   // different drive: copy then delete
            ec.clear();
            fs::copy_file(src, target, ec);
            if (!ec) fs::remove(src, ec);
        }
        if (ec) { std::cout << "  Could not move " << src.string() << ": " << ec.message() << '\n'; ec.clear(); return; }
        std::cout << "  Moved " << src.filename().string() << " -> " << folder << '\n';
        ++moved;
        (void)id;
    };
    for (const auto& pair : found) {
        place(pair.second.ledger, pair.first, knownLedgers.count(pair.first) > 0);
        place(pair.second.log, pair.first, app.logs.count(pair.first) > 0);
    }
    if (moved == 0) return;

    std::cout << "Reloading...\n";
    if (!loadData(app)) { std::cout << "No ledgers found after the import.\n"; return; }
    app.refresh();
    std::cout << "Now " << app.games.size() << " games and " << app.logs.size() << " hand logs loaded.\n";
    warnUnchecked(app);
}

// ---------------------------------------------------------------- reports

std::string defaultSessionId(const App& app) {
    if (!app.scope.folder.empty()) return app.scope.folder;
    if (app.scope.from != NO_TIME || app.scope.to != NO_TIME) {
        return (app.scope.from == NO_TIME ? "start" : formatLocalDate(app.scope.from)) + "_to_" +
               (app.scope.to == NO_TIME ? formatLocalDate(nowEpoch()) : formatLocalDate(app.scope.to));
    }
    return "all_games_as_of_" + formatLocalDate(nowEpoch());
}

// ---------------------------------------------------------------- settlement

// One line per game so the user can pick which night to settle.
void printGameList(const App& app, const std::vector<const Game*>& games) {
    std::cout << '\n' << padRight("#", 5) << padRight("Date", 18) << padRight("Folder", 28)
              << padRight("Players", 9) << padLeft("Buy-ins", 12) << "  Ledger\n" << divider(96, '-');
    for (size_t i = 0; i < games.size(); ++i) {
        const Game& g = *games[i];
        std::set<std::string> names;
        for (const LedgerRow& r : g.rows) names.insert(players::personOf(app.rules, r));
        std::cout << padRight(std::to_string(i + 1), 5) << padRight(formatLocalDateTime(g.start), 18)
                  << padRight(g.folder.empty() ? "(root)" : g.folder, 28) << padRight(std::to_string(names.size()), 9)
                  << padLeft(money(g.totalBuyIn), 12) << "  " << g.id << '\n';
    }
    std::cout << divider(96, '-');
}

// Guided flow behind menu 5: pick a game or folder, ask whether anyone wants to
// send to a specific person, then fill in the rest automatically.
void calculateSettlement(App& app) {
    std::cout << "\nWhat would you like to settle?\n" << divider(60)
              << "1. One game (a single ledger)\n"
              << "2. One folder (every game in it)\n"
              << "3. Everything in the current scope (" << app.scope.describe() << ")\n"
              << "0. Cancel\n";
    int what = console::askMenuChoice("Choose: ", 0, 3);
    if (what == 0) return;

    std::vector<const Game*> games;
    Scope target;
    std::string label;

    if (what == 1) {
        // Newest first: the game being settled is usually the last one played.
        std::vector<const Game*> list(app.scoped.rbegin(), app.scoped.rend());
        if (list.empty()) { std::cout << "No games in the current scope.\n"; return; }
        if (!app.scope.isEverything()) std::cout << "(Only games in the current scope are listed. Option 1 widens it.)\n";
        printGameList(app, list);
        int pick = console::askMenuChoice("Game number (0 to cancel): ", 0, static_cast<int>(list.size()));
        if (pick == 0) return;
        const Game* g = list[pick - 1];
        games = {g};
        target.folder = g->folder;
        target.from = parseLocalDate(formatLocalDate(g->start), false);
        target.to = parseLocalDate(formatLocalDate(g->start), true);
        label = "game_" + formatLocalDate(g->start) + "_" + g->id;
    } else if (what == 2) {
        std::vector<std::string> folders = ledger::listFolders(app.games);
        if (folders.empty()) { std::cout << "No folders found.\n"; return; }
        std::cout << '\n';
        for (size_t i = 0; i < folders.size(); ++i) {
            Scope probe;
            probe.folder = folders[i];
            size_t count = ledger::filterGames(app.games, probe).size();
            std::cout << "  " << (i + 1) << ". " << padRight(folders[i], 34) << count << " game" << (count == 1 ? "" : "s") << '\n';
        }
        int pick = console::askMenuChoice("Folder number (0 to cancel): ", 0, static_cast<int>(folders.size()));
        if (pick == 0) return;
        target.folder = folders[pick - 1];
        games = ledger::filterGames(app.games, target);
        label = target.folder;
    } else {
        games = app.scoped;
        target = app.scope;
        label = defaultSessionId(app);
    }

    std::map<std::string, PlayerStats> stats =
        players::aggregate(games, app.rules, adjustments::filter(app.adjustmentList, target));
    std::vector<PlayerStats> byNet = players::sortedByNet(stats);
    if (byNet.empty()) { std::cout << "No players found in that selection.\n"; return; }

    std::cout << "\nResults for " << label << " (" << games.size() << " game" << (games.size() == 1 ? "" : "s") << "):\n";
    players::printCompactList(byNet);

    // Saved pins always apply; one-off requests are added on top for this sheet only.
    std::vector<PaymentPreference> prefs = app.prefs;

    if (!app.settings.banker.empty()) {
        std::cout << "\nBanker mode is on: everyone settles through " << players::displayName(byNet, app.settings.banker)
                  << ", so payer -> payee requests are skipped. Turn the banker off in option 6 to use them.\n";
    } else {
        std::vector<PlayerStats> losers, winners;
        for (const PlayerStats& p : byNet) {
            if (p.totalNet < -EPSILON) losers.push_back(p);
            else if (p.totalNet > EPSILON) winners.push_back(p);
        }
        auto owes = [&](const std::string& n) {
            for (const PlayerStats& p : losers) if (p.normalizedName == n) return true;
            return false;
        };
        auto owed = [&](const std::string& n) {
            for (const PlayerStats& p : winners) if (p.normalizedName == n) return true;
            return false;
        };

        bool anyPinned = false;
        for (const PaymentPreference& pref : app.prefs) {
            if (!owes(pref.payerNormalized) || !owed(pref.payeeNormalized)) continue;
            if (!anyPinned) std::cout << "\nSaved preferences that apply here:\n";
            anyPinned = true;
            std::cout << "  " << players::displayName(byNet, pref.payerNormalized) << " always pays " << players::displayName(byNet, pref.payeeNormalized) << '\n';
        }

        if (losers.empty() || winners.empty()) {
            std::cout << "\nNobody owes anything in that selection.\n";
        } else if (console::askYesNo("\nDoes anyone want to send their money to a specific person? (y/n): ") == 'y') {
            while (true) {
                std::string payer = console::pickPlayer(losers, "Who is sending? (players who owe)");
                if (payer.empty()) break;
                std::string payee = console::pickPlayer(winners, "Who should " + players::displayName(byNet, payer) + " send to? (players who are owed)");
                if (payee.empty()) break;

                bool already = false;
                for (const PaymentPreference& pref : prefs) {
                    if (pref.payerNormalized == payer && pref.payeeNormalized == payee) already = true;
                }
                if (already) {
                    std::cout << "That pairing is already on the list.\n";
                } else {
                    PaymentPreference pref{payer, payee, "", true};
                    prefs.push_back(pref);
                    std::cout << players::displayName(byNet, payer) << " will send to " << players::displayName(byNet, payee) << " first.\n";
                    if (console::askYesNo("Remember this for future settlements too? (y/n): ") == 'y') {
                        pref.oneOff = false;
                        app.prefs.push_back(pref);
                        settlement::savePreferencesCSV(app.file("payment_preferences.csv").string(), app.prefs);
                        std::cout << "Saved as a pinned preference.\n";
                    }
                }
                if (console::askYesNo("Anyone else? (y/n): ") == 'n') break;
            }
        }
    }

    app.currentSettlements = settlement::calculate(byNet, prefs, app.settings.banker);
    app.settledScope = target;
    app.settledLabel = label;
    std::cout << "\nSettlement for " << label << (app.settings.banker.empty() ? "" : " (banker mode)") << '\n';
    settlement::print(app.currentSettlements);
    std::cout << "Option 7 saves this sheet as a session; option 13 exports it as CSV.\n";
}

fs::path writeReport(App& app, fs::path outPath) {
    if (outPath.empty()) {
        fs::create_directories(app.reportsDir);
        std::string stamp = formatLocalDateTime(nowEpoch());
        for (char& c : stamp) if (c == ' ' || c == ':') c = '-';
        outPath = app.reportsDir / ("report_" + stamp + ".html");
    } else {
        std::error_code ec;
        if (outPath.has_parent_path()) fs::create_directories(outPath.parent_path(), ec);
    }
    report::ReportInput in;
    in.byNet = players::sortedByNet(app.stats);
    in.games = app.scoped;
    // Reuse the sheet from menu 5 only if it was built for this same scope.
    bool sheetMatches = !app.currentSettlements.empty() && app.settledScope.describe() == app.scope.describe();
    in.settlements = sheetMatches ? app.currentSettlements
                                  : settlement::calculate(in.byNet, app.prefs, app.settings.banker);
    in.scope = app.scope;
    in.meNormalized = app.settings.me;
    in.focusNormalized = app.focusPlayer();
    std::vector<const handlog::HandLog*> logs = logsInScope(app);
    in.style = handlog::computeStyle(logs, app.rules, app.stats);
    for (auto it = logs.rbegin(); it != logs.rend(); ++it) {
        report::NightChart night;
        night.log = *it;
        night.series = handlog::nightSeries(**it, app.rules, app.stats);
        in.nights.push_back(std::move(night));
    }
    if (!report::writeHTMLReport(outPath.string(), in)) {
        std::cout << "Could not write " << outPath.string() << '\n';
        return {};
    }
    std::cout << "Report written to " << outPath.string() << '\n';
    return outPath;
}

void openInBrowser(const fs::path& file) {
#if defined(__APPLE__)
    std::string cmd = "open \"" + file.string() + "\"";
#elif defined(_WIN32)
    std::string cmd = "start \"\" \"" + file.string() + "\"";
#else
    std::string cmd = "xdg-open \"" + file.string() + "\"";
#endif
    std::system(cmd.c_str());
}

// ---------------------------------------------------------------- menu

void printMenu(const App& app) {
    std::int64_t first = app.scoped.empty() ? NO_TIME : app.scoped.front()->start;
    std::int64_t last = app.scoped.empty() ? NO_TIME : app.scoped.back()->start;
    std::vector<PlayerStats> byName = players::sortedByName(app.stats);
    std::string meName = app.settings.me.empty() ? "(not set)" : players::displayName(byName, app.settings.me);
    std::string banker = app.settings.banker.empty() ? "off" : players::displayName(byName, app.settings.banker);

    std::cout << '\n' << divider(72) << "POKER LEDGER\n" << divider(72)
              << "Scope: " << app.scope.describe() << "  |  " << app.scoped.size() << " games, " << app.stats.size()
              << " players, " << formatLocalDate(first) << " to " << formatLocalDate(last) << '\n'
              << "Me: " << meName << "  |  Banker: " << banker << "  |  Pinned preferences: " << app.prefs.size()
              << "  |  Hand logs: " << logsInScope(app).size() << "/" << app.scoped.size() << '\n'
              << divider(72, '-')
              << "DATA\n"
              << "  1. Change scope (folder / date range)\n"
              << "  2. Leaderboard: everyone's net wins and losses\n"
              << "  3. Player detail: game-by-game history and running total\n"
              << "  4. Player names: one person, several nicknames ("
              << players::suggestMergesByPlayerId(app.games, app.rules).size() << " new to check)\n"
              << " 20. Shared accounts: a seat played by someone other than its name ("
              << seats::findSuspicious(app.games, app.rules).size() << " to check)\n"
              << " 17. Adjustments: forgive a debt or correct a total (" << app.adjustmentList.size() << " saved)\n"
              << "SETTLEMENT\n"
              << "  5. Calculate settlement sheet (pick a game or folder, then who sends to whom)\n"
              << "  6. Payment preferences (pinned payer -> payee, banker, me)\n"
              << "  7. Save settlement sheet as a session\n"
              << "  8. View all session balances\n"
              << "  9. View open session balances\n"
              << " 10. Record a payment\n"
              << " 11. Combined unpaid summary\n"
              << "EXPORT & CHARTS\n"
              << " 12. Export player summary CSV\n"
              << " 13. Export settlement sheet CSV\n"
              << " 14. Generate HTML report with charts\n"
              << " 15. Terminal charts\n"
              << " 16. Check for duplicate ledgers" << (app.duplicates.empty() ? "" : "  (!)") << "\n"
              << "HAND LOGS\n"
              << " 18. Playing style stats from hand logs (VPIP, aggression, showdowns)\n"
              << " 21. Deep playstyle profiles (position, 3-bet, c-bet, sizing, archetypes)\n"
              << " 19. Import new PokerNow files from Downloads\n"
              << "  0. Save and exit\n" << divider(72);
}

void runMenu(App& app) {
    bool running = true;
    while (running) {
        printMenu(app);
        int choice = console::askMenuChoice("Choose an option: ", 0, 21);
        std::vector<PlayerStats> byNet = players::sortedByNet(app.stats);

        switch (choice) {
            case 1: chooseScope(app); break;

            case 2:
                std::cout << "\nLeaderboard for " << app.scope.describe() << ":\n";
                players::printLeaderboard(byNet);
                break;

            case 3: {
                if (byNet.empty()) { std::cout << "No players in scope.\n"; break; }
                players::printCompactList(byNet);
                int idx = console::askMenuChoice("Player number (0 to cancel): ", 0, static_cast<int>(byNet.size()));
                if (idx == 0) break;
                players::printPlayerHistory(byNet[idx - 1]);
                report::printCumulativeChart(byNet[idx - 1]);
                break;
            }

            case 4: playerNames(app); break;

            case 5: calculateSettlement(app); break;

            case 6:
                settlement::managePreferences(app.prefs, app.settings, byNet,
                                              app.file("payment_preferences.csv").string(),
                                              app.file("settings.csv").string());
                app.currentSettlements.clear();
                break;

            case 7: {
                if (app.currentSettlements.empty()) {
                    std::cout << "No settlement sheet yet. Let's build one first.\n";
                    calculateSettlement(app);
                    if (app.currentSettlements.empty()) break;
                }
                std::string suggested = app.settledLabel.empty() ? defaultSessionId(app) : app.settledLabel;
                std::string id = console::askLine("Session ID [" + suggested + "]: ");
                if (id.empty()) id = suggested;
                bool exists = false;
                for (const auto& pair : app.balances) {
                    if (pair.second.sessionId == id) { exists = true; break; }
                }
                if (exists && console::askYesNo("Session \"" + id + "\" already has balances. Add these on top of them? (y/n): ") == 'n') {
                    std::cout << "Nothing saved. Pick a different session ID next time.\n";
                    break;
                }
                sessions::addSettlementBatch(id, app.currentSettlements, app.balances);
                sessions::save(app.file("session_balances.csv").string(), app.balances);
                std::cout << "Saved " << app.currentSettlements.size() << " balances under session \"" << id << "\".\n";
                break;
            }

            case 8: sessions::printBalances(app.balances, false); break;
            case 9: sessions::printBalances(app.balances, true); break;

            case 10:
                sessions::recordPayment(app.balances);
                sessions::save(app.file("session_balances.csv").string(), app.balances);
                break;

            case 11: sessions::printCombinedUnpaid(app.balances); break;

            case 12: {
                fs::path out = app.file("player_summary.csv");
                std::cout << (players::exportPlayerSummaryCSV(out.string(), byNet) ? "Exported to " : "Could not write ")
                          << out.string() << '\n';
                break;
            }

            case 13: {
                if (app.currentSettlements.empty()) {
                    std::cout << "No settlement sheet yet. Let's build one first.\n";
                    calculateSettlement(app);
                    if (app.currentSettlements.empty()) break;
                }
                fs::path out = app.file("settlements.csv");
                std::cout << (settlement::exportCSV(out.string(), app.currentSettlements) ? "Exported to " : "Could not write ")
                          << out.string() << '\n';
                break;
            }

            case 14: {
                fs::path written = writeReport(app, {});
                if (!written.empty() && console::askYesNo("Open it in your browser now? (y/n): ") == 'y') openInBrowser(written);
                break;
            }

            case 15: {
                report::printNetBarChart(byNet);
                std::string focus = app.focusPlayer();
                const PlayerStats* p = players::find(app.stats, focus);
                if (p) report::printCumulativeChart(*p);
                break;
            }

            case 16: ledger::printDuplicates(app.duplicates); break;

            case 17:
                if (adjustments::manage(app.adjustmentList, byNet, app.scope, app.file("adjustments.csv").string())) {
                    app.refresh();
                    std::cout << "Totals recalculated with the adjustments.\n";
                }
                break;

            case 18: handLogStats(app); break;
            case 19: importDownloads(app); break;

            case 20:
                if (seats::manage(app.games, app.seatOwners, app.rules, app.file("seat_owners.csv").string())) {
                    app.refresh();
                    std::cout << "Totals recalculated with the new seat owners.\n";
                }
                break;

            case 21: deepPlaystyle(app); break;

            case 0:
                app.saveAll();
                std::cout << "Saved merge rules, preferences, settings, seat owners and session balances. Bye.\n";
                running = false;
                break;
        }

        // Every long view used to scroll away under the 30-line menu redraw: the table
        // would be printed and immediately buried. console::pause() existed but was
        // called from nowhere. These are the views that overflow a standard terminal.
        switch (choice) {
            case 2: case 3: case 5: case 8: case 9: case 11:
            case 15: case 16: case 18: case 21:
                console::pause();
                break;
            default:
                break;
        }
    }
}

void printUsage() {
    std::cout << "Usage: Poker_Ledger_Reader [--root PATH] [--folder NAME] [--from YYYY-MM-DD] [--to YYYY-MM-DD]\n"
              << "                           [--report [FILE.html]] [--help]\n";
}

}  // namespace

int main(int argc, char** argv) {
    App app;
#ifdef PLR_PROJECT_ROOT
    app.root = PLR_PROJECT_ROOT;
#else
    app.root = fs::current_path();
#endif
    bool reportOnly = false;
    fs::path reportPath;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        auto next = [&](const char* flag) -> std::string {
            if (i + 1 >= argc) { std::cerr << flag << " needs a value\n"; std::exit(1); }
            return argv[++i];
        };
        if (arg == "--root") app.root = next("--root");
        else if (arg == "--folder") app.scope.folder = next("--folder");
        else if (arg == "--from") app.scope.from = parseLocalDate(next("--from"), false);
        else if (arg == "--to") app.scope.to = parseLocalDate(next("--to"), true);
        else if (arg == "--report") {
            reportOnly = true;
            if (i + 1 < argc && argv[i + 1][0] != '-') reportPath = argv[++i];
        } else if (arg == "--help" || arg == "-h") { printUsage(); return 0; }
        else { std::cerr << "Unknown option " << arg << "\n"; printUsage(); return 1; }
    }

    locateData(app);
    std::error_code ec;
    fs::create_directories(app.savedDir, ec);
    if (!loadData(app)) {
        std::cerr << "No ledger CSV files found under " << app.dataDir.string() << '\n';
        return 1;
    }

    if (players::loadMergeRulesCSV(app.file("merge_rules.csv").string(), app.rules)) {
        std::cout << "Loaded " << app.rules.size() << " merge rules.\n";
    }
    settlement::loadPreferencesCSV(app.file("payment_preferences.csv").string(), app.prefs);
    settlement::loadSettingsCSV(app.file("settings.csv").string(), app.settings);
    if (adjustments::loadCSV(app.file("adjustments.csv").string(), app.adjustmentList)) {
        std::cout << "Loaded " << app.adjustmentList.size() << " adjustment rows.\n";
    }
    if (seats::loadCSV(app.file("seat_owners.csv").string(), app.seatOwners)) {
        std::cout << "Loaded " << app.seatOwners.size() << " seat owners.\n";
    }
    if (sessions::load(app.file("session_balances.csv").string(), app.balances)) {
        std::cout << "Loaded " << app.balances.size() << " session balances.\n";
    }

    app.refresh();
    std::cout << "Loaded " << app.games.size() << " games from " << ledger::listFolders(app.games).size()
              << " folders under " << app.dataDir.string() << ", " << app.logs.size() << " hand log" << (app.logs.size() == 1 ? "" : "s") << '\n';

    warnUnchecked(app);

    if (reportOnly) {
        players::printLeaderboard(players::sortedByNet(app.stats));
        return writeReport(app, reportPath).empty() ? 1 : 0;
    }

    runMenu(app);
    return 0;
}
