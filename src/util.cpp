#include "util.hpp"

#include <cctype>
#include <chrono>
#include <cstdio>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <sstream>

namespace util {

std::vector<std::string> splitCSVLine(const std::string& line) {
    std::vector<std::string> result;
    std::string current;
    bool inQuotes = false;

    for (size_t i = 0; i < line.size(); ++i) {
        char c = line[i];
        if (c == '"') {
            if (inQuotes && i + 1 < line.size() && line[i + 1] == '"') {
                current += '"';
                ++i;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (c == ',' && !inQuotes) {
            result.push_back(current);
            current.clear();
        } else if (c != '\r') {
            current += c;
        }
    }
    result.push_back(current);
    return result;
}

bool readCSV(const std::string& filename, std::vector<std::vector<std::string>>& rows) {
    std::ifstream in(filename);
    if (!in.is_open()) return false;
    std::string line;
    bool header = true;
    while (std::getline(in, line)) {
        if (trim(line).empty()) continue;
        if (header) { header = false; continue; }
        rows.push_back(splitCSVLine(line));
    }
    return true;
}

std::string cleanStem(const std::string& stem) {
    size_t space = stem.find(' ');   // PokerNow ids never contain spaces
    return trim(space == std::string::npos ? stem : stem.substr(0, space));
}

bool isExcludedDir(const std::string& name) {
    return name == "Saved_Data" || name == ".git" || name == ".idea" || name == "build" ||
           name == "reports" || name.rfind("cmake-build", 0) == 0;
}

std::string trim(const std::string& s) {
    size_t start = 0;
    while (start < s.size() && std::isspace(static_cast<unsigned char>(s[start]))) ++start;
    size_t end = s.size();
    while (end > start && std::isspace(static_cast<unsigned char>(s[end - 1]))) --end;
    return s.substr(start, end - start);
}

std::string lower(const std::string& s) {
    std::string out = s;
    for (char& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return out;
}

std::string normalizeName(const std::string& name) {
    std::string letters, digits;
    for (char ch : name) {
        unsigned char c = static_cast<unsigned char>(ch);
        if (std::isalpha(c)) letters += static_cast<char>(std::tolower(c));
        else if (std::isdigit(c)) digits += ch;
    }
    // A name with no letters ("24242424242424") is still a name: fall back to its digits.
    return letters.empty() ? digits : letters;
}

double centsToDollars(const std::string& s) {
    std::string t = trim(s);
    if (t.empty()) return 0.0;
    try { return std::stod(t) / 100.0; } catch (...) { return 0.0; }
}

double toDoubleSafe(const std::string& s) {
    std::string t = trim(s);
    if (t.empty()) return 0.0;
    try { return std::stod(t); } catch (...) { return 0.0; }
}

std::string escapeCSV(const std::string& s) {
    if (s.find(',') == std::string::npos && s.find('"') == std::string::npos &&
        s.find('\n') == std::string::npos) {
        return s;
    }
    std::string escaped = "\"";
    for (char c : s) {
        if (c == '"') escaped += "\"\"";
        else escaped += c;
    }
    escaped += "\"";
    return escaped;
}

std::string escapeHTML(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        switch (c) {
            case '&': out += "&amp;"; break;
            case '<': out += "&lt;"; break;
            case '>': out += "&gt;"; break;
            case '"': out += "&quot;"; break;
            case '\'': out += "&#39;"; break;
            default: out += c;
        }
    }
    return out;
}

std::string fixed2(double v) {
    std::ostringstream oss;
    oss << std::fixed << std::setprecision(2) << v;
    return oss.str();
}

// "1234.5" -> "1,234.50" (always positive).
static std::string grouped(double v) {
    std::string digits = fixed2(v);
    size_t dot = digits.find('.');
    for (int i = static_cast<int>(dot) - 3; i > 0; i -= 3) digits.insert(static_cast<size_t>(i), ",");
    return digits;
}

std::string money(double v) {
    if (v < 0 && v > -0.005) v = 0.0;  // avoid "-$0.00"
    return (v < 0 ? "-$" : "$") + grouped(v < 0 ? -v : v);
}

std::string moneySigned(double v) {
    if (v > -0.005 && v < 0.005) return "$0.00";
    return (v < 0 ? "-$" : "+$") + grouped(v < 0 ? -v : v);
}

bool asciiOnly = false;

std::string divider(int width, char ch) {
    if (asciiOnly) return std::string(width, ch) + "\n";
    std::string line;   // the fancy display draws a faint box line instead: ═ for '=', ─ for anything else
    for (int i = 0; i < width; ++i) line += ch == '=' ? "\xE2\x95\x90" : "\xE2\x94\x80";
    return "\x1b[2m" + line + "\x1b[0m\n";
}

namespace {
// Reads one UTF-8 code point starting at s[i]; returns its byte length (1 for anything malformed).
size_t decode(const std::string& s, size_t i, std::uint32_t& cp) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    size_t len = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 1;
    if (i + len > s.size()) len = 1;
    cp = len == 1 ? c : c & (0x7F >> len);
    for (size_t k = 1; k < len; ++k) cp = (cp << 6) | (static_cast<unsigned char>(s[i + k]) & 0x3F);
    return len;
}

// Length of an ANSI color sequence ("\x1b[32m") at s[i], or 0 if there is none.
size_t escapeAt(const std::string& s, size_t i) {
    if (s[i] != '\x1b' || i + 1 >= s.size() || s[i + 1] != '[') return 0;
    size_t j = i + 2;
    while (j < s.size() && (s[j] < 0x40 || s[j] > 0x7E)) ++j;
    return j < s.size() ? j - i + 1 : 0;
}

int columnsOf(std::uint32_t cp) {
    if ((cp >= 0x300 && cp <= 0x36F) || (cp >= 0x200B && cp <= 0x200F) || (cp >= 0xFE00 && cp <= 0xFE0F) ||
        (cp >= 0x20D0 && cp <= 0x20FF)) return 0;   // combining marks, zero-width, emoji variation selectors
    if ((cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7A3) ||
        (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) ||
        (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1FAFF) || (cp >= 0x20000 && cp <= 0x3FFFD))
        return 2;                                   // East Asian wide and emoji
    return 1;
}

// The first `width` columns of s, ending in an ellipsis because something was cut.
std::string cut(const std::string& s, size_t width) {
    std::string out;
    size_t used = 0;
    bool colored = false;
    const size_t room = width == 0 ? 0 : width - 1;   // one column for the ellipsis
    for (size_t i = 0; i < s.size();) {
        if (size_t esc = escapeAt(s, i)) { out += s.substr(i, esc); colored = true; i += esc; continue; }
        std::uint32_t cp;
        size_t len = decode(s, i, cp);
        size_t w = static_cast<size_t>(columnsOf(cp));
        if (used + w > room) break;
        out += s.substr(i, len);
        used += w;
        i += len;
    }
    if (width > 0) out += asciiOnly ? "." : "\xE2\x80\xA6";   // "…"
    if (colored) out += "\x1b[0m";
    return out + std::string(width > used + 1 ? width - used - 1 : 0, ' ');
}
}  // namespace

size_t displayWidth(const std::string& s) {
    size_t w = 0;
    for (size_t i = 0; i < s.size();) {
        if (size_t esc = escapeAt(s, i)) { i += esc; continue; }
        std::uint32_t cp;
        i += decode(s, i, cp);
        w += static_cast<size_t>(columnsOf(cp));
    }
    return w;
}

std::string padRight(const std::string& s, size_t width) {
    size_t w = displayWidth(s);
    if (w > width) return cut(s, width);
    return s + std::string(width - w, ' ');
}

std::string padLeft(const std::string& s, size_t width) {
    size_t w = displayWidth(s);
    if (w >= width) return s;   // numbers are never cut
    return std::string(width - w, ' ') + s;
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

// ---------------- time ----------------

static std::tm toLocalTm(std::int64_t epoch) {
    std::time_t t = static_cast<std::time_t>(epoch);
    std::tm out{};
#ifdef _WIN32
    localtime_s(&out, &t);
#else
    localtime_r(&t, &out);
#endif
    return out;
}

std::int64_t parseISO8601UTC(const std::string& raw) {
    std::string s = trim(raw);
    if (s.size() < 19) return NO_TIME;
    int Y = 0, M = 0, D = 0, h = 0, m = 0, sec = 0;
    if (std::sscanf(s.c_str(), "%4d-%2d-%2dT%2d:%2d:%2d", &Y, &M, &D, &h, &m, &sec) != 6) {
        return NO_TIME;
    }
    std::tm t{};
    t.tm_year = Y - 1900;
    t.tm_mon = M - 1;
    t.tm_mday = D;
    t.tm_hour = h;
    t.tm_min = m;
    t.tm_sec = sec;
#ifdef _WIN32
    return static_cast<std::int64_t>(_mkgmtime(&t));
#else
    return static_cast<std::int64_t>(timegm(&t));
#endif
}

std::int64_t parseLocalDate(const std::string& raw, bool endOfDay) {
    std::string s = trim(raw);
    int Y = 0, M = 0, D = 0;
    if (std::sscanf(s.c_str(), "%d-%d-%d", &Y, &M, &D) != 3) {
        if (std::sscanf(s.c_str(), "%d/%d/%d", &M, &D, &Y) != 3) return NO_TIME;
        if (Y < 100) Y += 2000;
    }
    if (M < 1 || M > 12 || D < 1 || D > 31) return NO_TIME;
    std::tm t{};
    t.tm_year = Y - 1900;
    t.tm_mon = M - 1;
    t.tm_mday = D;
    t.tm_hour = endOfDay ? 23 : 0;
    t.tm_min = endOfDay ? 59 : 0;
    t.tm_sec = endOfDay ? 59 : 0;
    t.tm_isdst = -1;
    return static_cast<std::int64_t>(std::mktime(&t));
}

std::string formatLocalDate(std::int64_t epoch) {
    if (epoch == NO_TIME) return "unknown";
    std::tm t = toLocalTm(epoch);
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%d", &t);
    return buf;
}

std::string formatLocalDateTime(std::int64_t epoch) {
    if (epoch == NO_TIME) return "unknown";
    std::tm t = toLocalTm(epoch);
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M", &t);
    return buf;
}

std::string formatShortDate(std::int64_t epoch) {
    if (epoch == NO_TIME) return "?";
    std::tm t = toLocalTm(epoch);
    static const char* months[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                   "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
    return std::string(months[t.tm_mon]) + " " + std::to_string(t.tm_mday);
}

std::int64_t nowEpoch() {
    return static_cast<std::int64_t>(
        std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());
}

}  // namespace util
