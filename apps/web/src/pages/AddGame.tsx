import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { ledger, scopeContains, type Game } from "@plr/core";

import type { Ctx } from "../context.ts";
import { currentBasis, getLocalJSON, postJSON } from "../data.ts";
import { clockTime, longDate, moneyCents, moneySignedCents, plural, shortDate } from "../format.ts";
import { startOfFile, suggestFolder } from "../folders.ts";
import { resultsOf } from "../game.ts";
import { setNotice } from "../notice.ts";
import { href } from "../router.ts";

// The id its hand log is filed under: "ledger_pglX" -> "pglX".
function logId(game: Game): string {
  return game.id.replace(/^ledger_/, "");
}

const FILE_NAME = /^(ledger|poker_now_log)_(pgl[A-Za-z0-9_-]{10,40})(?: \(\d+\))?\.[cC][sS][vV]$/;

type Status = "ready" | "saving" | "saved" | "there" | "error";

// A PokerNow file in the Downloads folder, as the server lists it (GET /api/downloads).
export interface Downloaded {
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

// A file on this page, waiting to be filed: a ledger fetched from a link, or a file from Downloads or picked by hand.
interface Item {
  key: string;
  kind: "ledger" | "poker_now_log";
  gameId: string;
  fileName: string;
  text: string;
  folder: string;
  status: Status;
  message: string;
  picked: boolean; // ticked to be filed by the one button
  source: "link" | "file";
  bytes?: number;
}

// The newest copy of each game's file in Downloads that is not in the data yet (filed says), nor on this page
// (or is bigger than the copy on this page that is not filed yet: a log downloaded again after the night ended).
export function freshDownloads(
  files: readonly Downloaded[],
  items: readonly Pick<Item, "key" | "source" | "status" | "bytes">[],
  filed: (kind: Downloaded["kind"], gameId: string) => boolean,
): Downloaded[] {
  const seen = new Set<string>();
  return files.filter((f) => {
    const key = `${f.kind}_${f.gameId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (filed(f.kind, f.gameId)) return false;
    const here = items.find((x) => x.key === key);
    return here === undefined || (here.source === "file" && (here.status === "ready" || here.status === "error") && (here.bytes ?? 0) < f.bytes);
  });
}

// Where a game id already sits in the data, if anywhere.
function findExisting(ctx: Ctx, kind: Item["kind"], gameId: string): string | null {
  const name = `${kind}_${gameId}`;
  const paths = kind === "ledger" ? ctx.payload.ledgers.map((l) => l.relativePath) : ctx.payload.logs;
  return paths.find((p) => (p.split("/").pop() ?? "").startsWith(name)) ?? null;
}

// The last two parts of a folder's path, for the page's words: ".../Poker_Ledger_Web/data".
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
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

// + Add a game: paste the link (the ledger comes at once), and the PokerNow files in Downloads are listed
// and ticked; one button files them all. With no data folder yet, the same button starts one first.
// first: the data has no games yet, so this is the whole start page (Standings shows it then).
export function AddGame({ ctx, onSaved, first = false }: { ctx: Ctx; onSaved: () => void | Promise<void>; first?: boolean }) {
  const { world, tz } = ctx;
  // Older payloads (and a snapshot, which never saves) do not say: the Games folder is assumed.
  const gamesFolder = ctx.payload.gamesFolder ?? true;
  const folders = ledger.listFolders(world.games).filter((f) => f !== "(root)");
  const [links, setLinks] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [choosing, setChoosing] = useState(false);
  // A new folder's name as it is typed in the chooser (null: not typing one).
  const [draft, setDraft] = useState<string | null>(null);
  const [filed, setFiled] = useState<string | null>(null);
  // The basis the server checks each save against. A save returns the new one, so the next file of the
  // batch goes through without a reload; a reload of the data (after a save) sets it again.
  // While saves run, a reload that lands (Refresh pressed meanwhile) may carry the basis from before the
  // last save, so it is not taken then; the reload after the saves sets it.
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

  const fresh = freshDownloads(downloads?.files ?? [], items, (kind, gameId) => findExisting(ctx, kind, gameId) !== null);
  // Each new file in Downloads is read and put on the page, ticked, as menu 19 takes every PokerNow file
  // it finds there. A file is read once, by its name and size (unticking it keeps it off the button).
  const reading = useRef(new Set<string>());
  const readKey = (f: Downloaded): string => `${f.name}|${f.bytes}`;
  const freshKey = fresh.map(readKey).join("\n");
  useEffect(() => {
    const todo = fresh.filter((f) => !reading.current.has(readKey(f)));
    if (todo.length === 0) return;
    for (const f of todo) reading.current.add(readKey(f));
    void (async () => {
      const why: string[] = [];
      for (const f of todo) {
        try {
          const r = await getLocalJSON<{ name: string; text: string }>(`/api/downloads/${encodeURIComponent(f.name)}`);
          add({ key: `${f.kind}_${f.gameId}`, kind: f.kind, gameId: f.gameId, fileName: f.name, text: r.text, source: "file", bytes: f.bytes });
        } catch (err) {
          reading.current.delete(readKey(f));
          why.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (why.length > 0) setProblems((p) => [...p, ...why]);
    })();
    // fresh is worked out each render; its file names say when it changed.
  }, [freshKey]);

  if (!ctx.payload.canWrite) {
    return (
      <>
        <h1>Add a game</h1>
        <p className="lede">Adding games works only on the computer that holds the data.</p>
      </>
    );
  }
  // No data folder, and none may be started here: say what to do instead.
  const starting = ctx.payload.dataReady === false;
  if (starting && ctx.payload.canStartData !== true) {
    return (
      <>
        <h1>Add a game</h1>
        <p className="lede">There is no data folder to add games to yet.</p>
        <p className="sub">
          The site reads the console app&apos;s folder: put it next to this one (or set PLR_DATA_ROOT to it), then press{" "}
          <strong>Refresh</strong>.
          {ctx.payload.dataStartable === true ? (
            <>
              {" "}
              Not using the console app? The site starts a data folder of its own only in a folder that is empty (or not there yet), that
              it may write to, and that is not a link. If <code>{ctx.payload.dataRoot}</code> holds other files, move them out; otherwise set
              PLR_DATA_ROOT to such a folder. Then press <strong>Refresh</strong>.
            </>
          ) : null}
        </p>
      </>
    );
  }

  function add(item: Omit<Item, "status" | "message" | "folder" | "picked"> & { folder?: string }): void {
    const there = findExisting(ctx, item.kind, item.gameId);
    // A hand log goes next to its ledger: the one already filed in a folder, or the one on this page. A ledger at
    // the top of Games has no folder to share, and a game is never saved there. Anything else gets the folder
    // for its month (folders.ts), so filing it is one press.
    const ledgerAt = findExisting(ctx, "ledger", item.gameId);
    const inherited = ledgerAt !== null ? folderOfPath(ledgerAt) : "";
    const suggested = inherited !== "" ? inherited : suggestFolder(world.games, startOfFile(item.kind, item.text), tz);
    setItems((list) => {
      // The same file added again (the link pasted twice, a bigger download) keeps the tick and folder chosen for it.
      const prev = list.find((x) => x.key === item.key && (x.status === "ready" || x.status === "error"));
      const keep = there === null ? prev : undefined;
      return [
      ...list.filter((x) => x.key !== item.key),
      {
        ...item,
        folder:
          item.folder ??
          keep?.folder ??
          (item.kind === "poker_now_log" && inherited === ""
            ? (list.find((x) => x.kind === "ledger" && x.gameId === item.gameId)?.folder ?? suggested)
            : suggested),
        status: there !== null ? "there" : "ready",
        picked: keep?.picked ?? there === null,
        message:
          there !== null
            ? `already in your data: ${there}. To file it somewhere else, move that file (and its hand log) to the other folder yourself, in Finder or File Explorer, then press Refresh.`
            : "",
      },
      ];
    });
  }

  // Every link is tried. The ones that fail stay in the box, each with what went wrong, to fix or try again.
  const fetchLinks = async (text: string): Promise<void> => {
    setProblems([]);
    setFiled(null);
    const wanted = text.split(/\s+/).filter((l) => l !== "");
    if (wanted.length === 0) return;
    setFetching(true);
    const failed: string[] = [];
    const why: string[] = [];
    for (const link of wanted) {
      try {
        const r = await postJSON<{ gameId: string; fileName: string; text: string }>("/api/pokernow", { link });
        add({ key: `ledger_${r.gameId}`, kind: "ledger", gameId: r.gameId, fileName: r.fileName, text: r.text, source: "link" });
      } catch (err) {
        failed.push(link);
        why.push(`${link}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setFetching(false);
    setProblems(why);
    setLinks(failed.join("\n"));
  };

  const pickFiles = async (files: File[]): Promise<void> => {
    setProblems([]);
    setFiled(null);
    const why: string[] = [];
    for (const f of files) {
      const m = FILE_NAME.exec(f.name);
      if (m === null) {
        why.push(`${f.name} is not a PokerNow ledger_… or poker_now_log_… file, so it was left out.`);
        continue;
      }
      const kind = m[1] as Item["kind"];
      const gameId = m[2] ?? "";
      add({ key: `${kind}_${gameId}`, kind, gameId, fileName: f.name, text: await f.text(), source: "file", bytes: f.size });
    }
    setProblems(why);
  };
  const onPick = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    void pickFiles(files);
  };
  const onDrop = (e: DragEvent<HTMLElement>): void => {
    if (e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    void pickFiles([...e.dataTransfer.files]);
  };

  // Files one item. reload: whether the page reads the data again afterwards (the batch reads it once, at the
  // end, so a reload that lands between two saves cannot hand the next save an older basis).
  // Resolves to null when it is filed, or to what went wrong.
  const save = async (item: Item, reload = true): Promise<string | null> => {
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
      const message = [`filed as ${savedLabel(r.saved, gamesFolder)}`, ...notes].join(" · ");
      setItems((list) => list.map((x) => (x.key === item.key ? { ...x, status: "saved", picked: false, message } : x)));
      if (reload) void onSaved();
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setItems((list) => list.map((x) => (x.key === item.key ? { ...x, status: "error", message } : x)));
      return message;
    } finally {
      saving.current--;
    }
  };

  // Ledgers first, so a game's hand log is filed after the game itself.
  const toFile = items
    .filter((x) => x.picked && (x.status === "ready" || x.status === "error") && x.folder.trim() !== "")
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "ledger" ? -1 : 1));
  const targets = [...new Set(toFile.map((x) => x.folder))];

  // The one button: (with no data folder yet, start one first), then file every ticked file.
  const fileAll = async (): Promise<void> => {
    if (toFile.length === 0) return;
    setBusy(true);
    setProblems([]);
    saving.current++;
    let done = 0;
    const failed: string[] = [];
    try {
      if (starting) {
        await postJSON<{ started: string }>("/api/start-data", {});
        const now = await currentBasis();
        if (now === null) throw new Error("The data folder was started, but the site could not read it back. Press Refresh, then file the game again.");
        basis.current = now;
      }
      for (const item of toFile) {
        const why = await save(item, false);
        if (why === null) done++;
        else failed.push(`${item.fileName}: ${why}`);
      }
      // On a first run, Standings takes this page's place once a game is in, so the rest is said above it.
      if (first && done > 0 && failed.length > 0) {
        setNotice(`Filed ${done} of ${toFile.length}. Not filed: ${failed.join("; ")}. Add ${failed.length === 1 ? "it" : "them"} again on + Add.`);
      }
      setFiled(
        done === 0
          ? null
          : `Filed ${done === toFile.length ? (done === 1 ? "it" : `all ${done}`) : `${done} of ${toFile.length}`}${targets.length === 1 ? ` into ${savedLabel(targets[0] ?? "", gamesFolder)}` : ""}. ${done === 1 ? "It shows" : "They show"} on every page now.`,
      );
    } catch (err) {
      setProblems([err instanceof Error ? err.message : String(err)]);
    } finally {
      saving.current--;
      setBusy(false);
      void onSaved();
    }
  };

  const setPicked = (key: string, picked: boolean): void => setItems((list) => list.map((x) => (x.key === key ? { ...x, picked } : x)));
  // "Choose another folder": every ticked file moves there, except a hand log whose ledger is filed already
  // (it always goes next to its ledger).
  const moveAll = (folder: string): void =>
    setItems((list) =>
      list.map((x) => (x.picked && !(x.kind === "poker_now_log" && findExisting(ctx, "ledger", x.gameId) !== null) ? { ...x, folder } : x)),
    );

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

  const fromLinks = items.filter((x) => x.source === "link");
  // The files, each game's ledger before its hand log, the games in the order they came (newest download first).
  const order = [...new Set(items.filter((x) => x.source === "file").map((x) => x.gameId))];
  const files = items
    .filter((x) => x.source === "file")
    .sort((a, b) => order.indexOf(a.gameId) - order.indexOf(b.gameId) || (a.kind === b.kind ? 0 : a.kind === "ledger" ? -1 : 1));
  const linkIds = new Set(fromLinks.map((x) => x.gameId));
  // Games with no hand log yet, newest first, with a link to download it.
  const missingAll = [...world.games].reverse().filter((g) => findExisting(ctx, "poker_now_log", logId(g)) === null);
  const missing = missingAll.slice(0, 12);
  // While a new folder's name is being typed, the files keep their folder until the name is not blank.
  const unnamed = choosing && draft !== null && draft.trim() === "";
  const one = toFile.length === 1;
  const games = new Set(toFile.map((x) => x.gameId)).size;
  const label = starting
    ? games === 1
      ? "Start with this game"
      : `Start with these ${games} games`
    : `File ${one ? "it" : toFile.length === 2 ? "both" : `all ${toFile.length}`}${targets.length === 1 ? ` into ${targets[0] ?? ""}` : ""}`;

  return (
    <div onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <h1>{first ? "Start with your first game" : "Add a game"}</h1>
      {first ? (
        <>
          <p className="lede">
            Paste the PokerNow link of a game your group played, then press the one button. The site keeps the results on this computer, in the
            same files the console app uses, and adds every next game the same way.
          </p>
          <p className="sub">
            {starting ? (
              <>
                The first game also makes the data folder, <code title={ctx.payload.dataRoot}>{shortPath(ctx.payload.dataRoot)}</code>. Keep it
                out of git: it holds everyone&apos;s names and results.{" "}
              </>
            ) : null}
            Already use the console app? Put its <code>Poker_Ledger_Reader</code> folder next to this one and press <strong>Refresh</strong>{" "}
            instead.
          </p>
        </>
      ) : (
        <p className="lede">
          Paste the game&apos;s link; the PokerNow files in your Downloads folder are listed too. One button files them all into your{" "}
          {gamesFolder ? (
            <>
              <code>Games</code> folder, the same place the console app&apos;s menu 19 puts it.
            </>
          ) : (
            <>
              data folder, in a folder of its own at the top level (there is no <code>Games</code> folder yet, so the console app reads games
              from there too).
            </>
          )}
        </p>
      )}
      {ctx.payload.consoleOpen > 0 ? (
        <p className="banner" role="status">
          The console app is open. A game filed here is saved at once, but the console app lists it only after it is restarted.
        </p>
      ) : null}

      <section className="sec paste" aria-labelledby="paste-h">
        <h2 id="paste-h">
          <label htmlFor="pokernow-links">Paste the PokerNow link</label>
        </h2>
        <textarea
          id="pokernow-links"
          className="links"
          rows={2}
          placeholder="https://www.pokernow.com/games/pgl…"
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (!/pgl[A-Za-z0-9_-]{6,}/.test(text)) return;
            e.preventDefault();
            const next = links.trim() === "" ? text.trim() : `${links.trim()}\n${text.trim()}`;
            setLinks(next);
            void fetchLinks(next);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey) return;
            e.preventDefault();
            void fetchLinks(links);
          }}
          aria-describedby="paste-how"
          disabled={fetching || busy}
        />
        <p id="paste-how" className="sub">
          {fetching
            ? "Fetching the ledger from PokerNow…"
            : "The ledger is fetched as soon as the link is pasted. Several links work too, one per line."}
          {links.trim() !== "" && !fetching ? (
            <>
              {" "}
              <button className="link" onClick={() => void fetchLinks(links)} disabled={busy}>
                Fetch the ledger
              </button>
            </>
          ) : null}
        </p>
        {problems.length > 0 ? (
          <div className="warnbox small down" role="alert">
            {problems.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        ) : null}
      </section>

      {fromLinks.map((item) => (
        <FoundSlip
          key={item.key}
          ctx={ctx}
          item={item}
          gamesFolder={gamesFolder}
          log={items.find((x) => x.kind === "poker_now_log" && x.gameId === item.gameId)}
          onPick={(p) => setPicked(item.key, p)}
          disabled={busy}
        />
      ))}

      <section className="sec" aria-labelledby="dl-h">
        <div className="sec-h">
          <h2 id="dl-h">
            In Downloads
            {files.some((x) => x.status !== "saved") ? ` · ${plural(files.filter((x) => x.status !== "saved").length, "new file")}` : ""}
          </h2>
          <label className="choosefile">
            <input type="file" accept=".csv,text/csv" multiple onChange={onPick} aria-label="Choose files to add (ledgers and hand logs)" />
            <span>Choose files…</span>
          </label>
        </div>
        <DownloadsNote list={downloads} any={files.length > 0} />
        {files.length > 0 ? (
          <ul className="files">
            {files.map((item) => (
              <FileRow
                key={item.key}
                ctx={ctx}
                item={item}
                paired={items.some((x) => x.kind === "ledger" && x.gameId === item.gameId && x.key !== item.key)}
                gamesFolder={gamesFolder}
                tag={linkIds.size === 0 ? "" : linkIds.has(item.gameId) ? "this game" : "another game"}
                onPick={(p) => setPicked(item.key, p)}
                disabled={busy}
              />
            ))}
          </ul>
        ) : null}
        <BiggerNote bigger={bigger} gamesFolder={gamesFolder} />
      </section>

      {toFile.length > 0 || filed !== null ? (
        <div className="filebar">
          {toFile.length > 0 ? (
            <>
              <button className="block" onClick={() => void fileAll()} disabled={busy || unnamed}>
                {busy ? "Filing…" : unnamed ? "Type a folder name" : label}
              </button>
              <p className="sub">
                {targets.length > 1 ? "Each to the folder shown with it. " : ""}
                {choosing ? (
                  <span className="row tight">
                    <FolderPicker
                      folders={folders}
                      value={draft ?? targets[0] ?? ""}
                      onChange={(f) => {
                        setDraft(f);
                        if (f.trim() !== "") moveAll(f.trim());
                      }}
                      disabled={busy}
                    />
                    <button
                      className="link"
                      onClick={() => {
                        setChoosing(false);
                        setDraft(null);
                      }}
                    >
                      Done
                    </button>
                  </span>
                ) : (
                  <button className="link" onClick={() => setChoosing(true)} disabled={busy}>
                    Choose another folder
                  </button>
                )}
              </p>
            </>
          ) : (
            <p className="small up" role="status">
              ✓ {filed}
            </p>
          )}
        </div>
      ) : null}

      {items.some((x) => x.status === "saved") ? (
        <p className="note">
          A filed game shows on every page at once (when the Folder and Dates at the top include it); the console app lists it after it is
          restarted. Game files hold everyone&apos;s names and results: keep them out of git, or keep that repository private.
        </p>
      ) : null}

      {missing.length > 0 && !starting ? (
        <details className="fold">
          <summary>Nights without a hand log ({missingAll.length})</summary>
          <p className="sub">
            Newest first{missingAll.length > missing.length ? `, the latest ${missing.length}` : ""}. Open the game on PokerNow and choose Download
            log; it shows up above when you come back.
          </p>
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
        </details>
      ) : null}
    </div>
  );
}

