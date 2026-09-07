#pragma once
// Finding and parsing ledger CSV files anywhere under the data root,
// including detection of duplicate or overlapping ledgers.
#include <filesystem>
#include <string>
#include <vector>

#include "models.hpp"

namespace ledger {

// A ledger that duplicates (or overlaps) another one.
struct DuplicateNote {
    std::string kind;          // "identical", "same-id", or "overlap"
    std::string path;          // the file in question
    std::string folder;
    std::string otherPath;     // the file it matches
    std::string otherFolder;
    bool sameFolder = false;
    bool skipped = false;      // true = not counted in any total
    int sharedRows = 0;        // for "overlap": sit-downs both files contain
};

struct LoadResult {
    std::vector<Game> games;               // de-duplicated, sorted by start time
    std::vector<std::string> messages;     // unreadable files etc.
    std::vector<DuplicateNote> duplicates;
};

// Recursively finds every CSV whose header contains "player_nickname".
// Skips Saved_Data, build folders, .git and .idea.
std::vector<std::filesystem::path> discoverLedgerFiles(const std::filesystem::path& root);

bool parseLedgerFile(const std::filesystem::path& file,
                     const std::filesystem::path& root,
                     Game& out,
                     std::string& error);

// Loads every ledger under root. Rules, in order:
//   identical content (any file name, any folder)  -> second copy skipped
//   same ledger id, different content              -> the less complete export skipped
//   different ids that share sit-down rows         -> both kept, flagged as "overlap"
LoadResult loadAllGames(const std::filesystem::path& root);

std::vector<std::string> listFolders(const std::vector<Game>& games);

// Games that match the folder / date-range scope, sorted by start time.
std::vector<const Game*> filterGames(const std::vector<Game>& games, const Scope& scope);

void printDuplicates(const std::vector<DuplicateNote>& duplicates);

}  // namespace ledger
