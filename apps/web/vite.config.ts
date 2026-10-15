// Local mode: the website runs on this computer and reads the console app's data
// folder (Games/ and Saved_Data/) on every page load, so it always shows what the
// console app shows. It writes only when you add a game (server/api.ts says how).
// It listens on this computer only, unless PLR_LAN=1 is set, which lets phones on
// the same Wi-Fi open it too (adding games still works only on this computer).
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { apiMiddleware } from "./server/api.ts";

const dataRoot = resolve(process.env.PLR_DATA_ROOT ?? resolve(import.meta.dirname, "../../../Poker_Ledger_Reader"));
const timeZone = process.env.PLR_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

function localData(): Plugin {
  return {
    name: "plr-local-data",
    configureServer(server) {
      server.middlewares.use(apiMiddleware({ dataRoot, timeZone }));
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
