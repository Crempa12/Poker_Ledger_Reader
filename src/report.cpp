#include "report.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>

using namespace util;

namespace report {

// ======================================================================
// Terminal charts
// ======================================================================

void printNetBarChart(const std::vector<PlayerStats>& byNet) {
    if (byNet.empty()) {
        std::cout << "No players in scope.\n";
        return;
    }
    double maxAbs = 0.0;
    for (const PlayerStats& p : byNet) maxAbs = std::max(maxAbs, std::fabs(p.totalNet));
    if (maxAbs < EPSILON) maxAbs = 1.0;

    const int half = 28;
    std::cout << "\nNet result by player (" << money(maxAbs) << " = full bar)\n";
    std::cout << padRight("", 16) << padLeft("losses ", half) << "|" << " wins\n";
    for (const PlayerStats& p : byNet) {
        int len = static_cast<int>(std::lround(std::fabs(p.totalNet) / maxAbs * half));
        std::string neg, pos;
        if (p.totalNet < 0) neg = std::string(len, '#');
        else pos = std::string(len, '#');
        std::cout << padRight(p.displayName, 16) << padLeft(neg, half) << "|" << padRight(pos, half)
                  << ' ' << moneySigned(p.totalNet) << '\n';
    }
    std::cout << '\n';
}

void printCumulativeChart(const PlayerStats& p) {
    if (p.history.empty()) return;

    const size_t maxCols = 70;
    size_t startIdx = p.history.size() > maxCols ? p.history.size() - maxCols : 0;
    std::vector<double> cum;
    double running = 0.0;
    for (size_t i = 0; i < p.history.size(); ++i) {
        running += p.history[i].net;
        if (i >= startIdx) cum.push_back(running);
    }

    double lo = 0.0, hi = 0.0;
    for (double v : cum) { lo = std::min(lo, v); hi = std::max(hi, v); }
    if (hi - lo < 1.0) hi = lo + 1.0;

    const int rows = 12;
    std::cout << "\nRunning total for " << p.displayName << " (one column per game"
              << (startIdx > 0 ? ", last 70 games" : "") << ")\n";
    for (int r = rows; r >= 0; --r) {
        double yTop = lo + (hi - lo) * (r + 0.5) / rows;
        double yBot = lo + (hi - lo) * (r - 0.5) / rows;
        double yMid = lo + (hi - lo) * r / rows;
        bool zeroRow = (0.0 >= yBot && 0.0 < yTop);
        std::string line = padLeft(moneySigned(yMid), 11) + " ";
        for (double v : cum) {
            if (v >= yBot && v < yTop) line += '*';
            else line += zeroRow ? '-' : ' ';
        }
        std::cout << line << '\n';
    }
    std::string first = formatLocalDate(p.history[startIdx].date);
    std::string last = formatLocalDate(p.history.back().date);
    std::string axis = first;
    if (cum.size() > first.size() + last.size() + 1) axis = padRight(first, cum.size() - last.size());
    else axis += " .. ";
    std::cout << padLeft("", 12) << axis << last << "\n\n";
}

// ======================================================================
// HTML report
// ======================================================================

namespace {

const char* kSeriesVars[8] = {"--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"};

std::string fmtNum(double v) {
    std::ostringstream o;
    o << std::fixed << std::setprecision(1) << v;
    return o.str();
}

// A "nice" tick step so an axis gets roughly `target` gridlines.
double niceStep(double range, int target) {
    if (range <= 0) return 1.0;
    double raw = range / target;
    double mag = std::pow(10.0, std::floor(std::log10(raw)));
    double norm = raw / mag;
    double step = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
    return step * mag;
}

std::string axisMoney(double v) {
    std::ostringstream o;
    if (std::fabs(v) >= 1000) o << (v < 0 ? "-$" : "$") << std::fixed << std::setprecision(1) << std::fabs(v) / 1000 << "k";
    else o << (v < 0 ? "-$" : "$") << std::fixed << std::setprecision(0) << std::fabs(v);
    return o.str();
}

void writeStyle(std::ostream& o) {
    o << R"(<style>
:root{color-scheme:light dark;
 --surface:#f6f5f2;--card:#fcfcfb;--text:#0b0b0b;--text2:#52514e;--grid:#e3e2dd;--pos:#2a78d6;--neg:#e34948;
 --s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#4a3aa7;--s8:#e34948;}
@media (prefers-color-scheme:dark){:root{
 --surface:#141413;--card:#1f1f1e;--text:#ffffff;--text2:#c3c2b7;--grid:#3a3a37;--pos:#3987e5;--neg:#e66767;
 --s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767;}}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:0 0 4px}
.sub{color:var(--text2);margin:0 0 20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:8px}
.tile{background:var(--card);border:1px solid var(--grid);border-radius:10px;padding:12px 14px}
.tile .k{font-size:12px;color:var(--text2)}.tile .v{font-size:22px;font-weight:600;margin-top:2px}
.card{background:var(--card);border:1px solid var(--grid);border-radius:10px;padding:16px 18px;margin:16px 0}
.card p.note{color:var(--text2);font-size:12px;margin:0 0 10px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:6px 8px;border-bottom:1px solid var(--grid);text-align:right;white-space:nowrap}
th{color:var(--text2);font-weight:500}th.l,td.l{text-align:left}
tr.me td{font-weight:600}
.scroll{overflow-x:auto}
svg{width:100%;height:auto;display:block;font-family:inherit}
svg text{fill:var(--text2);font-size:11px}svg text.lbl{fill:var(--text);font-size:11px}
.grid{stroke:var(--grid);stroke-width:1}.zero{stroke:var(--text2);stroke-width:1}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--text2);margin-top:8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
#tip{position:fixed;display:none;pointer-events:none;background:var(--card);color:var(--text);border:1px solid var(--grid);
 border-radius:6px;padding:6px 9px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.15);z-index:10;max-width:260px}
