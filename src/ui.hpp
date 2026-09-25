#pragma once
// How the app looks in a terminal: colors, box lines, bars and trend lines.
// The "simple" display (menu 6, --plain, or the NO_COLOR variable) turns all of it into plain
// ASCII, for consoles that show the symbols as garbage and for tools that read the output.
#include <string>
#include <vector>

namespace ui {

void init(bool fancy);   // call once before any output, and again when the setting changes
bool fancy();

// Colors (plain text back in the simple display).
std::string bold(const std::string& s);
std::string dim(const std::string& s);
std::string green(const std::string& s);
std::string red(const std::string& s);
std::string yellow(const std::string& s);
std::string cyan(const std::string& s);

std::string net(double v);                              // "+$1,234.56" green, "-$12.00" red, "$0.00" dim
std::string sym(const char* fancy, const char* plain);  // a symbol, or its ASCII stand-in

// Lines and boxes, `width` columns wide.
std::string rule(int width);                                        // ────────
std::string heading(const std::string& title, int width);           // ── Title ─────
std::string box(const std::vector<std::string>& lines, int width);  // rounded box around the lines

// Charts.
std::string sparkline(const std::vector<double>& values);   // ▃▅▂▇ green up, red down; simple: "+-+"
std::string bar(double fraction, int width);                // █████ ; simple: #####

}  // namespace ui
