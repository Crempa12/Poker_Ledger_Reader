#include "handlog.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <fstream>
#include <iostream>
#include <set>
#include <sstream>

namespace fs = std::filesystem;
using namespace util;

namespace handlog {

// ======================================================================
// CSV records (fields may contain quoted newlines, unlike the ledgers)
// ======================================================================

namespace {

std::vector<std::vector<std::string>> readCSVRecords(const fs::path& file) {
    std::vector<std::vector<std::string>> records;
    std::ifstream in(file, std::ios::binary);
    if (!in.is_open()) return records;
    std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());

    std::vector<std::string> row;
    std::string field;
    bool inQuotes = false;
    for (size_t i = 0; i < text.size(); ++i) {
        char c = text[i];
        if (inQuotes) {
            if (c == '"') {
                if (i + 1 < text.size() && text[i + 1] == '"') { field += '"'; ++i; }
                else inQuotes = false;
            } else {
                field += c;
            }
        } else if (c == '"') {
            inQuotes = true;
        } else if (c == ',') {
            row.push_back(field);
            field.clear();
        } else if (c == '\n') {
            row.push_back(field);
            field.clear();
            records.push_back(row);
            row.clear();
        } else if (c != '\r') {
            field += c;
        }
    }
    if (!field.empty() || !row.empty()) { row.push_back(field); records.push_back(row); }
    return records;
}

// Reads `"Name @ id"` starting at text[pos] (which must be the opening quote).
// Leaves pos just after the closing quote. Returns false if not a player ref.
bool readPlayerRef(const std::string& text, size_t& pos, std::string& nickname, std::string& id) {
    if (pos >= text.size() || text[pos] != '"') return false;
    size_t close = text.find('"', pos + 1);
    if (close == std::string::npos) return false;
    std::string inner = text.substr(pos + 1, close - pos - 1);
    size_t at = inner.rfind(" @ ");
    if (at == std::string::npos) return false;
    nickname = trim(inner.substr(0, at));
    id = trim(inner.substr(at + 3));
    pos = close + 1;
    return !id.empty();
}

// First number found in text at or after `from`.
double numberAt(const std::string& text, size_t from) {
    size_t i = from;
    while (i < text.size() && !(std::isdigit(static_cast<unsigned char>(text[i])) || text[i] == '.')) ++i;
    size_t j = i;
    while (j < text.size() && (std::isdigit(static_cast<unsigned char>(text[j])) || text[j] == '.')) ++j;
    return i < text.size() ? toDoubleSafe(text.substr(i, j - i)) : 0.0;
}

std::vector<std::string> splitCards(const std::string& s) {
    std::vector<std::string> out;
    std::stringstream ss(s);
    std::string item;
    while (std::getline(ss, item, ',')) {
        item = trim(item);
        if (!item.empty()) out.push_back(item);
    }
    return out;
}

// Cards inside the last [...] of a board line.
std::vector<std::string> bracketCards(const std::string& text) {
    size_t open = text.rfind('[');
    size_t close = text.rfind(']');
    if (open == std::string::npos || close == std::string::npos || close < open) return {};
    return splitCards(text.substr(open + 1, close - open - 1));
}

bool startsWith(const std::string& s, const char* prefix) { return s.rfind(prefix, 0) == 0; }

std::string gameIdFromFilename(const fs::path& file) {
    std::string stem = file.stem().string();        // poker_now_log_pglXXXX or "poker_now_log_pglXXXX (1)"
    const std::string prefix = "poker_now_log_";
    if (!startsWith(stem, prefix.c_str())) return "";
    std::string id = stem.substr(prefix.size());
    size_t sp = id.find(' ');
    if (sp != std::string::npos) id = id.substr(0, sp);
    return trim(id);
}

bool isExcludedDir(const fs::path& p) {
    std::string name = p.filename().string();
    return name == "Saved_Data" || name == ".git" || name == ".idea" || name == "build" ||
           name == "reports" || name.rfind("cmake-build", 0) == 0;
}

// Per-hand money tracking while parsing.
struct Money {
    std::map<std::string, double> committed;    // this street, live money
    std::map<std::string, double> contributed;  // whole hand
    std::map<std::string, double> won;
    void newStreet() { committed.clear(); }
    void live(const std::string& pid, double to) {   // call / bet / raise "to" amounts
        double prev = committed[pid];
        if (to < prev) to = prev;
        contributed[pid] += to - prev;
        committed[pid] = to;
    }
};

}  // namespace

