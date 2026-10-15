// Local mode: the website runs on this computer and reads the console app's data
// folder (Games/ and Saved_Data/) on every page load, so it always shows what the
// console app shows. It only reads; the console app stays the place to add games and
// record payments. It listens on this computer only, unless PLR_LAN=1 is set, which
// lets phones on the same Wi-Fi open it too.
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { looksLikeLedger } from "../../packages/core/src/ledger.ts";
import { loadDataRoot } from "../../tools/load.ts";

const dataRoot = resolve(process.env.PLR_DATA_ROOT ?? resolve(import.meta.dirname, "../../../Poker_Ledger_Reader"));
const timeZone = process.env.PLR_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

function localData(): Plugin {
  return {
    name: "plr-local-data",
    configureServer(server) {
      server.middlewares.use("/api/data", (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end();
          return;
        }
        loadDataRoot(dataRoot)
          .then((inputs) => {
            // Hand logs are large and not used yet; only ledgers go to the page.
            const ledgers = inputs.games.filter((g) => looksLikeLedger(g.text));
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ source: "local", dataRoot, timeZone, loadedAt: Date.now(), ledgers, saved: inputs.savedData }));
          })
          .catch((err: unknown) => {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: String(err) }));
          });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localData()],
  server: {
    host: process.env.PLR_LAN === "1" ? true : "127.0.0.1",
    port: 5173,
    open: process.env.PLR_NO_OPEN !== "1",
  },
});
