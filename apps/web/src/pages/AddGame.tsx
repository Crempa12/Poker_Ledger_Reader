import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ledger, type Game } from "@plr/core";

import type { Ctx } from "../context.ts";
import { postJSON } from "../data.ts";
import { clockTime, longDate, moneyCents, moneySignedCents, plural, shortDate } from "../format.ts";
import { resultsOf } from "../game.ts";
import { href } from "../router.ts";

// The id its hand log is filed under: "ledger_pglX" -> "pglX".
function logId(game: Game): string {
  return game.id.replace(/^ledger_/, "");
}

const FILE_NAME = /^(ledger|poker_now_log)_(pgl[A-Za-z0-9_-]{10,40})(?: \(\d+\))?\.csv$/;

type Status = "ready" | "saving" | "saved" | "there" | "error";

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
  const newest = world.games[world.games.length - 1];
  const defaultFolder = newest !== undefined && newest.folder !== "(root)" ? newest.folder : (folders[folders.length - 1] ?? "");
  const [links, setLinks] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  // The basis the server checks each save against. A save returns the new one, so the next game of the
  // batch goes through without a reload; a reload of the data (after a save) sets it again.
  const basis = useRef(ctx.payload.basis);
  useEffect(() => {
    basis.current = ctx.payload.basis;
  }, [ctx.payload.basis]);

  if (!ctx.payload.canWrite) {
    return <div className="card pad">Adding games works only on the computer that holds the data.</div>;
  }

  const add = (item: Omit<Item, "status" | "message" | "folder"> & { folder?: string }): void => {
    const there = findExisting(ctx, item.kind, item.gameId);
    // A hand log goes next to its ledger when the ledger is already filed in a folder. A ledger at the
    // top of Games has no folder to share, and a game is never saved there, so the usual folder is offered.
    const ledgerAt = findExisting(ctx, "ledger", item.gameId);
    const inherited = ledgerAt !== null ? folderOfPath(ledgerAt) : "";
    const folder = item.folder ?? (inherited !== "" ? inherited : defaultFolder);
    setItems((list) => [
      ...list.filter((x) => x.key !== item.key),
      { ...item, folder, status: there !== null ? "there" : "ready", message: there !== null ? `already in your data: ${there}` : "" },
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

  const save = async (item: Item): Promise<void> => {
    setItems((list) => list.map((x) => (x.key === item.key ? { ...x, status: "saving" } : x)));
    try {
      const r = await postJSON<{ saved: string; basis: string }>("/api/save", {
        fileName: item.fileName,
        folder: item.folder,
        text: item.text,
        basis: basis.current,
      });
      basis.current = r.basis;
      setItems((list) => list.map((x) => (x.key === item.key ? { ...x, status: "saved", message: `saved as ${savedLabel(r.saved, gamesFolder)}` } : x)));
      onSaved();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setItems((list) => list.map((x) => (x.key === item.key ? { ...x, status: "error", message } : x)));
    }
  };

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
          Hand logs can only be downloaded by a person (PokerNow puts a captcha on them): open the game on PokerNow, choose{" "}
          <em>Download log</em>, then pick the file here. Ledger files from your Downloads work too.
        </p>
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
          <ul className="plain">
            {items.map((item) => (
              <li key={item.key} className="additem">
                <Preview ctx={ctx} item={item} />
                <div className="row">
                  <label>
                    <span className="muted small">Folder</span>
                    <FolderPicker folders={folders} value={item.folder} onChange={(f) => setFolder(item.key, f)} disabled={item.status !== "ready" && item.status !== "error"} />
                  </label>
                  {item.status === "ready" || item.status === "error" ? (
                    <button onClick={() => void save(item)} disabled={item.folder.trim() === ""}>
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
            After saving, the game shows here at once; the console app lists it after it is restarted. Game files hold everyone&apos;s
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
      {folders.map((f) => (
        <option key={f} value={f}>
          {f}
        </option>
      ))}
      <option value="__new__">New folder…</option>
    </select>
  );
}