const Seat* Hand::seatOf(const std::string& playerId) const {
    for (const Seat& s : seats) if (s.playerId == playerId) return &s;
    return nullptr;
}

// ======================================================================
// Discovery and parsing
// ======================================================================

std::vector<fs::path> discoverLogFiles(const fs::path& root) {
    std::vector<fs::path> found;
    std::error_code ec;
    fs::recursive_directory_iterator it(root, fs::directory_options::skip_permission_denied, ec);
    fs::recursive_directory_iterator end;
    while (!ec && it != end) {
        const fs::directory_entry& entry = *it;
        if (entry.is_directory(ec)) {
            if (isExcludedDir(entry.path())) it.disable_recursion_pending();
        } else if (lower(entry.path().extension().string()) == ".csv" && !gameIdFromFilename(entry.path()).empty()) {
            found.push_back(entry.path());
        }
        it.increment(ec);
    }
    std::sort(found.begin(), found.end());
    return found;
}

bool parseLogFile(const fs::path& file, const fs::path& root, HandLog& out, std::string& error) {
    out = HandLog{};
    out.gameId = gameIdFromFilename(file);
    out.path = file.string();
    std::error_code ec;
    fs::path rel = fs::relative(file.parent_path(), root, ec);
    out.folder = (ec || rel.empty() || rel == ".") ? "(root)" : rel.generic_string();

    std::vector<std::vector<std::string>> records = readCSVRecords(file);
    if (records.empty()) { error = "could not read " + file.string(); return false; }

    // Header: entry,at,order. The file is newest-first; sort by order.
    struct Rec { std::string entry; std::int64_t at; std::int64_t order; };
    std::vector<Rec> recs;
    for (size_t i = 0; i < records.size(); ++i) {
        const std::vector<std::string>& r = records[i];
        if (r.size() < 3 || (i == 0 && lower(r[0]) == "entry")) continue;
        Rec rec;
        rec.entry = r[0];
        rec.at = parseISO8601UTC(trim(r[1]));
        try { rec.order = std::stoll(trim(r[2])); } catch (...) { rec.order = 0; }
        recs.push_back(rec);
    }
    if (recs.empty()) { error = "no log entries in " + file.string(); return false; }
    std::stable_sort(recs.begin(), recs.end(), [](const Rec& a, const Rec& b) { return a.order < b.order; });

    // Amounts are logged in cents until "Cents Mode" is switched on. Hands only start once it is,
    // but seat requests and rebuys can come before, so the factor follows the config changes.
    const std::string centsOn = "Cents Mode: off \xC2\xBB on";
    const std::string centsOff = "Cents Mode: on \xC2\xBB off";
    double centsFactor = 1.0;
    for (const Rec& rec : recs) {
        if (rec.entry.find(centsOn) != std::string::npos) { centsFactor = 0.01; break; }
        if (rec.entry.find(centsOff) != std::string::npos) break;
    }
    std::map<std::string, double> pendingRebuy;   // playerId -> amount asked for, until "rebought"

    Hand hand;
    bool inHand = false;
    std::string street;
    Money money;

    auto finish = [&]() {
        if (!inHand) return;
        for (const auto& c : money.contributed) hand.net[c.first] -= c.second;
        for (const auto& w : money.won) hand.net[w.first] += w.second;
        for (const Seat& s : hand.seats) hand.net.emplace(s.playerId, 0.0);
        for (const auto& b : hand.bounty) hand.net[b.first] += b.second;
        for (const auto& c : hand.collected) hand.pot += c.second;
        out.hands.push_back(hand);
        inHand = false;
    };

    for (const Rec& rec : recs) {
        const std::string& e = rec.entry;
        if (out.start == NO_TIME || (rec.at != NO_TIME && rec.at < out.start)) out.start = rec.at;
        if (rec.at != NO_TIME && rec.at > out.end) out.end = rec.at;

        if (startsWith(e, "-- starting hand")) {
            finish();
            hand = Hand{};
            money = Money{};
            street = "preflop";
            inHand = true;
            hand.number = static_cast<int>(numberAt(e, e.find('#')));
            size_t idPos = e.find("(id: ");
            if (idPos != std::string::npos) {
                size_t close = e.find(')', idPos);
                hand.id = trim(e.substr(idPos + 5, close == std::string::npos ? std::string::npos : close - idPos - 5));
            }
            hand.start = rec.at;
            size_t d = e.find("(dealer: ");
            if (d != std::string::npos) {
                size_t p = d + 9;
                std::string nick, pid;
                if (readPlayerRef(e, p, nick, pid)) hand.dealerId = pid;
            }
            continue;
        }
        if (startsWith(e, "-- ending hand")) { finish(); continue; }

        // 7-2 bounties: "\"A @ id\" paid 1.00 for the 7-2 bounty to \"B @ id\"". Paid in chips, but
        // logged after the hand-ended marker, so they belong to the hand that just finished.
        if (!e.empty() && e[0] == '"' && e.find(" paid ") != std::string::npos && e.find("bounty") != std::string::npos) {
            size_t p0 = 0;
            std::string nick, pid, nick2, pid2;
            if (!readPlayerRef(e, p0, nick, pid)) continue;
            double n = numberAt(e, p0);
            size_t q = e.find(" to \"", p0);
            if (q == std::string::npos) continue;
            size_t pos = q + 4;
            if (!readPlayerRef(e, pos, nick2, pid2)) continue;
            out.names[pid] = nick;
            out.names[pid2] = nick2;
            Hand* target = inHand ? &hand : (out.hands.empty() ? nullptr : &out.hands.back());
            if (!target) continue;
            target->bounty[pid] -= n;
            target->bounty[pid2] += n;
            if (!inHand) { target->net[pid] -= n; target->net[pid2] += n; }
            continue;
        }

        if (e.find("Cents Mode: ") != std::string::npos) {
            if (e.find(centsOn) != std::string::npos) centsFactor = 1.0;
            else if (e.find(centsOff) != std::string::npos) centsFactor = 0.01;
            continue;
        }

        // Chips put on the table between hands: "requested a rebuy of 40.00" then "rebought. New stack 40.00.",
        // or "The admin updated the player "A @ id" stack from 1.27 to 51.27." They take effect next hand.
        if (startsWith(e, "The player \"") || startsWith(e, "The admin updated the player \"")) {
            size_t q = e.find('"');
            std::string nick, pid;
            if (!readPlayerRef(e, q, nick, pid)) continue;
            std::string rest = e.substr(q);
            StackEvent ev;
            ev.at = rec.at;
            ev.playerId = pid;
            ev.hand = static_cast<int>(out.hands.size()) + (inHand ? 1 : 0);
            if (startsWith(rest, " requested a rebuy of ")) {
                pendingRebuy[pid] = numberAt(rest, 22) * centsFactor;
                continue;
            }
            if (startsWith(rest, " rebought.")) {
                auto asked = pendingRebuy.find(pid);
                ev.kind = "rebuy";
                ev.amount = asked != pendingRebuy.end() ? asked->second : numberAt(rest, rest.find("stack")) * centsFactor;
                if (asked != pendingRebuy.end()) pendingRebuy.erase(asked);
            } else if (startsWith(rest, " stack from ")) {
                size_t to = rest.find(" to ", 12);
                if (to == std::string::npos) continue;
                double diff = (numberAt(rest, to + 4) - numberAt(rest, 12)) * centsFactor;
                ev.kind = diff >= 0 ? "topup" : "remove";
                ev.amount = std::fabs(diff);
            } else {
                continue;   // joins, stand-ups, seat requests: the ledger already has the seats
            }
            if (ev.amount > EPSILON) out.events.push_back(ev);
            continue;
        }
        if (!inHand) continue;

        if (startsWith(e, "Player stacks:")) {
            size_t p = 0;
            while ((p = e.find('#', p)) != std::string::npos) {
                Seat s;
                s.seat = static_cast<int>(numberAt(e, p));
                size_t q = e.find('"', p);
                if (q == std::string::npos) break;
                if (!readPlayerRef(e, q, s.nickname, s.playerId)) break;
                s.stack = numberAt(e, q);
                hand.seats.push_back(s);
                out.names[s.playerId] = s.nickname;
                p = q;
            }
            continue;
        }
        if (startsWith(e, "Your hand is ")) { hand.myCards = trim(e.substr(13)); continue; }
        if (startsWith(e, "Flop")) {
            street = "flop"; money.newStreet();
            if (hand.board.empty()) hand.board = bracketCards(e);
            continue;
        }
        if (startsWith(e, "Turn")) {
            street = "turn"; money.newStreet();
            if (hand.board.size() == 3) for (const std::string& c : bracketCards(e)) hand.board.push_back(c);
            continue;
        }
        if (startsWith(e, "River")) {
            street = "river"; money.newStreet();
            if (hand.board.size() == 4) for (const std::string& c : bracketCards(e)) hand.board.push_back(c);
            continue;
        }
        if (startsWith(e, "Uncalled bet of ")) {
            double amount = numberAt(e, 16);
            size_t q = e.find('"');
            std::string nick, pid;
            if (q != std::string::npos && readPlayerRef(e, q, nick, pid)) money.won[pid] += amount;
            continue;
        }
        if (e.empty() || e[0] != '"') continue;   // joins, rebuys, config changes ...

        size_t p = 0;
        std::string nick, pid;
        if (!readPlayerRef(e, p, nick, pid)) continue;
        out.names[pid] = nick;
        std::string rest = trim(e.substr(p));
        bool allIn = rest.find("all in") != std::string::npos;

        auto act = [&](const char* kind, double amount) {
            Action a;
            a.playerId = pid; a.street = street; a.kind = kind; a.amount = amount; a.allIn = allIn;
            hand.actions.push_back(a);
        };

        if (startsWith(rest, "folds")) act("fold", 0);
        else if (startsWith(rest, "checks")) act("check", 0);
        else if (startsWith(rest, "calls ")) { double n = numberAt(rest, 6); money.live(pid, n); act("call", n); }
        else if (startsWith(rest, "bets ")) { double n = numberAt(rest, 5); money.live(pid, n); act("bet", n); }
        else if (startsWith(rest, "raises to ")) { double n = numberAt(rest, 10); money.live(pid, n); act("raise", n); }
        else if (startsWith(rest, "posts ")) {
            double n = numberAt(rest, rest.find(" of ") == std::string::npos ? 6 : rest.find(" of "));
            bool dead = rest.find("missing small blind") != std::string::npos;
            if (dead) money.contributed[pid] += n;   // dead money: in the pot, but not live toward a call
            else money.live(pid, n);
            act("post", n);
        }
        else if (startsWith(rest, "shows a ")) {
            std::string cards = trim(rest.substr(8));
            if (!cards.empty() && cards.back() == '.') cards.pop_back();
            hand.shown[pid] = cards;
            hand.showdown = true;
        }
        else if (startsWith(rest, "collected ") && rest.find("bounty") == std::string::npos) {
            double n = numberAt(rest, 10);
            hand.collected[pid] += n;
            money.won[pid] += n;
            size_t w = rest.find(" from pot with ");
            if (w != std::string::npos) {
                std::string r = rest.substr(w + 15);
                size_t comb = r.find(" (combination");
                hand.rank[pid] = trim(comb == std::string::npos ? r : r.substr(0, comb));
                hand.showdown = true;
            }
        }
        else if (rest.find("run it twice") != std::string::npos && rest.find("not") == std::string::npos) {
            hand.runItTwice = true;
        }
    }
    finish();

    if (out.hands.empty()) { error = "no hands in " + file.string(); return false; }

    // Biggest pot, and a sanity check of the money maths against the next hand's stacks.
    for (size_t h = 0; h < out.hands.size(); ++h) {
        const Hand& hd = out.hands[h];
        if (hd.pot > out.biggestPot) {
            out.biggestPot = hd.pot;
            out.biggestPotHand = hd.number;
            double best = -1;
            for (const auto& c : hd.collected) if (c.second > best) { best = c.second; out.biggestPotWinner = c.first; }
        }
        if (h + 1 < out.hands.size()) {
            const Hand& next = out.hands[h + 1];
            for (const Seat& s : hd.seats) {
                const Seat* ns = next.seatOf(s.playerId);
                if (!ns) continue;
                auto it = hd.net.find(s.playerId);
                double expected = s.stack + (it == hd.net.end() ? 0.0 : it->second);
                // A stack above the expected value is a top-up; below it means the maths went wrong.
                if (ns->stack < expected - 0.011) { ++out.stackMismatches; break; }
            }
        }
    }
    return true;
}

