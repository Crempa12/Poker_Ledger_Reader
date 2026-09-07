#pragma once
// Input helpers for the interactive menu.
#include <string>
#include <vector>

#include "models.hpp"

namespace console {
char askYesNo(const std::string& prompt);
int askMenuChoice(const std::string& prompt, int minChoice, int maxChoice);
double askAmount(const std::string& prompt);          // >= 0
double askSignedAmount(const std::string& prompt);    // any sign
std::string askLine(const std::string& prompt);
// Numbered list of players; returns the normalized name or "" if cancelled.
std::string pickPlayer(const std::vector<PlayerStats>& players, const std::string& prompt);
void pause();
}