#tip i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px}
.tag{display:inline-block;font-size:11px;color:var(--text2);border:1px solid var(--grid);border-radius:4px;padding:0 5px}
</style>
)";
}

// ---------- chart 1: net by player (horizontal diverging bars) ----------
void writeNetBars(std::ostream& o, const ReportInput& in) {
    const std::vector<PlayerStats>& list = in.byNet;
    if (list.empty()) return;

    const double W = 900, labelW = 130, rightPad = 80, rowH = 24, barH = 18, top = 8;
    double maxPos = 0, maxNeg = 0;
    for (const PlayerStats& p : list) {
        maxPos = std::max(maxPos, p.totalNet);
        maxNeg = std::max(maxNeg, -p.totalNet);
    }
    double span = maxPos + maxNeg;
    if (span < 1) span = 1;
    double plotW = W - labelW - rightPad;
    double zeroX = labelW + plotW * (maxNeg / span);
    double H = top + rowH * list.size() + 8;

    o << "<div class=card><h2>Net result by player</h2><p class=note>Blue = up, red = down. Hover a bar for details.</p>";
    o << "<svg viewBox=\"0 0 " << W << " " << H << "\" role=img aria-label=\"Net result by player\">";
    o << "<line class=zero x1=" << zeroX << " y1=" << top << " x2=" << zeroX << " y2=" << H - 4 << " />";
    for (size_t i = 0; i < list.size(); ++i) {
        const PlayerStats& p = list[i];
        double y = top + rowH * i;
        double len = std::fabs(p.totalNet) / span * plotW;
        bool pos = p.totalNet >= 0;
        double x = pos ? zeroX + 1 : zeroX - 1 - len;
        std::string tip = "<b>" + escapeHTML(p.displayName) + "</b><br>Net " + moneySigned(p.totalNet) + "<br>" +
                          std::to_string(p.games) + " games, " + std::to_string(p.buyIns) + " buy-ins<br>Avg " +
                          moneySigned(p.averagePerGame()) + " per game";
        o << "<text x=" << labelW - 8 << " y=" << y + barH / 2 + 4 << " text-anchor=end class=lbl>" << escapeHTML(p.displayName) << "</text>";
        o << "<rect x=" << x << " y=" << y << " width=" << std::max(len, 1.0) << " height=" << barH
          << " rx=4 style=\"fill:var(" << (pos ? "--pos" : "--neg") << ")\" data-tip=\"" << escapeHTML(tip) << "\"/>";
        double tx = pos ? zeroX + len + 6 : zeroX + 6;
        o << "<text x=" << tx << " y=" << y + barH / 2 + 4 << ">" << moneySigned(p.totalNet) << "</text>";
    }
    o << "</svg></div>\n";
}