// The game a link fetched, as a slip: when, how many, how much, and whether its hand log is here too.
function FoundSlip({
  ctx,
  item,
  gamesFolder,
  log,
  onPick,
  disabled,
}: {
  ctx: Ctx;
  item: Item;
  gamesFolder: boolean;
  log: Item | undefined;
  onPick: (picked: boolean) => void;
  disabled: boolean;
}) {
  const loaded = ledger.loadAllGames([{ relativePath: `${item.folder || "new"}/${item.fileName}`, text: item.text }]);
  const game = loaded.games[0];
  const logFiled = findExisting(ctx, "poker_now_log", item.gameId);
  const results = game === undefined ? [] : resultsOf(game, ctx.world.rules);
  const offBy = results.reduce((s, r) => s + r.netCents, 0);
  const top = results[0];
  return (
    <section className="sec found" aria-label="The game from the link">
      <div className="sec-h">
        <h2>Found from the link</h2>
        <Tick item={item} onPick={onPick} disabled={disabled} />
      </div>
      {game === undefined ? (
        <p className="down">The ledger has no played seats.</p>
      ) : (
        <div className="slip">
          <Line k="Game" v={`${longDate(game.start, ctx.tz)} · ${clockTime(game.start, ctx.tz)}`} />
          <Line k="Players" v={String(results.length)} mono />
          <Line k="Bought in" v={moneyCents(game.totalBuyInCents)} mono />
          {top !== undefined && top.netCents > 0 ? <Line k="Top" v={`${ctx.nameOf(top.person)} ${moneySignedCents(top.netCents)}`} /> : null}
          <Line k="Books" v={offBy === 0 ? "add up to $0.00 ✓" : `off by ${moneySignedCents(offBy)}`} tone={offBy === 0 ? "" : "down"} />
          <Line
            k="Hand log"
            v={logFiled !== null ? "filed already ✓" : log !== undefined ? (log.status === "saved" ? "filed ✓" : "in Downloads ✓") : "not downloaded yet"}
          />
        </div>
      )}
      <ItemNote item={item} gamesFolder={gamesFolder} />
      {game !== undefined && logFiled === null && log === undefined ? (
        <details className="fold">
          <summary>How to get the hand log</summary>
          <ol className="steps">
            <li>
              Open{" "}
              <a href={`https://www.pokernow.com/games/${item.gameId}`} target="_blank" rel="noreferrer">
                the game on PokerNow ↗
              </a>
              .
            </li>
            <li>Choose Download log (PokerNow asks a person to do this, so the site cannot).</li>
            <li>Come back here: the file shows up under In Downloads, ticked.</li>
          </ol>
        </details>
      ) : null}
    </section>
  );
}