std::map<std::string, HandLog> loadAllLogs(const fs::path& root, std::vector<std::string>& messages) {
    std::map<std::string, HandLog> logs;
    for (const fs::path& file : discoverLogFiles(root)) {
        HandLog log;
        std::string err;
        if (!parseLogFile(file, root, log, err)) { messages.push_back("Skipped hand log: " + err); continue; }
        auto existing = logs.find(log.gameId);
        if (existing != logs.end()) {
            // Keep the more complete export of the same game.
            if (log.hands.size() <= existing->second.hands.size()) {
                messages.push_back("Duplicate hand log ignored: " + file.string());
                continue;
            }
            messages.push_back("Duplicate hand log ignored: " + existing->second.path);
        }
        logs[log.gameId] = std::move(log);
    }
    return logs;
}

// ======================================================================
// Style statistics
// ======================================================================

std::string StyleStats::styleLabel() const {
    if (hands < 30) return "(few hands)";
    double v = vpipPct();
    double af = aggression();
    bool loose = v >= 32, tight = v <= 20;
    bool aggro = af >= 2.5, passive = af < 1.2;
    if (tight && aggro) return "Tight-aggressive";
    if (loose && aggro) return "Loose-aggressive";
    if (tight && passive) return "Tight-passive";
    if (loose && passive) return "Loose-passive (calls a lot)";
    if (aggro) return "Aggressive";
    if (passive) return "Passive";
    if (loose) return "Loose";
    if (tight) return "Tight";
    return "Balanced";
}

