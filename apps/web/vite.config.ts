// Local mode: the website runs on this computer and reads the console app's data
// folder (Games/ and Saved_Data/) on every page load, so it always shows what the
// console app shows. It writes when you add a game, and when you save a sheet,
// record a payment or answer a name question (server/api.ts says how and when).
// It listens on this computer only, unless started with --host (npm run web:phone, on any
// system) or PLR_LAN=1, which let phones on the same Wi-Fi open it too (changing anything
// still works only on this computer).
//
// PLR_CONSOLE_CHECK=0 skips the "is the console app open?" check: only for a test
// server pointed (PLR_DATA_ROOT) at a scratch copy that no console app is using. Its
// backups go to a folder of their own inside local/backups/ (one per data folder), so they
// never push out the real ones; PLR_BACKUP_DIR can still point them somewhere else.
import { join, resolve, sep } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { apiMiddleware } from "./server/api.ts";
import { defaultDataRoot } from "./server/dataroot.ts";
import { denyPatternFor } from "./server/fsdeny.ts";

// The console app's folder next to this project, or the site's own data/ folder (server/dataroot.ts). The
// site may start a data folder only in its own data/ or in a folder PLR_DATA_ROOT names: never in the
// console app's folder, even when that is missing for a while (a drive not plugged in).
const PROJECT = resolve(import.meta.dirname, "../..");
const dataRoot = resolve(process.env.PLR_DATA_ROOT ?? defaultDataRoot(PROJECT));
const startable = process.env.PLR_DATA_ROOT !== undefined || dataRoot === resolve(PROJECT, "data");
// When the data folder holds this project (PLR_DATA_ROOT names it or a folder above it), only its Games and
// Saved_Data folders are kept from Vite's /@fs/; denying the whole folder would refuse the site's own files.
const dataDeny =
  PROJECT === dataRoot || PROJECT.startsWith(dataRoot + sep)
    ? [denyPatternFor(join(dataRoot, "Games")), denyPatternFor(join(dataRoot, "Saved_Data"))]
    : [denyPatternFor(dataRoot)];
const timeZone = process.env.PLR_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const consoleCheck = process.env.PLR_CONSOLE_CHECK !== "0";
const LOCAL = resolve(import.meta.dirname, "../../local");

function localData(): Plugin {
  return {
    name: "plr-local-data",
    configureServer(server) {
      if (!consoleCheck) {
        console.warn(
          "\n!!! PLR_CONSOLE_CHECK=0: the website does NOT check whether the console app is open.\n" +
            "    Saving here can then be undone when the console app quits. Use this only for a test\n" +
            "    server pointed at a scratch copy that no console app is using.\n",
        );
      }
      server.middlewares.use(
        apiMiddleware({
          dataRoot,
          timeZone,
          consoleCheck,
          snapshotDir: process.env.PLR_SNAPSHOT_DIR,
          downloadsDir: process.env.PLR_DOWNLOADS_DIR, // a test server looks in a made-up Downloads folder
          startable,
          backupDir: process.env.PLR_BACKUP_DIR, // a test server keeps its backups apart from the real ones
        }),
      );
    },
  };
}

// `vite --mode quiet` (npm run web:quiet) starts without opening a browser, as PLR_NO_OPEN=1 does; a
// command-line flag, so it works in cmd.exe on Windows too, which has no VAR=value prefix.
export default defineConfig(({ mode }) => ({
  plugins: [react(), localData()],
  server: {
    host: process.env.PLR_LAN === "1" ? true : "127.0.0.1",
    port: 5173,
    open: process.env.PLR_NO_OPEN !== "1" && mode !== "quiet",
    // No other site may read from this server or show it in a frame (the API checks
    // its own requests; this covers Vite's own files too).
    cors: false,
    headers: { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" },
    fs: {
      // local/ holds the Saved_Data backups, the snapshots and the real-data reference
      // runs: Vite's /@fs/ must never hand them out (a phone on the Wi-Fi could ask).
      // Setting deny replaces Vite's list, so its own entries are repeated here.
      // The data folder too: the site's own data/ is inside this project, where /@fs/ could reach it.
      deny: [".env", ".env.*", "*.{crt,pem,key,p12,pfx,cer,der}", ".npmrc", ".yarnrc.yml", "**/.git/**", denyPatternFor(LOCAL), ...dataDeny],
    },
  },
}));
