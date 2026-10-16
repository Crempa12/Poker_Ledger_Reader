import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ledger } from "@plr/core";

import { buildCtx, type Ctx } from "./context.ts";
import { EVERYTHING, isSnapshot, loadData, readSavedScope, saveScope, type Loaded, type ScopeChoice } from "./data.ts";
import { clockTime, plural, shortDate } from "./format.ts";
import { href, useRoute } from "./router.ts";
import { Check, checkCount } from "./pages/Check.tsx";
import { GamePage } from "./pages/Game.tsx";
import { AddGame } from "./pages/AddGame.tsx";
import { Adjust } from "./pages/Adjust.tsx";
import { Games } from "./pages/Games.tsx";
import { Help } from "./pages/Help.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Owed } from "./pages/Owed.tsx";
import { PlayerPage } from "./pages/Player.tsx";
import { PlayStylePage } from "./pages/PlayStyle.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Settle } from "./pages/Settle.tsx";

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; loaded: Loaded };

export function App() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [choice, setChoice] = useState<ScopeChoice>(readSavedScope);
  const route = useRoute();

  // Each load gets a number. Only the newest load may set the page, so a load that started
  // earlier and finished later (after a save's own reload) cannot show older data.
  const latest = useRef(0);
  const refresh = useCallback(() => {
    const mine = latest.current + 1;
    latest.current = mine;
    loadData()
      .then((loaded) => {
        if (mine === latest.current) setState({ status: "ready", loaded });
      })
      .catch((err: unknown) => {
        if (mine === latest.current) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
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

  // The browser tab and the window's title follow the page, so the pages can be told apart.
  const routeKey = route.join("/");
  useEffect(() => {
    document.title = `${pageName(routeKey === "" ? [] : routeKey.split("/"))} · Poker Ledger`;
  }, [routeKey]);

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

  const snapshot = isSnapshot(ctx.payload);
  const taken = Math.floor(ctx.payload.loadedAt / 1000);
  return (
    <Shell ctx={ctx} onRefresh={snapshot ? undefined : refresh} route={route}>
      {snapshot ? (
        <p className="banner snapshot" role="status">
          A snapshot from {shortDate(taken, ctx.tz)} at {clockTime(taken, ctx.tz)}: the results up to then. It does not change; ask
          {ctx.me !== "" ? ` ${ctx.nameOf(ctx.me)}` : " whoever sent it"} for a new one after the next game.
        </p>
      ) : null}
      {ctx.payload.consoleOpen > 0 && ctx.payload.canWrite ? (
        <p className="banner" role="status">
          The console app is open. It saves its own copy of the names, sheets and settings when it quits, so the site will not save
          those until it is closed: quit it with <strong>0. Save and exit</strong>, then press Refresh. A new game can still be filed;
          the console app lists it after it restarts.
        </p>
      ) : ctx.payload.consoleOpen === -1 && ctx.payload.canWrite ? (
        <p className="banner" role="status">
          Could not tell whether the console app is open; saving will check again.
        </p>
      ) : null}
      <ScopeBar ctx={ctx} onChange={changeScope} />
      <PageBoundary key={route.join("/")}>
        {/* The pages that have no heading of their own still name themselves to a screen reader. */}
        {PAGES_WITH_OWN_HEADING.has(route[0] ?? "") ? null : <h1 className="sr-only">{pageName(route)}</h1>}
        <Page ctx={ctx} route={route} onSaved={refresh} />
      </PageBoundary>
      <footer className="footer muted">
        {snapshot ? (
          <>Snapshot of {plural(ctx.world.games.length, "game")} · taken {shortDate(taken, ctx.tz)} {clockTime(taken, ctx.tz)} · </>
        ) : (
          <>
            Reading <code>{folderName(ctx.payload.dataRoot)}</code> on this computer · loaded {clockTime(taken, ctx.tz)} ·{" "}
          </>
        )}
        times in {ctx.tz}
      </footer>
    </Shell>
  );
}

// A page that throws while it is drawn shows a short message in its place, so the rest of the site
// still works, instead of the whole page going blank. Moving to another page clears it (see the key).
class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state: { failed: boolean } = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(err: unknown): void {
    console.error("[plr] a page could not be shown:", err);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="card pad">
          <h2>This page could not be shown</h2>
          <p>Something on it failed. Go back to the overview, or press Refresh and try again.</p>
          <a href={href()}>Back to the overview</a>
        </div>
      );
    }
    return this.props.children;
  }
}