void pairWithLedger(HandLog& log, const Game& game, const players::MergeRules& rules) {
    log.seats.clear();
    for (const LedgerRow& r : game.rows) {
        if (r.playerId.empty()) continue;
        log.seats[r.playerId].push_back({r.start, r.end, players::personOf(rules, r)});
    }
}

std::string personAt(const HandLog& log, const std::string& playerId, std::int64_t at, const players::MergeRules& rules) {
    auto it = log.seats.find(playerId);
    if (it != log.seats.end() && !it->second.empty()) {
        const SeatWindow* best = nullptr;
        std::int64_t bestGap = 0;
        for (const SeatWindow& w : it->second) {
            std::int64_t gap = 0;
            if (at != NO_TIME && w.start != NO_TIME && at < w.start) gap = w.start - at;
            else if (at != NO_TIME && w.end != NO_TIME && at > w.end) gap = at - w.end;
            if (!best || gap < bestGap) { best = &w; bestGap = gap; }
        }
        return best->person;
    }
    auto n = log.names.find(playerId);
    return players::resolveCanonical(rules, normalizeName(n == log.names.end() ? playerId : n->second));
}

namespace {
struct Identity {
    std::string key;       // canonical name ("@<account>" for a nickname with no letters)
    std::string display;
};

Identity identify(const HandLog& log, const std::string& pid, std::int64_t at,
                  const players::MergeRules& rules,
                  const std::map<std::string, PlayerStats>& ledgerStats) {
    Identity id;
    id.key = personAt(log, pid, at, rules);
    auto n = log.names.find(pid);
    std::string nickname = n == log.names.end() ? pid : n->second;
    if (id.key.empty()) id.key = "@" + pid;
    auto it = ledgerStats.find(id.key);
    if (it != ledgerStats.end()) {
        id.display = it->second.displayName;
    } else if (players::resolveCanonical(rules, normalizeName(nickname)) == id.key || id.key[0] == '@') {
        id.display = nickname;
    } else {   // a seat handed to someone with no ledger stats in scope
        id.display = id.key;
        id.display[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(id.display[0])));
    }
    return id;
}
}  // namespace

