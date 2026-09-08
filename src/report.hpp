#pragma once
// Charts: quick ones in the terminal, full interactive ones in a self-contained HTML file.
#include <string>
#include <vector>

#include "handlog.hpp"
#include "models.hpp"

namespace report {

void printNetBarChart(const std::vector<PlayerStats>& byNet);
void printCumulativeChart(const PlayerStats& player);

// One night's hand log with each player's running result, for the report.
struct NightChart {
    const handlog::HandLog* log = nullptr;
    std::vector<handlog::NightSeries> series;
};

struct ReportInput {
    std::vector<PlayerStats> byNet;            // leaderboard order
    std::vector<const Game*> games;            // games in scope, sorted by date
    std::vector<SettlementEntry> settlements;  // may be empty
    Scope scope;
    std::string meNormalized;                  // may be empty
    std::string focusNormalized;               // player for the per-game chart
    std::vector<handlog::StyleStats> style;    // from the hand logs in scope (may be empty)
    std::vector<NightChart> nights;            // newest first
};

bool writeHTMLReport(const std::string& path, const ReportInput& in);

}  // namespace report
