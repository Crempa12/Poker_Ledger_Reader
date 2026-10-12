// Reads a poker data root from disk into the inputs the core takes. Node only:
// packages/core never touches the disk. Follows main.cpp's locateData: game
// files are under Games/ when that folder exists, otherwise directly under the
// root. Saved_Data/ holds the settings CSVs.
//
// Prints counts only, never names or amounts, so the output is safe to paste.

import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LedgerInput } from "../packages/core/src/ledger.ts";
import { isExcludedDir } from "../packages/core/src/util.ts";

// The settings files the app reads from Saved_Data. A missing one reads as "".
export const SAVED_DATA_FILES = [
  "settings.csv",
  "merge_rules.csv",
  "payment_preferences.csv",
  "adjustments.csv",
  "seat_owners.csv",
  "session_balances.csv",
] as const;

export interface DataRootInputs {
  dataDir: string; // the folder the game files were read from (Games/ or the root)
  games: LedgerInput[]; // every .csv under dataDir, paths relative to it with "/" separators
  savedData: Record<string, string>; // text of each CSV in Saved_Data by file name; "" when missing
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// Collects every .csv under dir. Like the C++ walk: folders with excluded names
// are skipped, symlinked folders are not entered, symlinked files are read, and
// unreadable folders and files are skipped.
async function collectCsv(dir: string, prefix: string, out: LedgerInput[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      const target = await stat(full).catch(() => null);
      isDirectory = target?.isDirectory() ?? false;
      isFile = target?.isFile() ?? false;
      if (isDirectory) continue; // the C++ walk does not enter symlinked folders
    }

    if (isDirectory) {
      if (!isExcludedDir(entry.name)) await collectCsv(full, relativePath, out);
    } else if (isFile && /\.csv$/i.test(entry.name)) {
      const text = await readText(full);
      if (text !== null) out.push({ relativePath, text });
    }
  }
}

async function readSavedData(savedDir: string): Promise<Record<string, string>> {
  const saved: Record<string, string> = {};
  for (const name of SAVED_DATA_FILES) {
    saved[name] = (await readText(join(savedDir, name))) ?? "";
  }
  let entries;
  try {
    entries = await readdir(savedDir, { withFileTypes: true });
  } catch {
    return saved;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.csv$/i.test(entry.name) || entry.name in saved) continue;
    saved[entry.name] = (await readText(join(savedDir, entry.name))) ?? "";
  }
  return saved;
}

export async function loadDataRoot(root: string): Promise<DataRootInputs> {
  const gamesDir = join(root, "Games");
  const dataDir = existsSync(gamesDir) ? gamesDir : root;
  const games: LedgerInput[] = [];
  await collectCsv(dataDir, "", games);
  return {
    dataDir,
    games,
    savedData: await readSavedData(join(root, "Saved_Data")),
  };
}

async function main(argv: string[]): Promise<void> {
  const root = argv[2];
  if (root === undefined) {
    console.error("usage: node tools/load.ts <data-root>");
    process.exitCode = 1;
    return;
  }
  const inputs = await loadDataRoot(root);
  console.log(`CSV files under the game folder: ${inputs.games.length}`);
  console.log(`Saved_Data CSVs read: ${Object.keys(inputs.savedData).length}`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main(process.argv);
}