// ---------- chart 2: cumulative net over time (line chart) ----------
void writeCumulativeLines(std::ostream& o, const ReportInput& in) {
    if (in.games.empty() || in.byNet.empty()) return;

    // Which players get a line: "me" first, then the biggest movers, max 8.
    std::vector<const PlayerStats*> chosen;
    const PlayerStats* me = nullptr;
    for (const PlayerStats& p : in.byNet) {
        if (p.normalizedName == in.meNormalized) me = &p;
    }
    if (me) chosen.push_back(me);
    std::vector<const PlayerStats*> movers;
    for (const PlayerStats& p : in.byNet) {
        if (&p != me) movers.push_back(&p);
    }
    std::sort(movers.begin(), movers.end(), [](const PlayerStats* a, const PlayerStats* b) {
        return std::fabs(a->totalNet) > std::fabs(b->totalNet);
    });
    for (const PlayerStats* p : movers) {
        if (chosen.size() >= 8) break;
        chosen.push_back(p);
    }

    // x positions = game index in scope.
    std::map<std::string, size_t> gameIndex;
    for (size_t i = 0; i < in.games.size(); ++i) gameIndex[in.games[i]->id] = i;
    const size_t n = in.games.size();

    // Per series: cumulative value at each game index (NaN = not started yet).
    std::vector<std::vector<double>> vals(chosen.size(), std::vector<double>(n, std::nan("")));
    double lo = 0, hi = 0;
    for (size_t s = 0; s < chosen.size(); ++s) {
        std::map<size_t, double> perIdx;
        for (const GameResult& r : chosen[s]->history) {
            auto it = gameIndex.find(r.gameId);
            if (it != gameIndex.end()) perIdx[it->second] += r.net;
        }
        if (perIdx.empty()) continue;
        double running = 0;
        size_t first = perIdx.begin()->first;
        for (size_t i = first; i < n; ++i) {
            auto it = perIdx.find(i);
            if (it != perIdx.end()) running += it->second;
            vals[s][i] = running;
            lo = std::min(lo, running);
            hi = std::max(hi, running);
        }
    }
    if (hi - lo < 1) hi = lo + 1;
    double step = niceStep(hi - lo, 5);
    lo = std::floor(lo / step) * step;
    hi = std::ceil(hi / step) * step;

    const double W = 900, H = 380, L = 64, R = 130, T = 16, B = 44;
    const double plotW = W - L - R, plotH = H - T - B;
    auto X = [&](size_t i) { return n > 1 ? L + plotW * i / (n - 1) : L + plotW / 2; };
    auto Y = [&](double v) { return T + plotH * (1 - (v - lo) / (hi - lo)); };

    o << "<div class=card><h2>Running total over time</h2><p class=note>One step per game in scope. "
      << "Shows " << (me ? "you plus " : "") << "the biggest movers (up to 8). Hover to read every line at a game.</p>";
    o << "<svg id=cum viewBox=\"0 0 " << W << " " << H << "\" role=img aria-label=\"Running total over time\">";

    for (double v = lo; v <= hi + step / 2; v += step) {
        o << "<line class=" << (std::fabs(v) < step / 100 ? "zero" : "grid") << " x1=" << L << " x2=" << L + plotW
          << " y1=" << Y(v) << " y2=" << Y(v) << " />";
        o << "<text x=" << L - 8 << " y=" << Y(v) + 4 << " text-anchor=end>" << axisMoney(v) << "</text>";
    }
    size_t labelEvery = std::max<size_t>(1, (n + 7) / 8);
    for (size_t i = 0; i < n; ++i) {
        if (i % labelEvery != 0 && i != n - 1) continue;
        o << "<text x=" << X(i) << " y=" << H - B + 18 << " text-anchor=middle>" << formatShortDate(in.games[i]->start) << "</text>";
    }

    // End labels, pushed apart so they do not overlap.
    struct EndLabel { double y; std::string name; size_t s; };
    std::vector<EndLabel> ends;
    for (size_t s = 0; s < chosen.size(); ++s) {
        for (size_t i = n; i-- > 0;) {
            if (!std::isnan(vals[s][i])) { ends.push_back({Y(vals[s][i]), chosen[s]->displayName, s}); break; }
        }
    }
    std::sort(ends.begin(), ends.end(), [](const EndLabel& a, const EndLabel& b) { return a.y < b.y; });
    for (size_t k = 1; k < ends.size(); ++k) {
        if (ends[k].y - ends[k - 1].y < 13) ends[k].y = ends[k - 1].y + 13;
    }

    for (size_t s = 0; s < chosen.size(); ++s) {
        std::string color = std::string("var(") + kSeriesVars[s] + ")";
        std::ostringstream path;
        bool started = false;
        for (size_t i = 0; i < n; ++i) {
            if (std::isnan(vals[s][i])) continue;
            path << (started ? "L" : "M") << fmtNum(X(i)) << " " << fmtNum(Y(vals[s][i])) << " ";
            started = true;
        }
        if (!started) continue;
        bool isMe = chosen[s] == me;
        o << "<path d=\"" << path.str() << "\" fill=none stroke=\"" << color << "\" stroke-width=" << (isMe ? 3 : 2)
          << " stroke-linejoin=\"round\" stroke-linecap=\"round\"/>";
        for (const GameResult& r : chosen[s]->history) {
            auto it = gameIndex.find(r.gameId);
            if (it == gameIndex.end()) continue;
            o << "<circle cx=" << fmtNum(X(it->second)) << " cy=" << fmtNum(Y(vals[s][it->second])) << " r=3.5 fill=\"" << color
              << "\" style=\"stroke:var(--card);stroke-width:2\"/>";
        }
    }
    for (const EndLabel& e : ends) {
        o << "<text x=" << L + plotW + 8 << " y=" << e.y + 4 << " class=lbl>" << escapeHTML(e.name) << "</text>";
    }
    o << "<line id=cross x1=0 x2=0 y1=" << T << " y2=" << T + plotH << " style=\"stroke:var(--text2);stroke-dasharray:3 3;display:none\"/>";
    o << "</svg><div class=legend>";
    for (size_t s = 0; s < chosen.size(); ++s) {
        o << "<span><i style=\"background:var(" << kSeriesVars[s] << ")\"></i>" << escapeHTML(chosen[s]->displayName)
          << " " << moneySigned(chosen[s]->totalNet) << "</span>";
    }
    o << "</div></div>\n";

    // Data for the hover layer.
    o << "<script>var LC={w:" << W << ",l:" << L << ",n:" << n << ",step:" << (n > 1 ? plotW / (n - 1) : 0) << ",labels:[";
    for (size_t i = 0; i < n; ++i) {
        o << (i ? "," : "") << "\"" << escapeHTML(formatLocalDate(in.games[i]->start)) << " · " << escapeHTML(in.games[i]->folder) << "\"";
    }
    o << "],series:[";
    for (size_t s = 0; s < chosen.size(); ++s) {
        o << (s ? "," : "") << "{name:\"" << escapeHTML(chosen[s]->displayName) << "\",color:\"var(" << kSeriesVars[s] << ")\",vals:[";
        for (size_t i = 0; i < n; ++i) {
            o << (i ? "," : "");
            if (std::isnan(vals[s][i])) o << "null";
            else o << fixed2(vals[s][i]);
        }
        o << "]}";
    }
    o << "]};</script>\n";
}

