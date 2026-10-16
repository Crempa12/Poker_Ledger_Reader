// A snapshot: the whole site as one HTML file with the data inside it, read-only. It
// opens from the file on any phone or computer, with no server and no account, so it
// can be sent to the group (AirDrop, a message, a shared drive). It holds every game's
// results, the names, notes and PokerNow account ids, and the saved sheets and
// payments: share it only with people who may see them. Only the six Saved_Data files
// the app keeps go in (the console's own reports do not).
//
//   npm run snapshot            (PLR_DATA_ROOT and PLR_TZ as for the site)
//
// The site's own pages read the data from the file instead of the local server, and
// every button that changes something is hidden (see data.ts, "snapshot").
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";

import { looksLikeLedger } from "../../../packages/core/src/ledger.ts";
import { formatLocalDate } from "../../../packages/core/src/util.ts";
import { SAVED_DATA_FILES, loadDataRoot } from "../../../tools/load.ts";

const APP = fileURLToPath(new URL("..", import.meta.url)); // apps/web
export const SNAPSHOTS = fileURLToPath(new URL("../../../local/snapshots/", import.meta.url));
export const SNAPSHOT_NAME = /^poker-ledger-\d{4}-\d{2}-\d{2}\.html$/;

export interface SnapshotResult {
  file: string;
  name: string;
  bytes: number;
  games: number;
}

// Text safe to put inside a <script> element: "</script" cannot end it early.
function scriptSafe(text: string): string {
  return text.replace(/<\/(script)/gi, "<\\/$1");
}

// The saved files a page may see: the six the app keeps, "" when a file is missing.
export function savedForPage(saved: Record<string, string>): Record<string, string> {
  return Object.fromEntries(SAVED_DATA_FILES.map((name): [string, string] => [name, saved[name] ?? ""]));
}

export async function makeSnapshot(dataRoot: string, timeZone: string, outDir: string = SNAPSHOTS): Promise<SnapshotResult> {
  const work = await mkdtemp(join(tmpdir(), "plr-snapshot-"));
  try {
    await build({
      root: APP,
      configFile: false,
      logLevel: "warn",
      plugins: [react()],
      build: { outDir: work, emptyOutDir: true, assetsInlineLimit: 100_000_000, cssCodeSplit: false, modulePreload: false },
    });
    const built = await readFile(join(work, "index.html"), "utf8");

    const inputs = await loadDataRoot(dataRoot);
    const ledgers = inputs.games.filter((g) => looksLikeLedger(g.text));
    const now = Date.now();
    const payload = {
      source: "snapshot",
      dataRoot: basename(resolve(dataRoot)),
      timeZone,
      loadedAt: now,
      ledgers,
      logs: inputs.games.filter((g) => /(^|\/)poker_now_log_[^/]*\.csv$/i.test(g.relativePath)).map((g) => g.relativePath),
      saved: savedForPage(inputs.savedData),
      basis: "", // a snapshot never writes, so there is nothing to check a save against
      canWrite: false,
      consoleOpen: 0,
    };
    const data = `<script id="plr-data" type="application/json">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>`;

    // The data goes in first, before the last closing head tag of the built page (which
    // holds no bundle text yet). Then the bundle and the styles go inline: the tags are
    // found in the page as built, once, and replaced in one pass, so text inside the
    // bundle that looks like a tag is never taken for one.
    const head = built.lastIndexOf("</head>");
    if (head < 0) throw new Error("the built page has no head to hold the data");
    const page = built.slice(0, head) + `${data}\n` + built.slice(head);
    const TAG = /<script\b[^>]*\bsrc="\/(assets\/[^"]+)"[^>]*><\/script>|<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\/(assets\/[^"]+)"[^>]*>/g;
    const files = new Map<string, string>();
    for (const m of page.matchAll(TAG)) {
      const path = m[1] ?? m[2] ?? "";
      files.set(path, await readFile(join(work, path), "utf8"));
    }
    const html = page.replace(TAG, (_tag, script: string | undefined, style: string | undefined) =>
      script !== undefined
        ? `<script type="module">${scriptSafe(files.get(script) ?? "")}</script>`
        : `<style>${(files.get(style ?? "") ?? "").replace(/<\/(style)/gi, "<\\/$1")}</style>`,
    );
    if (files.size === 0 || /\b(src|href)="\/assets\//.test(page.replace(TAG, ""))) {
      throw new Error("the built page has a file the snapshot cannot take in");
    }

    await mkdir(outDir, { recursive: true });
    const name = `poker-ledger-${formatLocalDate(Math.floor(now / 1000), timeZone)}.html`;
    const file = join(outDir, name);
    // Written under a temporary name and renamed over the old file, so a snapshot that
    // was already sent is never half replaced.
    const temp = join(outDir, `.${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, html, "utf8");
      await rename(temp, file);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
    return { file, name, bytes: Buffer.byteLength(html), games: ledgers.length };
  } finally {
    // The build folder is only a step on the way: it goes whether or not the snapshot was made.
    await rm(work, { recursive: true, force: true });
  }
}

// npm run snapshot
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataRoot = resolve(process.env.PLR_DATA_ROOT ?? resolve(APP, "../../../Poker_Ledger_Reader"));
  const timeZone = process.env.PLR_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const r = await makeSnapshot(dataRoot, timeZone, process.env.PLR_SNAPSHOT_DIR ?? SNAPSHOTS);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r)); // for the site's "Make a snapshot" button (api.ts)
  } else {
    console.log(`Snapshot of ${r.games} ledgers written to ${r.file} (${Math.round(r.bytes / 1024)} KB).`);
    console.log("It holds everyone's results, names, notes and PokerNow account ids: share it only with people who may see them.");
  }
}
