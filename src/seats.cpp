#include "seats.hpp"

#include <algorithm>
#include <ctime>
#include <fstream>
#include <iostream>
#include <set>
#include <sstream>

#include "console.hpp"

using namespace util;

namespace seats {

namespace {

// Written back in the same shape PokerNow uses, so the file lines up with the ledger by eye.
std::string formatUTC(std::int64_t epoch) {
    if (epoch == NO_TIME) return "";
    std::time_t t = static_cast<std::time_t>(epoch);
    std::tm out{};
#ifdef _WIN32
    gmtime_s(&out, &t);
#else
    gmtime_r(&t, &out);
#endif
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &out);
    return buf;
}

bool matches(const SeatOwner& s, const Game& g, const LedgerRow& r) {
    return s.ledgerId == g.id && s.playerId == r.playerId && s.start == r.start &&
           normalizeName(s.nickname) == normalizeName(r.nickname);
}

std::string nicknamePerson(const players::MergeRules& rules, const LedgerRow& r) {
    return players::resolveCanonical(rules, normalizeName(r.nickname));
}

// A seat still open when the ledger was exported ran to the end of the game.
std::int64_t seatEnd(const Game& g, const LedgerRow& r) { return r.end != NO_TIME ? r.end : g.end; }

// Who normally uses each account: the person with the most seats on it, when
// that is at least 3 seats and more than half of them.
std::map<std::string, std::string> usualOwners(const std::vector<Game>& games, const players::MergeRules& rules) {
    std::map<std::string, std::map<std::string, int>> uses;
    for (const Game& g : games) {
        for (const LedgerRow& r : g.rows) {
            if (!r.playerId.empty()) uses[r.playerId][players::personOf(rules, r)]++;
        }
    }
    std::map<std::string, std::string> out;
    for (const auto& account : uses) {
        int total = 0, bestCount = 0;
        std::string best;
        for (const auto& person : account.second) {
            total += person.second;
            if (person.second > bestCount) { best = person.first; bestCount = person.second; }
        }
        if (bestCount >= 3 && bestCount * 2 > total) out[account.first] = best;
    }
    return out;
}

// Everyone who has played in any game, for picking owners and showing display names.
struct People {
    std::vector<PlayerStats> list;