function Line({ k, v, mono = false, tone = "" }: { k: string; v: string; mono?: boolean; tone?: string }) {
  return (
    <div className="pl">
      <span className="who">{k}</span>
      <span className="lead" aria-hidden="true" />
      <span className={`${mono ? "amt " : ""}${tone}`}>{v}</span>
    </div>
  );
}

// A file from Downloads (or picked by hand): its kind, which game it is, its size, and where it goes.
function FileRow({
  ctx,
  item,
  paired,
  gamesFolder,
  tag,
  onPick,
  disabled,
}: {
  ctx: Ctx;
  item: Item;
  paired: boolean; // its ledger is on this page too
  gamesFolder: boolean;
  tag: string;
  onPick: (picked: boolean) => void;
  disabled: boolean;
}) {
  return (
    <li>
      <Tick item={item} onPick={onPick} disabled={disabled} />
      <div>
        <div className="fn">{item.fileName}</div>
        <div className="meta">
          <Preview ctx={ctx} item={item} paired={paired} />
          {item.bytes !== undefined ? ` · ${fileSize(item.bytes)}` : ""}
        </div>
        <ItemNote item={item} gamesFolder={gamesFolder} />
      </div>
      {tag !== "" ? <span className="tag">{tag}</span> : <span />}
    </li>
  );
}

