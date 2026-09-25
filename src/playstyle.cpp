#include "playstyle.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <set>
#include <sstream>

#include "ui.hpp"
#include "util.hpp"

namespace playstyle {

using handlog::Action;
using handlog::Hand;
using handlog::HandLog;
using handlog::Seat;
using util::EPSILON;

// Below this many opportunities a situational rate is noise, not a read. 25 is low for
// a statistical claim but right for a home game: it is the point where a rate stops
// swinging wildly on one hand. Every printed rate carries its denominator anyway.
int kMinOpportunities = 25;

const char* posName(Pos p) {
    switch (p) {
        case Pos::BTN: return "BTN";
        case Pos::SB:  return "SB";
        case Pos::BB:  return "BB";
        case Pos::UTG: return "UTG";
        case Pos::MP:  return "MP";
        case Pos::CO:  return "CO";
        default:       return "?";
    }
}

double bigBlindOf(const Hand& hand) {
    for (const Action& a : hand.actions)
        if (a.kind == "post" && a.post == Action::Post::BigBlind) return a.amount;
    return 0.0;
}

// Position is derived from the dealer marker plus the seat order. The blind posts are
// the fallback anchor for the "(dead button)" hands where PokerNow prints no dealer.
// Only the LIVE small/big blind may anchor: a dead or missed blind is posted by someone
// re-entering and can appear alongside a perfectly normal blind pair in the same hand.
std::map<std::string, Pos> positionsFor(const Hand& hand) {
    std::map<std::string, Pos> out;
    const int n = static_cast<int>(hand.seats.size());
    if (n < 2) return out;

    std::vector<const Seat*> srt;
    srt.reserve(hand.seats.size());
    for (const Seat& s : hand.seats) srt.push_back(&s);
    std::sort(srt.begin(), srt.end(), [](const Seat* a, const Seat* b) { return a->seat < b->seat; });

    std::map<std::string, int> idx;
    for (int i = 0; i < n; ++i) idx[srt[i]->playerId] = i;
    if (static_cast<int>(idx.size()) != n) return out;   // duplicate seat: refuse to guess

    std::string sbPid, bbPid;
    for (const Action& a : hand.actions) {
        if (a.kind != "post") continue;
        if (a.post == Action::Post::SmallBlind && sbPid.empty()) sbPid = a.playerId;
        if (a.post == Action::Post::BigBlind && bbPid.empty()) bbPid = a.playerId;
    }

    int btn = -1;
    if (!hand.dealerId.empty() && idx.count(hand.dealerId)) {
        btn = idx[hand.dealerId];
    } else if (n == 2 && !sbPid.empty() && idx.count(sbPid)) {
        btn = idx[sbPid];                                   // heads-up: the button posts the small blind
    } else if (!bbPid.empty() && idx.count(bbPid)) {
        btn = ((idx[bbPid] - 2) % n + n) % n;                // BB sits two seats after the button
    } else if (!sbPid.empty() && idx.count(sbPid)) {
        btn = ((idx[sbPid] - 1) % n + n) % n;
    }
    if (btn < 0) return out;                                 // unresolved: leave every seat Unknown

    for (int i = 0; i < n; ++i) {
        const int off = ((i - btn) % n + n) % n;
        Pos p;
        if (n == 2)            p = (off == 0) ? Pos::BTN : Pos::BB;
        else if (off == 0)     p = Pos::BTN;
        else if (off == 1)     p = Pos::SB;
        else if (off == 2)     p = Pos::BB;
        else if (off == n - 1) p = Pos::CO;                  // last seat before the button
        else if (off == 3)     p = Pos::UTG;
        else                   p = Pos::MP;
        out[srt[i]->playerId] = p;
    }
    return out;
}

std::string Profile::typicalBetSize() const {
    if (betSizeSamples == 0) return "-";
    static const char* kNames[kSizeBuckets] = {"<1/3 pot", "1/3-1/2", "1/2-3/4", "3/4-pot", "pot-1.5x", ">1.5x pot"};
    int best = 0;
    for (int i = 1; i < kSizeBuckets; ++i) if (betSize[i] > betSize[best]) best = i;
    std::ostringstream os;
    os << kNames[best] << " (" << static_cast<int>(betSizeShare(best) + 0.5) << "% of bets)";
    return os.str();
}

std::string Profile::archetype(double poolVpip, double poolPfr) const {
    if (handsVoluntary < 200) return "(too few hands)";
    // Cuts are relative to THIS pool, not to online full-ring norms. The pool here plays
    // about 79% of hands to a flop, so a "tight" player by internet standards does not exist.
    const double dv = vpip.pct() - poolVpip;
    std::string looseness = dv > 8 ? "Loose" : (dv < -8 ? "Tight" : "Average");

    const double raiseShare = vpip.pct() > 0 ? pfr.pct() / vpip.pct() : 0.0;
    std::string aggression;
    if (raiseShare >= 0.50)      aggression = "aggressive";
    else if (raiseShare >= 0.28) aggression = "balanced";
    else                         aggression = "passive";

    std::string label = looseness + "-" + aggression;
    // A calling station is defined by what they do facing aggression, not by VPIP.
    if (foldToCbet.reliable(kMinOpportunities) && foldToCbet.pct() < 35.0 && raiseShare < 0.35)
        label += " (station)";
    else if (pfr.pct() > poolPfr + 10 && foldToCbet.reliable(kMinOpportunities) && foldToCbet.pct() > 55.0)
        label += " (fires and folds)";
    return label;
}

// ======================================================================
// Analysis
// ======================================================================

namespace {

bool isLate(Pos p)  { return p == Pos::BTN || p == Pos::CO; }
bool isBlind(Pos p) { return p == Pos::SB || p == Pos::BB; }

std::string num(double v, int dp) {
    std::ostringstream os;
    os << std::fixed << std::setprecision(dp) << v;
    return os.str();
}

}  // namespace

std::vector<Profile> analyze(const std::vector<const HandLog*>& logs,
                             const players::MergeRules& rules,
                             const std::map<std::string, PlayerStats>& ledgerStats) {
    std::map<std::string, Profile> rows;
    std::map<std::string, std::set<std::string>> gamesOf;

    for (const HandLog* log : logs) {
        for (const Hand& hand : log->hands) {
            // Resolve accounts to people per hand: a shared account can change hands mid-night.
            std::map<std::string, std::string> keyOf;
            auto person = [&](const std::string& pid) -> const std::string& {
                auto c = keyOf.find(pid);
                if (c == keyOf.end()) {
                    std::string key = handlog::personAt(*log, pid, hand.start, rules);
                    Profile& p = rows[key];
                    if (p.normalizedName.empty()) {
                        p.normalizedName = key;
                        p.displayName = handlog::displayNameAt(*log, pid, hand.start, rules, ledgerStats);
                    }
                    c = keyOf.emplace(pid, key).first;
                }
                return c->second;
            };

            const std::map<std::string, Pos> pos = positionsFor(hand);
            const double bb = bigBlindOf(hand);
            auto posOf = [&](const std::string& pid) {
                auto it = pos.find(pid);
                return it == pos.end() ? Pos::Unknown : it->second;
            };

            std::set<std::string> seated;
            for (const Seat& s : hand.seats) seated.insert(person(s.playerId));
            for (const std::string& k : seated) {
                ++rows[k].hands;
                if (!hand.bombPot) ++rows[k].handsVoluntary;
                gamesOf[k].insert(log->gameId);
            }

            // ---------- preflop ----------
            int raiseCount = 0;
            std::string lastRaiser, opener;
            bool potUnopened = true;                 // no raise and no limp yet
            bool stealAttempt = false;
            std::set<std::string> foldedPre;
            std::set<std::string> vpipSet, pfrSet;
            std::set<std::string> sawOpenDecision, sawVsOpen, sawVs3Bet, sawStealSpot, sawDefendSpot;

            for (const Action& a : hand.actions) {
                if (a.street != "preflop" || a.kind == "post") continue;
                const std::string& k = person(a.playerId);
                Profile& r = rows[k];
                const Pos p = posOf(a.playerId);

                if (a.kind == "fold") foldedPre.insert(a.playerId);

                if (!hand.bombPot && !a.bombPot) {
                    if (a.kind == "call" || a.kind == "bet" || a.kind == "raise") vpipSet.insert(k);
                    if (a.kind == "raise") pfrSet.insert(k);
                }

                if (raiseCount == 0 && !a.bombPot && !sawOpenDecision.count(k)) {
                    sawOpenDecision.insert(k);
                    ++r.openRaise.opportunities;
                    ++r.limp.opportunities;
                    if (a.kind == "raise") ++r.openRaise.made;
                    if (a.kind == "call" && potUnopened) ++r.limp.made;
                    // A steal is a first-in raise from the two seats before the blinds, or
                    // from the small blind itself. Only counted when nobody has entered.
                    if (potUnopened && (isLate(p) || p == Pos::SB) && !sawStealSpot.count(k)) {
                        sawStealSpot.insert(k);
                        ++r.steal.opportunities;
                        if (a.kind == "raise") ++r.steal.made;
                    }
                } else if (raiseCount == 1 && a.playerId != lastRaiser && !a.bombPot && !sawVsOpen.count(k)) {
                    sawVsOpen.insert(k);
                    ++r.threeBet.opportunities;
                    ++r.foldToOpen.opportunities;
                    if (a.kind == "raise") ++r.threeBet.made;
                    if (a.kind == "fold") ++r.foldToOpen.made;
                    if (stealAttempt && isBlind(p) && !sawDefendSpot.count(k)) {
                        sawDefendSpot.insert(k);
                        ++r.blindDefend.opportunities;
                        if (a.kind != "fold") ++r.blindDefend.made;
                    }
                } else if (raiseCount >= 2 && a.playerId == opener && !sawVs3Bet.count(k)) {
                    sawVs3Bet.insert(k);
                    ++r.foldToThreeBet.opportunities;
                    if (a.kind == "fold") ++r.foldToThreeBet.made;
                }

                if (a.kind == "raise") {
                    if (raiseCount == 0) {
                        opener = a.playerId;
                        stealAttempt = potUnopened && (isLate(p) || p == Pos::SB);
                    }
                    ++raiseCount;
                    lastRaiser = a.playerId;
                    potUnopened = false;
                } else if (a.kind == "call") {
                    potUnopened = false;
                }
            }
            const std::string aggressor = lastRaiser;

            if (!hand.bombPot) {
                for (const std::string& k : vpipSet) ++rows[k].vpip.made;
                for (const std::string& k : pfrSet)  ++rows[k].pfr.made;
                for (const std::string& k : seated) {
                    ++rows[k].vpip.opportunities;
                    ++rows[k].pfr.opportunities;
                }
                // Coarse positional split. Three buckets, not six: at roughly 175 hands
                // per player per seat, a per-seat rate in this corpus is noise.
                for (const Seat& s : hand.seats) {
                    const Pos p = posOf(s.playerId);
                    if (p == Pos::Unknown) continue;
                    const std::string& k = person(s.playerId);
                    Profile& r = rows[k];
                    Rate& bucket = isLate(p) ? r.vpipLate : (isBlind(p) ? r.vpipBlinds : r.vpipEarly);
                    ++bucket.opportunities;
                    if (vpipSet.count(k)) ++bucket.made;
                }
            }

            // ---------- postflop ----------
            const bool sawFlop = hand.board.size() >= 3;
            std::set<std::string> flopPlayers;
            if (sawFlop)
                for (const Seat& s : hand.seats)
                    if (!foldedPre.count(s.playerId)) flopPlayers.insert(s.playerId);

            if (sawFlop && !hand.bombPot)
                for (const std::string& pid : flopPlayers) ++rows[person(pid)].wtsd.opportunities;

            double potBefore = 0.0;                  // running pot, for bet sizing
            std::map<std::string, double> streetIn;  // "to" amount committed this street
            std::string street = "preflop";
            std::string firstAggressorThisStreet;
            std::set<std::string> checkedThisStreet;
            bool cbetChanceCounted = false;
            std::set<std::string> sawCbetDecision;

            for (const Action& a : hand.actions) {
                if (a.street != street) {
                    street = a.street;
                    streetIn.clear();
                    checkedThisStreet.clear();
                    firstAggressorThisStreet.clear();
                }
                const std::string& k = person(a.playerId);
                Profile& r = rows[k];
                if (a.allIn) ++r.allIns;

                const bool isFlop  = a.street == "flop";
                const bool isTurn  = a.street == "turn";
                const bool isRiver = a.street == "river";

                if (isFlop || isTurn || isRiver) {
                    if (a.kind == "bet")        { if (isFlop) ++r.betsFlop;   else if (isTurn) ++r.betsTurn;   else ++r.betsRiver; }
                    else if (a.kind == "raise") { if (isFlop) ++r.raisesFlop; else if (isTurn) ++r.raisesTurn; else ++r.raisesRiver; }
                    else if (a.kind == "call")  { if (isFlop) ++r.callsFlop;  else if (isTurn) ++r.callsTurn;  else ++r.callsRiver; }
                    else if (a.kind == "fold")  { if (isFlop) ++r.foldsFlop;  else if (isTurn) ++r.foldsTurn;  else ++r.foldsRiver; }

                    // Check-raise: checked earlier on this street, now raising it.
                    if (a.kind == "raise" && checkedThisStreet.count(a.playerId)) ++r.checkRaise.made;
                    if (a.kind == "check") { checkedThisStreet.insert(a.playerId); ++r.checkRaise.opportunities; }
                }

                // Flop continuation betting, measured only on the flop, where the preflop
                // story is still intact and the sample is largest.
                if (isFlop && !aggressor.empty() && flopPlayers.count(aggressor)) {
                    if (a.playerId == aggressor && !cbetChanceCounted &&
                        (a.kind == "bet" || a.kind == "check" || a.kind == "fold" || a.kind == "call")) {
                        cbetChanceCounted = true;
                        ++r.cbet.opportunities;
                        if (a.kind == "bet" && firstAggressorThisStreet.empty()) ++r.cbet.made;
                    }
                    // Donk bet: someone other than the preflop raiser leads out first.
                    if (a.kind == "bet" && firstAggressorThisStreet.empty() && a.playerId != aggressor)
                        ++r.donkBet.made;
                    if (a.kind == "check" && a.playerId != aggressor && firstAggressorThisStreet.empty())
                        ++r.donkBet.opportunities;
                    if (a.playerId != aggressor && !sawCbetDecision.count(k) &&
                        firstAggressorThisStreet == aggressor &&
                        (a.kind == "fold" || a.kind == "call" || a.kind == "raise")) {
                        sawCbetDecision.insert(k);
                        ++r.foldToCbet.opportunities;
                        if (a.kind == "fold") ++r.foldToCbet.made;
                    }
                }

                // Bet sizing as a share of the pot. Clean bets only: a raise amount is a
                // "to" figure and mixes the call with the increment.
                if (a.kind == "bet" && potBefore > EPSILON) {
                    const double pct = 100.0 * a.amount / potBefore;
                    int b;
                    if (pct < 33)       b = Profile::kUnder33;
                    else if (pct < 50)  b = Profile::k33to50;
                    else if (pct < 75)  b = Profile::k50to75;
                    else if (pct < 100) b = Profile::k75to100;
                    else if (pct < 150) b = Profile::k100to150;
                    else                b = Profile::kOver150;
                    ++r.betSize[b];
                    ++r.betSizeSamples;
                }

                double delta = 0.0;
                if (a.kind == "post") {
                    delta = a.amount;
                    streetIn[a.playerId] += a.amount;
                } else if (a.kind == "call" || a.kind == "bet" || a.kind == "raise") {
                    delta = a.amount - streetIn[a.playerId];
                    if (delta < 0) delta = 0;
                    streetIn[a.playerId] = a.amount;
                }
                potBefore += delta;

                if ((a.kind == "bet" || a.kind == "raise") && firstAggressorThisStreet.empty())
                    firstAggressorThisStreet = a.playerId;
            }

            // ---------- showdown and money ----------
            std::set<std::string> tabled, winners;
            for (const auto& s : hand.shown) {
                if (Hand::shownCardCount(s.second) >= 2) {
                    if (hand.showdown) tabled.insert(person(s.first));
                } else {
                    ++rows[person(s.first)].courtesyReveals;
                }
            }
            for (const auto& rk : hand.rank) {
                const std::string& k = person(rk.first);
                tabled.insert(k);
                winners.insert(k);
                rows[k].showdownHandClass[rk.second]++;
            }
            for (const std::string& k : tabled) {
                ++rows[k].showdownsTabled;
                ++rows[k].wtsd.made;
                ++rows[k].wsd.opportunities;
                if (winners.count(k)) ++rows[k].wsd.made;
            }
            for (const auto& c : hand.collected) {
                Profile& r = rows[person(c.first)];
                r.biggestPot = std::max(r.biggestPot, c.second);
            }
            for (const auto& nt : hand.net) {
                Profile& r = rows[person(nt.first)];
                r.net += nt.second;
                if (bb > EPSILON) r.netBigBlinds += nt.second / bb;
            }
        }
    }

    std::vector<Profile> out;
    out.reserve(rows.size());
    for (auto& pair : rows) {
        pair.second.games = static_cast<int>(gamesOf[pair.first].size());
        out.push_back(pair.second);
    }
    std::sort(out.begin(), out.end(), [](const Profile& a, const Profile& b) {
        if (a.hands != b.hands) return a.hands > b.hands;
        return a.displayName < b.displayName;
    });
    return out;
}

// ======================================================================
// Output
// ======================================================================

namespace {

std::string rateCell(const Rate& r) {
    if (r.opportunities == 0) return "-";
    std::ostringstream os;
    if (r.opportunities < kMinOpportunities) os << "(" << num(r.pct(), 0) << ")";
    else                                     os << num(r.pct(), 0) << "%";
    return os.str();
}

// Hit & run factor: "-" with no nights to judge, "(42)" on too few winning nights to trust.
std::string hitRunCell(const Profile& p) {
    if (p.hitRun < 0) return "-";
    return p.hitRunReliable ? num(p.hitRun, 0) : "(" + num(p.hitRun, 0) + ")";
}

void poolAverages(const std::vector<Profile>& all, double& poolV, double& poolP, int& counted) {
    poolV = poolP = 0.0;
    counted = 0;
    for (const Profile& q : all)
        if (q.handsVoluntary >= 200) { poolV += q.vpip.pct(); poolP += q.pfr.pct(); ++counted; }
    if (counted) { poolV /= counted; poolP /= counted; }
}

}  // namespace

void printProfiles(const std::vector<Profile>& rows) {
    double poolV, poolP;
    int counted;
    poolAverages(rows, poolV, poolP, counted);

    // Two tables (before and after the flop) so each fits a normal terminal.
    const int W = 100;
    using util::padLeft;
    using util::padRight;
    std::cout << '\n' << ui::dim("Pool average over " + std::to_string(counted) + " players with 200+ hands: VPIP " +
                                 num(poolV, 0) + "%, PFR " + num(poolP, 0) + "%")
              << "\n\n" << ui::heading("Before the flop", W) << '\n'
              << ui::bold(padRight("Player", 16) + padLeft("Hands", 7) + padLeft("VPIP", 7) + padLeft("PFR", 7) +
                          padLeft("Limp", 7) + padLeft("3Bet", 7) + padLeft("Steal", 7) + padLeft("Def", 7) + "   Archetype")
              << '\n' << ui::rule(W) << '\n';
    for (const Profile& p : rows) {
        if (p.hands < 50) continue;
        std::cout << padRight(p.displayName, 16) << padLeft(std::to_string(p.hands), 7) << padLeft(rateCell(p.vpip), 7)
                  << padLeft(rateCell(p.pfr), 7) << padLeft(rateCell(p.limp), 7) << padLeft(rateCell(p.threeBet), 7)
                  << padLeft(rateCell(p.steal), 7) << padLeft(rateCell(p.blindDefend), 7) << "   "
                  << ui::cyan(padRight(p.archetype(poolV, poolP), W - 68)) << '\n';
    }
    std::cout << ui::rule(W) << "\n\n" << ui::heading("After the flop, and leaving the table", W) << '\n'
              << ui::bold(padRight("Player", 16) + padLeft("CBet", 7) + padLeft("F>CB", 7) + padLeft("ChkR", 7) +
                          padLeft("AF flop", 9) + padLeft("AF turn", 9) + padLeft("AF river", 10) + padLeft("WTSD", 7) +
                          padLeft("W$SD", 7) + padLeft("H&R", 6) + "  Leaving")
              << '\n' << ui::rule(W) << '\n';
    for (const Profile& p : rows) {
        if (p.hands < 50) continue;
        std::cout << padRight(p.displayName, 16) << padLeft(rateCell(p.cbet), 7) << padLeft(rateCell(p.foldToCbet), 7)
                  << padLeft(rateCell(p.checkRaise), 7) << padLeft(num(p.afFlop(), 1), 9) << padLeft(num(p.afTurn(), 1), 9)
                  << padLeft(num(p.afRiver(), 1), 10) << padLeft(rateCell(p.wtsd), 7) << padLeft(rateCell(p.wsd), 7)
                  << padLeft(hitRunCell(p), 6) << "  " << ui::cyan(padRight(p.hitRunTag, W - 87)) << '\n';
    }
    std::cout << ui::rule(W) << '\n'
              << ui::dim("A rate in (brackets) has fewer than " + std::to_string(kMinOpportunities) +
                         " opportunities behind it and is not a tendency.\n"
                         "Limp = called the big blind with the pot unopened.   3Bet = re-raised a single raise.\n"
                         "Steal = first-in raise from CO/BTN/SB.   Def = did not fold a blind to a steal.\n"
                         "CBet = bet the flop having raised preflop.   F>CB = folded facing a flop c-bet.\n"
                         "ChkR = check-raised.   AF = (bets + raises) / calls.   WTSD = flops that reached showdown.\n"
                         "H&R = hit & run factor, 0-100, from every night in scope (menu 22 has the night-by-night exits).\n"
                         "An H&R in (brackets) has fewer than 3 winning nights behind it; its only possible tag is Busts out.\n")
              << '\n';
}

void printOnePlayer(const Profile& p, const std::vector<Profile>& all) {
    double poolV, poolP;
    int counted;
    poolAverages(all, poolV, poolP, counted);

    std::cout << "\n" << p.displayName << " - " << p.hands << " hands over " << p.games << " games\n";
    std::cout << std::string(74, '-') << "\n";
    std::cout << "  Archetype        " << p.archetype(poolV, poolP)
              << (p.hitRunTag.empty() ? "" : ui::sym(" · ", " | ") + p.hitRunTag) << "\n";
    std::cout << "  VPIP / PFR       " << num(p.vpip.pct(), 1) << "% / " << num(p.pfr.pct(), 1)
              << "%   (pool " << num(poolV, 0) << "% / " << num(poolP, 0) << "%)\n";
    std::cout << "  Passivity gap    " << num(p.passivityGap(), 1)
              << " points between entering a pot and raising it\n";
    std::cout << "  Position (VPIP)  late " << rateCell(p.vpipLate) << " n=" << p.vpipLate.opportunities
              << ", blinds " << rateCell(p.vpipBlinds) << " n=" << p.vpipBlinds.opportunities
              << ", early " << rateCell(p.vpipEarly) << " n=" << p.vpipEarly.opportunities << "\n";
    std::cout << "  Preflop          limp " << rateCell(p.limp) << " n=" << p.limp.opportunities
              << ", 3bet " << rateCell(p.threeBet) << " n=" << p.threeBet.opportunities
              << ", fold-to-open " << rateCell(p.foldToOpen) << " n=" << p.foldToOpen.opportunities << "\n";
    std::cout << "  Blind war        steal " << rateCell(p.steal) << " n=" << p.steal.opportunities
              << ", defend " << rateCell(p.blindDefend) << " n=" << p.blindDefend.opportunities << "\n";
    std::cout << "  Flop             cbet " << rateCell(p.cbet) << " n=" << p.cbet.opportunities
              << ", fold-to-cbet " << rateCell(p.foldToCbet) << " n=" << p.foldToCbet.opportunities
              << ", check-raise " << rateCell(p.checkRaise) << " n=" << p.checkRaise.opportunities << "\n";
    std::cout << "  Aggression       flop " << num(p.afFlop(), 2) << ", turn " << num(p.afTurn(), 2)
              << ", river " << num(p.afRiver(), 2) << "\n";
    std::cout << "  Bet sizing       mostly " << p.typicalBetSize() << "; "
              << num(p.overbetShare(), 0) << "% of bets are pot-sized or bigger ("
              << p.betSizeSamples << " bets)\n";
    std::cout << "  Showdown         reached " << rateCell(p.wtsd) << " of flops seen, won "
              << rateCell(p.wsd) << " of " << p.wsd.opportunities << "\n";
    if (!p.showdownHandClass.empty()) {
        std::vector<std::pair<std::string, int>> v(p.showdownHandClass.begin(), p.showdownHandClass.end());
        std::sort(v.begin(), v.end(), [](const std::pair<std::string, int>& a,
                                         const std::pair<std::string, int>& b) { return a.second > b.second; });
        std::cout << "  Winning hands    ";
        for (size_t i = 0; i < v.size() && i < 5; ++i) std::cout << v[i].first << " x" << v[i].second << "   ";
        std::cout << "\n";
    }
    std::cout << "  Result           " << util::money(p.net) << " over " << p.hands
              << " hands (" << num(p.bbPer100(), 1) << " bb/100)\n";
    if (p.hitRun >= 0) {
        std::cout << "  Hit & run        " << hitRunCell(p) << (p.hitRunTag.empty() ? "" : " - " + p.hitRunTag)
                  << (p.hitRunReliable ? "" : " (fewer than 3 winning nights: not a tendency yet)") << "\n";
        std::istringstream lines(p.hitRunLine);
        for (std::string line; std::getline(lines, line);) std::cout << "                   " << line << "\n";
    }
    std::cout << "  NOTE  bb/100 over " << p.hands << " hands carries a confidence interval far wider\n"
              << "        than any plausible edge. Read it as description, never as proof of skill.\n";
}

bool exportCSV(const std::string& filename, const std::vector<Profile>& rows) {
    std::ofstream f(filename);
    if (!f) return false;
    f << "player,games,hands,hands_voluntary,vpip_pct,vpip_n,pfr_pct,pfr_n,limp_pct,limp_n,"
         "open_pct,open_n,threebet_pct,threebet_n,fold_to_open_pct,fold_to_open_n,"
         "fold_to_3bet_pct,fold_to_3bet_n,steal_pct,steal_n,blind_defend_pct,blind_defend_n,"
         "cbet_pct,cbet_n,fold_to_cbet_pct,fold_to_cbet_n,checkraise_pct,checkraise_n,"
         "donk_pct,donk_n,af_flop,af_turn,af_river,wtsd_pct,wtsd_n,wsd_pct,wsd_n,"
         "showdowns_tabled,courtesy_reveals,bet_lt33_pct,bet_33_50_pct,bet_50_75_pct,"
         "bet_75_100_pct,bet_100_150_pct,bet_over150_pct,overbet_pct,bet_samples,all_ins,net,bb_per_100,"
         "biggest_pot,vpip_late_pct,vpip_late_n,vpip_blinds_pct,vpip_blinds_n,vpip_early_pct,vpip_early_n,"
         "hit_run,hit_run_reliable,hit_run_tag\n";
    for (const Profile& p : rows) {
        auto rc = [&f](const Rate& r) { f << num(r.pct(), 2) << "," << r.opportunities << ","; };
        f << util::escapeCSV(p.displayName) << "," << p.games << "," << p.hands << "," << p.handsVoluntary << ",";
        rc(p.vpip); rc(p.pfr); rc(p.limp); rc(p.openRaise); rc(p.threeBet); rc(p.foldToOpen);
        rc(p.foldToThreeBet); rc(p.steal); rc(p.blindDefend); rc(p.cbet); rc(p.foldToCbet);
        rc(p.checkRaise); rc(p.donkBet);
        f << num(p.afFlop(), 3) << "," << num(p.afTurn(), 3) << "," << num(p.afRiver(), 3) << ",";
        rc(p.wtsd); rc(p.wsd);
        f << p.showdownsTabled << "," << p.courtesyReveals << ",";
        for (int b = 0; b < Profile::kSizeBuckets; ++b) f << num(p.betSizeShare(b), 2) << ",";
        f << num(p.overbetShare(), 2) << ","
          << p.betSizeSamples << "," << p.allIns << "," << num(p.net, 2) << "," << num(p.bbPer100(), 3) << ","
          << num(p.biggestPot, 2) << ",";
        rc(p.vpipLate); rc(p.vpipBlinds);
        f << num(p.vpipEarly.pct(), 2) << "," << p.vpipEarly.opportunities << ","
          << (p.hitRun < 0 ? "" : num(p.hitRun, 2)) << "," << (p.hitRunReliable ? "yes" : "no") << ","
          << util::escapeCSV(p.hitRunTag) << "\n";
    }
    return true;
}

}  // namespace playstyle
