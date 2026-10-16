// Whether a folder is the console app's data folder. The site's saves (api.ts) and the snapshot
// (snapshot.ts) both check it first, so a mistyped PLR_DATA_ROOT is reported, not quietly read as
// a folder with no games.
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

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
