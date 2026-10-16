// A snapshot: the whole site as one HTML file with the data inside it, read-only. It
// opens from the file on any phone or computer, with no server and no account, so it
// can be sent to the group (AirDrop, a message, a shared drive). It holds every game's
// results and the saved names and sheets: share it only with people who may see them.
//
//   npm run snapshot            (PLR_DATA_ROOT and PLR_TZ as for the site)
//
// The site's own pages read the data from the file instead of the local server, and
// every button that changes something is hidden (see data.ts, "snapshot").
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";

import { looksLikeLedger } from "../../../packages/core/src/ledger.ts";
import { formatLocalDate } from "../../../packages/core/src/util.ts";
import { loadDataRoot } from "../../../tools/load.ts";

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

export async function makeSnapshot(dataRoot: string, timeZone: string, outDir: string = SNAPSHOTS): Promise<SnapshotResult> {
  const work = await mkdtemp(join(tmpdir(), "plr-snapshot-"));
  await build({
    root: APP,
    configFile: false,
    logLevel: "warn",
    plugins: [react()],
    build: { outDir: work, emptyOutDir: true, assetsInlineLimit: 100_000_000, cssCodeSplit: false, modulePreload: false },
  });

  // One file: the bundle and the styles go inline. The tags are found in the page as
  // built, once, and replaced in one pass, so text inside the bundle that looks like
  // a tag is never taken for one.
  const built = await readFile(join(work, "index.html"), "utf8");
  const TAG = /<script\b[^>]*\bsrc="\/(assets\/[^"]+)"[^>]*><\/script>|<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\/(assets\/[^"]+)"[^>]*>/g;
  const files = new Map<string, string>();
  for (const m of built.matchAll(TAG)) {
    const path = m[1] ?? m[2] ?? "";
    files.set(path, await readFile(join(work, path), "utf8"));
  }
  let html = built.replace(TAG, (_tag, script: string | undefined, style: string | undefined) =>
    script !== undefined
      ? `<script type="module">${scriptSafe(files.get(script) ?? "")}</script>`
      : `<style>${(files.get(style ?? "") ?? "").replace(/<\/(style)/gi, "<\\/$1")}</style>`,
  );
  if (files.size === 0 || /\b(src|href)="\/assets\//.test(built.replace(TAG, ""))) throw new Error("the built page has a file the snapshot cannot take in");

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
    saved: inputs.savedData,
    canWrite: false,
    consoleOpen: 0,
  };
  const data = `<script id="plr-data" type="application/json">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>`;
  html = html.replace("</head>", () => `${data}\n</head>`);

  await mkdir(outDir, { recursive: true });
  const name = `poker-ledger-${formatLocalDate(Math.floor(now / 1000), timeZone)}.html`;
  const file = join(outDir, name);
  await writeFile(file, html, "utf8");
  return { file, name, bytes: Buffer.byteLength(html), games: ledgers.length };
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
    console.log("It holds everyone's results: share it only with people who may see them.");
  }
}
