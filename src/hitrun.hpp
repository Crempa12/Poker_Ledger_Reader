#pragma once
// Hit & run: does a player take their winnings off the table while the game is still going,
// right after hitting them?
//
// Every night a person played ends in exactly one exit: they stayed to the end, left up,
// left down, left about even, busted out without rebuying, or were taken out by the admin.
// Three habits come out of those exits, each a share from 0 to 1:
//
//   when up    how much of the night (from their sit-down on) went on without them, on the
//              nights they finished ahead - weighted by the size of the win
//   when down  the same on the nights they finished behind but still had chips
//   the hit    the part of "when up" that came right after their best point of the night,
//              with most of it still in hand: walking away within a few hands of the peak
//              counts fully, and the credit halves every kPeakHalfLifeHands hands they
//              played on after it
//
//   H&R = 100 x ( whenUp + max(0, whenUp - whenDown) + hit ) / 3
//
// The first part is what the table feels. The other two are why they left: earlier when
// winning than when losing, and straight after the peak. Leaving early is normal in this
// game (164 of 228 nights in the September logs, 72%, end before the night's last 10
// hands), so the first part alone would flag nearly everyone who ever wins; a player who
// goes home at the same time whatever happened scores on it but not on the other two.
//
// Only nights with a hand log count. A ledger cannot say when someone stopped playing: a
// seat stays open when a player stands up and walks away without quitting, and the game's
// end is not recorded. Checked against the 223 nights the 21 logs deal, the ledger's times
// called 49 of their 69 "left up" exits "stayed" and put every factor near zero.
//
// PokerNow cuts the oldest hands off a long night's log (7 of the 21 logs start between
// hand #31 and #397). Hands keep their numbers, so the night's length and each exit's
// position stay exact. Where the ledger says someone sat down before the log begins, their
// sit-down hand is estimated from its time; someone who left before the log begins is
// placed the same way (an "estimated" night, whose peak cannot be known).
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "handlog.hpp"
#include "models.hpp"
#include "players.hpp"
#include "playstyle.hpp"

namespace hitrun {

// --- Tunables (see hitrun.cpp for why each value) ----------------------------
extern const int kGraceHands;          // leaving within this many hands of the end = stayed
extern const int kBreakHands;          // a gap this long, then dealt in again = came back
extern const double kEvenBB;           // a result inside +/- this is "about even"
extern const double kFullWinBB;        // a win this big counts fully toward "when up"
extern const double kBustBB;           // under this many big blinds left = busted
extern const double kPeakHalfLifeHands;// the hit's credit halves every this many hands after the peak
extern const double kShrinkUpNights;   // phantom pool-average nights added to "when up" and the hit
extern const double kShrinkDownNights; // phantom pool-average nights added to "when down"
extern const int kMinUpNights;         // winning nights needed before the factor is a tendency

enum class Exit { Stayed, LeftUp, LeftDown, LeftEven, Busted, Removed };
const char* exitName(Exit e);

// One person's one night. Hand numbers are PokerNow's (#1 is the night's first hand).
struct Night {
    std::string gameId;
    std::int64_t date = util::NO_TIME;
    std::string person;          // canonical name (the same key the leaderboard uses)
    std::string displayName;

    int handsInNight = 0;        // the last hand's number: every hand dealt that night
    int handsMissing = 0;        // hands at the start of the night that the log does not have
    int satDownHand = 0;         // hand number they sat down at (from the ledger's time when before the log)
    int lastHand = 0;            // hand number of the last hand they were dealt
    int handsPlayed = 0;         // hands dealt in (hands before the log: every one since they sat down)
    int handsLeft = 0;           // hands dealt after their last one
    bool estimated = false;      // they left before the log begins: placed from the ledger's times

    double played = 0.0;         // handsPlayed / handsInNight
    double away = 0.0;           // handsLeft / hands dealt since they sat down (0 when they stayed)
    double net = 0.0;            // dollars: the night's result from the ledger (from the log without one)
    double bigBlind = 0.0;       // dollars, the blind in force when they left

    // Their best point of the night, on the same scale as `net`, and what came after it.
    bool peakKnown = false;      // false on estimated nights
    bool peakAtLogStart = false; // the best point seen was where the log begins: it may have been earlier
    double peak = 0.0;           // 0 = never ahead
    double finalRunning = 0.0;   // their result when they left, on the same scale as `peak`
    int handsAfterPeak = 0;      // hands they were dealt after the one that took them to the peak
    double minutesAfterPeak = 0.0;