std::string displayNameAt(const HandLog& log, const std::string& playerId, std::int64_t at,
                          const players::MergeRules& rules,
                          const std::map<std::string, PlayerStats>& ledgerStats) {
    return identify(log, playerId, at, rules, ledgerStats).display;
}

std::vector<StyleStats> computeStyle(const std::vector<const HandLog*>& logs,
                                     const players::MergeRules& rules,
                                     const std::map<std::string, PlayerStats>& ledgerStats) {
    std::map<std::string, StyleStats> rows;
    std::map<std::string, std::set<std::string>> gamesOf;

    for (const HandLog* log : logs) {
        for (const Hand& hand : log->hands) {
            // Accounts are resolved to people hand by hand, since a shared account can change hands mid-night.
            std::map<std::string, std::string> keyOf;   // playerId -> person
            auto person = [&](const std::string& pid) -> const std::string& {
                auto c = keyOf.find(pid);
                if (c == keyOf.end()) {
                    Identity id = identify(*log, pid, hand.start, rules, ledgerStats);
                    StyleStats& s = rows[id.key];
                    if (s.normalizedName.empty()) { s.normalizedName = id.key; s.displayName = id.display; }
                    c = keyOf.emplace(pid, id.key).first;
                }
                return c->second;
            };

            // Someone holding two seats in one hand was still dealt one hand.
            std::set<std::string> seated;
            for (const Seat& s : hand.seats) seated.insert(person(s.playerId));
            for (const std::string& k : seated) {
                ++rows[k].hands;
                gamesOf[k].insert(log->gameId);
            }

            std::set<std::string> vpip, pfr, faced, foldedPre;   // people, except foldedPre (accounts)
            bool raisedPre = false;
            std::string lastRaiser;
            for (const Action& a : hand.actions) {
                const std::string& k = person(a.playerId);
                StyleStats& r = rows[k];
                if (a.allIn) ++r.allIns;
                if (a.street == "preflop") {
                    if (a.kind == "call" || a.kind == "bet" || a.kind == "raise") vpip.insert(k);
                    if (raisedPre && lastRaiser != k && !faced.count(k) &&
                        (a.kind == "fold" || a.kind == "call" || a.kind == "raise")) {
                        faced.insert(k);
                        ++r.facedRaise;
                        if (a.kind == "fold") ++r.foldedToRaise;
                    }
                    if (a.kind == "raise") { pfr.insert(k); raisedPre = true; lastRaiser = k; }
                    if (a.kind == "fold") foldedPre.insert(a.playerId);
                } else {
                    if (a.kind == "bet") ++r.bets;
                    else if (a.kind == "raise") ++r.raises;
                    else if (a.kind == "call") ++r.calls;
                }
            }
            for (const std::string& k : vpip) ++rows[k].vpip;
            for (const std::string& k : pfr) ++rows[k].pfr;
            if (hand.board.size() >= 3) {
                std::set<std::string> sawFlop;
                for (const Seat& s : hand.seats) if (!foldedPre.count(s.playerId)) sawFlop.insert(person(s.playerId));
                for (const std::string& k : sawFlop) ++rows[k].sawFlop;
            }
            std::set<std::string> atShowdown, showdownWinners;
            for (const auto& s : hand.shown) atShowdown.insert(person(s.first));
            for (const auto& r : hand.rank) { atShowdown.insert(person(r.first)); showdownWinners.insert(person(r.first)); }
            for (const std::string& k : atShowdown) {
                ++rows[k].showdowns;
                if (showdownWinners.count(k)) ++rows[k].showdownWins;
            }
            std::map<std::string, double> collected;
            for (const auto& c : hand.collected) collected[person(c.first)] += c.second;
            for (const auto& c : collected) {
                StyleStats& r = rows[c.first];
                if (c.second > EPSILON) ++r.handsWon;
                r.wonTotal += c.second;
                r.biggestPotWon = std::max(r.biggestPotWon, c.second);
            }
            for (const auto& n : hand.net) rows[person(n.first)].netFromLog += n.second;
            for (const auto& b : hand.bounty) rows[person(b.first)].bountiesNet += b.second;
        }
    }

    std::vector<StyleStats> out;
    for (auto& pair : rows) {
        pair.second.games = static_cast<int>(gamesOf[pair.first].size());
        out.push_back(pair.second);
    }
    std::sort(out.begin(), out.end(), [](const StyleStats& a, const StyleStats& b) {
        if (a.hands != b.hands) return a.hands > b.hands;
        return a.displayName < b.displayName;
    });
    return out;
}

