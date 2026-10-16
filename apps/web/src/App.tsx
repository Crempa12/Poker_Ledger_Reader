import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ledger } from "@plr/core";

import { buildCtx, type Ctx } from "./context.ts";
import { currentBasis, EVERYTHING, isoDay, isSnapshot, loadData, readSavedScope, saveScope, withDays, type Loaded, type ScopeChoice } from "./data.ts";
import { clockTime, plural, shortDate } from "./format.ts";
import { useNotice, setNotice } from "./notice.ts";
import { href, useRoute } from "./router.ts";
import { Check, checkCount } from "./pages/Check.tsx";
import { GamePage } from "./pages/Game.tsx";
import { AddGame } from "./pages/AddGame.tsx";
import { Adjust } from "./pages/Adjust.tsx";
import { Games } from "./pages/Games.tsx";
import { Help } from "./pages/Help.tsx";
import { More } from "./pages/More.tsx";
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
  const notice = useNotice();
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

  if (state.status === "loading") {
    return (
      <Shell>
        <p className="sub">Reading your games…</p>
      </Shell>
    );
  }
  if (state.status === "error" || ctx === null) {
    return (
      <Shell>
        <h1>Could not read the data</h1>
        <p>{state.status === "error" ? state.message : "Unknown problem."}</p>
        <p className="sub">
          Start the site with <code>npm run web</code> in the Poker_Ledger_Web folder (or open <strong>Start Poker Ledger</strong>), then
          press Try again.
        </p>
        <button onClick={() => void refresh()}>Try again</button>
      </Shell>
    );
  }

  const snapshot = isSnapshot(ctx.payload);
  const taken = Math.floor(ctx.payload.loadedAt / 1000);
  const page = route[0] ?? "";
  return (
    <Shell ctx={ctx} onRefresh={snapshot ? undefined : refresh} route={route}>
      {snapshot ? (
        <p className="banner snapshot" role="status">
          A snapshot from {shortDate(taken, ctx.tz)} at {clockTime(taken, ctx.tz)}: the results up to then. It does not change; ask
          {ctx.me !== "" ? ` ${ctx.nameOf(ctx.me)}` : " whoever sent it"} for a new one after the next game.
        </p>
      ) : null}
      {ctx.payload.consoleOpen > 0 && ctx.payload.canWrite ? (
        <div className="banner" role="status">
          <details>
            <summary>The console app is open, so names, sheets and settings are not saved here until it quits.</summary>
            <p>
              It saves its own copy of the names, sheets and settings when it quits, so the site will not save those until it is closed:
              quit it with <strong>0. Save and exit</strong>, then press Refresh. A new game can still be filed; the console app lists it
              after it restarts.
            </p>
          </details>
        </div>
      ) : ctx.payload.consoleOpen === -1 && ctx.payload.canWrite ? (
        <p className="banner" role="status">
          Could not tell whether the console app is open; saving will check again.
        </p>
      ) : null}
      {notice !== null ? (
        <div className="banner warn-banner" role="alert">
          <p>{notice}</p>
          <button className="link" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {SCOPED.has(page) && !(page === "settle" && (route[1] ?? "") !== "") && ctx.world.games.length > 0 ? (
        <ScopeLine ctx={ctx} onChange={changeScope} />
      ) : null}
      <main id="main" tabIndex={-1} className={WIDE.has(page) ? "screen wide" : "screen"}>
        <PageBoundary key={route.join("/")}>
          {/* The pages that have no heading of their own still name themselves to a screen reader. */}
          {PAGES_WITH_OWN_HEADING.has(page) || (page === "" && ctx.world.games.length === 0 && !snapshot) ? null : (
            <h1 className="sr-only">{pageName(route)}</h1>
          )}
          <Page ctx={ctx} route={route} onSaved={refresh} />
        </PageBoundary>
      </main>
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
          <p>Something on it failed. Go back to the standings, or press Refresh and try again.</p>
          <a href={href()}>Back to the standings</a>
        </div>
      );
    }
    return this.props.children;
  }
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
    case "more":
      return <More ctx={ctx} />;
    case "add":
      if (isSnapshot(ctx.payload)) {
        return (
          <>
            <h1>Add a game</h1>
            <p className="lede">Games are added on the computer that runs the site.</p>
          </>
        );
      }
      return <AddGame ctx={ctx} onSaved={onSaved} />;
    default:
      return (
        <>
          <p>That page does not exist.</p>
          <a href={href()}>Back to the standings</a>
        </>
      );
  }
}

// Every page's name, as the bars and the browser tab word it.
const NAMES: Record<string, string> = {
  "": "Standings",
  games: "Nights",
  game: "Night",
  settle: "Settle up",
  owed: "Who owes",
  add: "Add a game",
  more: "More",
  style: "Play style",
  check: "Checks",
  adjust: "Payments & corrections",
  settings: "Settings",
  help: "Help",
  player: "Player",
};

