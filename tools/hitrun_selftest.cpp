// Self-test for the hit & run factor: one made-up night per way a night can end, a night whose
// log starts late, the peak ("the hit"), the factor arithmetic and the admin-line parsing, each
// checked against numbers worked out by hand.
//
//   clang++ -std=c++20 -Isrc tools/hitrun_selftest.cpp src/*.cpp -o hitrun_selftest && ./hitrun_selftest
//
// Prints one line per check and exits non-zero if any fails.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <map>
#include <string>
#include <vector>

#include "handlog.hpp"
#include "hitrun.hpp"
#include "players.hpp"

namespace fs = std::filesystem;
using hitrun::Exit;
using hitrun::Night;

namespace {

int failures = 0;

void check(bool ok, const std::string& what) {
    std::printf("%s  %s\n", ok ? "ok  " : "FAIL", what.c_str());
    if (!ok) ++failures;
}

bool near(double a, double b, double tol = 1e-6) { return std::fabs(a - b) <= tol; }

const double BB = 0.50;
const std::int64_t T0 = 1790000000;   // any fixed moment; hands are 45 seconds apart

std::int64_t at(int hand) { return T0 + 45 * static_cast<std::int64_t>(hand); }

// One account's night: the hands it is dealt (indexes into the log), its starting stack, what
// it wins or loses on given hands, and chips added before given hands (a rebuy).
struct Script {
    std::string pid, nick;
    std::vector<std::pair<int, int>> spans;   // inclusive ranges of hand indexes dealt in
    double stack = 50.0;
    std::map<int, double> net;
    std::map<int, double> add;
    bool dealt(int h) const {
        for (const auto& s : spans) if (h >= s.first && h <= s.second) return true;
        return false;
    }
};

// A log of `hands` hands numbered from `firstNumber`. A filler account sits through all of it
// so every hand has a big blind to read; it takes the other side of every result.
handlog::HandLog buildNight(const std::vector<Script>& scripts, int hands, int firstNumber = 1) {
    handlog::HandLog log;
    log.gameId = "pgltest";
    Script filler{"fill", "Filler", {{0, hands - 1}}, 10000.0, {}, {}};
    std::map<std::string, double> stack;
    for (const Script& s : scripts) stack[s.pid] = s.stack;
    stack[filler.pid] = filler.stack;
    for (int h = 0; h < hands; ++h) {
        handlog::Hand hand;
        hand.number = firstNumber + h;
        hand.start = at(h);
        int seat = 1;
        double others = 0.0;
        for (const Script& s : scripts) {
            auto add = s.add.find(h);
            if (add != s.add.end()) stack[s.pid] += add->second;
            if (!s.dealt(h)) continue;
            auto n = s.net.find(h);
            const double net = n == s.net.end() ? 0.0 : n->second;
            hand.seats.push_back({seat++, s.pid, s.nick, stack[s.pid]});
            hand.net[s.pid] = net;
            stack[s.pid] += net;
            others += net;
            log.names[s.pid] = s.nick;
        }
        hand.seats.push_back({seat++, filler.pid, filler.nick, stack[filler.pid]});
        hand.net[filler.pid] = -others;
        stack[filler.pid] -= others;
        log.names[filler.pid] = filler.nick;
        handlog::Action post;
        post.playerId = filler.pid;
        post.street = "preflop";
        post.kind = "post";
        post.amount = BB;
        post.post = handlog::Action::Post::BigBlind;
        hand.actions.push_back(post);
        log.hands.push_back(hand);
    }
    log.start = log.hands.front().start;
    log.end = log.hands.back().start;
    return log;
}

LedgerRow seat(const std::string& nick, const std::string& pid, std::int64_t start, std::int64_t end, double net,
               double buyOut = 0.0) {
    LedgerRow r;
    r.nickname = nick;
    r.playerId = pid;
    r.start = start;
    r.end = end;
    r.net = net;
    r.buyOut = buyOut;
    return r;
}

const Night* find(const std::vector<Night>& nights, const std::string& person) {
    for (const Night& n : nights) if (n.person == person) return &n;
    return nullptr;
}

void exitsOfOneNight() {
    std::printf("\n-- every way a night can end (hands #1-#100, big blind $0.50) --\n");
    std::vector<Script> s = {
        {"p1", "Stay", {{0, 99}}, 50, {{50, 30}}, {}},
        {"p2", "UpLeft", {{0, 49}}, 50, {{10, 30}}, {}},
        {"p3", "DownLeft", {{0, 59}}, 50, {{10, -20}}, {}},
        {"p4", "Bust", {{0, 29}}, 20, {{29, -20}}, {}},
        {"p5", "Rebuy", {{0, 99}}, 20, {{19, -20}}, {{20, 20}}},
        {"p6", "BreakBack", {{0, 29}, {70, 99}}, 50, {{5, 30}}, {}},
        {"p7", "Grace", {{0, 91}}, 50, {{5, 30}}, {}},
        {"p8", "Even", {{0, 49}}, 50, {{5, 1}}, {}},
        {"p9", "Late", {{60, 79}}, 50, {{65, 30}}, {}},
        {"pa", "Kicked", {{0, 39}}, 50, {{5, 30}}, {}},
        {"pb", "Refill", {{0, 39}}, 20, {{39, -20}}, {}},
        {"tA", "Twin A", {{0, 49}}, 50, {{5, 10}}, {}},
        {"tB", "Twin B", {{30, 79}}, 50, {{40, 20}}, {}},
        {"sh", "Shared", {{0, 99}}, 50, {{10, 30}, {60, -10}}, {}},
        {"pq", "Quick", {{0, 40}}, 50, {{38, 30}}, {}},
        {"pg", "GaveBack", {{0, 49}}, 50, {{5, 40}, {45, -30}}, {}},
    };
    handlog::HandLog log = buildNight(s, 100);
    // After Kicked's last hand the admin forces them away; Refill rebuys but never plays again.
    log.events.push_back({at(40), 40, "pa", "away", 0.0});
    log.events.push_back({at(40), 40, "pb", "rebuy", 20.0});
    // "Shared" is one account held by two people: Carol for the first half, Dave after.
    log.seats["sh"] = {{at(0) - 60, at(49) + 10, "carol"}, {at(50) - 5, util::NO_TIME, "dave"}};

    players::MergeRules rules;
    players::addMergeRule(rules, "twinb", "twina");   // one person on two accounts

    // The ledger says UpLeft won $40 (the log says $30): the ledger is what the leaderboard counts.
    Game game;
    game.id = "ledger_pgltest";
    game.start = at(0);
    game.rows.push_back(seat("UpLeft", "p2", at(0), at(49), 40.0, 90.0));

    std::vector<Night> nights = hitrun::nightsFromLog(log, &game, rules, {}, 1.0);

    const Night* n = find(nights, "stay");
    check(n && n->exit == Exit::Stayed && n->away == 0.0 && n->finishedUp() && n->upSample() && n->handsInNight == 100,
          "dealt in to the last hand, up: stayed, counts toward 'when up' at 0%");
    n = find(nights, "upleft");
    check(n && n->exit == Exit::LeftUp && n->lastHand == 50 && n->handsLeft == 50 && near(n->away, 0.5) && near(n->played, 0.5),
          "left up after hand #50 of 100: 50 hands left, walked away from 50%");
    check(n && near(n->net, 40.0) && near(n->netBB(), 80.0) && near(n->winWeight(), 1.0),
          "the ledger's $40 is the result (80 bb, a full-weight win), not the log's $30");
    check(n && n->peakKnown && near(n->peak, 30.0) && n->handsAfterPeak == 39 && near(n->minutesAfterPeak, 39 * 45 / 60.0) &&
              near(n->kept(), 1.0) && near(n->fresh(), std::pow(0.5, 39 / 20.0)),
          "won $30 on hand #11 and played 39 more hands (29 min): the hit counts 0.5^(39/20)");
    n = find(nights, "downleft");
    check(n && n->exit == Exit::LeftDown && n->handsLeft == 40 && near(n->away, 0.4) && n->downSample() && n->peak == 0.0,
          "left down with chips after hand #60: 40% walked away, counts toward 'when down', never ahead");
    n = find(nights, "bust");
    check(n && n->exit == Exit::Busted && near(n->away, 0.7) && !n->upSample() && !n->downSample(),
          "went to $0 on hand #30 and never came back: busted out, in neither habit");
    n = find(nights, "rebuy");
    check(n && n->exit == Exit::Stayed && n->rebuys == 1 && n->cameBack == 0,
          "busted on hand #20, bought back in, played to the end: stayed with 1 rebuy");
    n = find(nights, "breakback");
    check(n && n->exit == Exit::Stayed && n->cameBack == 1 && n->cameBackUp == 1 && n->handsPlayed == 60,
          "left up for 40 hands and came back to the end: not a hit and run, 1 return while up");
    n = find(nights, "grace");
    check(n && n->exit == Exit::Stayed && n->handsLeft == 8 && n->away == 0.0,
          "left with 8 hands to go (inside the 10-hand grace): stayed");
    n = find(nights, "even");
    check(n && n->exit == Exit::LeftEven && near(n->netBB(), 2.0) && !n->upSample() && !n->downSample(),
          "left $1 (2 bb) up: about even, in neither habit");
    n = find(nights, "late");
    check(n && n->exit == Exit::LeftUp && n->satDownHand == 61 && n->handsLeft == 20 && near(n->away, 0.5) && near(n->played, 0.2),
          "sat down at #61, left up after #80: 20 of the 40 hands since sitting down (arriving late is not held against them)");
    n = find(nights, "kicked");
    check(n && n->exit == Exit::Removed && !n->upSample(), "forced to away mode by the admin as they stopped: removed, not judged");
    n = find(nights, "refill");
    check(n && n->exit == Exit::LeftDown, "went to $0 but rebought after the last hand and left: left down, not busted");
    n = find(nights, "twina");
    check(n && n->exit == Exit::LeftUp && n->satDownHand == 1 && n->lastHand == 80 && n->handsPlayed == 80 &&
              near(n->net, 30.0) && near(n->away, 0.2),
          "two accounts, one person: one night from #1 to #80, results added (+$30)");
    check(!find(nights, "twinb"), "the second account is not a person of its own");
    n = find(nights, "carol");
    check(n && n->exit == Exit::LeftUp && n->lastHand == 50 && near(n->net, 30.0) && near(n->away, 0.5),
          "shared account, first holder: left up at half-time");
    n = find(nights, "dave");
    check(n && n->exit == Exit::Stayed && n->satDownHand == 51 && near(n->net, -10.0) && n->downSample(),
          "shared account, second holder: stayed to the end down");
    n = find(nights, "quick");
    check(n && n->exit == Exit::LeftUp && n->handsAfterPeak == 2 && near(n->fresh(), std::pow(0.5, 0.1)),
          "won $30 on hand #39 and left after #41: a hit and run, nearly full credit");
    n = find(nights, "gaveback");
    check(n && near(n->peak, 40.0) && near(n->kept(), 0.25) && n->handsAfterPeak == 44 &&
              near(n->fresh(), 0.25 * std::pow(0.5, 44 / 20.0)),
          "up $40 on hand #6, gave $30 back and left after #50: kept 25%, little credit as a hit");
}

void cutOffLog() {
    std::printf("\n-- a log PokerNow cut short: it holds hands #101-#200 of a 200-hand night --\n");
    // The night started (first sit-down) 100 hands' worth of time before the log begins.
    const std::int64_t nightStart = at(-100);
    std::vector<Script> s = {
        {"ps", "Seated", {{0, 99}}, 50, {{50, 10}}, {}},
        {"pu", "SeatedUp", {{0, 59}}, 50, {{5, 20}}, {}},
    };
    handlog::HandLog log = buildNight(s, 100, 101);
    Game game;
    game.id = "ledger_pglcut";
    game.start = nightStart;
    game.rows.push_back(seat("Early", "pe", nightStart, at(-50), 40.0, 60.0));          // gone by hand #51
    game.rows.push_back(seat("Seated", "ps", at(-80), util::NO_TIME, -20.0));           // down $30 before the log
    game.rows.push_back(seat("SeatedUp", "pu", nightStart, util::NO_TIME, 50.0));       // up $30 before the log
    // Three seats before the log: busted out of the first, cashed out of the second with chips,
    // then sat a third time. Only the second seat follows a bust.
    game.rows.push_back(seat("Trip", "pt", at(-100), at(-90), -50.0, 0.0));
    game.rows.push_back(seat("Trip", "pt", at(-88), at(-70), 0.0, 50.0));
    game.rows.push_back(seat("Trip", "pt", at(-65), at(-55), 10.0, 60.0));
    std::vector<Night> nights = hitrun::nightsFromLog(log, &game, {}, {}, 1.0);

    const Night* n = find(nights, "early");
    check(n && n->estimated && n->satDownHand == 1 && n->lastHand == 51 && n->handsLeft == 149 && near(n->away, 149 / 200.0) &&
              n->exit == Exit::LeftUp && !n->peakKnown,
          "left before the log begins: placed at #1-#51 by the ledger's times, left up with 149 hands to come");
    n = find(nights, "seated");
    check(n && n->satDownHand == 21 && n->handsPlayed == 180 && n->handsInNight == 200 && n->handsMissing == 100 &&
              n->exit == Exit::Stayed && n->peak == 0.0 && near(n->net, -20.0),
          "seated before the log begins (~#21): the ledger's -$20 is the result, never ahead on the night");
    n = find(nights, "seatedup");
    check(n && n->satDownHand == 1 && n->lastHand == 160 && n->handsLeft == 40 && near(n->away, 0.2) && n->exit == Exit::LeftUp &&
              near(n->peak, 50.0) && !n->peakAtLogStart && n->handsAfterPeak == 54 && near(n->kept(), 1.0),
          "up $30 before the log, $20 more on #106, left after #160: peak $50 on the ledger's scale, 54 hands before leaving");
    n = find(nights, "trip");
    check(n && n->estimated && n->rebuys == 1 && n->exit == Exit::LeftDown,
          "three seats before the log (busted, cashed out, sat again): one rebuy, not two");

    // A log of only #4-#13: someone who left just before it begins left inside the last 10 hands.
    handlog::HandLog shortLog = buildNight({}, 10, 4);
    Game shortGame;
    shortGame.id = "ledger_pglshort";
    shortGame.start = at(-3);
    shortGame.rows.push_back(seat("Late", "pl", at(-3), at(-1), 25.0, 100.0));
    nights = hitrun::nightsFromLog(shortLog, &shortGame, {}, {}, 1.0);
    n = find(nights, "late");
    check(n && n->estimated && n->lastHand == 3 && n->handsLeft == 10 && n->exit == Exit::Stayed && n->away == 0.0,
          "a 13-hand night whose log has #4-#13: left after #3, 10 hands from the end, so stayed");
}

// Four winning and four losing nights each for three kinds of player, all wins 60 bb.
void factorArithmetic() {
    std::printf("\n-- the factor, worked by hand --\n");
    auto night = [](const std::string& who, double away, double netBB, int handsAfterPeak) {
        Night n;
        n.person = who;
        n.displayName = who;
        n.bigBlind = 1.0;
        n.net = netBB;
        n.away = away;
        n.exit = away == 0.0 ? Exit::Stayed : (netBB > 0 ? Exit::LeftUp : Exit::LeftDown);
        n.peakKnown = true;
        n.peak = std::max(0.0, netBB);
        n.finalRunning = netBB;
        n.handsAfterPeak = handsAfterPeak;
        return n;
    };
    std::vector<Night> nights;
    for (int i = 0; i < 4; ++i) {
        nights.push_back(night("stayer", 0.1, 60, 40));  nights.push_back(night("stayer", 0.1, -60, 0));
        nights.push_back(night("bedtime", 0.8, 60, 40)); nights.push_back(night("bedtime", 0.8, -60, 0));
        nights.push_back(night("runner", 0.8, 60, 0));   nights.push_back(night("runner", 0.2, -60, 0));
    }
    std::map<std::string, hitrun::Summary> by;
    for (const hitrun::Summary& s : hitrun::summarize(nights)) by[s.person] = s;

    // Hit per night = away x fresh; fresh = 1 at the peak, 0.25 forty hands after it.
    // Pool: when up (0.4 + 3.2 + 3.2) / 12, hit (0.1 + 0.8 + 3.2) / 12, when down (0.4 + 3.2 + 0.8) / 12.
    const double poolUp = 6.8 / 12, poolHit = 4.1 / 12, poolDown = 4.4 / 12;
    auto expect = [&](const std::string& who, double sumUp, double sumHit, double sumDown, const char* tag) {
        const double up = (sumUp + hitrun::kShrinkUpNights * poolUp) / (4 + hitrun::kShrinkUpNights);
        const double hit = (sumHit + hitrun::kShrinkUpNights * poolHit) / (4 + hitrun::kShrinkUpNights);
        const double down = (sumDown + hitrun::kShrinkDownNights * poolDown) / (4 + hitrun::kShrinkDownNights);
        const double factor = 100 * (up + std::max(0.0, up - down) + hit) / 3;
        const hitrun::Summary& s = by[who];
        char line[240];
        std::snprintf(line, sizeof line, "%-8s up %.3f, down %.3f, hit %.3f: H&R %.2f (got %.2f), tag \"%s\" (got \"%s\")",
                      who.c_str(), up, down, hit, factor, s.factor, tag, s.tag.c_str());
        check(near(s.whenUp, up) && near(s.whenDown, down) && near(s.hit, hit) && near(s.factor, factor) && s.tag == tag, line);
    };
    expect("stayer", 0.4, 0.1, 0.4, "");
    expect("bedtime", 3.2, 0.8, 3.2, "Runs when up");
    expect("runner", 3.2, 3.2, 0.8, "Hit & runner");
    check(by["runner"].factor > by["bedtime"].factor && by["bedtime"].factor > by["stayer"].factor,
          "leaving winners early right after the peak outranks a bedtime, which outranks staying");
    check(near(by["runner"].whenUpRaw, 0.8) && near(by["runner"].whenDownRaw, 0.2) && near(by["runner"].hitRaw, 0.8),
          "raw habits are kept alongside");

    // A long record of leaving at the same hour either way reads as a bedtime, not a hit and run.
    std::vector<Night> curfew;
    for (int i = 0; i < 20; ++i) { curfew.push_back(night("curfew", 0.8, 60, 60)); curfew.push_back(night("curfew", 0.8, -60, 0)); }
    hitrun::Summary c = hitrun::summarize(curfew).front();
    check(c.tag == "Early leaver", "20 winning and 20 losing nights all left at 80%: tagged Early leaver (got \"" + c.tag + "\")");

    // Thin samples: two winning nights are shown but not trusted; busting most nights is its own tag.
    std::vector<Night> thin = {night("thin", 0.9, 60, 0), night("thin", 0.9, 60, 0)};
    Night b = night("buster", 0.5, -40, 0);
    b.exit = Exit::Busted;
    for (int i = 0; i < 3; ++i) thin.push_back(b);
    thin.push_back(night("buster", 0.0, 60, 0));
    std::map<std::string, hitrun::Summary> t;
    for (const hitrun::Summary& s : hitrun::summarize(thin)) t[s.person] = s;
    check(!t["thin"].reliable() && t["thin"].tag.empty(), "two winning nights: factor shown in brackets, no tag");
    check(t["buster"].busted == 3 && t["buster"].tag == "Busts out", "busted out on 3 of 4 nights: tagged Busts out");
}

void adminLines() {
    std::printf("\n-- reading the admin's away / removal lines --\n");
    const fs::path dir = fs::temp_directory_path() / "hitrun_selftest";
    fs::create_directories(dir);
    const fs::path file = dir / "poker_now_log_pgladmin.csv";
    std::ofstream f(file);
    f << "entry,at,order\n"
      << "\"-- starting hand #1 (id: abc)  No Limit Texas Hold'em (dealer: \"\"A @ pa\"\") --\",2026-09-01T02:00:00.000Z,1\n"
      << "\"Player stacks: #1 \"\"A @ pa\"\" (10.00) | #2 \"\"B @ pb\"\" (10.00)\",2026-09-01T02:00:00.000Z,2\n"
      << "\"\"\"A @ pa\"\" posts a small blind of 0.25\",2026-09-01T02:00:00.000Z,3\n"
      << "\"\"\"B @ pb\"\" posts a big blind of 0.50\",2026-09-01T02:00:00.000Z,4\n"
      << "\"\"\"A @ pa\"\" folds\",2026-09-01T02:00:05.000Z,5\n"
      << "\"Uncalled bet of 0.25 returned to \"\"B @ pb\"\"\",2026-09-01T02:00:05.000Z,6\n"
      << "\"\"\"B @ pb\"\" collected 0.50 from pot\",2026-09-01T02:00:05.000Z,7\n"
      << "\"-- ending hand #1 --\",2026-09-01T02:00:05.000Z,8\n"
      << "\"The admin \"\"A @ pa\"\" forced the player \"\"B @ pb\"\" to away mode in the next hand.\",2026-09-01T02:00:06.000Z,9\n"
      << "\"The admin \"\"A @ pa\"\" enqueued the removal of the player \"\"B @ pb\"\".\",2026-09-01T02:00:07.000Z,10\n";
    f.close();
    handlog::HandLog log;
    std::string error;
    const bool ok = handlog::parseLogFile(file, dir, log, error);
    int away = 0, kick = 0;
    for (const handlog::StackEvent& e : log.events) {
        if (e.kind == "away" && e.playerId == "pb" && e.hand == 1) ++away;
        if (e.kind == "kick" && e.playerId == "pb" && e.hand == 1) ++kick;
    }
    check(ok && away == 1 && kick == 1, "forced away and queued removal read as events on B, before hand index 1");
    std::error_code ec;
    fs::remove_all(dir, ec);
}

}  // namespace

int main() {
    exitsOfOneNight();
    cutOffLog();
    factorArithmetic();
    adminLines();
    std::printf("\n%s: %d check%s failed\n", failures ? "FAILED" : "PASSED", failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