// ======================================================================
// Night series (running net per player, hand by hand)
// ======================================================================

std::vector<NightSeries> nightSeries(const HandLog& log,
                                     const players::MergeRules& rules,
                                     const std::map<std::string, PlayerStats>& ledgerStats) {
    std::map<std::string, size_t> index;                // person -> series
    std::vector<NightSeries> series;
    std::vector<double> running;
    std::vector<std::set<std::string>> accounts;
    const size_t n = log.hands.size();

    auto seriesOf = [&](const std::string& pid, std::int64_t at) -> size_t {
        Identity id = identify(log, pid, at, rules, ledgerStats);
        auto it = index.find(id.key);
        if (it == index.end()) {
            it = index.emplace(id.key, series.size()).first;
            NightSeries s;
            s.person = id.key;
            s.displayName = id.display;
            s.netByHand.assign(n, std::nan(""));
            series.push_back(std::move(s));
            running.push_back(0.0);
            accounts.emplace_back();
        }
        return it->second;
    };

    for (size_t h = 0; h < n; ++h) {
        const Hand& hand = log.hands[h];
        for (const auto& net : hand.net) running[seriesOf(net.first, hand.start)] += net.second;
        for (const Seat& s : hand.seats) {
            size_t i = seriesOf(s.playerId, hand.start);
            series[i].netByHand[h] = running[i];
            accounts[i].insert(s.nickname);
        }
    }
    for (size_t i = 0; i < series.size(); ++i) {
        series[i].finalNet = running[i];
        series[i].accounts.assign(accounts[i].begin(), accounts[i].end());
    }
    std::sort(series.begin(), series.end(), [](const NightSeries& a, const NightSeries& b) { return a.finalNet > b.finalNet; });
    return series;
}