function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function Page({ ctx, route, onSaved }: { ctx: Ctx; route: string[]; onSaved: () => void }) {
  const [first, second, third] = route;
  switch (first) {
    case undefined:
      return <Overview ctx={ctx} onSaved={onSaved} />;
    case "player":
      return <PlayerPage ctx={ctx} normalized={second ?? ""} />;
    case "games":
      return <Games ctx={ctx} />;
    case "style":
      return <PlayStylePage ctx={ctx} section={second ?? ""} person={third ?? ""} />;
    case "game":
      return <GamePage ctx={ctx} id={second ?? ""} onSaved={onSaved} />;
    case "settle":
      return <Settle ctx={ctx} gameId={second ?? ""} onSaved={onSaved} />;
    case "owed":
      return <Owed ctx={ctx} onSaved={onSaved} />;
    case "check":
      return <Check ctx={ctx} onSaved={onSaved} />;
    case "adjust":
      return <Adjust ctx={ctx} onSaved={onSaved} />;
    case "settings":
      return <Settings ctx={ctx} onSaved={onSaved} />;
    case "help":
      return <Help ctx={ctx} />;
    case "add":
      if (isSnapshot(ctx.payload)) return <div className="card pad">Games are added on the computer that runs the site.</div>;
      return <AddGame ctx={ctx} onSaved={onSaved} />;
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
  { path: "style", label: "Play style" },
  { path: "settle", label: "Settle up" },
  { path: "owed", label: "Who owes" },
  { path: "check", label: "Checks" },
  { path: "settings", label: "Settings" },
  { path: "add", label: "+ Add game" },
  { path: "help", label: "Help" },
];

// The pages that show a heading of their own (their h1), and the names of the others that are not tabs.
const PAGES_WITH_OWN_HEADING = new Set(["player", "game", "help"]);
const OTHER_PAGE_NAMES: Record<string, string> = { player: "Player", game: "Game", adjust: "Payments & corrections" };

// The page's name, as the tab bar words it (the browser tab and the page heading use it too).
export function pageName(route: string[]): string {
  const first = route[0] ?? "";
  if (first === "") return "Overview";
  const tab = TABS.find((t) => t.path === first);
  return tab?.label ?? OTHER_PAGE_NAMES[first] ?? "Page not found";
}

function Shell({ ctx, onRefresh, route, children }: { ctx?: Ctx; onRefresh?: () => void; route?: string[]; children: React.ReactNode }) {
  const active = route?.[0] === "player" ? "" : route?.[0] === "game" ? "games" : (route?.[0] ?? "");
  // The tab that is this page says so. A game is one of the Games list, so Games is marked as the place
  // the reader is in; a player's page is not any tab's, so Overview is only highlighted.
  const current = (path: string): "page" | "true" | undefined =>
    active !== path || route?.[0] === "player" ? undefined : route?.[0] === "game" ? "true" : "page";
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
            {TABS.filter((t) => !(isSnapshot(ctx.payload) && (t.path === "add" || t.path === "settings"))).map((t) => (
              <a
                key={t.path}
                href={t.path === "" ? href() : href(t.path)}
                className={active === t.path ? "active" : ""}
                aria-current={current(t.path)}
              >
                {t.label}
                {t.path === "check" && checks > 0 ? (
                  <>
                    <span className="badge" aria-hidden="true">
                      {checks}
                    </span>
                    <span className="sr-only"> ({plural(checks, "item")} to check)</span>
                  </>
                ) : null}
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
