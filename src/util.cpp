#include "util.hpp"

#include <cctype>
#include <chrono>
#include <cstdio>
#include <ctime>
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
    std::string cleaned;
    for (char ch : name) {
        if (std::isalpha(static_cast<unsigned char>(ch))) {
            cleaned += static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
        }
    }
    return cleaned;
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

std::string money(double v) {
    if (v < 0 && v > -0.005) v = 0.0;  // avoid "-$0.00"
    return (v < 0 ? "-$" : "$") + fixed2(v < 0 ? -v : v);
}

std::string moneySigned(double v) {
    if (v > -0.005 && v < 0.005) return "$0.00";
    return (v < 0 ? "-$" : "+$") + fixed2(v < 0 ? -v : v);
}

std::string divider(int width, char ch) { return std::string(width, ch) + "\n"; }

std::string padRight(const std::string& s, size_t width) {
    if (s.size() >= width) return s.substr(0, width);
    return s + std::string(width - s.size(), ' ');
}

std::string padLeft(const std::string& s, size_t width) {
    if (s.size() >= width) return s;
    return std::string(width - s.size(), ' ') + s;
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