    People(const std::vector<Game>& games, const players::MergeRules& rules) {
        std::vector<const Game*> all;
        for (const Game& g : games) all.push_back(&g);
        list = players::sortedByName(players::aggregate(all, rules));
    }
    std::string display(const std::string& normalized) const {
        for (const PlayerStats& p : list) if (p.normalizedName == normalized) return p.displayName;
        return normalized;
    }
    bool known(const std::string& normalized) const {
        for (const PlayerStats& p : list) if (p.normalizedName == normalized) return true;
        return false;
    }
};

void printSeatHeader() {
    std::cout << padRight("#", 4) << padRight("Nickname", 20) << padRight("Account", 12) << padRight("Sat down", 18)
              << padLeft("Buy-in", 10) << padLeft("Net", 11) << "  Counted for\n" << divider(96, '-');
}

void printSeat(size_t number, const LedgerRow& r, const People& people, const players::MergeRules& rules) {
    std::string counted = people.display(players::personOf(rules, r));
    if (!r.owner.empty()) counted += "  (reassigned)";
    std::cout << padRight(std::to_string(number), 4) << padRight(r.nickname, 20) << padRight(r.playerId, 12)
              << padRight(formatLocalDateTime(r.start), 18) << padLeft(money(r.buyIn), 10)
              << padLeft(moneySigned(r.net), 11) << "  " << counted << '\n';
}

void printGameHeader(const Game& g) {
    std::cout << '\n' << formatLocalDateTime(g.start) << "  " << g.folder << "  " << g.id << '\n';
}

struct OwnerChoice {
    enum Kind { Cancel, Skip, Nickname, Person } kind = Cancel;
    std::string person;   // for Person
};

// Asks whose money the seats were. `usual` is the account's usual owner ("" if none).
OwnerChoice askOwner(const People& people,
                     const players::MergeRules& rules,
                     const std::vector<const LedgerRow*>& seats,
                     const std::string& usual,
                     bool allowSkip) {
    std::set<std::string> nickPeople;
    for (const LedgerRow* r : seats) nickPeople.insert(nicknamePerson(rules, *r));
    bool offerUsual = !usual.empty() && !(nickPeople.size() == 1 && *nickPeople.begin() == usual);

    std::cout << "\nWhose money " << (seats.size() == 1 ? "was this seat" : "were these seats") << "?\n";
    if (nickPeople.size() == 1) {
        std::cout << "  1. " << people.display(*nickPeople.begin()) << " (the name on the seat is right)\n";
    } else {
        std::cout << "  1. Whoever each seat's name says (undo any reassignment)\n";
    }
    if (offerUsual) std::cout << "  2. " << people.display(usual) << " (who normally uses this account)\n";
    std::cout << "  3. Someone else\n";
    if (allowSkip) std::cout << "  4. Skip for now (ask again next time)\n";
    std::cout << "  0. " << (allowSkip ? "Stop reviewing" : "Cancel") << '\n';

    OwnerChoice out;
    while (true) {
        int pick = console::askMenuChoice("Choose: ", 0, allowSkip ? 4 : 3);
        if (pick == 0) return out;
        if (pick == 1) { out.kind = OwnerChoice::Nickname; return out; }
        if (pick == 2) {
            if (!offerUsual) { std::cout << "That option is not available here.\n"; continue; }
            out.kind = OwnerChoice::Person;
            out.person = usual;
            return out;
        }
        if (pick == 4) { out.kind = OwnerChoice::Skip; return out; }

        std::string typed = console::askLine("Type their name, or press Enter to pick from a list: ");
        std::string person;
        if (typed.empty()) {
            person = console::pickPlayer(people.list, "Whose money was it?");
        } else {
            person = players::resolveCanonical(rules, normalizeName(typed));
            if (person.empty()) { std::cout << "A name needs at least one letter.\n"; continue; }
            if (!people.known(person) &&
                console::askYesNo("Nobody called \"" + typed + "\" has played yet. Count it for a new player? (y/n): ") == 'n') {
                continue;
            }
        }
        if (person.empty()) continue;
        out.kind = OwnerChoice::Person;
        out.person = person;
        return out;
    }
}

// Saves the choice for each seat, replacing any earlier entry for it. Returns the money moved.
double assign(std::vector<SeatOwner>& list,
              const Game& g,
              const std::vector<const LedgerRow*>& seats,
              const OwnerChoice& choice,
              const players::MergeRules& rules) {
    double moved = 0.0;
    for (const LedgerRow* r : seats) {
        list.erase(std::remove_if(list.begin(), list.end(), [&](const SeatOwner& s) { return matches(s, g, *r); }),
                   list.end());
        SeatOwner s;
        s.ledgerId = g.id;
        s.playerId = r->playerId;
        s.start = r->start;
        s.nickname = r->nickname;
        if (choice.kind == OwnerChoice::Nickname) {
            s.owner = nicknamePerson(rules, *r);
            s.note = "checked: name was right";
        } else {
            s.owner = choice.person;
            s.note = s.owner == nicknamePerson(rules, *r) ? "checked: name was right"
                                                         : "bought under \"" + r->nickname + "\" on account " + r->playerId;
        }
        if (players::personOf(rules, *r) != players::resolveCanonical(rules, s.owner)) moved += r->net;
        list.push_back(s);
    }
    return moved;
}

void reportAssignment(const People& people,
                      const players::MergeRules& rules,
                      const std::vector<const LedgerRow*>& seats,
                      const OwnerChoice& choice,
                      double moved) {
    size_t n = seats.size();
    std::string what = std::to_string(n) + " seat" + (n == 1 ? "" : "s");
    if (choice.kind == OwnerChoice::Nickname) {
        std::cout << what << " now count for the name on the seat.\n";
    } else {
        std::cout << what << " now count for " << people.display(players::resolveCanonical(rules, choice.person)) << ".\n";
    }
    if (moved > EPSILON || moved < -EPSILON) {
        std::cout << "Their combined net of " << moneySigned(moved) << " changed hands. Rebuild any settlement sheet for that game (menu 5).\n";
    }
}

// Menu 20, option 1: walk through every flagged seat, one question per name + account + game.
bool review(std::vector<Game>& games, std::vector<SeatOwner>& list, const players::MergeRules& rules,
            const std::string& filename) {
    std::vector<Flag> flags = findSuspicious(games, rules);
    if (flags.empty()) { std::cout << "\nNothing looks shared. Every seat is either normal or already reviewed.\n"; return false; }
    People people(games, rules);

    // Seats with the same name on the same account in the same game get one answer. Newest game first.
    std::reverse(flags.begin(), flags.end());
    std::vector<std::vector<const Flag*>> groups;
    std::map<std::string, size_t> groupOf;
    for (const Flag& f : flags) {
        const LedgerRow& r = f.game->rows[f.row];
        std::string key = f.game->id + "|" + r.playerId + "|" + normalizeName(r.nickname);
        auto it = groupOf.find(key);
        if (it == groupOf.end()) {
            groupOf[key] = groups.size();
            groups.push_back({&f});
        } else {
            groups[it->second].push_back(&f);
        }
    }

    bool changed = false;
    for (size_t gi = 0; gi < groups.size(); ++gi) {
        const Game& g = *groups[gi].front()->game;
        // An earlier answer can explain this one too (the "same time" clash is gone), so check again.
        if (gi > 0) {
            bool stillFlagged = false;
            for (const Flag& now : findSuspicious(games, rules)) {
                for (const Flag* f : groups[gi]) if (now.game == f->game && now.row == f->row) stillFlagged = true;
            }
            if (!stillFlagged) continue;
        }
        std::vector<const LedgerRow*> seatRows;
        std::set<std::string> reasons;
        for (const Flag* f : groups[gi]) {
            const LedgerRow& r = g.rows[f->row];
            seatRows.push_back(&r);
            std::string person = people.display(nicknamePerson(rules, r));
            if (!f->usualOwner.empty()) {
                reasons.insert("account " + r.playerId + " is normally " + people.display(f->usualOwner) + "'s, not " + person + "'s");
            }
            for (const std::string& other : f->overlapAccounts) {
                std::string otherName;
                for (const LedgerRow& o : g.rows) if (o.playerId == other) otherName = o.nickname;
                reasons.insert(person + " was also sitting as \"" + otherName + "\" on account " + other + " at the same time");
            }
        }

        std::cout << '\n' << divider(96) << "Shared seat " << (gi + 1) << " of " << groups.size();
        printGameHeader(g);
        printSeatHeader();
        for (size_t i = 0; i < seatRows.size(); ++i) printSeat(i + 1, *seatRows[i], people, rules);
        for (const std::string& why : reasons) std::cout << "  Why: " << why << '\n';

        OwnerChoice choice = askOwner(people, rules, seatRows, groups[gi].front()->usualOwner, true);
        if (choice.kind == OwnerChoice::Cancel) break;
        if (choice.kind == OwnerChoice::Skip) continue;
        double moved = assign(list, g, seatRows, choice, rules);
        saveCSV(filename, list);
        apply(games, list, rules);
        reportAssignment(people, rules, seatRows, choice, moved);
        changed = true;
    }
    return changed;
}

std::vector<int> parseNumbers(const std::string& text) {
    std::vector<int> out;
    std::string cleaned = text;
    for (char& c : cleaned) if (c == ',') c = ' ';
    std::istringstream in(cleaned);
    std::string token;
    while (in >> token) {
        try { out.push_back(std::stoi(token)); } catch (...) { return {}; }
    }
    return out;
}

// Menu 20, option 2: pick a game, then any of its seats.
bool reassignInGame(std::vector<Game>& games, std::vector<SeatOwner>& list, const players::MergeRules& rules,
                    const std::string& filename) {
    if (games.empty()) return false;
    std::cout << '\n' << padRight("#", 5) << padRight("Date", 18) << padRight("Folder", 28) << padLeft("Seats", 6)
              << "  Ledger\n" << divider(96, '-');
    for (size_t i = 0; i < games.size(); ++i) {
        const Game& g = games[games.size() - 1 - i];   // newest first
        std::cout << padRight(std::to_string(i + 1), 5) << padRight(formatLocalDateTime(g.start), 18)
                  << padRight(g.folder, 28) << padLeft(std::to_string(g.rows.size()), 6) << "  " << g.id << '\n';
    }
    int pick = console::askMenuChoice("Game number (0 to cancel): ", 0, static_cast<int>(games.size()));
    if (pick == 0) return false;
    const Game& g = games[games.size() - pick];
    std::map<std::string, std::string> usual = usualOwners(games, rules);

    bool changed = false;
    while (true) {
        People people(games, rules);
        printGameHeader(g);
        printSeatHeader();
        for (size_t i = 0; i < g.rows.size(); ++i) printSeat(i + 1, g.rows[i], people, rules);

        std::string text = console::askLine("Seat numbers to reassign, e.g. 3 or 2,5,7 (Enter to go back): ");
        if (text.empty()) return changed;
        std::vector<int> numbers = parseNumbers(text);
        std::vector<const LedgerRow*> seatRows;
        bool bad = numbers.empty();
        for (int n : numbers) {
            if (n < 1 || n > static_cast<int>(g.rows.size())) { bad = true; break; }
            const LedgerRow* r = &g.rows[n - 1];
            if (std::find(seatRows.begin(), seatRows.end(), r) == seatRows.end()) seatRows.push_back(r);
        }
        if (bad) { std::cout << "Enter seat numbers from the list, separated by commas.\n"; continue; }

        std::string usualOwner;
        std::set<std::string> accounts;
        for (const LedgerRow* r : seatRows) accounts.insert(r->playerId);
        if (accounts.size() == 1 && usual.count(*accounts.begin())) usualOwner = usual[*accounts.begin()];

        OwnerChoice choice = askOwner(people, rules, seatRows, usualOwner, false);
        if (choice.kind == OwnerChoice::Cancel) continue;
        double moved = assign(list, g, seatRows, choice, rules);
        saveCSV(filename, list);
        apply(games, list, rules);
        reportAssignment(people, rules, seatRows, choice, moved);
        changed = true;
    }
}

// Menu 20, option 3: every saved entry, with a way to undo one.
bool listAndUndo(std::vector<Game>& games, std::vector<SeatOwner>& list, const players::MergeRules& rules,
                 const std::string& filename) {
    People people(games, rules);
    std::cout << "\nSaved seat owners\n" << divider(100);
    if (list.empty()) { std::cout << "  none\n" << divider(100); return false; }
    std::cout << padRight("#", 4) << padRight("Game", 12) << padRight("Nickname", 20) << padRight("Account", 12)
              << padLeft("Net", 11) << "  " << padRight("Counted for", 16) << "Note\n" << divider(100);
    for (size_t i = 0; i < list.size(); ++i) {
        const SeatOwner& s = list[i];
        std::string date = "(not loaded)";
        std::string net = "-";
        for (const Game& g : games) {
            if (g.id != s.ledgerId) continue;
            date = formatLocalDate(g.start);
            for (const LedgerRow& r : g.rows) if (matches(s, g, r)) net = moneySigned(r.net);
        }
        std::cout << padRight(std::to_string(i + 1), 4) << padRight(date, 12) << padRight(s.nickname, 20)
                  << padRight(s.playerId, 12) << padLeft(net, 11) << "  "
                  << padRight(people.display(players::resolveCanonical(rules, s.owner)), 16) << s.note << '\n';
    }
    std::cout << divider(100);
    int idx = console::askMenuChoice("Number to undo, so the seat counts for its nickname again (0 = back): ", 0,
                                     static_cast<int>(list.size()));
    if (idx == 0) return false;
    std::cout << "Undone: \"" << list[idx - 1].nickname << "\" in " << list[idx - 1].ledgerId << ".\n";
    list.erase(list.begin() + (idx - 1));
    saveCSV(filename, list);
    apply(games, list, rules);
    return true;
}

}  // namespace

