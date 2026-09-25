#pragma once
// Small shared helpers: CSV parsing, string cleanup, money formatting, and date handling.
#include <cstdint>
#include <string>
#include <vector>

namespace util {

constexpr std::int64_t NO_TIME = -1;
constexpr double EPSILON = 0.009;  // anything under a cent counts as zero

std::vector<std::string> splitCSVLine(const std::string& line);
// Every non-blank row of a Saved_Data CSV after its header. False if the file cannot be opened.
bool readCSV(const std::string& filename, std::vector<std::vector<std::string>>& rows);
// PokerNow file stem without a browser copy suffix: "ledger_pglX (1)" -> "ledger_pglX".
std::string cleanStem(const std::string& stem);
// Folders never searched for game files: Saved_Data, reports, build output, .git, .idea.
bool isExcludedDir(const std::string& folderName);
std::string trim(const std::string& s);
std::string lower(const std::string& s);
std::string normalizeName(const std::string& name);   // "Yaden ):" -> "yaden"; no letters: digits only ("2424")
double centsToDollars(const std::string& s);          // ledger stores 2500 for $25.00
double toDoubleSafe(const std::string& s);
std::string escapeCSV(const std::string& s);
std::string escapeHTML(const std::string& s);
std::string fixed2(double v);                          // "1234.56" (files)
std::string money(double v);                           // "$1,234.56" / "-$1,234.56" (screen)
std::string moneySigned(double v);                     // "+$1,234.56" / "-$1,234.56" (screen)
std::string divider(int width = 100, char ch = '=');
// Columns a string takes on screen: UTF-8 aware, color codes take none, emoji take two.
size_t displayWidth(const std::string& s);
// Pad (or cut, ending in an ellipsis) to exactly `width` screen columns. Color-safe.
std::string padRight(const std::string& s, size_t width);
std::string padLeft(const std::string& s, size_t width);
extern bool asciiOnly;                                 // set by ui::init: no Unicode symbols
std::vector<int> parseNumbers(const std::string& text);   // "3" / "2,5 7" -> {2,5,7}; anything else -> {}

// Time helpers. Ledger timestamps are ISO-8601 in UTC ("2026-05-06T03:34:31.484Z").
std::int64_t parseISO8601UTC(const std::string& s);              // epoch seconds or NO_TIME
std::int64_t parseLocalDate(const std::string& s, bool endOfDay); // "2026-05-06" -> local midnight / 23:59:59
std::string formatLocalDate(std::int64_t epoch);                 // "2026-05-06"
std::string formatLocalDateTime(std::int64_t epoch);             // "2026-05-06 19:16"
std::string formatShortDate(std::int64_t epoch);                 // "May 6"
std::int64_t nowEpoch();

}  // namespace util