    Exit exit = Exit::Stayed;
    int rebuys = 0;              // busted (under kBustBB) and put chips back in
    int cameBack = 0;            // left for kBreakHands+ (not busted) and was dealt in again
    int cameBackUp = 0;          // ... of which they were ahead when they left

    double netBB() const { return bigBlind > 0 ? net / bigBlind : 0.0; }
    bool finishedUp() const { return netBB() >= kEvenBB; }
    bool finishedDown() const { return netBB() <= -kEvenBB; }
    // Counts toward "when up" (and the hit): finished ahead and either stayed or left with chips.
    bool upSample() const { return finishedUp() && (exit == Exit::Stayed || exit == Exit::LeftUp); }
    // Counts toward "when down": finished behind and either stayed or left with chips.
    bool downSample() const { return finishedDown() && (exit == Exit::Stayed || exit == Exit::LeftDown); }
    // A win's weight: 1 for kFullWinBB or more, proportionally less below it.
    double winWeight() const;
    // Share of the peak still in hand when they left, 0..1.
    double kept() const;
    // How much this exit was a run from the peak: the share kept, halved for every
    // kPeakHalfLifeHands hands played after the peak. 0 when never ahead or not known.
    double fresh() const;
};

struct Summary {
    std::string person;
    std::string displayName;
    int nights = 0;
    int estimatedNights = 0;      // left before their night's log begins
    int stayed = 0, stayedUp = 0, stayedDown = 0;
    int leftUp = 0, leftDown = 0, leftEven = 0, busted = 0, removed = 0;
    int rebuys = 0, cameBack = 0, cameBackUp = 0;
    double played = 0.0;          // mean share of each night's hands they were dealt
    double handsLeftWhenUp = 0.0; // mean hands still to come when they left up
    int peakNightsLeftUp = 0;     // nights they left up with a known peak, behind the two medians below
    double handsAfterPeakWhenUp = 0.0;    // median hands played after the peak, on nights they left up
    double minutesAfterPeakWhenUp = 0.0;  // the same in minutes
    double keptWhenUp = 0.0;      // median share of the peak kept, on nights they left up

    int upNights = 0;             // the "when up" sample
    double whenUpRaw = 0.0;       // win-weighted mean of Night::away over it
    double whenUp = 0.0;          // ... leaning toward the pool (kShrinkUpNights)
    int downNights = 0;           // the "when down" sample
    double whenDownRaw = 0.0;     // plain mean of Night::away over it
    double whenDown = 0.0;        // ... leaning toward the pool (kShrinkDownNights)
    double hitRaw = 0.0;          // win-weighted mean of away x fresh over up nights with a known peak
    double hit = 0.0;             // ... leaning toward the pool (kShrinkUpNights)
    double factor = 0.0;          // 0..100, from the leaning values
    std::string tag;

    bool reliable() const { return upNights >= kMinUpNights; }
    // The three habits in one or two lines ("\n" between them), for the deep profile.
    std::string habitsLine() const;
};

// Every person's night in one hand log. `game` is the paired ledger (may be null): its nets
// are the results, and its times place anything before a cut-off log. `defaultBigBlind`
// is used when the night has no readable big blind.
std::vector<Night> nightsFromLog(const handlog::HandLog& log, const Game* game,
                                 const players::MergeRules& rules,
                                 const std::map<std::string, PlayerStats>& ledgerStats,
                                 double defaultBigBlind);

// Every person's night in the games given that have a hand log. Games without one are
// counted in `unmeasured` (may be null) and otherwise skipped.
std::vector<Night> collect(const std::vector<const Game*>& games,
                           const std::map<std::string, handlog::HandLog>& logs,
                           const players::MergeRules& rules,
                           const std::map<std::string, PlayerStats>& ledgerStats,
                           int* unmeasured = nullptr);

// One row per person, most hit-and-run first (trusted rows before thin ones).
std::vector<Summary> summarize(const std::vector<Night>& nights);

// The factor and tag on the playing-style rows (menus 18 and 21, the HTML report).
void annotate(std::vector<handlog::StyleStats>& rows, const std::vector<Summary>& summaries);
void annotate(std::vector<playstyle::Profile>& rows, const std::vector<Summary>& summaries);

// `unmeasured` = games in scope with no hand log, which the table says it left out.
void printTable(const std::vector<Summary>& rows, const std::vector<Night>& nights, int unmeasured);
void printPlayer(const Summary& s, const std::vector<Night>& nights);
bool exportCSV(const std::string& filename, const std::vector<Summary>& rows);
bool exportNightsCSV(const std::string& filename, const std::vector<Night>& nights);

}  // namespace hitrun
