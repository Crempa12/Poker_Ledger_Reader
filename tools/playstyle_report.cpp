// Standalone driver for the deep playing-style analysis.
//
//   playstyle_report --root PATH [--csv OUT.csv] [--player NAME] [--hitrun]
//
// Loads the same ledgers, hand logs, merge rules and seat-owner overrides the app uses,
// runs playstyle::analyze over every log found, and prints the profile table. With
// --player it prints the long-form read for one person instead. With --hitrun it prints
// the hit & run table (menu 22) instead, or with --player that person's every night;
// --csv then writes the per-night exits.
//
// It exists so the analysis can be run and diffed without driving the interactive menu.
#include <filesystem>
#include <iostream>
#include <map>
#include <string>
#include <vector>

#include "adjustments.hpp"
#include "handlog.hpp"
#include "hitrun.hpp"
#include "ledger.hpp"
#include "players.hpp"
#include "playstyle.hpp"
#include "seats.hpp"
#include "settlement.hpp"
#include "util.hpp"

namespace fs = std::filesystem;

int main(int argc, char** argv) {
    fs::path root =
#ifdef PLR_PROJECT_ROOT
        PLR_PROJECT_ROOT;
#else
        fs::current_path();
#endif
    std::string csvOut, wantPlayer;
    bool hitRun = false;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--root" && i + 1 < argc) root = argv[++i];
        else if (a == "--csv" && i + 1 < argc) csvOut = argv[++i];
        else if (a == "--player" && i + 1 < argc) wantPlayer = argv[++i];
        else if (a == "--hitrun") hitRun = true;
    }

    const fs::path savedDir = root / "Saved_Data";
    fs::path dataDir = root / "Games";
    if (!fs::exists(dataDir)) dataDir = root;

    ledger::LoadResult loaded = ledger::loadAllGames(dataDir);
    std::vector<Game> games = loaded.games;

    players::MergeRules rules;
    players::loadMergeRulesCSV((savedDir / "merge_rules.csv").string(), rules);

    std::vector<SeatOwner> seatOwners;
    seats::loadCSV((savedDir / "seat_owners.csv").string(), seatOwners);
    seats::apply(games, seatOwners, rules);

    std::vector<std::string> logMessages;
    std::map<std::string, handlog::HandLog> logs = handlog::loadAllLogs(dataDir, logMessages);
    for (const Game& g : games) {
        const std::string id = g.id.rfind("ledger_", 0) == 0 ? g.id.substr(7) : g.id;
        auto it = logs.find(id);
        if (it != logs.end()) handlog::pairWithLedger(it->second, g, rules);
    }

    std::vector<Adjustment> adjustmentList;
    adjustments::loadCSV((savedDir / "adjustments.csv").string(), adjustmentList);

    Scope scope;   // everything
    std::vector<const Game*> scoped = ledger::filterGames(games, scope);
    std::map<std::string, PlayerStats> stats =
        players::aggregate(scoped, rules, adjustments::filter(adjustmentList, scope));

    std::vector<const handlog::HandLog*> inScope;
    for (const Game* g : scoped) {
        const std::string id = g->id.rfind("ledger_", 0) == 0 ? g->id.substr(7) : g->id;
        auto it = logs.find(id);
        if (it != logs.end()) inScope.push_back(&it->second);
    }

    std::cout << "Games loaded: " << games.size() << "   in scope: " << scoped.size()
              << "   hand logs in scope: " << inScope.size() << "\n";
    std::size_t handCount = 0;
    for (const handlog::HandLog* l : inScope) handCount += l->hands.size();
    std::cout << "Hands analysed: " << handCount << "\n";

    int unmeasured = 0;
    std::vector<hitrun::Night> nights = hitrun::collect(scoped, logs, rules, stats, &unmeasured);
    std::vector<hitrun::Summary> hr = hitrun::summarize(nights);
    if (hitRun) {
        if (wantPlayer.empty()) {
            hitrun::printTable(hr, nights, unmeasured);
        } else {
            const std::string want = players::resolveCanonical(rules, util::normalizeName(wantPlayer));
            bool found = false;
            for (const hitrun::Summary& s : hr)
                if (s.person == want || util::normalizeName(s.displayName) == util::normalizeName(wantPlayer)) {
                    hitrun::printPlayer(s, nights);
                    found = true;
                    break;
                }
            if (!found) std::cout << "No player matching \"" << wantPlayer << "\".\n";
        }
        if (!csvOut.empty()) {
            if (hitrun::exportNightsCSV(csvOut, nights)) std::cout << "\nWrote " << csvOut << "\n";
            else std::cout << "\nCould not write " << csvOut << "\n";
        }
        return 0;
    }

    std::vector<playstyle::Profile> profiles = playstyle::analyze(inScope, rules, stats);
    hitrun::annotate(profiles, hr);

    if (!wantPlayer.empty()) {
        const std::string want = util::normalizeName(wantPlayer);
        bool found = false;
        for (const playstyle::Profile& p : profiles) {
            if (util::normalizeName(p.displayName) == want || p.normalizedName == want) {
                playstyle::printOnePlayer(p, profiles);
                found = true;
            }
        }
        if (!found) std::cout << "No player matching \"" << wantPlayer << "\".\n";
    } else {
        playstyle::printProfiles(profiles);
    }

    if (!csvOut.empty()) {
        if (playstyle::exportCSV(csvOut, profiles)) std::cout << "\nWrote " << csvOut << "\n";
        else std::cout << "\nCould not write " << csvOut << "\n";
    }
    return 0;
}
