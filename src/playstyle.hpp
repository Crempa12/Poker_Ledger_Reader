#pragma once
// Deep playing-style analysis from PokerNow hand logs.
//
// handlog::StyleStats answers "how often does this player put money in". This module
// answers "how do they actually play": what they do from each seat, how they react to
// aggression, whether their bets are bluffs or value, and where their money comes from.
//
// Everything here is derived from data already in handlog::Hand. Nothing needs a new
// download. The two facts that make it possible are that PokerNow names the dealer on
// every hand-start line and labels each blind post, which together fix every player's
// position, and that it logs every action in order with its amount.
//
// Sample-size discipline (this corpus: ~10,500 hands, ~14 people with real volume):
//   - Frequencies over 1,000+ hands (VPIP, PFR, aggression) are stable to a few points.
//   - Situational frequencies (3-bet, c-bet, steal) have far smaller denominators than
//     the hand count, so every one of them is reported WITH its denominator. A number
//     whose denominator is under kMinOpportunities is suppressed, not shown small.
//   - Per-player-per-position rates are NOT exposed: ~175 hands per cell in this corpus.
//     Position is used per player only as a coarse early/middle/late split.
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "handlog.hpp"
#include "models.hpp"
#include "players.hpp"

namespace playstyle {

// Seat relative to the button, computed for the number of players actually dealt in.
// Most hands in this corpus are short-handed (2-4 players), where UTG/MP/CO do not
// exist as distinct seats, so the label set shrinks with the table.
enum class Pos { Unknown, BTN, SB, BB, UTG, MP, CO };
const char* posName(Pos p);

// A counter plus its denominator. Rates are only meaningful alongside the opportunity
// count, so the two always travel together and are always printed together.
struct Rate {
    int made = 0;
    int opportunities = 0;
    bool reliable(int minOpp) const { return opportunities >= minOpp; }
    double pct() const { return opportunities == 0 ? 0.0 : 100.0 * made / opportunities; }
};

struct Profile {
    std::string displayName;
    std::string normalizedName;
    int games = 0;
    int hands = 0;             // dealt in
    int handsVoluntary = 0;    // excluding bomb pots, where entry is forced

    // --- Preflop shape -------------------------------------------------------
    Rate vpip;                 // voluntarily put money in
    Rate pfr;                  // raised
    Rate limp;                 // called the big blind when the pot was unopened
    Rate openRaise;            // raised first in
    Rate threeBet;             // re-raised a single raise
    Rate foldToThreeBet;       // opened, then folded to a re-raise
    Rate foldToOpen;           // folded facing a single raise
    Rate steal;                // first-in raise from CO/BTN/SB
    Rate blindDefend;          // in a blind, did not fold to a steal attempt

    // --- Postflop shape ------------------------------------------------------
    Rate cbet;                 // was the preflop raiser and bet the flop
    Rate foldToCbet;           // folded facing a flop continuation bet
    Rate checkRaise;           // checked then raised on the same street
    Rate donkBet;              // bet into the preflop raiser before they acted

    // Per-street aggression: (bets + raises) / calls, the standard AF, split by street
    // so a player who fires the flop and gives up on the turn is visible as such.
    int betsFlop = 0, raisesFlop = 0, callsFlop = 0, foldsFlop = 0;
    int betsTurn = 0, raisesTurn = 0, callsTurn = 0, foldsTurn = 0;
    int betsRiver = 0, raisesRiver = 0, callsRiver = 0, foldsRiver = 0;

    // --- Showdown ------------------------------------------------------------
    Rate wtsd;                 // of flops seen, how many reached showdown
    Rate wsd;                  // of showdowns, how many were won
    int showdownsTabled = 0;   // hands where they turned over both cards
    int courtesyReveals = 0;   // flashed a single card (not a showdown)
    std::map<std::string, int> showdownHandClass;   // "Two Pair" -> count, at showdown

    // --- Sizing and commitment ----------------------------------------------
    // Bet size as a share of the pot, bucketed rather than averaged. A mean is useless
    // here: a single all-in into a small pot scores thousands of percent and drags the
    // average past 300% for the shove-happy players. Buckets are outlier-proof and say
    // more anyway - "two thirds of their bets are half-pot" beats "their average is 84%".
    enum SizeBucket { kUnder33, k33to50, k50to75, k75to100, k100to150, kOver150, kSizeBuckets };
    int betSize[kSizeBuckets] = {0, 0, 0, 0, 0, 0};
    int betSizeSamples = 0;
    int allIns = 0;

    // --- Money ---------------------------------------------------------------
    double net = 0.0;          // dollars, from the log
    double netBigBlinds = 0.0; // normalized per hand by the blind actually in force
    double biggestPot = 0.0;

    // --- Coarse positional split (NOT per-seat: too few hands per cell) -------
    Rate vpipLate;             // BTN / CO
    Rate vpipBlinds;           // SB / BB
    Rate vpipEarly;            // everything else

    // The modal sizing band, as a readable label, plus the share of bets in it.
    std::string typicalBetSize() const;
    double betSizeShare(int bucket) const {
        return betSizeSamples == 0 ? 0.0 : 100.0 * betSize[bucket] / betSizeSamples;
    }
    // Share of bets that are pot-sized or bigger: the overbet tendency.
    double overbetShare() const {
        return betSizeSamples == 0 ? 0.0
                                   : 100.0 * (betSize[k100to150] + betSize[kOver150]) / betSizeSamples;
    }
    static double af(int b, int r, int c) { return c == 0 ? (b + r > 0 ? 99.0 : 0.0) : double(b + r) / c; }
    double afFlop() const { return af(betsFlop, raisesFlop, callsFlop); }
    double afTurn() const { return af(betsTurn, raisesTurn, callsTurn); }
    double afRiver() const { return af(betsRiver, raisesRiver, callsRiver); }
    double bbPer100() const { return hands == 0 ? 0.0 : 100.0 * netBigBlinds / hands; }
    // Passive players call far more than they raise; the gap between how often they
    // enter and how often they enter with a raise is the single clearest signal.
    double passivityGap() const { return vpip.pct() - pfr.pct(); }

    // A label that actually discriminates in this player pool, unlike a fixed
    // tight/loose cut borrowed from full-ring online play.
    std::string archetype(double poolVpip, double poolPfr) const;
};

// Minimum opportunities before a situational rate is considered readable at all.
extern int kMinOpportunities;

// Per-hand position for every seated account. Unresolvable hands map to Pos::Unknown
// rather than being guessed.
std::map<std::string, Pos> positionsFor(const handlog::Hand& hand);

// The big blind actually in force for a hand, taken from the live BB post. Returns 0
// when the hand has no readable big blind, in which case bb-normalization skips it.
double bigBlindOf(const handlog::Hand& hand);

std::vector<Profile> analyze(const std::vector<const handlog::HandLog*>& logs,
                             const players::MergeRules& rules,
                             const std::map<std::string, PlayerStats>& ledgerStats);

void printProfiles(const std::vector<Profile>& rows);
void printOnePlayer(const Profile& p, const std::vector<Profile>& all);
bool exportCSV(const std::string& filename, const std::vector<Profile>& rows);

}  // namespace playstyle