bool loadCSV(const std::string& filename, std::vector<SeatOwner>& list) {
    std::ifstream in(filename);
    if (!in.is_open()) return false;
    std::string line;
    bool first = true;
    while (std::getline(in, line)) {
        if (trim(line).empty()) continue;
        if (first) { first = false; continue; }
        std::vector<std::string> row = splitCSVLine(line);
        if (row.size() < 5) continue;
        SeatOwner s;
        s.ledgerId = trim(row[0]);
        s.playerId = trim(row[1]);
        s.start = parseISO8601UTC(row[2]);
        s.nickname = trim(row[3]);
        s.owner = normalizeName(row[4]);
        s.note = row.size() > 5 ? trim(row[5]) : "";
        if (s.ledgerId.empty() || s.owner.empty()) continue;
        list.push_back(s);
    }
    return true;
}

bool saveCSV(const std::string& filename, const std::vector<SeatOwner>& list) {
    std::ofstream out(filename);
    if (!out.is_open()) return false;
    out << "ledger_id,player_id,session_start_at,nickname,owner_normalized,note\n";
    for (const SeatOwner& s : list) {
        out << escapeCSV(s.ledgerId) << ',' << escapeCSV(s.playerId) << ',' << formatUTC(s.start) << ','
            << escapeCSV(s.nickname) << ',' << escapeCSV(s.owner) << ',' << escapeCSV(s.note) << '\n';
    }
    return true;
}