// The tick that puts a file on the one button (or a word saying why it is not there).
function Tick({ item, onPick, disabled }: { item: Item; onPick: (picked: boolean) => void; disabled: boolean }) {
  if (item.status === "saved") return <span className="tickdone" aria-label="Filed">✓</span>;
  if (item.status === "saving") return <span className="sub">…</span>;
  return (
    <input
      type="checkbox"
      checked={item.picked}
      disabled={disabled || item.status === "there"}
      onChange={(e) => onPick(e.target.checked)}
      aria-label={`File ${item.fileName}`}
    />
  );
}

// Where the file goes, or what happened to it.
function ItemNote({ item, gamesFolder }: { item: Item; gamesFolder: boolean }) {
  if (item.message !== "") {
    return <p className={item.status === "error" ? "small down" : item.status === "saved" ? "small up" : "sub"}>{item.message}</p>;
  }
  if (!item.picked) return null;
  return <p className="sub">Goes to {savedLabel(item.folder, gamesFolder)}</p>;
}

// What the Downloads folder said, when there is nothing to list from it.
function DownloadsNote({ list, any }: { list: DownloadsList | null; any: boolean }) {
  if (list !== null && list.unreadable !== undefined) {
    return (
      <p className="sub">
        The site may not open your Downloads folder ({list.unreadable}). On a Mac, allow the app that runs the site (Terminal) in System
        Settings → Privacy &amp; Security → Files and Folders, then press <strong>Refresh</strong>. You can still choose the files yourself.
      </p>
    );
  }
  if (any) return null;
  return (
    <p className="sub">
      {list === null || !list.found ? "Choose the files yourself, or drop them on this page." : "No new PokerNow files in Downloads."} Hand
      logs come from PokerNow&apos;s Download log; they show up here when you come back to this page.
    </p>
  );
}

