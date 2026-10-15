import { useCallback, useEffect, useMemo, useState } from "react";
import { ledger } from "@plr/core";

import { buildCtx, type Ctx } from "./context.ts";
import { EVERYTHING, loadData, readSavedScope, saveScope, type Loaded, type ScopeChoice } from "./data.ts";
import { clockTime, plural, shortDate } from "./format.ts";
import { href, useRoute } from "./router.ts";
import { Check, checkCount } from "./pages/Check.tsx";
import { GamePage } from "./pages/Game.tsx";
import { Games } from "./pages/Games.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Owed } from "./pages/Owed.tsx";
import { PlayerPage } from "./pages/Player.tsx";
import { Settle } from "./pages/Settle.tsx";

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; loaded: Loaded };

export function App() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [choice, setChoice] = useState<ScopeChoice>(readSavedScope);
  const route = useRoute();

  const refresh = useCallback(() => {
    loadData()
      .then((loaded) => setState({ status: "ready", loaded }))
      .catch((err: unknown) => setState({ status: "error", message: err instanceof Error ? err.message : String(err) }));
  }, []);
  useEffect(refresh, [refresh]);

  const ctx = useMemo(() => {
    if (state.status !== "ready") return null;
    const { payload, world } = state.loaded;
    // A saved folder that no longer exists falls back to every folder.
    const folders = ledger.listFolders(world.games);
    const safe = choice.folder === "" || folders.includes(choice.folder) ? choice : { ...choice, folder: "" };
    return buildCtx(payload, world, safe);
  }, [state, choice]);

  const changeScope = (next: ScopeChoice): void => {
    setChoice(next);
    saveScope(next);
  };

  if (state.status === "loading") return <Shell><p className="muted pad">Loading your games…</p></Shell>;
  if (state.status === "error" || ctx === null) {
    return (
      <Shell>
        <div className="card pad">
          <h2>Could not load the data</h2>
          <p>{state.status === "error" ? state.message : "Unknown problem."}</p>
          <p className="muted">Start the site with <code>npm run web</code> from the Poker_Ledger_Web folder, then reload this page.</p>
          <button onClick={refresh}>Try again</button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell ctx={ctx} onRefresh={refresh} route={route}>
      <ScopeBar ctx={ctx} onChange={changeScope} />
      <Page ctx={ctx} route={route} />
      <footer className="footer muted">
        Reading <code>{folderName(ctx.payload.dataRoot)}</code> on this computer · loaded {clockTime(Math.floor(ctx.payload.loadedAt / 1000), ctx.tz)} ·
        times in {ctx.tz}
      </footer>
    </Shell>
  );
}

function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function Page({ ctx, route }: { ctx: Ctx; route: string[] }) {
  const [first, second] = route;
  switch (first) {
    case undefined:
      return <Overview ctx={ctx} />;
    case "player":
      return <PlayerPage ctx={ctx} normalized={second ?? ""} />;
    case "games":
      return <Games ctx={ctx} />;
    case "game":
      return <GamePage ctx={ctx} id={second ?? ""} />;
    case "settle":
      return <Settle ctx={ctx} gameId={second ?? ""} />;
    case "owed":
      return <Owed ctx={ctx} />;
    case "check":
      return <Check ctx={ctx} />;
    default:
      return (
        <div className="card pad">
          <p>That page does not exist.</p>
          <a href={href()}>Back to the overview</a>
        </div>
      );
  }
}

const TABS: { path: string; label: string }[] = [
  { path: "", label: "Overview" },
  { path: "games", label: "Games" },
  { path: "settle", label: "Settle up" },
  { path: "owed", label: "Who owes" },
  { path: "check", label: "Checks" },
];

function Shell({ ctx, onRefresh, route, children }: { ctx?: Ctx; onRefresh?: () => void; route?: string[]; children: React.ReactNode }) {
  const active = route?.[0] === "player" ? "" : route?.[0] === "game" ? "games" : (route?.[0] ?? "");
  const checks = ctx === undefined ? 0 : checkCount(ctx);
  return (
    <div className="app">
      <header className="top">
        <a className="brand" href={href()}>
          <span aria-hidden="true">♠</span> Poker Ledger
        </a>
        {onRefresh !== undefined ? (
          <button className="ghost" onClick={onRefresh} title="Read the data folder again">
            Refresh
          </button>
        ) : null}
        {ctx !== undefined ? (
          <nav className="tabs" aria-label="Pages">
            {TABS.map((t) => (
              <a key={t.path} href={t.path === "" ? href() : href(t.path)} className={active === t.path ? "active" : ""}>
                {t.label}
                {t.path === "check" && checks > 0 ? <span className="badge">{checks}</span> : null}
              </a>
            ))}
          </nav>
        ) : null}
      </header>
      <main>{children}</main>
    </div>
  );
}

const PRESETS: { id: string; label: string; days: number | null }[] = [
  { id: "all", label: "All time", days: null },
  { id: "30", label: "Past 30 days", days: 30 },
  { id: "90", label: "Past 90 days", days: 90 },
];

function isoDay(epochMs: number, timeZone: string): string {
  // en-CA prints YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epochMs));
}

function ScopeBar({ ctx, onChange }: { ctx: Ctx; onChange: (c: ScopeChoice) => void }) {
  const { choice, view, world, tz } = ctx;
  const folders = ledger.listFolders(world.games);
  const preset =
    choice.from === "" && choice.to === ""
      ? "all"
      : PRESETS.find((p) => p.days !== null && choice.to === "" && choice.from === isoDay(Date.now() - p.days * 86400000, tz))?.id ?? "custom";
  const [custom, setCustom] = useState(preset === "custom");

  const pickPreset = (id: string): void => {
    if (id === "custom") {
      setCustom(true);
      return;
    }
    setCustom(false);
    const p = PRESETS.find((x) => x.id === id);
    onChange({ ...choice, from: p?.days == null ? "" : isoDay(Date.now() - p.days * 86400000, tz), to: "" });
  };

  const first = view.games[0];
  const last = view.games[view.games.length - 1];
  return (
    <section className="scopebar" aria-label="What to look at">
      <label>
        <span className="muted">Folder</span>
        <select value={choice.folder} onChange={(e) => onChange({ ...choice, folder: e.target.value })}>
          <option value="">All folders</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="muted">Dates</span>
        <select value={custom ? "custom" : preset} onChange={(e) => pickPreset(e.target.value)}>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom range…</option>
        </select>
      </label>
      {custom ? (
        <>
          <label>
            <span className="muted">From</span>
            <input type="date" value={choice.from} onChange={(e) => onChange({ ...choice, from: e.target.value })} />
          </label>
          <label>
            <span className="muted">To</span>
            <input type="date" value={choice.to} onChange={(e) => onChange({ ...choice, to: e.target.value })} />
          </label>
        </>
      ) : null}
      <p className="scopeinfo muted">
        {plural(view.games.length, "game")}
        {first !== undefined && last !== undefined ? ` · ${shortDate(first.start, tz)} – ${shortDate(last.start, tz)}` : ""}
        {choice.folder !== "" || choice.from !== "" || choice.to !== "" ? (
          <>
            {" · "}
            <button className="link" onClick={() => { setCustom(false); onChange(EVERYTHING); }}>
              show everything
            </button>
          </>
        ) : null}
      </p>
    </section>
  );
}
