import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ledger, scopeContains, type Game } from "@plr/core";

import type { Ctx } from "../context.ts";
import { getLocalJSON, postJSON } from "../data.ts";
import { clockTime, longDate, moneyCents, moneySignedCents, plural, shortDate } from "../format.ts";
import { startOfFile, suggestFolder } from "../folders.ts";
import { resultsOf } from "../game.ts";
import { href } from "../router.ts";

// The id its hand log is filed under: "ledger_pglX" -> "pglX".
function logId(game: Game): string {
  return game.id.replace(/^ledger_/, "");
}

const FILE_NAME = /^(ledger|poker_now_log)_(pgl[A-Za-z0-9_-]{10,40})(?: \(\d+\))?\.[cC][sS][vV]$/;

type Status = "ready" | "saving" | "saved" | "there" | "error";

// A PokerNow file in the Downloads folder, as the server lists it (GET /api/downloads).
interface Downloaded {
  name: string;
  kind: "ledger" | "poker_now_log";
  gameId: string;
  bytes: number;
  modified: number;
  filed?: { path: string; bytes: number }; // the copy of this game's file already filed, if there is one
}
interface DownloadsList {
  found: boolean;
  files: Downloaded[]; // newest first
  unreadable?: string; // why the folder could not be opened (EPERM ...), when it is there but closed to the site
}

interface Item {
  key: string;
  kind: "ledger" | "poker_now_log";
  gameId: string;
  fileName: string;
  text: string;
  folder: string;
  status: Status;
  message: string;
}

// Where a game id already sits in the data, if anywhere.
function findExisting(ctx: Ctx, kind: Item["kind"], gameId: string): string | null {
  const name = `${kind}_${gameId}`;
  const paths = kind === "ledger" ? ctx.payload.ledgers.map((l) => l.relativePath) : ctx.payload.logs;
  return paths.find((p) => (p.split("/").pop() ?? "").startsWith(name)) ?? null;
}

