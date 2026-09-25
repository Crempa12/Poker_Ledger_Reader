#include "hitrun.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <set>
#include <sstream>

#include "ledger.hpp"
#include "ui.hpp"
#include "util.hpp"

namespace hitrun {

using handlog::Hand;
using handlog::HandLog;
using handlog::Seat;
using handlog::StackEvent;
using util::EPSILON;
using util::NO_TIME;

// Ten hands is about seven minutes at the pace of these games (81 hands an hour over the
// September logs): the last few people standing up together while the game breaks are
// all "staying", not leaving early.
const int kGraceHands = 10;
// Thirty hands (over twenty minutes) away and then back is a real break, not a missed
// orbit. It is not a hit and run either: only the final exit of a night is judged.
const int kBreakHands = 30;
// Five big blinds either way ($2.50 at the usual $0.25/$0.50) is a wash, not a win or a loss.
const double kEvenBB = 5.0;
// Fifty big blinds (half a standard buy-in) is a real win. Smaller wins count in
// proportion, so walking away after a 10 bb win counts a fifth as much. (Four winning
// nights in five in the September logs were 50 bb or more; the median was 168 bb.)
const double kFullWinBB = 50.0;
// Less than one big blind cannot cover the next blind: leaving with it is a bust.
const double kBustBB = 1.0;
// Twenty hands is about a quarter of an hour. Walking away within a couple of orbits of the
// best point of the night is running with it; an hour later (80 hands) the credit is down to
// a sixteenth. In the September logs, winning nights that ended by leaving up had a median
// of 28 hands after the peak; winning nights they stayed to the end, 72.
const double kPeakHalfLifeHands = 20.0;
// A handful of nights is a noisy read of a habit, so each one leans toward the pool's
// average by this many phantom nights (the usual small-sample correction for rates).
// Both were measured on the September logs, as the night-to-night variance of one
// player's exits over the variance between players' true habits:
//   when up    0.064 / 0.037 = 1.7   over 110 winning nights (also used for the hit)
//   when down  0.072 / 0.031 = 2.3   over only 46 losing nights, so far less certain:
//                                    resampling the players puts it anywhere from 1 to 36,
//                                    and a little extra pull is the safer side
const double kShrinkUpNights = 2.0;
const double kShrinkDownNights = 3.0;
// Three winning nights is the least that says anything about a habit. Below it the
// factor is shown in brackets and earns no tag but Busts out.
const int kMinUpNights = 3;

namespace {

// Tag cut-offs, checked in this order; the first that fits wins. For scale: the pool's
// average habits (30% when up, 23% when down, a 12% hit) score 16; leaving winners with
// half the night to come, 20 hands after a peak they kept, scores 34 (with the pool's
// habit when losing); leaving them with 70% to come, 10 hands after it, 55.
const double kEarlyLeaverWhenUp = 0.40;   // leaves 40%+ of the night early when winning...
const double kEarlyLeaverGap = 0.10;      // ...and within 10 points of that when losing,
const int kEarlyLeaverDownNights = 2;     // with at least two losing exits to show it
const double kHitRunnerAt = 40.0;
const double kRunsWhenUpAt = 25.0;
const double kBustsOutShare = 0.40;       // busts out and goes home on 40%+ of their nights
const double kStaysLateBelow = 10.0;      // clearly below the pool's average

std::string num(double v, int dp) {
    std::ostringstream os;
    os << std::fixed << std::setprecision(dp) << v;
    return os.str();
}

std::string pct(double share) { return num(100.0 * share, 0) + "%"; }

double median(std::vector<double> v) {
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    const size_t m = v.size() / 2;
    return v.size() % 2 ? v[m] : (v[m - 1] + v[m]) / 2.0;
}

// The person behind an account at a moment; an account whose nickname has no letters or
// digits is its own person, as in the style tables.
std::string personKey(const HandLog& log, const std::string& pid, std::int64_t at, const players::MergeRules& rules) {
    std::string k = handlog::personAt(log, pid, at, rules);
    return k.empty() ? "@" + pid : k;
}

std::string displayFor(const std::string& person, const std::string& fallback,
                       const std::map<std::string, PlayerStats>& ledgerStats) {
    auto it = ledgerStats.find(person);
    return it != ledgerStats.end() ? it->second.displayName : fallback;
}

// The live big blind posted most often over the given logs, for hands with no readable
// blind. 0 when none has one.
double modalBigBlind(const std::vector<const HandLog*>& logs) {
    std::map<long, int> count;
    for (const HandLog* log : logs)
        for (const Hand& h : log->hands) {
            double bb = playstyle::bigBlindOf(h);
            if (bb > EPSILON) ++count[std::lround(bb * 100)];
        }
    long best = 0;
    int bestN = 0;
    for (const auto& c : count) if (c.second > bestN) { best = c.first; bestN = c.second; }
    return best / 100.0;
}

void classifyByResult(Night& n) {
    if (n.finishedUp()) n.exit = Exit::LeftUp;
    else if (n.finishedDown()) n.exit = Exit::LeftDown;
    else n.exit = Exit::LeftEven;
}

// Seats taken right after the same person's previous seat ended busted: rebuys the ledger
// can see (a new seat after going broke). Only the seat they left last before each new one
// counts, so a clean cash-out in between is not a bust.
int ledgerRebuys(const std::vector<const LedgerRow*>& rows, double bigBlind) {
    int n = 0;
    for (const LedgerRow* seat : rows) {
        if (seat->start == NO_TIME) continue;
        const LedgerRow* previous = nullptr;
        for (const LedgerRow* r : rows)
            if (r != seat && r->end != NO_TIME && r->end <= seat->start && (!previous || r->end > previous->end))
                previous = r;
        if (previous && previous->buyOut < kBustBB * bigBlind) ++n;
    }
    return n;
}

}  // namespace

const char* exitName(Exit e) {
    switch (e) {
        case Exit::Stayed:   return "Stayed";
        case Exit::LeftUp:   return "Left up";
        case Exit::LeftDown: return "Left down";
        case Exit::LeftEven: return "Left even";
        case Exit::Busted:   return "Busted out";
        case Exit::Removed:  return "Removed";
    }
    return "?";
}

double Night::winWeight() const {
    if (!finishedUp()) return 0.0;
    return std::min(1.0, netBB() / kFullWinBB);
}

double Night::kept() const {
    if (!peakKnown || peak <= EPSILON) return 0.0;
    return std::clamp(finalRunning / peak, 0.0, 1.0);
}

double Night::fresh() const {
    if (!peakKnown || peak <= EPSILON) return 0.0;
    return kept() * std::pow(0.5, handsAfterPeak / kPeakHalfLifeHands);
}

std::string Summary::habitsLine() const {
    std::ostringstream os;
    if (upNights == 0) {
        os << "no winning nights to judge";
    } else {
        os << "leaves with " << pct(whenUp) << " of the night to come when up (" << upNights << " night"
           << (upNights == 1 ? "" : "s") << "), " << pct(whenDown) << " when down";
        if (peakNightsLeftUp)
            os << "\nleaving up, typically " << num(handsAfterPeakWhenUp, 0) << " hands (" << num(minutesAfterPeakWhenUp, 0)
               << " min) after their peak, keeping " << pct(keptWhenUp) << " of it";
    }
    return os.str();
}

// ======================================================================
// Nights
// ======================================================================

std::vector<Night> nightsFromLog(const HandLog& log, const Game* game,
                                 const players::MergeRules& rules,
                                 const std::map<std::string, PlayerStats>& ledgerStats,
                                 double defaultBigBlind) {
    struct Track {
        std::string display;
        int first = -1, last = -1, played = 0;   // indexes into log.hands
        double running = 0.0;         // the log's net so far
        double maxRunning = -std::numeric_limits<double>::infinity();
        int maxHand = -1;             // index of the hand that took `running` to its highest
        int playedAtMax = 0;          // hands dealt in up to and including that one
        double stackAfter = 0.0;      // chips after their latest hand dealt in
        double runningAtLast = 0.0;
        double bbAtLast = 0.0;
        int rebuys = 0, cameBack = 0, cameBackUp = 0;
        bool refilledAfterLast = false;   // chips added after their last hand, never played
        bool removed = false;             // the admin took them out right as they stopped
    };

    std::vector<Night> out;
    const int n = static_cast<int>(log.hands.size());
    if (n == 0) return out;
    double nightBB = modalBigBlind({&log});
    if (nightBB <= EPSILON) nightBB = defaultBigBlind;

    // Hands keep their numbers when PokerNow cuts the start off a long night's log, so the
    // last number is the length of the whole night. Fall back on counting when the numbers
    // do not run in order.
    const bool numbered = log.hands.front().number >= 1 && log.hands.back().number - log.hands.front().number + 1 == n;
    auto numberOf = [&](int h) { return numbered ? log.hands[h].number : h + 1; };
    const int firstNo = numberOf(0);
    const int lastNo = numberOf(n - 1);
    const int missing = firstNo - 1;
    const std::int64_t logStart = log.hands.front().start;
    // The hand being dealt at a moment before the log begins, pacing the missing hands
    // evenly from the ledger's first sit-down to the log's first hand.
    auto numberAt = [&](std::int64_t t) {
        if (missing == 0 || !game || game->start == NO_TIME || t == NO_TIME || logStart == NO_TIME || logStart <= game->start)
            return firstNo;
        double f = static_cast<double>(t - game->start) / static_cast<double>(logStart - game->start);
        return 1 + static_cast<int>(std::lround(std::clamp(f, 0.0, 1.0) * missing));
    };

    std::map<std::string, Track> tracks;
    for (int h = 0; h < n; ++h) {
        const Hand& hand = log.hands[h];
        double bb = playstyle::bigBlindOf(hand);
        if (bb <= EPSILON) bb = nightBB;

        // Accounts are resolved to people hand by hand: a shared account can change hands mid-night.
        std::map<std::string, std::string> keyOf;
        auto key = [&](const std::string& pid) -> const std::string& {
            auto c = keyOf.find(pid);
            if (c == keyOf.end()) c = keyOf.emplace(pid, personKey(log, pid, hand.start, rules)).first;
            return c->second;
        };

        // Someone on two accounts in one hand is one person with the two stacks added up.
        std::map<std::string, double> startStack, endStack;
        for (const Seat& s : hand.seats) {
            const std::string& k = key(s.playerId);
            auto net = hand.net.find(s.playerId);
            startStack[k] += s.stack;
            endStack[k] += s.stack + (net == hand.net.end() ? 0.0 : net->second);
            Track& t = tracks[k];
            if (t.display.empty()) t.display = handlog::displayNameAt(log, s.playerId, hand.start, rules, ledgerStats);
        }
        for (const auto& st : startStack) {
            Track& t = tracks[st.first];
            if (t.first < 0) {
                t.first = h;
            } else {
                // Busted last time and sitting with more chips now: they bought back in, whether by
                // a rebuy, a new seat or an admin top-up. Otherwise a long gap is a break they came back from.
                const bool bustedBefore = t.stackAfter < kBustBB * t.bbAtLast;
                const bool addedChips = st.second > t.stackAfter + EPSILON;
                if (bustedBefore && addedChips) {
                    ++t.rebuys;
                } else if (h - t.last - 1 >= kBreakHands) {
                    ++t.cameBack;
                    if (t.runningAtLast >= kEvenBB * t.bbAtLast) ++t.cameBackUp;
                }
            }
            t.last = h;
            ++t.played;
        }
        for (const auto& net : hand.net) {
            auto t = tracks.find(key(net.first));
            if (t != tracks.end()) t->second.running += net.second;
        }
        for (const auto& st : endStack) {
            Track& t = tracks[st.first];
            t.stackAfter = st.second;
            t.runningAtLast = t.running;
            t.bbAtLast = bb;
            if (t.running > t.maxRunning + EPSILON) {
                t.maxRunning = t.running;
                t.maxHand = h;
                t.playedAtMax = t.played;
            }
        }
    }

    // What happened after each person's last hand: chips put back on the table that were never
    // played (so they did not leave busted), or the admin forcing them away or removing them.
    for (const StackEvent& ev : log.events) {
        auto it = tracks.find(personKey(log, ev.playerId, ev.at, rules));
        if (it == tracks.end() || it->second.first < 0) continue;
        Track& t = it->second;
        if ((ev.kind == "rebuy" || ev.kind == "topup") && ev.hand > t.last) t.refilledAfterLast = true;
        if ((ev.kind == "away" || ev.kind == "kick") && ev.hand >= t.last && ev.hand <= t.last + 1 + kGraceHands)
            t.removed = true;
    }

    // The ledger is what the leaderboard counts and covers the whole night, cut-off log or not:
    // it decides up or down, and its times place anything from before the log begins.
    std::map<std::string, std::vector<const LedgerRow*>> seatsOf;
    std::map<std::string, double> ledgerNet;
    if (game)
        for (const LedgerRow& r : game->rows) {
            const std::string k = players::personOf(rules, r);
            seatsOf[k].push_back(&r);
            ledgerNet[k] += r.net;
        }
    auto earliestSeat = [&](const std::string& k) {
        std::int64_t e = NO_TIME;
        auto it = seatsOf.find(k);
        if (it != seatsOf.end())
            for (const LedgerRow* r : it->second)
                if (r->start != NO_TIME && (e == NO_TIME || r->start < e)) e = r->start;
        return e;
    };

    for (const auto& pair : tracks) {
        const std::string& k = pair.first;
        const Track& t = pair.second;
        if (t.first < 0) continue;
        Night nt;
        nt.gameId = game ? game->id : log.gameId;
        nt.date = game ? game->start : log.start;
        nt.person = k;
        nt.displayName = displayFor(k, t.display, ledgerStats);
        nt.handsInNight = lastNo;
        nt.handsMissing = missing;

        const int firstNumber = numberOf(t.first);
        const std::int64_t earliest = earliestSeat(k);
        const bool seatedBefore = missing > 0 && earliest != NO_TIME && earliest < logStart;
        nt.satDownHand = seatedBefore ? std::min(firstNumber, numberAt(earliest)) : firstNumber;
        nt.lastHand = numberOf(t.last);
        nt.handsLeft = lastNo - nt.lastHand;
        nt.handsPlayed = t.played + (seatedBefore ? std::max(0, firstNo - nt.satDownHand) : 0);
        nt.played = static_cast<double>(nt.handsPlayed) / lastNo;
        nt.bigBlind = t.bbAtLast > EPSILON ? t.bbAtLast : nightBB;
        auto ln = ledgerNet.find(k);
        const bool inLedger = ln != ledgerNet.end();
        nt.net = inLedger ? ln->second : t.running;
        nt.rebuys = t.rebuys;
        nt.cameBack = t.cameBack;
        nt.cameBackUp = t.cameBackUp;

        // The peak on the same scale as the ledger's result. Someone already seated when the log
        // begins starts it with whatever they had won or lost in the hands it does not have.
        const double before = (seatedBefore && inLedger) ? ln->second - t.running : 0.0;
        double best = before;
        bool atStart = true;
        if (t.maxHand >= 0 && before + t.maxRunning > best + EPSILON) {
            best = before + t.maxRunning;
            atStart = false;
        }
        nt.peakKnown = true;
        nt.finalRunning = before + t.runningAtLast;
        if (best > EPSILON) {
            nt.peak = best;
            nt.peakAtLogStart = atStart;
            nt.handsAfterPeak = atStart ? t.played : t.played - t.playedAtMax;
            const std::int64_t from = log.hands[atStart ? t.first : t.maxHand].start;
            const std::int64_t to = log.hands[t.last].start;
            if (from != NO_TIME && to != NO_TIME && to > from) nt.minutesAfterPeak = static_cast<double>(to - from) / 60.0;
        }

        if (nt.handsLeft <= kGraceHands) {
            nt.exit = Exit::Stayed;
            nt.away = 0.0;
        } else {
            // Of the hands dealt from their sit-down to the end of the night, the share after they left.
            const int window = lastNo - nt.satDownHand + 1;
            nt.away = window > 0 ? static_cast<double>(nt.handsLeft) / window : 0.0;
            if (t.stackAfter < kBustBB * nt.bigBlind && !t.refilledAfterLast) nt.exit = Exit::Busted;
            else if (t.removed) nt.exit = Exit::Removed;
            else classifyByResult(nt);
        }
        out.push_back(nt);
    }

    // People the cut-off log never deals in, whose seats began before it: they left in the
    // hands it does not have. Place them from the ledger's times.
    if (missing > 0 && game) {
        for (const auto& pair : seatsOf) {
            const std::string& k = pair.first;
            auto tr = tracks.find(k);
            if (tr != tracks.end() && tr->second.first >= 0) continue;
            const std::int64_t earliest = earliestSeat(k);
            if (earliest == NO_TIME || earliest >= logStart) continue;   // sat down later, never dealt in: nothing to judge

            std::int64_t leftAt = NO_TIME;
            bool open = false;
            const LedgerRow* lastOut = nullptr;
            double net = 0.0;
            for (const LedgerRow* r : pair.second) {
                net += r->net;
                if (r->start == NO_TIME) continue;
                if (r->end == NO_TIME) open = true;
                else if (leftAt == NO_TIME || r->end > leftAt) { leftAt = r->end; lastOut = r; }
            }
            // Still seated at the end, or cashed out after the log begins, yet never dealt a logged
            // hand: they were sitting out, so their last hand came before the log.
            if (open || leftAt == NO_TIME || leftAt > logStart) { leftAt = logStart; if (open) lastOut = nullptr; }

            Night nt;
            nt.gameId = game->id;
            nt.date = game->start;
            nt.person = k;
            nt.displayName = displayFor(k, pair.second.front()->nickname, ledgerStats);
            nt.estimated = true;
            nt.handsInNight = lastNo;
            nt.handsMissing = missing;
            nt.satDownHand = numberAt(earliest);
            nt.lastHand = std::max(nt.satDownHand, std::min(numberAt(leftAt), firstNo - 1));
            nt.handsLeft = lastNo - nt.lastHand;
            nt.handsPlayed = nt.lastHand - nt.satDownHand + 1;
            nt.played = static_cast<double>(nt.handsPlayed) / lastNo;
            nt.net = net;
            nt.bigBlind = nightBB;
            nt.rebuys = ledgerRebuys(pair.second, nightBB);
            // The same order as a logged night; staying is only possible here when the log is that short.
            if (nt.handsLeft <= kGraceHands) {
                nt.exit = Exit::Stayed;
            } else {
                const int window = lastNo - nt.satDownHand + 1;
                nt.away = window > 0 ? static_cast<double>(nt.handsLeft) / window : 0.0;
                if (lastOut && lastOut->buyOut < kBustBB * nightBB) nt.exit = Exit::Busted;
                else classifyByResult(nt);
            }
            out.push_back(nt);
        }
    }
    return out;
}

std::vector<Night> collect(const std::vector<const Game*>& games,
                           const std::map<std::string, HandLog>& logs,
                           const players::MergeRules& rules,
                           const std::map<std::string, PlayerStats>& ledgerStats,
                           int* unmeasured) {
    std::vector<std::pair<const Game*, const HandLog*>> logged;
    int missing = 0;
    for (const Game* g : games) {
        auto log = logs.find(ledger::logId(*g));
        if (log == logs.end()) ++missing;
        else logged.emplace_back(g, &log->second);
    }
    if (unmeasured) *unmeasured = missing;

    // A night with no readable big blind at all falls back on the stake of the rest.
    std::vector<const HandLog*> all;
    for (const auto& p : logged) all.push_back(p.second);
    double usual = modalBigBlind(all);
    if (usual <= EPSILON) usual = 1.0;

    std::vector<Night> out;
    for (const auto& p : logged) {
        std::vector<Night> nights = nightsFromLog(*p.second, p.first, rules, ledgerStats, usual);
        out.insert(out.end(), nights.begin(), nights.end());
    }
    return out;
}

// ======================================================================
// Summaries
// ======================================================================

std::vector<Summary> summarize(const std::vector<Night>& nights) {
    // The pool's habits, over every night by anyone, for thin personal samples to lean on.
    double poolUp = 0.0, poolUpWeight = 0.0, poolHit = 0.0, poolHitWeight = 0.0, poolDown = 0.0;
    int poolDownN = 0;
    for (const Night& n : nights) {
        if (n.upSample()) {
            poolUp += n.winWeight() * n.away;
            poolUpWeight += n.winWeight();
            if (n.peakKnown) { poolHit += n.winWeight() * n.away * n.fresh(); poolHitWeight += n.winWeight(); }
        }
        if (n.downSample()) { poolDown += n.away; ++poolDownN; }
    }
    if (poolUpWeight > 0) poolUp /= poolUpWeight;
    if (poolHitWeight > 0) poolHit /= poolHitWeight;
    if (poolDownN > 0) poolDown /= poolDownN;

    struct Sums {
        double up = 0, upWeight = 0, hit = 0, hitWeight = 0, down = 0, handsLeftUp = 0;
        std::vector<double> afterPeak, afterPeakMinutes, kept;
    };
    std::map<std::string, Summary> rows;
    std::map<std::string, Sums> sums;
    for (const Night& n : nights) {
        Summary& s = rows[n.person];
        Sums& x = sums[n.person];
        if (s.person.empty()) { s.person = n.person; s.displayName = n.displayName; }
        ++s.nights;
        if (n.estimated) ++s.estimatedNights;
        s.played += n.played;
        s.rebuys += n.rebuys;
        s.cameBack += n.cameBack;
        s.cameBackUp += n.cameBackUp;
        switch (n.exit) {
            case Exit::Stayed:
                ++s.stayed;
                if (n.finishedUp()) ++s.stayedUp;
                else if (n.finishedDown()) ++s.stayedDown;
                break;
            case Exit::LeftUp:
                ++s.leftUp;
                x.handsLeftUp += n.handsLeft;
                if (n.peakKnown && n.peak > EPSILON) {
                    x.afterPeak.push_back(n.handsAfterPeak);
                    x.afterPeakMinutes.push_back(n.minutesAfterPeak);
                    x.kept.push_back(n.kept());
                }
                break;
            case Exit::LeftDown: ++s.leftDown; break;
            case Exit::LeftEven: ++s.leftEven; break;
            case Exit::Busted:   ++s.busted; break;
            case Exit::Removed:  ++s.removed; break;
        }
        if (n.upSample()) {
            ++s.upNights;
            x.up += n.winWeight() * n.away;
            x.upWeight += n.winWeight();
            if (n.peakKnown) { x.hit += n.winWeight() * n.away * n.fresh(); x.hitWeight += n.winWeight(); }
        }
        if (n.downSample()) {
            ++s.downNights;
            x.down += n.away;
        }
    }

    std::vector<Summary> out;
    for (auto& pair : rows) {
        Summary& s = pair.second;
        const Sums& x = sums[pair.first];
        s.played = s.nights ? s.played / s.nights : 0.0;
        s.handsLeftWhenUp = s.leftUp ? x.handsLeftUp / s.leftUp : 0.0;
        s.peakNightsLeftUp = static_cast<int>(x.afterPeak.size());
        s.handsAfterPeakWhenUp = median(x.afterPeak);
        s.minutesAfterPeakWhenUp = median(x.afterPeakMinutes);
        s.keptWhenUp = median(x.kept);
        s.whenUpRaw = x.upWeight > 0 ? x.up / x.upWeight : 0.0;
        s.whenUp = (x.up + kShrinkUpNights * poolUp) / (x.upWeight + kShrinkUpNights);
        s.whenDownRaw = s.downNights ? x.down / s.downNights : 0.0;
        s.whenDown = (x.down + kShrinkDownNights * poolDown) / (s.downNights + kShrinkDownNights);
        s.hitRaw = x.hitWeight > 0 ? x.hit / x.hitWeight : 0.0;
        s.hit = (x.hit + kShrinkUpNights * poolHit) / (x.hitWeight + kShrinkUpNights);
        s.factor = s.upNights == 0 ? 0.0 : 100.0 * (s.whenUp + std::max(0.0, s.whenUp - s.whenDown) + s.hit) / 3.0;

        // Tags compare the factor as it is printed, so a "15" is never called "Stays late".
        const double shown = std::round(s.factor);
        const bool enough = s.reliable();
        if (enough && s.downNights >= kEarlyLeaverDownNights && s.whenUp >= kEarlyLeaverWhenUp &&
            s.whenUp - s.whenDown < kEarlyLeaverGap)
            s.tag = "Early leaver";
        else if (enough && shown >= kHitRunnerAt)
            s.tag = "Hit & runner";
        else if (enough && shown >= kRunsWhenUpAt)
            s.tag = "Runs when up";
        else if (s.nights >= kMinUpNights && s.busted >= kBustsOutShare * s.nights && (!enough || shown < kRunsWhenUpAt))
            s.tag = "Busts out";
        else if (enough && shown < kStaysLateBelow)
            s.tag = "Stays late";
        out.push_back(s);
    }
    std::sort(out.begin(), out.end(), [](const Summary& a, const Summary& b) {
        if (a.reliable() != b.reliable()) return a.reliable();
        if (std::fabs(a.factor - b.factor) > 1e-9) return a.factor > b.factor;
        if (a.nights != b.nights) return a.nights > b.nights;
        return a.displayName < b.displayName;
    });
    return out;
}

void annotate(std::vector<handlog::StyleStats>& rows, const std::vector<Summary>& summaries) {
    std::map<std::string, const Summary*> by;
    for (const Summary& s : summaries) by[s.person] = &s;
    for (handlog::StyleStats& r : rows) {
        auto it = by.find(r.normalizedName);
        if (it == by.end()) continue;
        r.hitRunTag = it->second->tag;
        if (it->second->upNights == 0) continue;   // no factor without a winning night to judge
        r.hitRun = it->second->factor;
        r.hitRunReliable = it->second->reliable();
    }
}

void annotate(std::vector<playstyle::Profile>& rows, const std::vector<Summary>& summaries) {
    std::map<std::string, const Summary*> by;
    for (const Summary& s : summaries) by[s.person] = &s;
    for (playstyle::Profile& p : rows) {
        auto it = by.find(p.normalizedName);
        if (it == by.end()) continue;
        p.hitRunTag = it->second->tag;
        p.hitRunLine = it->second->habitsLine();
        if (it->second->upNights == 0) continue;
        p.hitRun = it->second->factor;
        p.hitRunReliable = it->second->reliable();
    }
}

// ======================================================================
// Output
// ======================================================================

namespace {

std::string factorCell(const Summary& s) {
    if (s.upNights == 0) return "-";
    return s.reliable() ? num(s.factor, 0) : "(" + num(s.factor, 0) + ")";
}

std::string colored(const Summary& s, const std::string& text) {
    if (!s.reliable()) return ui::dim(text);
    if (std::round(s.factor) >= kHitRunnerAt) return ui::red(text);
    if (std::round(s.factor) >= kRunsWhenUpAt) return ui::yellow(text);
    return text;
}

}  // namespace

void printTable(const std::vector<Summary>& rows, const std::vector<Night>& nights, int unmeasured) {
    using util::padLeft;
    using util::padRight;
    const int W = 100;
    if (rows.empty()) {
        std::cout << "\nNo hand logs in scope, so no nights to judge. Download \"poker_now_log_<id>.csv\" from PokerNow\n"
                  << "and drop it next to the matching ledger (menu 19 files it).\n";
        return;
    }
    std::set<std::string> games, cut;
    for (const Night& n : nights) {
        games.insert(n.gameId);
        if (n.handsMissing > 0) cut.insert(n.gameId);
    }
    const int measured = static_cast<int>(games.size());

    std::cout << '\n' << ui::heading("Hit & run: how early they leave when winning", W) << '\n'
              << ui::dim(std::to_string(measured) + " night" + (measured == 1 ? "" : "s") + " with a hand log, measured hand by hand.");
    if (!cut.empty())
        std::cout << '\n'
                  << ui::dim(std::to_string(cut.size()) + " of those logs start late (PokerNow cuts the first hands off a long "
                             "night); seats from\nbefore a log begins are placed by the ledger's times.");
    if (unmeasured > 0)
        std::cout << '\n'
                  << ui::yellow(std::to_string(unmeasured) + " night" + (unmeasured == 1 ? "" : "s") +
                                " in scope have no hand log and are left out: a ledger cannot say when\n"
                                "someone stopped playing.");
    double poolFactor = 0.0;
    int trusted = 0;
    for (const Summary& s : rows) if (s.reliable()) { poolFactor += s.factor; ++trusted; }
    if (trusted)
        std::cout << '\n' << ui::dim("Average H&R over the " + std::to_string(trusted) + " players with " +
                                     std::to_string(kMinUpNights) + "+ winning nights: " + num(poolFactor / trusted, 0) + ".");
    std::cout << "\n\n"
              << ui::bold(padRight("Player", 16) + padLeft("Nights", 7) + padLeft("Play", 6) + padLeft("Stay", 5) +
                          padLeft("Up", 4) + padLeft("Down", 5) + padLeft("Bust", 5) + padLeft("Rebuy", 6) + padLeft("Back", 5) +
                          padLeft("When up", 8) + padLeft("When dn", 8) + padLeft("Hit", 6) + padLeft("H&R", 5) + "  Tag")
              << '\n' << ui::rule(W) << '\n';
    for (const Summary& s : rows) {
        std::cout << padRight(s.displayName, 16) << padLeft(std::to_string(s.nights), 7) << padLeft(pct(s.played), 6)
                  << padLeft(std::to_string(s.stayed), 5) << padLeft(std::to_string(s.leftUp), 4)
                  << padLeft(std::to_string(s.leftDown), 5) << padLeft(std::to_string(s.busted), 5)
                  << padLeft(std::to_string(s.rebuys), 6) << padLeft(std::to_string(s.cameBack), 5)
                  << padLeft(s.upNights ? pct(s.whenUp) : "-", 8) << padLeft(pct(s.whenDown), 8)
                  << padLeft(s.upNights ? pct(s.hit) : "-", 6)
                  << colored(s, padLeft(factorCell(s), 5)) << "  " << colored(s, padRight(s.tag, W - 88)) << '\n';
    }
    std::cout << ui::rule(W) << '\n'
              << ui::dim("Each night ends in one exit, judged on the LAST time they left (a break they came back from is not).\n"
                         "Stay = dealt in during the night's last " + std::to_string(kGraceHands) + " hands.  "
                         "Play = share of each night's hands dealt to them.\n"
                         "Up / Down = left for good with chips, " + num(kEvenBB, 0) + "+ big blinds ahead / behind.\n"
                         "(About even, and taken out by the admin: in the player view.)\n"
                         "Bust = went under " + num(kBustBB, 0) + " big blind and went home.  Rebuy = busted and bought back in.\n"
                         "Back = gone " + std::to_string(kBreakHands) + "+ hands, then dealt in again.\n"
                         "When up = share of the night (from their sit-down) still to come when they left, on nights they\n"
                         "finished ahead, weighted by the win (" + num(kFullWinBB, 0) + "+ big blinds counts fully).  "
                         "Staying counts as 0%.\n"
                         "When dn = the same on nights they finished behind with chips.\n"
                         "Hit = the part of When up that came right after their best point of the night, with most of it\n"
                         "kept: full credit leaving at the peak, half " + num(kPeakHalfLifeHands, 0) + " hands later, a sixteenth " +
                         num(4 * kPeakHalfLifeHands, 0) + " hands later.\n"
                         "All three lean toward the pool's average for a player with few such nights.\n"
                         "H&R = 100 x (When up + how much When up exceeds When dn + Hit) / 3.\n"
                         "An H&R in (brackets) has fewer than " + std::to_string(kMinUpNights) +
                         " winning nights; the only tag it can get is Busts out.\n")
              << '\n';
}

void printPlayer(const Summary& s, const std::vector<Night>& nights) {
    using util::padLeft;
    using util::padRight;
    const int W = 100;
    std::cout << '\n' << ui::heading(s.displayName + " - hit & run " + factorCell(s) + (s.tag.empty() ? "" : " (" + s.tag + ")"), W)
              << '\n';
    // Each line fits 100 columns; "with the pool" is the value after leaning toward the pool's average.
    std::cout << "  When winning   ";
    if (s.upNights)
        std::cout << "left with " << pct(s.whenUpRaw) << " of the night still to come over " << s.upNights << " winning night"
                  << (s.upNights == 1 ? "" : "s") << " (" << pct(s.whenUp) << " with the pool)\n";
    else
        std::cout << "no winning nights\n";
    std::cout << "  When losing    ";
    if (s.downNights)
        std::cout << "left with " << pct(s.whenDownRaw) << " still to come over " << s.downNights << " losing night"
                  << (s.downNights == 1 ? "" : "s") << " with chips (" << pct(s.whenDown) << " with the pool)\n";
    else
        std::cout << "no losing nights with chips (the pool's " << pct(s.whenDown) << " stands in)\n";
    std::cout << "  The hit        ";
    if (s.peakNightsLeftUp)
        std::cout << "leaving up (median of " << s.peakNightsLeftUp << "): " << num(s.handsAfterPeakWhenUp, 0) << " hands ("
                  << num(s.minutesAfterPeakWhenUp, 0) << " min) after their peak, keeping " << pct(s.keptWhenUp) << " of it\n"
                  << "                 hit " << pct(s.hitRaw) << " (" << pct(s.hit) << " with the pool)\n";
    else
        std::cout << "never left up on a night whose peak is known\n";
    std::cout << "  Exits          stayed " << s.stayed << " (" << s.stayedUp << " up, " << s.stayedDown << " down), left up "
              << s.leftUp << ", down " << s.leftDown << ", even " << s.leftEven << ", busted out " << s.busted
              << ", removed " << s.removed << '\n'
              << "  Along the way  " << s.rebuys << " rebuy" << (s.rebuys == 1 ? "" : "s") << "; came back after a break "
              << s.cameBack << " time" << (s.cameBack == 1 ? "" : "s") << ", " << s.cameBackUp << " of them after leaving up\n"
              << "  Hands          played " << pct(s.played) << " of each night's hands";
    if (s.leftUp) std::cout << "; left up with " << num(s.handsLeftWhenUp, 0) << " still to deal, on average";
    std::cout << "\n\n"
              << ui::bold(padRight("Date", 11) + padLeft("Sat at", 7) + padLeft("Last", 7) + padLeft("Still to come", 16) +
                          padLeft("Result", 11) + padLeft("Peak", 11) + padLeft("After peak", 11) + padLeft("Rebuy", 6) +
                          padLeft("Back", 5) + "  Exit")
              << '\n' << ui::rule(W) << '\n';

    std::vector<const Night*> mine;
    for (const Night& n : nights) if (n.person == s.person) mine.push_back(&n);
    std::sort(mine.begin(), mine.end(), [](const Night* a, const Night* b) { return a->date > b->date; });
    bool anyEstimated = false, anyCut = false;
    for (const Night* n : mine) {
        std::string toCome = std::to_string(n->handsLeft) + "/" + std::to_string(n->handsInNight - n->satDownHand + 1);
        if (n->exit != Exit::Stayed) toCome += " (" + pct(n->away) + ")";
        std::string peak = "?", after = "?";
        if (n->peakKnown) {
            peak = n->peak > EPSILON ? util::money(n->peak) + (n->peakAtLogStart ? "+" : "") : "-";
            after = n->peak > EPSILON ? std::to_string(n->handsAfterPeak) + " (" + num(n->minutesAfterPeak, 0) + "m)" : "-";
        }
        std::string exit = exitName(n->exit);
        if (n->exit == Exit::Stayed) exit += n->finishedUp() ? " (up)" : n->finishedDown() ? " (down)" : " (even)";
        const bool cut = n->satDownHand < n->handsMissing + 1;
        anyEstimated = anyEstimated || n->estimated;
        anyCut = anyCut || cut;
        std::cout << padRight(util::formatLocalDate(n->date), 11)
                  << padLeft((cut ? "~#" : "#") + std::to_string(n->satDownHand), 7)
                  << padLeft((n->estimated ? "~#" : "#") + std::to_string(n->lastHand), 7) << padLeft(toCome, 16)
                  << padLeft(ui::net(n->net), 11) << padLeft(peak, 11) << padLeft(after, 11)
                  << padLeft(n->rebuys ? std::to_string(n->rebuys) : "", 6) << padLeft(n->cameBack ? std::to_string(n->cameBack) : "", 5)
                  << "  " << exit << '\n';
    }
    std::cout << ui::rule(W) << '\n'
              << ui::dim("Sat at / Last = PokerNow hand numbers of their first and last hand.  Still to come = hands dealt\n"
                         "after their last hand / hands dealt since they sat down (that share).  Peak = their best point of\n"
                         "the night; After peak = hands (minutes) they played after reaching it.\n");
    if (anyCut || anyEstimated)
        std::cout << ui::dim("~ = before the night's log begins (PokerNow cut its first hands off): placed by the ledger's times.\n"
                             "A peak ending in + was reached where the log begins and may have been higher before it.\n");
    std::cout << '\n';
}

bool exportCSV(const std::string& filename, const std::vector<Summary>& rows) {
    std::ofstream f(filename);
    if (!f) return false;
    f << "player,normalized,nights,estimated_nights,played_pct,stayed,stayed_up,stayed_down,left_up,left_down,left_even,"
         "busted,removed,rebuys,came_back,came_back_up,hands_left_when_up,up_nights,when_up_raw_pct,when_up_pct,down_nights,"
         "when_down_raw_pct,when_down_pct,peak_nights_left_up,hands_after_peak_when_up,minutes_after_peak_when_up,"
         "kept_of_peak_when_up_pct,hit_raw_pct,hit_pct,hit_run,reliable,tag\n";
    for (const Summary& s : rows) {
        f << util::escapeCSV(s.displayName) << ',' << util::escapeCSV(s.person) << ',' << s.nights << ',' << s.estimatedNights << ','
          << num(100 * s.played, 2) << ',' << s.stayed << ',' << s.stayedUp << ',' << s.stayedDown << ',' << s.leftUp << ','
          << s.leftDown << ',' << s.leftEven << ',' << s.busted << ',' << s.removed << ',' << s.rebuys << ',' << s.cameBack << ','
          << s.cameBackUp << ',' << num(s.handsLeftWhenUp, 1) << ',' << s.upNights << ',' << num(100 * s.whenUpRaw, 2) << ','
          << num(100 * s.whenUp, 2) << ',' << s.downNights << ',' << num(100 * s.whenDownRaw, 2) << ','
          << num(100 * s.whenDown, 2) << ',' << s.peakNightsLeftUp << ',' << num(s.handsAfterPeakWhenUp, 1) << ','
          << num(s.minutesAfterPeakWhenUp, 1) << ',' << num(100 * s.keptWhenUp, 2) << ',' << num(100 * s.hitRaw, 2) << ','
          << num(100 * s.hit, 2) << ',' << num(s.factor, 2) << ',' << (s.reliable() ? "yes" : "no") << ','
          << util::escapeCSV(s.tag) << '\n';
    }
    return true;
}

bool exportNightsCSV(const std::string& filename, const std::vector<Night>& nights) {
    std::ofstream f(filename);
    if (!f) return false;
    f << "date,game,player,normalized,hands_in_night,hands_missing_from_log,sat_down_hand,last_hand,hands_played,hands_left,"
         "estimated,played_pct,away_pct,net,big_blind,net_bb,exit,rebuys,came_back,came_back_up,peak,peak_at_log_start,"
         "final_running,kept_pct,hands_after_peak,minutes_after_peak,fresh\n";
    for (const Night& n : nights) {
        f << util::formatLocalDate(n.date) << ',' << util::escapeCSV(n.gameId) << ',' << util::escapeCSV(n.displayName) << ','
          << util::escapeCSV(n.person) << ',' << n.handsInNight << ',' << n.handsMissing << ',' << n.satDownHand << ','
          << n.lastHand << ',' << n.handsPlayed << ',' << n.handsLeft << ',' << (n.estimated ? "yes" : "no") << ','
          << num(100 * n.played, 2) << ',' << num(100 * n.away, 2) << ',' << util::fixed2(n.net) << ','
          << util::fixed2(n.bigBlind) << ',' << num(n.netBB(), 2) << ',' << exitName(n.exit) << ',' << n.rebuys << ','
          << n.cameBack << ',' << n.cameBackUp << ',' << (n.peakKnown ? util::fixed2(n.peak) : "") << ','
          << (n.peakAtLogStart ? "yes" : "no") << ',' << (n.peakKnown ? util::fixed2(n.finalRunning) : "") << ','
          << (n.peakKnown ? num(100 * n.kept(), 2) : "") << ',' << (n.peakKnown ? std::to_string(n.handsAfterPeak) : "") << ','
          << (n.peakKnown ? num(n.minutesAfterPeak, 1) : "") << ',' << (n.peakKnown ? num(n.fresh(), 4) : "") << '\n';
    }
    return true;
}

}  // namespace hitrun
