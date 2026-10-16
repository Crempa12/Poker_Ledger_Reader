// Local mode: the website runs on this computer and reads the console app's data
// folder (Games/ and Saved_Data/) on every page load, so it always shows what the
// console app shows. It writes when you add a game, and when you save a sheet,
// record a payment or answer a name question (server/api.ts says how and when).
// It listens on this computer only, unless PLR_LAN=1 is set, which lets phones on
// the same Wi-Fi open it too (changing anything still works only on this computer).
//
// PLR_CONSOLE_CHECK=0 skips the "is the console app open?" check: only for a test
// server pointed (PLR_DATA_ROOT) at a scratch copy that no console app is using. Give
// such a server its own PLR_BACKUP_DIR too, so its backups never push out the real ones
// (local/backups/ keeps the newest 50 of each file).
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { apiMiddleware } from "./server/api.ts";

const dataRoot = resolve(process.env.PLR_DATA_ROOT ?? resolve(import.meta.dirname, "../../../Poker_Ledger_Reader"));
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
          backupDir: process.env.PLR_BACKUP_DIR, // a test server keeps its backups apart from the real ones
        }),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), localData()],
  server: {
    host: process.env.PLR_LAN === "1" ? true : "127.0.0.1",
    port: 5173,
    open: process.env.PLR_NO_OPEN !== "1",
    // No other site may read from this server or show it in a frame (the API checks
    // its own requests; this covers Vite's own files too).
    cors: false,
    headers: { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" },
    fs: {
      // local/ holds the Saved_Data backups, the snapshots and the real-data reference
      // runs: Vite's /@fs/ must never hand them out (a phone on the Wi-Fi could ask).
      // Setting deny replaces Vite's list, so its own entries are repeated here.
      deny: [".env", ".env.*", "*.{crt,pem,key,p12,pfx,cer,der}", ".npmrc", ".yarnrc.yml", "**/.git/**", `${LOCAL}/**`],
    },
  },
});
