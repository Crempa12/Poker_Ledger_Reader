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

#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <map>
#include <string>
#include <vector>

#include "console.hpp"
#include "adjustments.hpp"
#include "ledger.hpp"
#include "models.hpp"
#include "players.hpp"
#include "report.hpp"
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

    std::vector<Game> games;
    std::vector<ledger::DuplicateNote> duplicates;
    players::MergeRules rules;
    std::vector<PaymentPreference> prefs;
    std::vector<Adjustment> adjustmentList;
    Settings settings;
    sessions::Balances balances;

    Scope scope;
    std::vector<const Game*> scoped;                 // games matching the scope
    std::map<std::string, PlayerStats> stats;        // aggregated for the scope
    std::vector<SettlementEntry> currentSettlements;

    fs::path file(const char* name) const { return savedDir / name; }

    void refresh() {
        scoped = ledger::filterGames(games, scope);
        stats = players::aggregate(scoped, rules, adjustments::filter(adjustmentList, scope));
        currentSettlements.clear();
    }

    void saveAll() {
        players::saveMergeRulesCSV(file("merge_rules.csv").string(), rules);
        settlement::savePreferencesCSV(file("payment_preferences.csv").string(), prefs);
        settlement::saveSettingsCSV(file("settings.csv").string(), settings);
        adjustments::saveCSV(file("adjustments.csv").string(), adjustmentList);
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

// ---------------------------------------------------------------- merging

void mergeNames(App& app) {
    // 1. Automatic suggestions: nicknames that share a ledger player_id.
    std::vector<players::MergeSuggestion> suggestions = players::suggestMergesByPlayerId(app.games, app.rules);
    if (!suggestions.empty()) {
        std::cout << "\nThese names share the same ledger account (player_id), so they are probably one person:\n";
        for (const players::MergeSuggestion& s : suggestions) {
            std::cout << "\n  Account " << s.playerId << ":\n";
            for (size_t i = 0; i < s.canonicals.size(); ++i) {
                const PlayerStats* p = players::find(app.stats, s.canonicals[i]);
                std::cout << "    " << (i + 1) << ". " << s.canonicals[i]
                          << (p ? "  (" + p->displayName + ", " + moneySigned(p->totalNet) + ")" : "") << '\n';
            }
            int keep = console::askMenuChoice("  Merge all of these into which name? (0 = leave them separate): ", 0,
                                              static_cast<int>(s.canonicals.size()));
            if (keep == 0) continue;
            for (size_t i = 0; i < s.canonicals.size(); ++i) {
                if (static_cast<int>(i) + 1 != keep) players::addMergeRule(app.rules, s.canonicals[i], s.canonicals[keep - 1]);
            }
            app.refresh();
        }
    }

    // 2. Manual merges.
    while (true) {
        std::vector<PlayerStats> list = players::sortedByName(app.stats);
        std::cout << "\nPlayers in scope:\n";
        players::printCompactList(list);
        if (console::askYesNo("Merge two names by hand? (y/n): ") == 'n') break;

        int keep = console::askMenuChoice("Number of the name to KEEP: ", 1, static_cast<int>(list.size()));
        int drop = console::askMenuChoice("Number of the name to MERGE INTO it: ", 1, static_cast<int>(list.size()));
        if (keep == drop) {
            std::cout << "Those are the same player.\n";
            continue;
        }
        players::addMergeRule(app.rules, list[drop - 1].normalizedName, list[keep - 1].normalizedName);
        app.refresh();
        std::cout << "Merged \"" << list[drop - 1].displayName << "\" into \"" << list[keep - 1].displayName << "\".\n";
    }
    players::saveMergeRulesCSV(app.file("merge_rules.csv").string(), app.rules);
    std::cout << "Merge rules saved.\n";
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
    in.settlements = app.currentSettlements.empty()
                         ? settlement::calculate(in.byNet, app.prefs, app.settings.banker)
                         : app.currentSettlements;
    in.scope = app.scope;
    in.meNormalized = app.settings.me;
    in.focusNormalized = app.focusPlayer();
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
    std::string meName = app.settings.me.empty() ? "(not set)" : app.settings.me;
    std::string banker = app.settings.banker.empty() ? "off" : app.settings.banker;

    std::cout << '\n' << divider(72) << "POKER LEDGER\n" << divider(72)
              << "Scope: " << app.scope.describe() << "  |  " << app.scoped.size() << " games, " << app.stats.size()
              << " players, " << formatLocalDate(first) << " to " << formatLocalDate(last) << '\n'
              << "Me: " << meName << "  |  Banker: " << banker << "  |  Pinned preferences: " << app.prefs.size() << '\n'
              << divider(72, '-')
              << "DATA\n"
              << "  1. Change scope (folder / date range)\n"
              << "  2. Leaderboard: everyone's net wins and losses\n"
              << "  3. Player detail: game-by-game history and running total\n"
              << "  4. Merge duplicate player names\n"
              << "SETTLEMENT\n"
              << "  5. Calculate settlement sheet (who sends what to whom)\n"
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
              << " 17. Adjustments: forgive a debt or correct a total (" << app.adjustmentList.size() << " saved)\n"
              << "  0. Save and exit\n" << divider(72);
}

void runMenu(App& app) {
    bool running = true;
    while (running) {
        printMenu(app);
        int choice = console::askMenuChoice("Choose an option: ", 0, 17);
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

            case 4: mergeNames(app); break;

            case 5:
                app.currentSettlements = settlement::calculate(byNet, app.prefs, app.settings.banker);
                std::cout << "\nSettlement for " << app.scope.describe()
                          << (app.settings.banker.empty() ? "" : " (banker mode)") << '\n';
                settlement::print(app.currentSettlements);
                break;

            case 6:
                settlement::managePreferences(app.prefs, app.settings, byNet,
                                              app.file("payment_preferences.csv").string(),
                                              app.file("settings.csv").string());
                app.currentSettlements.clear();
                break;

            case 7: {
                if (app.currentSettlements.empty()) {
                    std::cout << "Calculate a settlement sheet first (option 5).\n";
                    break;
                }
                std::string suggested = defaultSessionId(app);
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
                    app.currentSettlements = settlement::calculate(byNet, app.prefs, app.settings.banker);
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

            case 0:
                app.saveAll();
                std::cout << "Saved merge rules, preferences, settings and session balances. Bye.\n";
                running = false;
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

    app.savedDir = app.root / "Saved_Data";
    app.reportsDir = app.savedDir / "reports";
    std::error_code ec;
    fs::create_directories(app.savedDir, ec);

    ledger::LoadResult loaded = ledger::loadAllGames(app.root);
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
    if (app.games.empty()) {
        std::cerr << "No ledger CSV files found under " << app.root.string() << '\n';
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
    if (sessions::load(app.file("session_balances.csv").string(), app.balances)) {
        std::cout << "Loaded " << app.balances.size() << " session balances.\n";
    }

    app.refresh();
    std::cout << "Loaded " << app.games.size() << " games from " << ledger::listFolders(app.games).size()
              << " folders under " << app.root.string() << '\n';

    if (reportOnly) {
        players::printLeaderboard(players::sortedByNet(app.stats));
        return writeReport(app, reportPath).empty() ? 1 : 0;
    }

    runMenu(app);
    return 0;
}