// ---------- chart 3: per-game results for the focus player ----------
void writePerGameBars(std::ostream& o, const ReportInput& in) {
    const PlayerStats* focus = nullptr;
    for (const PlayerStats& p : in.byNet) {
        if (p.normalizedName == in.focusNormalized) focus = &p;
    }
    if (!focus || focus->history.empty()) return;

    const std::vector<GameResult>& h = focus->history;
    double lo = 0, hi = 0;
    for (const GameResult& r : h) { lo = std::min(lo, r.net); hi = std::max(hi, r.net); }
    if (hi - lo < 1) hi = lo + 1;
    double step = niceStep(hi - lo, 5);
    lo = std::floor(lo / step) * step;
    hi = std::ceil(hi / step) * step;

    const double W = 900, H = 300, L = 64, R = 20, T = 16, B = 44;
    const double plotW = W - L - R, plotH = H - T - B;
    const size_t n = h.size();
    double slot = plotW / n;
    double barW = std::max(2.0, std::min(28.0, slot - 2));
    auto Y = [&](double v) { return T + plotH * (1 - (v - lo) / (hi - lo)); };

    int wins = 0;
    for (const GameResult& r : h) if (r.net > EPSILON) ++wins;

    o << "<div class=card><h2>Game-by-game results for " << escapeHTML(focus->displayName) << "</h2><p class=note>"
      << n << " games, " << wins << " winning nights (" << (n ? wins * 100 / n : 0) << "%). Best "
      << moneySigned(focus->biggestWin) << ", worst " << moneySigned(focus->biggestLoss) << ".</p>";
    o << "<svg viewBox=\"0 0 " << W << " " << H << "\" role=img aria-label=\"Per-game results\">";
    for (double v = lo; v <= hi + step / 2; v += step) {
        o << "<line class=" << (std::fabs(v) < step / 100 ? "zero" : "grid") << " x1=" << L << " x2=" << L + plotW
          << " y1=" << Y(v) << " y2=" << Y(v) << " />";
        o << "<text x=" << L - 8 << " y=" << Y(v) + 4 << " text-anchor=end>" << axisMoney(v) << "</text>";
    }
    size_t labelEvery = std::max<size_t>(1, (n + 9) / 10);
    double running = 0;
    for (size_t i = 0; i < n; ++i) {
        const GameResult& r = h[i];
        running += r.net;
        double cx = L + slot * i + slot / 2;
        double y0 = Y(0), y1 = Y(r.net);
        bool pos = r.net >= 0;
        std::string tip = "<b>" + escapeHTML(formatLocalDate(r.date)) + "</b> · " + escapeHTML(r.folder) + "<br>Net " +
                          moneySigned(r.net) + " over " + std::to_string(r.buyIns) + " buy-in" + (r.buyIns == 1 ? "" : "s") +
                          "<br>Running total " + moneySigned(running);
        o << "<rect x=" << fmtNum(cx - barW / 2) << " y=" << fmtNum(std::min(y0, y1)) << " width=" << fmtNum(barW)
          << " height=" << fmtNum(std::max(1.0, std::fabs(y0 - y1))) << " rx=3 style=\"fill:var(" << (pos ? "--pos" : "--neg")
          << ")\" data-tip=\"" << escapeHTML(tip) << "\"/>";
        if (i % labelEvery == 0 || i == n - 1) {
            o << "<text x=" << fmtNum(cx) << " y=" << H - B + 18 << " text-anchor=middle>" << formatShortDate(r.date) << "</text>";
        }
    }
    o << "</svg></div>\n";
}