// The pages the Folder and Dates line changes; the others (Who owes, + Add, Settings, a night) do not show it.
const SCOPED = new Set(["", "games", "settle", "style", "player", "adjust", "check"]);
// The pages laid out across a wide screen (a table or two columns); the others keep a readable measure.
const WIDE = new Set(["", "style", "player", "check"]);
// The pages that show a heading of their own (their h1).
const PAGES_WITH_OWN_HEADING = new Set(["player", "game", "help", "games", "more", "settle", "owed", "check", "adjust", "settings", "style", "add"]);

// The page's name (the browser tab and the page heading use it too).
export function pageName(route: string[]): string {
  return NAMES[route[0] ?? ""] ?? "Page not found";
}

// The part of the site a page belongs to, for the bars: a player is one of the standings, a night one of
// the nights, and the pages under More are More's.
function sectionOf(page: string | undefined): string {
  if (page === undefined || page === "" || page === "player") return "";
  if (page === "game") return "games";
  if (page === "settle" || page === "owed" || page === "add" || page === "games") return page;
  return "more";
}

interface Tab {
  path: string;
  label: string;
  add?: boolean;
}

// The bars' places. Phone: four places and the one thing to do. A read-only copy (a snapshot, a phone on the
// Wi-Fi) never adds a game, so Settle up takes that place there, and the desktop row leaves + Add game out.
export function navTabs(noAdd: boolean): { phone: Tab[]; desktop: Tab[] } {
  return {
    phone: [
      { path: "", label: "Standings" },
      { path: "games", label: "Nights" },
      noAdd ? { path: "settle", label: "Settle up" } : { path: "add", label: "+ Add", add: true },
      { path: "owed", label: "Who owes" },
      { path: "more", label: "More" },
    ],
    desktop: [
      { path: "", label: "Standings" },
      { path: "games", label: "Nights" },
      { path: "settle", label: "Settle up" },
      { path: "owed", label: "Who owes" },
      ...(noAdd ? [] : [{ path: "add", label: "+ Add game", add: true }]),
      { path: "more", label: "More" },
    ],
  };
}

function Shell({ ctx, onRefresh, route, children }: { ctx?: Ctx; onRefresh?: () => void; route?: string[]; children: ReactNode }) {
  const page = route?.[0] ?? "";
  const section = route === undefined ? "" : sectionOf(route[0]);
  const snapshot = ctx !== undefined && isSnapshot(ctx.payload);
  // A snapshot, or a phone on the Wi-Fi, cannot add a game: + Add is left out there.
  const noAdd = ctx !== undefined && (snapshot || !ctx.payload.canWrite);
  const checks = ctx === undefined ? 0 : checkCount(ctx);
  // This page is the tab's own ("page"), or one inside it ("true": a player under Standings, a night under Nights).
  const current = (path: string): "page" | "true" | undefined => (section !== path ? undefined : page === path ? "page" : "true");
  const { phone, desktop } = navTabs(noAdd);
  // Settle up has no tab on a phone (it is reached from a night): Nights stays lit there.
  const phoneCurrent = (path: string): "page" | "true" | undefined =>
    !noAdd && section === "settle" && path === "games" ? "true" : current(path);
  const badge =
    checks > 0 ? (
      <>
        <span className="badge" aria-hidden="true">
          {checks}
        </span>
        <span className="sr-only"> ({plural(checks, "item")} to check)</span>
      </>
    ) : null;
  const link = (t: Tab, at: (path: string) => "page" | "true" | undefined) => (
    <a key={t.path} href={t.path === "" ? href() : href(t.path)} className={t.add === true ? "add" : undefined} aria-current={at(t.path)}>
      {t.label}
      {t.path === "more" ? badge : null}
    </a>
  );
  return (
    <div className="app">
      <button className="skip" onClick={() => document.getElementById("main")?.focus()}>
        Skip to the page
      </button>
      <header className="top">
        <a className="brand" href={href()} aria-current={page === "" && ctx !== undefined ? "page" : undefined}>
          Poker Ledger
        </a>
        {ctx !== undefined ? (
          <nav className="topnav" aria-label="Pages">
            {desktop.map((t) => link(t, current))}
          </nav>
        ) : null}
        <span className="top-end">
          {onRefresh !== undefined ? (
            <button className="plain" onClick={onRefresh} title="Read the data folder again">
              Refresh
            </button>
          ) : null}
        </span>
      </header>
      {ctx === undefined ? <main className="screen">{children}</main> : children}
      {ctx !== undefined ? (
        <nav className="tabbar" aria-label="Pages">
          {phone.map((t) => link(t, phoneCurrent))}
        </nav>
      ) : null}
    </div>
  );
}

const PRESETS: { id: string; label: string; days: number | null }[] = [
  { id: "all", label: "All time", days: null },
  { id: "30", label: "Past 30 days", days: 30 },
  { id: "90", label: "Past 90 days", days: 90 },
];

