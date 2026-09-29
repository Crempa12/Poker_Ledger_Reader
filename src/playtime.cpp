#include "playtime.hpp"

#include <algorithm>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <set>
#include <sstream>
#include <utility>

#include "ledger.hpp"
#include "ui.hpp"
#include "util.hpp"

namespace playtime {

using handlog::Hand;
using handlog::HandLog;
using util::NO_TIME;

// Ten minutes. The median gap between two hands in the September logs is 36 seconds, and only
// 10 of 14,260 gaps are longer than this: a food break or a rebuy round, when nobody is playing.
const double kMaxHandSeconds = 600.0;
// That median gap, for a hand with nothing after it to time it by.
const double kDefaultHandSeconds = 36.0;

namespace {

using Window = std::pair<double, double>;   // [start, end) in epoch seconds

double median(std::vector<double> v) {
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    const size_t m = v.size() / 2;
    return v.size() % 2 ? v[m] : (v[m - 1] + v[m]) / 2.0;
}

// Total length of some seat windows, overlaps counted once: two seats at the same time (a second
// account, or a new seat bought before the old one closed) are one person at the table.
double unionLength(std::vector<Window> w) {
    std::sort(w.begin(), w.end());
    double total = 0.0, from = 0.0, to = 0.0;
    bool open = false;
    for (const Window& s : w) {
        if (s.second <= s.first) continue;
        if (!open) { from = s.first; to = s.second; open = true; }
        else if (s.first > to) { total += to - from; from = s.first; to = s.second; }
        else to = std::max(to, s.second);
    }
    return open ? total + (to - from) : total;
}

std::string personKey(const HandLog& log, const std::string& pid, std::int64_t at, const players::MergeRules& rules) {
    std::string k = handlog::personAt(log, pid, at, rules);
    return k.empty() ? "@" + pid : k;
}

std::string num(double v, int dp) {
    std::ostringstream os;
    os << std::fixed << std::setprecision(dp) << v;
    return os.str();
}

std::string withCommas(int v) {
    std::string s = std::to_string(v);
    for (int i = static_cast<int>(s.size()) - 3; i > 0; i -= 3) s.insert(static_cast<size_t>(i), ",");
    return s;
}

}  // namespace

std::vector<Night> nights(const std::vector<const Game*>& games,
                          const std::map<std::string, HandLog>& logs,
                          const players::MergeRules& rules) {
    std::vector<Night> out;
    for (const Game* g : games) {
        std::map<std::string, Night> byPerson;
        auto night = [&](const std::string& k) -> Night& {
            Night& n = byPerson[k];
            if (n.person.empty()) { n.person = k; n.gameId = g->id; }
            return n;
        };
        // Everyone with a seat played the night; seats with a start time are windows of time.
        std::map<std::string, std::vector<std::pair<std::int64_t, std::int64_t>>> seatsOf;
        for (const LedgerRow& r : g->rows) {
            const std::string k = players::personOf(rules, r);
            night(k);
            if (r.start != NO_TIME) seatsOf[k].push_back({r.start, r.end});
        }

        auto log = logs.find(ledger::logId(*g));
        const bool logged = log != logs.end();
        if (!logged) {
            // No hand log: the ledger's seat times are all there is. A seat still open when the
            // ledger was saved ends with the game, at its last recorded time.
            for (const auto& [k, seats] : seatsOf) {
                std::vector<Window> w;
                for (const auto& s : seats) {
                    const std::int64_t end = s.second != NO_TIME ? s.second : g->end;
                    if (end != NO_TIME) w.push_back({static_cast<double>(s.first), static_cast<double>(end)});
                }
                night(k).secondsEstimated = unionLength(w);
            }
        } else {
            const std::vector<Hand>& hands = log->second.hands;
            const size_t n = hands.size();
            // Each hand lasts until the next one starts. The last hand of the night has nothing after
            // it, so it gets the night's typical gap.
            std::vector<double> gaps;
            for (size_t h = 0; h + 1 < n; ++h)
                if (hands[h].start != NO_TIME && hands[h + 1].start != NO_TIME)
                    gaps.push_back(static_cast<double>(hands[h + 1].start - hands[h].start));
            const double lastHand = gaps.empty() ? kDefaultHandSeconds : std::clamp(median(gaps), 0.0, kMaxHandSeconds);
            for (size_t h = 0; h < n; ++h) {
                double length = lastHand;
                if (h + 1 < n) {
                    length = hands[h].start != NO_TIME && hands[h + 1].start != NO_TIME
                                 ? std::clamp(static_cast<double>(hands[h + 1].start - hands[h].start), 0.0, kMaxHandSeconds)
                                 : kDefaultHandSeconds;
                }
                std::set<std::string> people;   // someone on two accounts was still dealt one hand
                for (const handlog::Seat& s : hands[h].seats) people.insert(personKey(log->second, s.playerId, hands[h].start, rules));
                for (const std::string& k : people) {
                    Night& nt = night(k);
                    ++nt.hands;
                    nt.secondsDealt += length;
                }
            }
            // PokerNow cuts the first hands off a long night's log. Time seated before the log begins
            // cannot be measured hand by hand, so the ledger's seat times stand in for it.
            if (n > 0 && hands.front().number > 1 && hands.front().start != NO_TIME) {
                const double logStart = static_cast<double>(hands.front().start);
                for (const auto& [k, seats] : seatsOf) {
                    std::vector<Window> w;
                    for (const auto& s : seats) {
                        const double end = s.second == NO_TIME ? logStart : std::min(static_cast<double>(s.second), logStart);
                        w.push_back({static_cast<double>(s.first), end});
                    }
                    night(k).secondsEstimated = unionLength(w);
                }
            }
        }
        for (auto& pair : byPerson) {
            pair.second.logged = logged;
            out.push_back(pair.second);
        }
    }
    return out;
}

std::map<std::string, PlayTime> summarize(const std::vector<Night>& nights) {
    std::map<std::string, PlayTime> out;
    for (const Night& n : nights) {
        PlayTime& t = out[n.person];
        ++t.nights;
        if (n.logged && n.hands > 0) ++t.nightsLogged;
        t.hands += n.hands;
        t.secondsDealt += n.secondsDealt;
        t.secondsEstimated += n.secondsEstimated;
    }
    return out;
}

std::map<std::string, PlayTime> collect(const std::vector<const Game*>& games,
                                        const std::map<std::string, HandLog>& logs,
                                        const players::MergeRules& rules) {
    return summarize(nights(games, logs, rules));
}

std::string hoursText(const PlayTime& t) {
    return (t.secondsEstimated >= 0.5 ? "~" : "") + num(t.hours(), 1) + " h";
}

void printPlayer(const PlayerStats& p, const PlayTime* t) {
    const int W = 97;
    std::cout << '\n' << ui::heading("At the table", W) << '\n';
    if (!t || t->seconds() < 1.0) {
        std::cout << "  No seat time on record for " << p.displayName << " in this scope.\n";
        return;
    }
    const double hours = t->hours();
    const int nightsShown = std::max(1, t->nights);
    std::cout << "  Time      " << ui::bold(hoursText(*t)) << " over " << t->nights << " night" << (t->nights == 1 ? "" : "s")
              << ", " << num(hours / nightsShown, 1) << " h a night\n"
              << "  Rate      " << ui::bold(ui::net(p.totalNet / hours)) << " an hour"
              << ui::dim("   (poker net " + util::moneySigned(p.totalNet) + " / " + num(hours, 1) + " h)") << '\n';
    if (t->nightsLogged > 0) {
        std::cout << "  Hands     " << withCommas(t->hands) << " dealt over " << t->nightsLogged << " night"
                  << (t->nightsLogged == 1 ? "" : "s") << " with a hand log";
        if (t->secondsDealt >= 60.0) std::cout << ", about " << num(t->hands / (t->secondsDealt / 3600.0), 0) << " an hour";
        std::cout << '\n';
    }
    if (t->secondsEstimated >= 0.5) {
        std::cout << ui::dim("  ~ " + num(t->secondsEstimated / 3600.0, 1) +
                             " h of it is ledger seat time (nights with no hand log, or before a log begins).\n"
                             "    It runs long: a seat stays open while its player sits out.")
                  << '\n';
    }
}

}  // namespace playtime