void writeLeaderboardTable(std::ostream& o, const ReportInput& in) {
    o << "<div class=card><h2>Leaderboard</h2><div class=scroll><table><tr><th>#</th><th class=l>Player</th><th>Games</th><th>Buy-ins</th>"
      << "<th>Won</th><th>Lost</th><th>Net</th><th>Avg/game</th><th>Best</th><th>Worst</th><th class=l>Also known as</th></tr>";
    for (size_t i = 0; i < in.byNet.size(); ++i) {
        const PlayerStats& p = in.byNet[i];
        std::string aliases;
        for (const std::string& a : p.aliases) {
            if (a != p.normalizedName && a != normalizeName(p.displayName)) aliases += (aliases.empty() ? "" : ", ") + a;
        }
        o << "<tr" << (p.normalizedName == in.meNormalized ? " class=me" : "") << "><td>" << (i + 1) << "</td><td class=l>"
          << escapeHTML(p.displayName) << "</td><td>" << p.games << "</td><td>" << p.buyIns << "</td><td>" << money(p.totalWon)
          << "</td><td>" << money(p.totalLost) << "</td><td>" << moneySigned(p.totalNet) << "</td><td>"
          << moneySigned(p.averagePerGame()) << "</td><td>" << moneySigned(p.biggestWin) << "</td><td>"
          << moneySigned(p.biggestLoss) << "</td><td class=l>" << escapeHTML(aliases) << "</td></tr>";
    }
    o << "</table></div></div>\n";
}

