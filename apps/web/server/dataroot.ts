// Whether a folder is the console app's data folder. The site's saves (api.ts) and the snapshot
// (snapshot.ts) both check it first, so a mistyped PLR_DATA_ROOT is reported, not quietly read as
// a folder with no games.
import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

// The data folder must be there and hold the console app's data: a Games or Saved_Data folder, or
// CSV files directly in it. Anything else is refused before a file or folder is made, so a mistyped
// PLR_DATA_ROOT cannot collect saves in a folder the console app never reads.
export async function dataRootReady(root: string): Promise<boolean> {
  const s = await stat(root).catch(() => null);
  if (s === null || !s.isDirectory()) return false;
  if (existsSync(join(root, "Games")) || existsSync(join(root, "Saved_Data"))) return true;
  const names = await readdir(root).catch(() => [] as string[]);
  return names.some((n) => /\.csv$/i.test(n));
}

export function notADataFolder(root: string): string {
  return (
    `The data folder ${root} is not there, or holds no console app data (no Games or Saved_Data folder, no game files). ` +
    "Nothing was changed. If it is the console app's folder, run the console app once in it (it creates Saved_Data), " +
    "then press Refresh. If it is not, set PLR_DATA_ROOT to the console app's folder and restart the site."
  );
}

// The folder the site reads when PLR_DATA_ROOT does not name one: the console app's folder next to this
// project (../Poker_Ledger_Reader) when it is there, else a data folder of the site's own inside this
// project (data/, which git ignores), for a group that does not use the console app.
export function defaultDataRoot(webProject: string): string {
  const consoleApp = resolve(webProject, "..", "Poker_Ledger_Reader");
  return existsSync(consoleApp) ? consoleApp : resolve(webProject, "data");
}

// Whether a new data folder may be started at root: it is not there yet, or it is a folder with nothing
// in it but the files a computer leaves in any folder (.DS_Store, desktop.ini). A folder with anything
// else in it is never taken over.
export async function canStartDataRoot(root: string): Promise<boolean> {
  const s = await stat(root).catch(() => null);
  if (s === null) return true;
  if (!s.isDirectory()) return false;
  const names = await readdir(root).catch(() => null);
  return names !== null && names.every((n) => n === ".DS_Store" || n.toLowerCase() === "desktop.ini");
}

// Starts a data folder the console app would read: Games and Saved_Data, empty. The Saved_Data files are
// written by the first save that needs each one, as the console app writes them when it first quits.
export async function startDataRoot(root: string): Promise<void> {
  await mkdir(join(root, "Games"), { recursive: true });
  await mkdir(join(root, "Saved_Data"), { recursive: true });
}