function folderOfPath(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

// Where a saved game's folder is, for the page's words: under Games/ when the data has a Games
// folder, else at the top of the data folder (the console app reads games there then too).
export function savedLabel(folder: string, gamesFolder: boolean): string {
  if (folder.trim() === "") return "a folder"; // none typed yet
  return gamesFolder ? `Games/${folder}` : folder;
}

export function AddGame({ ctx, onSaved }: { ctx: Ctx; onSaved: () => void }) {
  const { world, tz } = ctx;
  // Older payloads (and a snapshot, which never saves) do not say: the Games folder is assumed.
  const gamesFolder = ctx.payload.gamesFolder ?? true;
  const folders = ledger.listFolders(world.games).filter((f) => f !== "(root)");
  const [links, setLinks] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  // The basis the server checks each save against. A save returns the new one, so the next game of the
  // batch goes through without a reload; a reload of the data (after a save) sets it again.
  // While saves run (one, or a Save all), a reload that lands (Refresh pressed meanwhile) may carry the basis
  // from before the last save, so it is not taken then; the reload after the saves sets it.
  const basis = useRef(ctx.payload.basis);
  const saving = useRef(0);
  useEffect(() => {
    if (saving.current === 0) basis.current = ctx.payload.basis;
  }, [ctx.payload.basis]);
  // The PokerNow files in the Downloads folder (menu 19 looks there). Looked at again each time the data is
  // read (a save, Refresh) and when this tab comes back to the front, as it does after a download elsewhere.
  const [downloads, setDownloads] = useState<DownloadsList | null>(null);
  useEffect(() => {
    if (!ctx.payload.canWrite) return;
    let current = true;
    const look = (): void => {
      getLocalJSON<DownloadsList>("/api/downloads").then(
        (d) => current && setDownloads(d),
        () => current && setDownloads(null),
      );
    };
    const onFront = (): void => {
      if (document.visibilityState === "visible") look();
    };
    look();
    window.addEventListener("focus", look);
    document.addEventListener("visibilitychange", onFront);
    return () => {
      current = false;
      window.removeEventListener("focus", look);
      document.removeEventListener("visibilitychange", onFront);
    };
  }, [ctx.payload.loadedAt, ctx.payload.canWrite]);

  if (!ctx.payload.canWrite) {
    return <div className="card pad">Adding games works only on the computer that holds the data.</div>;
  }
  // No data folder yet: a game has nowhere to go. A group without the console app starts one on the Overview.
  if (ctx.payload.dataReady === false) {
    return (
      <div className="card pad">
        <p>There is no data folder to add games to yet.</p>
        <p className="muted">
          {ctx.payload.canStartData === true ? (
            <>
              Not using the console app? Start one on the <a href={href()}>Overview</a>, then come back here.
            </>
          ) : (
            <>
              The site reads the console app&apos;s folder: put it next to this one (or set PLR_DATA_ROOT to it), then press{" "}
              <strong>Refresh</strong>.
              {ctx.payload.dataStartable === true ? (
                <>
                  {" "}
                  Not using the console app? The site starts a data folder of its own only in a folder that is empty (or not
                  there yet), that it may write to, and that is not a link. If <code>{ctx.payload.dataRoot}</code> holds other
                  files, move them out; otherwise set PLR_DATA_ROOT to such a folder. Then press <strong>Refresh</strong>.
                </>
              ) : null}
            </>
          )}
        </p>
      </div>
    );
  }

  const add = (item: Omit<Item, "status" | "message" | "folder"> & { folder?: string }): void => {
    const there = findExisting(ctx, item.kind, item.gameId);
    // A hand log goes next to its ledger: the one already filed in a folder, or the one on this page. A ledger at
    // the top of Games has no folder to share, and a game is never saved there. Anything else gets the folder
    // for its month (folders.ts), so filing it is one press.
    const ledgerAt = findExisting(ctx, "ledger", item.gameId);
    const inherited = ledgerAt !== null ? folderOfPath(ledgerAt) : "";
    const suggested = inherited !== "" ? inherited : suggestFolder(world.games, startOfFile(item.kind, item.text), tz);
    setItems((list) => [
      ...list.filter((x) => x.key !== item.key),
      {
        ...item,
        folder:
          item.folder ??
          (item.kind === "poker_now_log" && inherited === ""
            ? (list.find((x) => x.kind === "ledger" && x.gameId === item.gameId)?.folder ?? suggested)
            : suggested),
        status: there !== null ? "there" : "ready", message: there !== null ? `already in your data: ${there}. To file it somewhere else, move that file (and its hand log) to the other folder yourself, in Finder or File Explorer, then press Refresh.` : "",
      },
    ]);
  };

  // Every link is tried. The ones that fail stay in the box, each with what went wrong, to fix or try again.
  const fetchLinks = async (): Promise<void> => {
    setProblems([]);
    const wanted = links.split(/\s+/).filter((l) => l !== "");
    if (wanted.length === 0) return;
    setBusy(true);
    const failed: string[] = [];
    const why: string[] = [];
    for (const link of wanted) {
      try {
        const r = await postJSON<{ gameId: string; fileName: string; text: string }>("/api/pokernow", { link });
        add({ key: `ledger_${r.gameId}`, kind: "ledger", gameId: r.gameId, fileName: r.fileName, text: r.text });
      } catch (err) {
        failed.push(link);
        why.push(`${link}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setBusy(false);
    setProblems(why);
    setLinks(failed.join("\n"));
  };

  const pickFiles = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    setProblems([]);
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    const why: string[] = [];
    for (const f of files) {
      const m = FILE_NAME.exec(f.name);
      if (m === null) {
        why.push(`${f.name} is not a PokerNow ledger_… or poker_now_log_… file, so it was left out.`);
        continue;
      }
      const kind = m[1] as Item["kind"];
      const gameId = m[2] ?? "";
      add({ key: `${kind}_${gameId}`, kind, gameId, fileName: f.name, text: await f.text() });
    }
    setProblems(why);
  };

  // reload: whether the page reads the data again afterwards. Save all reads it once, at the end, so a
  // reload that lands between two saves cannot hand the next save an older basis.
  const save = async (item: Item, reload = true): Promise<void> => {
    setItems((list) => list.map((x) => (x.key === item.key ? { ...x, status: "saving" } : x)));
    saving.current++;
    try {
      const r = await postJSON<{ saved: string; basis: string }>("/api/save", {
        fileName: item.fileName,
        folder: item.folder,
        text: item.text,
        basis: basis.current,
      });
      basis.current = r.basis;
      const notes = afterSaveNotes(ctx, item, r.saved, items);
      const message = [`saved as ${savedLabel(r.saved, gamesFolder)}`, ...notes].join(" · ");
      setItems((list) => list.map((x) => (x.key === item.key ? { ...x, status: "saved", message } : x)));
      if (reload) onSaved();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setItems((list) => list.map((x) => (x.key === item.key ? { ...x, status: "error", message } : x)));
    } finally {
      saving.current--;
    }
  };

  const saveAll = async (list: Item[]): Promise<void> => {
    setBusy(true);
    saving.current++;
    try {
      for (const item of list) await save(item, false);
    } finally {
      saving.current--;
      setBusy(false);
      onSaved();
    }
  };

  // The newest copy of each game's file in Downloads that is not in the data yet, nor on this page.
  const seen = new Set<string>();
  const fresh = (downloads?.files ?? []).filter((f) => {
    const key = `${f.kind}_${f.gameId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return findExisting(ctx, f.kind, f.gameId) === null && !items.some((x) => x.key === key);
  });
  // Downloads bigger than the copy of the same game already filed: most likely the whole file of a game filed
  // early (a hand log downloaded before the night ended). The site never files over a game, so they are
  // pointed out instead of being left out with the other filed games. The biggest copy of each game is shown.
  const bigger: Downloaded[] = [];
  for (const f of downloads?.files ?? []) {
    if (f.filed === undefined || f.bytes <= f.filed.bytes) continue;
    const at = bigger.findIndex((b) => b.kind === f.kind && b.gameId === f.gameId);
    if (at === -1) bigger.push(f);
    else if (f.bytes > (bigger[at]?.bytes ?? 0)) bigger[at] = f;
  }

  const addFromDownloads = async (files: Downloaded[]): Promise<void> => {
    setProblems([]);
    setBusy(true);
    const why: string[] = [];
    for (const f of files) {
      try {
        const r = await getLocalJSON<{ name: string; text: string }>(`/api/downloads/${encodeURIComponent(f.name)}`);
        add({ key: `${f.kind}_${f.gameId}`, kind: f.kind, gameId: f.gameId, fileName: f.name, text: r.text });
      } catch (err) {
        why.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setBusy(false);
    setProblems(why);
  };

  // Ledgers first, so a game's hand log is filed after the game itself.
  const saveable = items
    .filter((x) => (x.status === "ready" || x.status === "error") && x.folder.trim() !== "")
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "ledger" ? -1 : 1));

  const setFolder = (key: string, folder: string): void =>
    setItems((list) => list.map((x) => (x.key === key ? { ...x, folder } : x)));

  // Games with no hand log yet, newest first, with a link to download it.
  const missing = [...world.games]
    .reverse()
    .filter((g) => findExisting(ctx, "poker_now_log", logId(g)) === null)
    .slice(0, 12);

  return (
    <>
      <section className="card">
        <h2>Add a game from PokerNow</h2>
        <p className="muted small">
          Paste the game's link (or several, one per line). The ledger is fetched straight from PokerNow and filed into your{" "}
          {gamesFolder ? (
            <>
              <code>Games</code> folder, the same place the console app's menu 19 puts it.
            </>
          ) : (
            <>
              data folder, in a folder of its own at the top level (there is no <code>Games</code> folder yet, so the console app
              reads games from there too).
            </>
          )}
        </p>
        {ctx.payload.consoleOpen > 0 ? (
          <p className="banner" role="status">
            The console app is open. A game filed here is saved at once, but the console app lists it only after it is restarted.
          </p>
        ) : null}
        <textarea
          className="links"
          rows={3}
          placeholder="https://www.pokernow.com/games/pgl…"
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          aria-label="PokerNow links, one per line"
          disabled={busy}
        />
        <div className="row">
          <button onClick={() => void fetchLinks()} disabled={busy || links.trim() === ""}>
            {busy ? "Fetching…" : "Fetch ledger"}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Add downloaded files</h2>
        <p className="muted small">
          Hand logs can only be downloaded by a person (PokerNow puts a captcha on them): open the game on PokerNow and choose{" "}
          <em>Download log</em>. The PokerNow files in your Downloads folder show up here when you come back to this page (or press{" "}
          <strong>Refresh</strong>); ledger files work too.
        </p>
        <DownloadsFound
          list={downloads}
          fresh={fresh}
          bigger={bigger}
          gamesFolder={gamesFolder}
          listed={(downloads?.files ?? []).some((f) => items.some((x) => x.key === `${f.kind}_${f.gameId}`))}
          busy={busy}
          tz={ctx.tz}
          onAdd={(files) => void addFromDownloads(files)}
        />
        <p className="muted small">Or pick the files yourself:</p>
        <input type="file" accept=".csv,text/csv" multiple onChange={(e) => void pickFiles(e)} aria-label="Downloaded game files to add" />
      </section>

      {problems.length > 0 ? (
        <div className="card pad down" role="alert">
          {problems.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      ) : null}

      {items.length > 0 ? (
        <section className="card">
          <h2>Ready to file</h2>
          {saveable.length > 1 ? (
            <div className="row tight">
              <button onClick={() => void saveAll(saveable)} disabled={busy}>
                Save all {saveable.length}
              </button>
              <span className="muted small">each to the folder shown with it</span>
            </div>
          ) : null}
          <ul className="plain">
            {items.map((item) => (
              <li key={item.key} className="additem">
                <Preview ctx={ctx} item={item} />
                <div className="row">
                  <label>
                    <span className="muted small">Folder</span>
                    <FolderPicker
                      folders={folders}
                      value={item.folder}
                      onChange={(f) => setFolder(item.key, f)}
                      disabled={busy || (item.status !== "ready" && item.status !== "error")}
                    />
                  </label>
                  {item.status === "ready" || item.status === "error" ? (
                    <button onClick={() => void save(item)} disabled={busy || item.folder.trim() === ""}>
                      Save to {savedLabel(item.folder, gamesFolder)}
                    </button>
                  ) : null}
                  {item.status === "saving" ? <span className="muted">Saving…</span> : null}
                </div>
                {item.message !== "" ? (
                  <p className={item.status === "error" ? "down small" : item.status === "saved" ? "up small" : "muted small"}>{item.message}</p>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="muted small">
            After saving, the game shows on every page at once (when the Folder and Dates at the top include it); the console app
            lists it after it is restarted. Game files hold everyone&apos;s
            names and results: keep them out of git, or keep that repository private.
          </p>
        </section>
      ) : null}

      {missing.length > 0 ? (
        <section className="card">
          <h2>Games without a hand log</h2>
          <p className="muted small">Newest first. Open the game on PokerNow, download its log, then add it above.</p>
          <ul className="plain">
            {missing.map((g: Game) => (
              <li key={g.id}>
                <a href={href("game", g.id)}>{longDate(g.start, tz)}</a> <span className="muted small">{g.folder}</span> ·{" "}
                <a href={`https://www.pokernow.com/games/${logId(g)}`} target="_blank" rel="noreferrer">
                  open on PokerNow ↗
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

// The PokerNow files the Downloads folder holds that are not filed yet, to add with one press. Nothing is
// said when the folder cannot be looked at (a phone, or no Downloads folder).
function DownloadsFound({
  list,
  fresh,
  bigger,
  gamesFolder,
  listed,
  busy,
  tz,
  onAdd,
}: {
  list: DownloadsList | null;
  fresh: Downloaded[];
  bigger: Downloaded[]; // bigger than the copy of the same game already filed
  gamesFolder: boolean;
  listed: boolean; // some of its files are on this page already
  busy: boolean;
  tz: string;
  onAdd: (files: Downloaded[]) => void;
}) {
  if (list !== null && list.unreadable !== undefined) {
    return (
      <p className="muted small">
        The site may not open your Downloads folder ({list.unreadable}). On a Mac, allow the app that runs the site (Terminal) in
        System Settings → Privacy &amp; Security → Files and Folders, then press <strong>Refresh</strong>. You can still pick the
        files below.
      </p>
    );
  }
  if (list === null || !list.found) return null;
  const biggerNote =
    bigger.length > 0 ? (
      <div className="downloads">
        <p>
          <strong>{plural(bigger.length, "download")}</strong> bigger than the copy already filed:
        </p>
        <ul className="plain small">
          {bigger.map((f) => (
            <li key={f.name}>
              <code>{f.name}</code>{" "}
              <span className="muted">
                · {sizes(f.bytes, f.filed?.bytes ?? 0)[0]}; filed at {savedLabel(f.filed?.path ?? "", gamesFolder)},{" "}
                {sizes(f.bytes, f.filed?.bytes ?? 0)[1]}
              </span>
            </li>
          ))}
        </ul>
        <p className="muted small">
          A game filed before the night ended holds less. The site never files over a game: to use the bigger copy, move the filed
          file out of its folder yourself (in Finder or File Explorer), press <strong>Refresh</strong>, then add this one.
        </p>
      </div>
    ) : null;
  if (fresh.length === 0) {
    return (
      <>
        <p className="muted small">
          {listed ? "The new PokerNow files from your Downloads folder are listed below." : "No new PokerNow files in your Downloads folder."}
        </p>
        {biggerNote}
      </>
    );
  }
  return (
    <>
    <div className="downloads">
      <p>
        <strong>{plural(fresh.length, "new PokerNow file")}</strong> in your Downloads folder:
      </p>
      <ul className="plain small">
        {fresh.map((f) => (
          <li key={f.name}>
            {f.kind === "ledger" ? "Ledger" : "Hand log"} <code>{f.name}</code>{" "}
            <span className="muted">· downloaded {shortDate(Math.floor(f.modified / 1000), tz)} {clockTime(Math.floor(f.modified / 1000), tz)}</span>
          </li>
        ))}
      </ul>
      <div className="row">
        <button onClick={() => onAdd(fresh)} disabled={busy}>
          {fresh.length === 1 ? "Add it" : `Add all ${fresh.length}`}
        </button>
        <span className="muted small">They stay in Downloads; a copy is filed when you save.</span>
      </div>
    </div>
    {biggerNote}
    </>
  );
}

// Two file sizes, in KB, or in bytes when the KB would read the same (a small ledger), so the bigger one shows.
export function sizes(a: number, b: number): [string, string] {
  const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024)).toLocaleString("en-US")} KB`;
  if (kb(a) !== kb(b)) return [kb(a), kb(b)];
  const exact = (n: number): string => `${n.toLocaleString("en-US")} bytes`;
  return [exact(a), exact(b)];
}

// What to add to "saved as ..." for a game just filed: that the Folder or Dates at the top hide it, and,
// for a hand log, that its ledger is not filed yet (nor on this page to file).
export function afterSaveNotes(ctx: Ctx, item: Pick<Item, "kind" | "gameId" | "text">, saved: string, items: readonly Pick<Item, "kind" | "gameId">[]): string[] {
  const notes: string[] = [];
  const folder = folderOfPath(saved);
  const start = item.kind === "ledger" ? (ledger.loadAllGames([{ relativePath: saved, text: item.text }]).games[0]?.start ?? null) : null;
  const shown = item.kind === "ledger" ? scopeContains(ctx.scope, folder, start) : ctx.scope.folder === "" || ctx.scope.folder === folder;
  if (!shown) notes.push("the Folder or Dates choice at the top hides it: pick All folders and All time to see it");
  if (
    item.kind === "poker_now_log" &&
    findExisting(ctx, "ledger", item.gameId) === null &&
    !items.some((x) => x.kind === "ledger" && x.gameId === item.gameId)
  ) {
    notes.push("its ledger is not filed yet: add that too");
  }
  return notes;
}

function Preview({ ctx, item }: { ctx: Ctx; item: Item }) {
  if (item.kind === "poker_now_log") {
    const ledgerAt = findExisting(ctx, "ledger", item.gameId);
    const hands = (item.text.match(/-- starting hand #/g) ?? []).length;
    return (
      <div>
        <strong>Hand log</strong> <code>{item.gameId}</code>
        <div className="muted small">
          {plural(hands, "hand")} · {ledgerAt !== null ? `pairs with ${ledgerAt}` : "its ledger is not in your data yet; add that too"}
        </div>
      </div>
    );
  }
  const loaded = ledger.loadAllGames([{ relativePath: `${item.folder || "new"}/${item.fileName}`, text: item.text }]);
  const game = loaded.games[0];
  if (game === undefined) return <div className="down">The ledger has no played seats.</div>;
  const results = resultsOf(game, ctx.world.rules);
  const offBy = results.reduce((s, r) => s + r.netCents, 0);
  const top = results[0];
  return (
    <div>
      <strong>{longDate(game.start, ctx.tz)}</strong>{" "}
      <span className="muted small">
        {clockTime(game.start, ctx.tz)} · {shortDate(game.end, ctx.tz)}
      </span>
      <div className="muted small">
        {plural(results.length, "player")} · {moneyCents(game.totalBuyInCents)} bought in
        {top !== undefined && top.netCents > 0 ? ` · top ${ctx.nameOf(top.person)} ${moneySignedCents(top.netCents)}` : ""} ·{" "}
        <span className={offBy === 0 ? "up" : "down"}>{offBy === 0 ? "balanced" : `off by ${moneySignedCents(offBy)}`}</span>
      </div>
    </div>
  );
}

// The folder to file a game in: an existing one picked from the list, or a new name typed. With no
// folder yet the name is typed from the start (a list holding only "New folder…" cannot be picked
// from: choosing that option is no change for the browser, so nothing would open).
export function FolderPicker({
  folders,
  value,
  onChange,
  disabled,
}: {
  folders: string[];
  value: string;
  onChange: (f: string) => void;
  disabled: boolean;
}) {
  const isNew = value !== "" && !folders.includes(value);
  const [typing, setTyping] = useState(isNew || folders.length === 0);
  if (typing) {
    return (
      <span className="row tight">
        <input type="text" value={value} placeholder="e.g. Nov 2026" onChange={(e) => onChange(e.target.value)} disabled={disabled} />
        {folders.length > 0 ? (
          <button className="link" onClick={() => setTyping(false)} disabled={disabled}>
            pick existing
          </button>
        ) : null}
      </span>
    );
  }
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value === "__new__") {
          setTyping(true);
          onChange("");
        } else onChange(e.target.value);
      }}
    >
      {/* A typed name not made yet: listed, so the box shows the folder the save will use. */}
      {isNew ? <option value={value}>{value} (new)</option> : null}
      {folders.map((f) => (
        <option key={f} value={f}>
          {f}
        </option>
      ))}
      <option value="__new__">New folder…</option>
    </select>
  );
}