void writeSettlementTable(std::ostream& o, const ReportInput& in) {
    o << "<div class=card><h2>Settlement sheet</h2>";
    if (in.settlements.empty()) {
        o << "<p class=note>No settlement was calculated for this report (or nobody owes anything).</p></div>\n";
        return;
    }
    o << "<div class=scroll><table><tr><th>#</th><th class=l>From (pays)</th><th class=l>To (receives)</th><th>Amount</th><th class=l>Why</th></tr>";
    for (size_t i = 0; i < in.settlements.size(); ++i) {
        const SettlementEntry& e = in.settlements[i];
        o << "<tr><td>" << (i + 1) << "</td><td class=l>" << escapeHTML(e.fromDisplay) << "</td><td class=l>" << escapeHTML(e.toDisplay)
          << "</td><td>" << money(e.amount) << "</td><td class=l><span class=tag>" << e.reason << "</span></td></tr>";
    }
    o << "</table></div></div>\n";
}

void writeGamesTable(std::ostream& o, const ReportInput& in) {
    o << "<div class=card><h2>Games in scope</h2><div class=scroll><table><tr><th>#</th><th class=l>Date</th><th class=l>Folder</th>"
      << "<th class=l>Ledger</th><th>Players</th><th>Buy-in volume</th><th class=l>Biggest winner</th><th class=l>Biggest loser</th></tr>";
    for (size_t i = 0; i < in.games.size(); ++i) {
        const Game* g = in.games[i];
        std::map<std::string, double> nets;
        for (const LedgerRow& r : g->rows) nets[normalizeName(r.nickname)] += r.net;
        std::string win, lose;
        double best = 0, worst = 0;
        for (const auto& pair : nets) {
            if (pair.second > best) { best = pair.second; win = pair.first; }
            if (pair.second < worst) { worst = pair.second; lose = pair.first; }
        }
        o << "<tr><td>" << (i + 1) << "</td><td class=l>" << formatLocalDateTime(g->start) << "</td><td class=l>" << escapeHTML(g->folder)
          << "</td><td class=l>" << escapeHTML(g->id) << "</td><td>" << nets.size() << "</td><td>" << money(g->totalBuyIn)
          << "</td><td class=l>" << escapeHTML(win) << (win.empty() ? "" : " " + moneySigned(best)) << "</td><td class=l>"
          << escapeHTML(lose) << (lose.empty() ? "" : " " + moneySigned(worst)) << "</td></tr>";
    }
    o << "</table></div></div>\n";
}