// Downloads bigger than the copy of the same game already filed.
function BiggerNote({ bigger, gamesFolder }: { bigger: Downloaded[]; gamesFolder: boolean }) {
  if (bigger.length === 0) return null;
  return (
    <div className="downloads">
      <p>
        <strong>{plural(bigger.length, "download")}</strong> bigger than the copy already filed:
      </p>
      <ul className="plain small">
        {bigger.map((f) => (
          <li key={f.name}>
            <code>{f.name}</code>{" "}
            <span className="muted">
              · {sizes(f.bytes, f.filed?.bytes ?? 0)[0]}; filed at {savedLabel(f.filed?.path ?? "", gamesFolder)}, {sizes(f.bytes, f.filed?.bytes ?? 0)[1]}
            </span>
          </li>
        ))}
      </ul>
      <p className="sub">
        A game filed before the night ended holds less. The site never files over a game: to use the bigger copy, move the filed file out of its
        folder yourself (in Finder or File Explorer), press <strong>Refresh</strong>, then add this one.
      </p>
    </div>
  );
}

// A file's size in KB: "184 KB" (never "0 KB").
function fileSize(n: number): string {
  return `${Math.max(1, Math.round(n / 1024)).toLocaleString("en-US")} KB`;
}

// Two file sizes, in KB, or in bytes when the KB would read the same (a small ledger), so the bigger one shows.
export function sizes(a: number, b: number): [string, string] {
  if (fileSize(a) !== fileSize(b)) return [fileSize(a), fileSize(b)];
  const exact = (n: number): string => `${n.toLocaleString("en-US")} bytes`;
  return [exact(a), exact(b)];
}

