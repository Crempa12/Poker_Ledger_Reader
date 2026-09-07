#pragma once
// Input helpers for the interactive menu.
#include <string>

namespace console {
char askYesNo(const std::string& prompt);
int askMenuChoice(const std::string& prompt, int minChoice, int maxChoice);
double askAmount(const std::string& prompt);
std::string askLine(const std::string& prompt);
void pause();
}
