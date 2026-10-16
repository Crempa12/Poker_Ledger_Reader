// Whether a folder is the console app's data folder. The site's saves (api.ts) and the snapshot
// (snapshot.ts) both check it first, so a mistyped PLR_DATA_ROOT is reported, not quietly read as
// a folder with no games.
import { constants, existsSync, lstatSync } from "node:fs";
import { access, lstat, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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

// canStart: the site may start a data folder there (see canStartDataRoot), so the text points to that too.
export function notADataFolder(root: string, canStart = false): string {
  return (
    `The data folder ${root} is not there, or holds no console app data (no Games or Saved_Data folder, no game files). ` +
    "Nothing was changed. If it is the console app's folder, run the console app once in it (it creates Saved_Data), " +
    "then press Refresh. If it is not, set PLR_DATA_ROOT to the console app's folder and restart the site." +
    (canStart ? " Not using the console app? Press Start a new data folder on the Overview." : "")
  );
}

// The folder the site reads when PLR_DATA_ROOT does not name one: the console app's folder next to this
// project (../Poker_Ledger_Reader) when it is there, else a data folder of the site's own inside this
// project (data/, which git ignores), for a group that does not use the console app.
// Anything at the console app's path counts, even a link to a drive that is not plugged in: then the site
// reads that path (and says it holds no data) rather than quietly starting a second data folder.
export function defaultDataRoot(webProject: string): string {
  const consoleApp = resolve(webProject, "..", "Poker_Ledger_Reader");
  let there: boolean;
  try {
    lstatSync(consoleApp);
    there = true;
  } catch {
    there = existsSync(consoleApp);
  }
  return there ? consoleApp : resolve(webProject, "data");
}

// Whether a new data folder may be started at root: it is not there yet but the folder it would go in is,
// or it is a folder (not a link) this server may write to, with nothing in it but the files a computer
// leaves in any folder (.DS_Store, desktop.ini). A folder with anything else in it is never taken over,
// and no folder above it is ever made (a mistyped PLR_DATA_ROOT is not built up). Never throws: GET
// /api/data asks it.
export async function canStartDataRoot(root: string): Promise<boolean> {
  let s;
  try {
    s = await lstat(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
    const parent = await stat(dirname(root)).catch(() => null);
    return parent !== null && parent.isDirectory() && (await access(dirname(root), constants.W_OK).then(() => true, () => false));
  }
  if (!s.isDirectory()) return false;
  if (!(await access(root, constants.W_OK).then(() => true, () => false))) return false;
  const names = await readdir(root).catch(() => null);
  return names !== null && names.every((n) => n === ".DS_Store" || n.toLowerCase() === "desktop.ini");
}

// Starts a data folder the console app would read: Games and Saved_Data, empty. The Saved_Data files are
// written by the first save that needs each one, as the console app writes them when it first quits.
// Only the folder itself is made, never one above it.
export async function startDataRoot(root: string): Promise<void> {
  await mkdir(root).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
  await mkdir(join(root, "Games"));
  await mkdir(join(root, "Saved_Data"));
}