// What to add to "filed as ..." for a game just filed: that the Folder or Dates at the top hide it, and,
// for a hand log, that its ledger is not filed yet (nor on this page to file).
export function afterSaveNotes(ctx: Ctx, item: Pick<Item, "kind" | "gameId" | "text">, saved: string, items: readonly Pick<Item, "kind" | "gameId">[]): string[] {
  const notes: string[] = [];
  const folder = folderOfPath(saved);
  const start = item.kind === "ledger" ? (ledger.loadAllGames([{ relativePath: saved, text: item.text }]).games[0]?.start ?? null) : null;
  const shown = item.kind === "ledger" ? scopeContains(ctx.scope, folder, start) : ctx.scope.folder === "" || ctx.scope.folder === folder;
  if (!shown) notes.push("the Folder or Dates choice (at the top of Standings) hides it: pick All folders and All time there to see it");
  if (
    item.kind === "poker_now_log" &&
    findExisting(ctx, "ledger", item.gameId) === null &&
    !items.some((x) => x.kind === "ledger" && x.gameId === item.gameId)
  ) {
    notes.push("its ledger is not filed yet: add that too");
  }
  return notes;
}

// One line about a file: a ledger's night, a hand log's hands and which game it pairs with.
function Preview({ ctx, item, paired = false }: { ctx: Ctx; item: Item; paired?: boolean }) {
  if (item.kind === "poker_now_log") {
    const ledgerAt = findExisting(ctx, "ledger", item.gameId);
    const hands = (item.text.match(/-- starting hand #/g) ?? []).length;
    const pairs = ledgerAt !== null ? `pairs with ${ledgerAt}` : paired ? "pairs with the ledger on this page" : "its ledger is not in your data yet; add that too";
    return (
      <>
        Hand log · {plural(hands, "hand")} · {pairs}
      </>
    );
  }
  const loaded = ledger.loadAllGames([{ relativePath: `${item.folder || "new"}/${item.fileName}`, text: item.text }]);
  const game = loaded.games[0];
  if (game === undefined) return <span className="down">The ledger has no played seats.</span>;
  const results = resultsOf(game, ctx.world.rules);
  const offBy = results.reduce((s, r) => s + r.netCents, 0);
  return (
    <>
      Ledger · {shortDate(game.start, ctx.tz)} · {plural(results.length, "player")} · {moneyCents(game.totalBuyInCents)} bought in ·{" "}
      <span className={offBy === 0 ? "" : "down"}>{offBy === 0 ? "balanced" : `off by ${moneySignedCents(offBy)}`}</span>
    </>
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
        <input type="text" value={value} placeholder="e.g. Nov 2026" onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label="Folder name" />
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
      aria-label="Folder"
      onChange={(e) => {
        // "" asks for a name to be typed: the page keeps each file's folder until the name is not blank.
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