int apply(std::vector<Game>& games, const std::vector<SeatOwner>& list, const players::MergeRules& rules) {
    std::vector<bool> used(list.size(), false);
    for (Game& g : games) {
        for (LedgerRow& r : g.rows) {
            r.owner.clear();
            r.ownerReviewed = false;
            for (size_t i = 0; i < list.size(); ++i) {
                if (!matches(list[i], g, r)) continue;
                used[i] = true;
                r.ownerReviewed = true;
                // A seat confirmed as the nickname's own stays an ordinary seat.
                if (players::resolveCanonical(rules, list[i].owner) != nicknamePerson(rules, r)) r.owner = list[i].owner;
            }
        }
    }
    return static_cast<int>(std::count(used.begin(), used.end(), false));
}

std::vector<Flag> findSuspicious(const std::vector<Game>& games, const players::MergeRules& rules) {
    std::map<std::string, std::string> usual = usualOwners(games, rules);
    std::vector<Flag> out;
    for (const Game& g : games) {
        for (size_t i = 0; i < g.rows.size(); ++i) {
            const LedgerRow& r = g.rows[i];
            if (r.ownerReviewed) continue;
            std::string person = players::personOf(rules, r);

            Flag f;
            f.game = &g;
            f.row = i;
            auto u = usual.find(r.playerId);
            if (u != usual.end() && u->second != person) f.usualOwner = u->second;

            // One person cannot sit in two seats at once, so one of them was someone else.
            if (r.start != NO_TIME) {
                std::set<std::string> others;
                for (const LedgerRow& o : g.rows) {
                    if (&o == &r || o.playerId == r.playerId || o.start == NO_TIME) continue;
                    if (players::personOf(rules, o) != person) continue;
                    if (r.start < seatEnd(g, o) && o.start < seatEnd(g, r)) others.insert(o.playerId);
                }
                f.overlapAccounts.assign(others.begin(), others.end());
            }
            if (!f.usualOwner.empty() || !f.overlapAccounts.empty()) out.push_back(f);
        }
    }
    return out;
}

