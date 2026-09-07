#pragma once
// Finding and parsing ledger CSV files anywhere under the data root.
#include <filesystem>
#include <string>
#include <vector>

#include "models.hpp"

namespace ledger {

// Recursively finds every CSV whose header contains "player_nickname".
// Skips Saved_Data, build folders, .git and .idea.
std::vector<std::filesystem::path> discoverLedgerFiles(const std::filesystem::path& root);

bool parseLedgerFile(const std::filesystem::path& file,
                     const std::filesystem::path& root,
                     Game& out,
                     std::string& error);

// Loads every ledger under root, de-duplicated by game id. Messages collect
// warnings (unreadable files, duplicates) for the caller to print.
std::vector<Game> loadAllGames(const std::filesystem::path& root, std::vector<std::string>& messages);

std::vector<std::string> listFolders(const std::vector<Game>& games);

// Games that match the folder / date-range scope, sorted by start time.
std::vector<const Game*> filterGames(const std::vector<Game>& games, const Scope& scope);

}  // namespace ledger
