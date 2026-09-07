#pragma once
// Who pays whom. Honors pinned payer->payee preferences and an optional banker.
#include <string>
#include <vector>

#include "models.hpp"

namespace settlement {

bool loadPreferencesCSV(const std::string& filename, std::vector<PaymentPreference>& prefs);
bool savePreferencesCSV(const std::string& filename, const std::vector<PaymentPreference>& prefs);
bool loadSettingsCSV(const std::string& filename, Settings& settings);
bool saveSettingsCSV(const std::string& filename, const Settings& settings);

// Order of operations:
//   1. banker mode (if set): every loser pays the banker, the banker pays every winner.
//   2. preferences, in file order: payer sends to payee as long as both have room.
//   3. greedy largest-debt -> largest-credit matching for whatever is left.
std::vector<SettlementEntry> calculate(const std::vector<PlayerStats>& players,
                                       const std::vector<PaymentPreference>& prefs,
                                       const std::string& bankerNormalized);

void print(const std::vector<SettlementEntry>& entries);
bool exportCSV(const std::string& filename, const std::vector<SettlementEntry>& entries);

// Interactive editor for preferences / banker / "me". Saves after every change.
void managePreferences(std::vector<PaymentPreference>& prefs,
                       Settings& settings,
                       const std::vector<PlayerStats>& players,
                       const std::string& prefsFile,
                       const std::string& settingsFile);

}  // namespace settlement
