#pragma once
// Manual corrections to player totals: forgiven debts, side payments, mistakes.
#include <string>
#include <vector>

#include "models.hpp"

namespace adjustments {

bool loadCSV(const std::string& filename, std::vector<Adjustment>& list);
bool saveCSV(const std::string& filename, const std::vector<Adjustment>& list);

// Adjustments that belong to the scope (same folder tag when a folder is chosen, date inside the range).
std::vector<const Adjustment*> filter(const std::vector<Adjustment>& list, const Scope& scope);

void printList(const std::vector<Adjustment>& list, const std::vector<PlayerStats>& players);

// Interactive editor. Saves after every change. Returns true if anything changed.
bool manage(std::vector<Adjustment>& list,
            const std::vector<PlayerStats>& players,
            const Scope& scope,
            const std::string& filename);

}  // namespace adjustments
