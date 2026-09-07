#pragma once
// Charts: quick ones in the terminal, full interactive ones in a self-contained HTML file.
#include <string>
#include <vector>

#include "models.hpp"

namespace report {

void printNetBarChart(const std::vector<PlayerStats>& byNet);
void printCumulativeChart(const PlayerStats& player);

struct ReportInput {
    std::vector<PlayerStats> byNet;            // leaderboard order
    std::vector<const Game*> games;            // games in scope, sorted by date
    std::vector<SettlementEntry> settlements;  // may be empty
    Scope scope;
    std::string meNormalized;                  // may be empty
    std::string focusNormalized;               // player for the per-game chart
};

bool writeHTMLReport(const std::string& path, const ReportInput& in);

}  // namespace report
