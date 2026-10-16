import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ledger } from "@plr/core";

import { buildCtx, type Ctx } from "./context.ts";
import { currentBasis, EVERYTHING, isoDay, isSnapshot, loadData, readSavedScope, saveScope, withDays, type Loaded, type ScopeChoice } from "./data.ts";
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
  // The promise settles once the page has the newest data (a save waits for it before its buttons come back):
  // a load overtaken by a newer one (Refresh pressed meanwhile) settles with that newer load.
  const newest = useRef<Promise<void>>(Promise.resolve());
  const refresh = useCallback((): Promise<void> => {
    const mine = latest.current + 1;
    latest.current = mine;
    const load: Promise<void> = loadData().then(
      (loaded) => (mine === latest.current ? setState({ status: "ready", loaded }) : newest.current),
      (err: unknown) =>
        mine === latest.current ? setState({ status: "error", message: err instanceof Error ? err.message : String(err) }) : newest.current,
    );
    newest.current = load;
    return load;
  }, []);
  // Bumped when the tab comes back to the front, so a date preset ("Past 30 days") is worked out again for a
  // new day without a reload (the page context below keys on the day).
  const [, setShown] = useState(0);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // When this tab comes back to the front (after the console app filed a game or changed a name, say), the
  // data is read again if it changed, so the page shows what the console app shows without a Refresh, and
  // a save is not refused for data the page did not have. A snapshot never changes, so it never asks.
  const shownBasis = useRef<string | null>(null);
  useEffect(() => {
    shownBasis.current = state.status === "ready" && !isSnapshot(state.loaded.payload) ? state.loaded.payload.basis : null;
  }, [state]);
  useEffect(() => {
    let asked = 0;
    const look = (): void => {
      if (document.visibilityState !== "visible") return;
      setShown((n) => n + 1);
      if (shownBasis.current === null || Date.now() - asked < 2000) return;
      asked = Date.now();
      void currentBasis().then((now) => {
        if (now !== null && shownBasis.current !== null && now !== shownBasis.current) void refresh();
      });
    };
    window.addEventListener("focus", look);
    document.addEventListener("visibilitychange", look);
    return () => {
      window.removeEventListener("focus", look);
      document.removeEventListener("visibilitychange", look);
    };
  }, [refresh]);

  // A preset's From date counts back from today, or, in a snapshot, from the day it was made (its results end
  // then). day changes at midnight, so the next render after that (a page change, the tab coming back) moves it on.
  const anchorMs = state.status === "ready" && isSnapshot(state.loaded.payload) ? state.loaded.payload.loadedAt : Date.now();
  const day = state.status === "ready" ? isoDay(anchorMs, state.loaded.world.timeZone) : "";
  const ctx = useMemo(() => {
    if (state.status !== "ready") return null;
    const { payload, world } = state.loaded;
    // A saved folder that no longer exists falls back to every folder.
    const folders = ledger.listFolders(world.games);
    const safe = choice.folder === "" || folders.includes(choice.folder) ? choice : { ...choice, folder: "" };
    return buildCtx(payload, world, withDays(safe, world.timeZone, anchorMs));
    // anchorMs is read for its day only: the context is built again when the day changes, not every render.
  }, [state, choice, day]);

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
          <button onClick={() => void refresh()}>Try again</button>
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

function ScopeBar({ ctx, onChange }: { ctx: Ctx; onChange: (c: ScopeChoice) => void }) {
  const { choice, view, world, tz } = ctx;
  const folders = ledger.listFolders(world.games);
  // A preset is kept as its number of days. A range saved as dates (before presets kept days) still shows
  // as its preset on the day it matches.
  const preset =
    choice.days !== undefined
      ? (PRESETS.find((p) => p.days === choice.days)?.id ?? "custom")
      : choice.from === "" && choice.to === ""
        ? "all"
        : (PRESETS.find((p) => p.days !== null && choice.to === "" && choice.from === isoDay(Date.now() - p.days * 86400000, tz))?.id ?? "custom");
  // The dates as typed: editing From or To ends a preset.
  const fixed: ScopeChoice = { folder: choice.folder, from: choice.from, to: choice.to };
  const [custom, setCustom] = useState(preset === "custom");

  const pickPreset = (id: string): void => {
    if (id === "custom") {
      setCustom(true);
      return;
    }
    setCustom(false);
    const p = PRESETS.find((x) => x.id === id);
    onChange(p?.days == null ? { ...fixed, from: "", to: "" } : { ...fixed, from: "", to: "", days: p.days });
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
            <input type="date" value={choice.from} onChange={(e) => onChange({ ...fixed, from: e.target.value })} />
          </label>
          <label>
            <span className="muted">To</span>
            <input type="date" value={choice.to} onChange={(e) => onChange({ ...fixed, to: e.target.value })} />
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
