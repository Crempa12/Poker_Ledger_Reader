// Local mode: the website runs on this computer and reads the console app's data
// folder (Games/ and Saved_Data/) on every page load, so it always shows what the
// console app shows. It writes when you add a game, and when you save a sheet,
// record a payment or answer a name question (server/api.ts says how and when).
// It listens on this computer only, unless PLR_LAN=1 is set, which lets phones on
// the same Wi-Fi open it too (changing anything still works only on this computer).
//
// PLR_CONSOLE_CHECK=0 skips the "is the console app open?" check: only for a test
// server pointed (PLR_DATA_ROOT) at a scratch copy that no console app is using.
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { apiMiddleware } from "./server/api.ts";

const dataRoot = resolve(process.env.PLR_DATA_ROOT ?? resolve(import.meta.dirname, "../../../Poker_Ledger_Reader"));
const timeZone = process.env.PLR_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const consoleCheck = process.env.PLR_CONSOLE_CHECK !== "0";

function localData(): Plugin {
  return {
    name: "plr-local-data",
    configureServer(server) {
      server.middlewares.use(apiMiddleware({ dataRoot, timeZone, consoleCheck }));
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
