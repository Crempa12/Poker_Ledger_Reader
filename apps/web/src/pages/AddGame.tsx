import { useState, type ChangeEvent } from "react";
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

export function AddGame({ ctx, onSaved }: { ctx: Ctx; onSaved: () => void }) {
  const { world, tz } = ctx;
  const folders = ledger.listFolders(world.games).filter((f) => f !== "(root)");
  const newest = world.games[world.games.length - 1];
  const defaultFolder = newest !== undefined && newest.folder !== "(root)" ? newest.folder : (folders[folders.length - 1] ?? "");
  const [links, setLinks] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  if (!ctx.payload.canWrite) {
    return <div className="card pad">Adding games works only on the computer that holds the data.</div>;
  }

  const add = (item: Omit<Item, "status" | "message" | "folder"> & { folder?: string }): void => {
    const there = findExisting(ctx, item.kind, item.gameId);
    // A hand log goes next to its ledger when the ledger is already filed.
    const ledgerAt = findExisting(ctx, "ledger", item.gameId);
    const folder = item.folder ?? (ledgerAt !== null ? folderOfPath(ledgerAt) : defaultFolder);
    setItems((list) => [
      ...list.filter((x) => x.key !== item.key),
      { ...item, folder, status: there !== null ? "there" : "ready", message: there !== null ? `already in your data: ${there}` : "" },
    ]);
  };

  const fetchLinks = async (): Promise<void> => {
    setProblem("");
    const wanted = links.split(/\s+/).filter((l) => l !== "");
    if (wanted.length === 0) return;
    setBusy(true);
    for (const link of wanted) {
      try {
        const r = await postJSON<{ gameId: string; fileName: string; text: string }>("/api/pokernow", { link });
        add({ key: `ledger_${r.gameId}`, kind: "ledger", gameId: r.gameId, fileName: r.fileName, text: r.text });
      } catch (err) {
        setProblem(`${link}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setBusy(false);
    setLinks("");
  };

  const pickFiles = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    setProblem("");
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    for (const f of files) {
      const m = FILE_NAME.exec(f.name);
      if (m === null) {
        setProblem(`${f.name} is not a PokerNow ledger_… or poker_now_log_… file, so it was left out.`);
        continue;
      }
      const kind = m[1] as Item["kind"];
      const gameId = m[2] ?? "";
      add({ key: `${kind}_${gameId}`, kind, gameId, fileName: f.name, text: await f.text() });
    }
  };

  const save = async (item: Item): Promise<void> => {
    setItems((list) => list.map((x) => (x.key === item.key ? { ...x, status: "saving" } : x)));
    try {
      const r = await postJSON<{ saved: string }>("/api/save", { fileName: item.fileName, folder: item.folder, text: item.text });
      setItems((list) => list.map((x) => (x.key === item.key ? { ...x, status: "saved", message: `saved as Games/${r.saved}` } : x)));
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
          <code>Games</code> folder, the same place the console app's menu 19 puts it.
        </p>
        <textarea
          className="links"
          rows={3}
          placeholder="https://www.pokernow.com/games/pgl…"
          value={links}
          onChange={(e) => setLinks(e.target.value)}
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
        <input type="file" accept=".csv,text/csv" multiple onChange={(e) => void pickFiles(e)} />
      </section>

      {problem !== "" ? <p className="card pad down">{problem}</p> : null}

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
                      Save to Games/{item.folder}
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
            After saving, the game shows here and in the console app. Commit the new files to git as you usually do.
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

function FolderPicker({ folders, value, onChange, disabled }: { folders: string[]; value: string; onChange: (f: string) => void; disabled: boolean }) {
  const isNew = value !== "" && !folders.includes(value);
  const [typing, setTyping] = useState(isNew);
  if (typing) {
    return (
      <span className="row tight">
        <input type="text" value={value} placeholder="e.g. Nov 2026" onChange={(e) => onChange(e.target.value)} disabled={disabled} />
        <button className="link" onClick={() => setTyping(false)} disabled={disabled}>
          pick existing
        </button>
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
