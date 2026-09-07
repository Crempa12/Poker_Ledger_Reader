#pragma once
// Small shared helpers: CSV parsing, string cleanup, money formatting, and date handling.
#include <cstdint>
#include <string>
#include <vector>

namespace util {

constexpr std::int64_t NO_TIME = -1;
constexpr double EPSILON = 0.009;  // anything under a cent counts as zero

std::vector<std::string> splitCSVLine(const std::string& line);
std::string trim(const std::string& s);
std::string lower(const std::string& s);
std::string normalizeName(const std::string& name);   // "Yaden ):" -> "yaden"
double centsToDollars(const std::string& s);          // ledger stores 2500 for $25.00
double toDoubleSafe(const std::string& s);
std::string escapeCSV(const std::string& s);
std::string escapeHTML(const std::string& s);
std::string fixed2(double v);                          // "12.34"
std::string money(double v);                           // "$12.34" / "-$12.34"
std::string moneySigned(double v);                     // "+$12.34" / "-$12.34"
std::string divider(int width = 100, char ch = '=');
std::string padRight(const std::string& s, size_t width);
std::string padLeft(const std::string& s, size_t width);

// Time helpers. Ledger timestamps are ISO-8601 in UTC ("2026-05-06T03:34:31.484Z").
std::int64_t parseISO8601UTC(const std::string& s);              // epoch seconds or NO_TIME
std::int64_t parseLocalDate(const std::string& s, bool endOfDay); // "2026-05-06" -> local midnight / 23:59:59
std::string formatLocalDate(std::int64_t epoch);                 // "2026-05-06"
std::string formatLocalDateTime(std::int64_t epoch);             // "2026-05-06 19:16"
std::string formatShortDate(std::int64_t epoch);                 // "May 6"
std::int64_t nowEpoch();

}  // namespace util