void writeScript(std::ostream& o) {
    o << R"(<div id=tip></div>
<script>
(function(){
var tip=document.getElementById('tip');
function show(html,x,y){tip.innerHTML=html;tip.style.display='block';
 var w=tip.offsetWidth,h=tip.offsetHeight;tip.style.left=Math.min(x+14,window.innerWidth-w-8)+'px';tip.style.top=Math.min(y+14,window.innerHeight-h-8)+'px';}
function hide(){tip.style.display='none';}
document.querySelectorAll('[data-tip]').forEach(function(el){
 el.addEventListener('mousemove',function(e){show(el.getAttribute('data-tip'),e.clientX,e.clientY);});
 el.addEventListener('mouseleave',hide);});
var svg=document.getElementById('cum');
if(svg&&window.LC&&LC.n>0){
 var cross=document.getElementById('cross');
 function money(v){var s=Math.abs(v).toFixed(2);return (v<0?'-$':'+$')+s;}
 svg.addEventListener('mousemove',function(e){
  var r=svg.getBoundingClientRect();var sx=(e.clientX-r.left)*LC.w/r.width;
  var i=LC.step>0?Math.round((sx-LC.l)/LC.step):0;if(i<0)i=0;if(i>LC.n-1)i=LC.n-1;
  var x=LC.l+i*LC.step;cross.setAttribute('x1',x);cross.setAttribute('x2',x);cross.style.display='block';
  var rows=LC.series.filter(function(s){return s.vals[i]!==null;}).map(function(s){return {n:s.name,c:s.color,v:s.vals[i]};})
   .sort(function(a,b){return b.v-a.v;});
  show('<b>'+LC.labels[i]+'</b><br>'+rows.map(function(o){return '<i style="background:'+o.c+'"></i>'+o.n+' '+money(o.v);}).join('<br>'),e.clientX,e.clientY);});
 svg.addEventListener('mouseleave',function(){cross.style.display='none';hide();});
}
})();
</script>
)";
}

}  // namespace

bool writeHTMLReport(const std::string& path, const ReportInput& in) {
    std::ofstream o(path);
    if (!o.is_open()) return false;

    double volume = 0;
    for (const Game* g : in.games) volume += g->totalBuyIn;
    const PlayerStats* me = nullptr;
    for (const PlayerStats& p : in.byNet) {
        if (p.normalizedName == in.meNormalized) me = &p;
    }
    std::int64_t first = in.games.empty() ? NO_TIME : in.games.front()->start;
    std::int64_t last = in.games.empty() ? NO_TIME : in.games.back()->start;

    o << "<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\">"
      << "<title>Poker Ledger Report</title>";
    writeStyle(o);
    o << "</head><body><div class=wrap>";
    o << "<h1>Poker Ledger Report</h1><p class=sub>Scope: " << escapeHTML(in.scope.describe()) << " · "
      << formatLocalDate(first) << " to " << formatLocalDate(last) << " · generated " << formatLocalDateTime(nowEpoch()) << "</p>";

    o << "<div class=tiles>"
      << "<div class=tile><div class=k>Games</div><div class=v>" << in.games.size() << "</div></div>"
      << "<div class=tile><div class=k>Players</div><div class=v>" << in.byNet.size() << "</div></div>"
      << "<div class=tile><div class=k>Buy-in volume</div><div class=v>" << money(volume) << "</div></div>";
    if (me) {
        o << "<div class=tile><div class=k>" << escapeHTML(me->displayName) << " net</div><div class=v>" << moneySigned(me->totalNet) << "</div></div>"
          << "<div class=tile><div class=k>" << escapeHTML(me->displayName) << " avg/game</div><div class=v>" << moneySigned(me->averagePerGame()) << "</div></div>";
    } else if (!in.byNet.empty()) {
        o << "<div class=tile><div class=k>Top earner</div><div class=v>" << escapeHTML(in.byNet.front().displayName) << " "
          << moneySigned(in.byNet.front().totalNet) << "</div></div>";
    }
    o << "</div>";

    writeNetBars(o, in);
    writeCumulativeLines(o, in);
    writePerGameBars(o, in);
    writeLeaderboardTable(o, in);
    writeSettlementTable(o, in);
    writeGamesTable(o, in);
    o << "</div>";
    writeScript(o);
    o << "</body></html>\n";
    return true;
}

}  // namespace report