bool manage(std::vector<Game>& games,
            std::vector<SeatOwner>& list,
            const players::MergeRules& rules,
            const std::string& filename) {
    bool changed = false;
    while (true) {
        apply(games, list, rules);
        size_t flagged = findSuspicious(games, rules).size();
        size_t reassigned = 0;
        for (const Game& g : games) for (const LedgerRow& r : g.rows) if (!r.owner.empty()) ++reassigned;

        std::cout << "\nBuy-ins under someone else's name or account\n" << divider(90)
                  << "PokerNow credits a seat to the name and account it was bought on. When someone\n"
                  << "plays on a friend's account, or under a friend's name, hand the seat to the person\n"
                  << "whose money it was. Totals, settlement sheets, charts and hand-log stats follow.\n"
                  << "If one seat mixed two people's money, give it to one of them here and move the\n"
                  << "other person's share with an adjustment (menu 17).\n"
                  << divider(90, '-')
                  << "1. Review seats that look shared (" << flagged << " to check)\n"
                  << "2. Reassign any seat in a game\n"
                  << "3. List saved seat owners / undo one (" << list.size() << " saved, " << reassigned
                  << " seat" << (reassigned == 1 ? "" : "s") << " reassigned)\n"
                  << "0. Back\n";
        int choice = console::askMenuChoice("Choose: ", 0, 3);
        if (choice == 0) return changed;
        if (choice == 1 && review(games, list, rules, filename)) changed = true;
        if (choice == 2 && reassignInGame(games, list, rules, filename)) changed = true;
        if (choice == 3 && listAndUndo(games, list, rules, filename)) changed = true;
    }
}

}  // namespace seats
