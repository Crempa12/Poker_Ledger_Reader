#pragma once
// Tracks settlement sheets you have "locked in" as sessions and the payments made against them.
#include <string>
#include <unordered_map>
#include <vector>

#include "models.hpp"

namespace sessions {

using Balances = std::unordered_map<std::string, SessionBalance>;  // key: session|from->to

bool load(const std::string& filename, Balances& balances);
bool save(const std::string& filename, const Balances& balances);

void addSettlementBatch(const std::string& sessionId, const std::vector<SettlementEntry>& entries, Balances& balances);
void printBalances(const Balances& balances, bool openOnly);
void recordPayment(Balances& balances);
void printCombinedUnpaid(const Balances& balances);

}  // namespace sessions