// ======================================================================
// Output
// ======================================================================

std::string asciiCards(const std::string& cards) {
    std::string out;
    for (size_t i = 0; i < cards.size(); ++i) {
        unsigned char c = static_cast<unsigned char>(cards[i]);
        if (c == 0xE2 && i + 2 < cards.size() && static_cast<unsigned char>(cards[i + 1]) == 0x99) {
            unsigned char s = static_cast<unsigned char>(cards[i + 2]);
            out += s == 0xA0 ? 's' : s == 0xA5 ? 'h' : s == 0xA6 ? 'd' : s == 0xA3 ? 'c' : '?';
            i += 2;
        } else {
            out += cards[i];
        }
    }
    return out;
}

namespace {
std::string pct1(double v) {
    std::ostringstream o;
    o.setf(std::ios::fixed);
    o.precision(0);
    o << v << '%';
    return o.str();
}
std::string af1(double v) {
    if (v >= 99) return "inf";
    std::ostringstream o;
    o.setf(std::ios::fixed);
    o.precision(1);
    o << v;
    return o.str();
}
}  // namespace

void printStyleTable(const std::vector<StyleStats>& rows) {
    const int W = 128;
    if (rows.empty()) {
        std::cout << "No hand logs in scope. Put poker_now_log_<id>.csv files next to their ledgers (see README).\n";
        return;
    }
    std::cout << divider(W)
              << padRight("Player", 20) << padLeft("Games", 6) << padLeft("Hands", 7) << padLeft("VPIP", 7)
              << padLeft("PFR", 6) << padLeft("Flop", 6) << padLeft("WTSD", 6) << padLeft("W$SD", 6)
              << padLeft("FoldR", 7) << padLeft("AF", 6) << padLeft("Won", 5) << padLeft("Big pot", 10)
              << "  Style\n" << divider(W);
    for (const StyleStats& r : rows) {
        std::cout << padRight(r.displayName, 20) << padLeft(std::to_string(r.games), 6) << padLeft(std::to_string(r.hands), 7)
                  << padLeft(pct1(r.vpipPct()), 7) << padLeft(pct1(r.pfrPct()), 6) << padLeft(pct1(r.sawFlopPct()), 6)
                  << padLeft(pct1(r.wtsdPct()), 6) << padLeft(pct1(r.wsdPct()), 6) << padLeft(pct1(r.foldToRaisePct()), 7)
                  << padLeft(af1(r.aggression()), 6) << padLeft(std::to_string(r.handsWon), 5)
                  << padLeft(money(r.biggestPotWon), 10) << "  " << r.styleLabel() << '\n';
    }
    std::cout << divider(W)
              << "VPIP = % of hands where money went in voluntarily preflop.  PFR = % raised preflop.\n"
              << "Flop = % of hands that reached the flop.  WTSD = % of flops that went to showdown.  W$SD = % of showdowns won.\n"
              << "FoldR = % folded when facing a preflop raise.  AF = postflop (bets + raises) / calls.  Won = hands won.\n\n";
}