// "Oct 3 – now", "start – Oct 31", "Oct 3 – Oct 31" for a range typed by hand (dates as typed, 2026-10-03).
function rangeWords(from: string, to: string): string {
  const day = (iso: string): string => {
    const [y, m, d] = iso.split("-").map(Number);
    if (y === undefined || m === undefined || d === undefined || !Number.isFinite(d)) return iso;
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  };
  return `${from === "" ? "start" : day(from)} – ${to === "" ? "now" : day(to)}`;
}

// The Folder and Dates choice, as one line that opens: "All folders · All time". The presets are kept as
// their number of days, so "Past 30 days" moves on with the calendar (data.ts withDays).
function ScopeLine({ ctx, onChange }: { ctx: Ctx; onChange: (c: ScopeChoice) => void }) {
  const { choice, view, world, tz } = ctx;
  const folders = ledger.listFolders(world.games);
  // A range saved as dates (before presets kept days) still shows as its preset on the day it matches.
  const preset =
    choice.days !== undefined
      ? (PRESETS.find((p) => p.days === choice.days)?.id ?? "custom")
      : choice.from === "" && choice.to === ""
        ? "all"
        : (PRESETS.find((p) => p.days !== null && choice.to === "" && choice.from === isoDay(Date.now() - p.days * 86400000, tz))?.id ?? "custom");
  // The dates as typed: editing From or To ends a preset.
  const fixed: ScopeChoice = { folder: choice.folder, from: choice.from, to: choice.to };
  const [custom, setCustom] = useState(preset === "custom");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDetailsElement>(null);

  // A tap outside the panel, or Escape, closes it.
  useEffect(() => {
    if (!open) return;
    const away = (e: Event): void => {
      if (box.current !== null && e.target instanceof Node && !box.current.contains(e.target)) setOpen(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      setOpen(false);
      box.current?.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const pickPreset = (id: string): void => {
    if (id === "custom") {
      setCustom(true);
      return;
    }
    setCustom(false);
    const p = PRESETS.find((x) => x.id === id);
    onChange(p?.days == null ? { ...fixed, from: "", to: "" } : { ...fixed, from: "", to: "", days: p.days });
  };

  const datesNow = custom || preset === "custom" ? rangeWords(choice.from, choice.to) : (PRESETS.find((p) => p.id === preset)?.label ?? "All time");
  const first = view.games[0];
  const last = view.games[view.games.length - 1];
  const narrowed = choice.folder !== "" || choice.from !== "" || choice.to !== "";
  return (
    <div className="scoperow">
      <details className="scope" ref={box} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary aria-label={`Showing ${choice.folder === "" ? "all folders" : choice.folder}, ${datesNow}. Change`}>
          <span className="scope-now">
            {choice.folder === "" ? "All folders" : choice.folder} · {datesNow}
          </span>
          <span className="caret" aria-hidden="true">
            ▼
          </span>
        </summary>
        <div className="scope-pop">
          <fieldset>
            <legend className="label">Folder</legend>
            {["", ...folders].map((f) => (
              <label key={f === "" ? "(all)" : f} className="opt">
                <input type="radio" name="scope-folder" checked={choice.folder === f} onChange={() => onChange({ ...choice, folder: f })} />
                {f === "" ? "All folders" : f}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend className="label">Dates</legend>
            {PRESETS.map((p) => (
              <label key={p.id} className="opt">
                <input type="radio" name="scope-dates" checked={!custom && preset === p.id} onChange={() => pickPreset(p.id)} />
                {p.label}
              </label>
            ))}
            <label className="opt">
              <input type="radio" name="scope-dates" checked={custom || preset === "custom"} onChange={() => pickPreset("custom")} />
              Custom range
            </label>
            {custom || preset === "custom" ? (
              <div className="dates">
                <label>
                  From
                  <input type="date" value={choice.from} onChange={(e) => onChange({ ...fixed, from: e.target.value })} />
                </label>
                <label>
                  To
                  <input type="date" value={choice.to} onChange={(e) => onChange({ ...fixed, to: e.target.value })} />
                </label>
              </div>
            ) : null}
          </fieldset>
          <div className="foot">
            {narrowed ? (
              <button
                className="link"
                onClick={() => {
                  setCustom(false);
                  onChange(EVERYTHING);
                  // This button goes once everything is shown: the keyboard goes on from the folder list.
                  requestAnimationFrame(() => box.current?.querySelector<HTMLInputElement>("fieldset input")?.focus());
                }}
              >
                Show everything
              </button>
            ) : (
              <span />
            )}
            <button
              className="small"
              onClick={() => {
                setOpen(false);
                box.current?.querySelector("summary")?.focus();
              }}
            >
              Done
            </button>
          </div>
        </div>
      </details>
      <span className="stamp">
        {plural(view.games.length, "game")}
        {first !== undefined && last !== undefined ? <span className="hide-xs">{` · ${shortDate(first.start, tz)} – ${shortDate(last.start, tz)}`}</span> : null}
      </span>
    </div>
  );
}
