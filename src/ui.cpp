#include "ui.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>

#include "util.hpp"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#ifndef ENABLE_VIRTUAL_TERMINAL_PROCESSING
#define ENABLE_VIRTUAL_TERMINAL_PROCESSING 0x0004
#endif
#endif

namespace ui {

namespace {
bool gFancy = true;

std::string paint(const char* code, const std::string& s) {
    return gFancy ? std::string("\x1b[") + code + "m" + s + "\x1b[0m" : s;
}

std::string repeat(const std::string& piece, int times) {
    std::string out;
    for (int i = 0; i < times; ++i) out += piece;
    return out;
}
}  // namespace

void init(bool fancy) {
    if (std::getenv("NO_COLOR")) fancy = false;
    gFancy = fancy;
    util::asciiOnly = !fancy;
#ifdef _WIN32
    // Player names are UTF-8 either way; colors need the console's escape-code mode.
    SetConsoleOutputCP(CP_UTF8);
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD mode = 0;
    if (fancy && GetConsoleMode(out, &mode)) SetConsoleMode(out, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
#endif
}

bool fancy() { return gFancy; }

std::string bold(const std::string& s) { return paint("1", s); }
std::string dim(const std::string& s) { return paint("2", s); }
std::string green(const std::string& s) { return paint("32", s); }
std::string red(const std::string& s) { return paint("31", s); }
std::string yellow(const std::string& s) { return paint("33", s); }
std::string cyan(const std::string& s) { return paint("36", s); }

std::string net(double v) {
    std::string text = util::moneySigned(v);
    return v > 0.005 ? green(text) : v < -0.005 ? red(text) : dim(text);
}

std::string sym(const char* fancySymbol, const char* plain) { return gFancy ? fancySymbol : plain; }

std::string rule(int width) { return dim(repeat(sym("─", "-"), width)); }

std::string heading(const std::string& title, int width) {
    int rest = std::max(0, width - 4 - static_cast<int>(util::displayWidth(title)));
    return dim(repeat(sym("─", "-"), 2)) + " " + bold(title) + " " + dim(repeat(sym("─", "-"), rest));
}

std::string box(const std::vector<std::string>& lines, int width) {
    const std::string h = sym("─", "-"), v = dim(sym("│", "|"));
    std::string out = dim(sym("╭", "+") + repeat(h, width - 2) + sym("╮", "+")) + "\n";
    for (const std::string& line : lines) out += v + " " + util::padRight(line, width - 4) + " " + v + "\n";
    return out + dim(sym("╰", "+") + repeat(h, width - 2) + sym("╯", "+")) + "\n";
}

std::string sparkline(const std::vector<double>& values) {
    static const char* blocks[] = {"▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"};
    double top = 0.0;
    for (double v : values) top = std::max(top, std::fabs(v));
    std::string out;
    for (double v : values) {
        bool up = v > 0.005, down = v < -0.005;
        if (!gFancy) { out += up ? '+' : down ? '-' : '.'; continue; }
        if (!up && !down) { out += dim("·"); continue; }
        int level = static_cast<int>(std::lround(std::fabs(v) / top * 7.0));   // taller = bigger night
        out += up ? green(blocks[level]) : red(blocks[level]);
    }
    return out;
}

std::string bar(double fraction, int width) {
    int cells = static_cast<int>(std::lround(std::clamp(fraction, 0.0, 1.0) * width));
    return repeat(sym("█", "#"), cells);
}

}  // namespace ui