void printGameSummaries(const std::vector<const HandLog*>& logs) {
    if (logs.empty()) return;
    const int W = 128;
    std::cout << "Hand logs in scope:\n" << divider(W, '-')
              << padRight("Date", 12) << padRight("Folder", 26) << padLeft("Hands", 7) << padLeft("Hours", 7)
              << padLeft("Players", 9) << padLeft("Showdown", 10) << padLeft("Biggest pot", 13) << "  Won by (hand #)\n"
              << divider(W, '-');
    for (const HandLog* log : logs) {
        std::set<std::string> players;
        int showdowns = 0;
        for (const Hand& h : log->hands) {
            for (const Seat& s : h.seats) players.insert(s.playerId);
            if (h.showdown) ++showdowns;
        }
        double hours = (log->start == NO_TIME || log->end == NO_TIME) ? 0.0 : (log->end - log->start) / 3600.0;
        std::ostringstream hrs;
        hrs.setf(std::ios::fixed); hrs.precision(1); hrs << hours;
        auto nm = log->names.find(log->biggestPotWinner);
        std::string winner = nm == log->names.end() ? log->biggestPotWinner : nm->second;
        std::cout << padRight(formatLocalDate(log->start), 12) << padRight(log->folder, 26)
                  << padLeft(std::to_string(log->hands.size()), 7) << padLeft(hrs.str(), 7)
                  << padLeft(std::to_string(players.size()), 9)
                  << padLeft(pct1(log->hands.empty() ? 0.0 : 100.0 * showdowns / log->hands.size()), 10)
                  << padLeft(money(log->biggestPot), 13) << "  " << winner << " (#" << log->biggestPotHand << ")"
                  << (log->stackMismatches ? "  [" + std::to_string(log->stackMismatches) + " hands did not reconcile]" : "")
                  << '\n';
    }
    std::cout << divider(W, '-') << '\n';
}

bool exportStyleCSV(const std::string& filename, const std::vector<StyleStats>& rows) {
    std::ofstream out(filename);
    if (!out.is_open()) return false;
    out << "player,normalized,games,hands,vpip_pct,pfr_pct,saw_flop_pct,wtsd_pct,wsd_pct,fold_to_raise_pct,"
           "aggression,hands_won,biggest_pot_won,net_from_log,bounties_net,all_ins,style\n";
    for (const StyleStats& r : rows) {
        out << escapeCSV(r.displayName) << ',' << escapeCSV(r.normalizedName) << ',' << r.games << ',' << r.hands << ','
            << fixed2(r.vpipPct()) << ',' << fixed2(r.pfrPct()) << ',' << fixed2(r.sawFlopPct()) << ',' << fixed2(r.wtsdPct()) << ','
            << fixed2(r.wsdPct()) << ',' << fixed2(r.foldToRaisePct()) << ',' << fixed2(r.aggression()) << ',' << r.handsWon << ','
            << fixed2(r.biggestPotWon) << ',' << fixed2(r.netFromLog) << ',' << fixed2(r.bountiesNet) << ',' << r.allIns << ',' << escapeCSV(r.styleLabel()) << '\n';
    }
    return true;
}

}  // namespace handlog
