// Checks that nothing git would commit in this repo, nor the history of the checked-out branch,
// contains a real value from the real data: nicknames (including the names in hand-log
// "name @ id" tokens), normalized names, player ids, game and ledger ids, sit-down timestamps,
// and the notes and session ids saved in Saved_Data (12+ characters). The real values are read
// at run time and kept in memory only: they are never written to disk and never printed.
//   node tools/check-privacy.ts [--data <real data root>]     (default: ../Poker_Ledger_Reader)
//
// It fails closed: no real values loaded, a game CSV with no player_nickname column (its values
// could not be checked), or any hit, each exits non-zero. Text is compared with accents folded
// and separators ignored only where that is the same value; the match is otherwise exact.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// SHA-256 (lowercase hex) of text the app writes itself, or of an ordinary word that happens to be
// someone's nickname. Only hashes are stored, never the words. Add a hash only after a hit is read in context.
const ALLOW_HASHES = new Set<string>([
  "9f584196e7fe6de85d3898bc0b11c78b1d0a1d49530ee5eaf7c26c3939cf043d",
  "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e",
  "3547cb112ac4489af2310c0626cdba6f3097a2ad5a3b42ddd3b59c76c7a079a3",
  "bc16f5825a9dafc8c245dc7cd93f4e671a9885035a73e6ef29c04f2d3863bfab",
  "c28f28a284eadc147f0a50c19219b7d3784af2603c1496e53707ab206ec3fb84",
  // "checked: name was right": the note the C++ app writes for a seat whose name was right (src/seats.cpp).
  "2588677ff48e3343704bd1630283cab935817273e2e77b42eb6139008ce815ec",
]);

// Folders the app never searches for ledgers (util.cpp isExcludedDir).
const EXCLUDED_DIRS = new Set(["Saved_Data", ".git", ".idea", "build", "reports"]);

// Saved_Data columns by what they hold.
const NORMALIZED_COLUMNS = new Set([
  "alias_normalized", "canonical_normalized", "payer_normalized", "payee_normalized",
  "owner_normalized", "player_normalized", "from_normalized", "to_normalized",
]);
const DISPLAY_COLUMNS = new Set(["nickname", "from_display", "to_display"]);
const ID_COLUMNS = new Set(["player_id", "ledger_id"]);
const TIME_COLUMNS = new Set(["session_start_at", "session_end_at"]);
const FREE_TEXT_COLUMNS = new Set(["note", "session_id"]);

// The shortest real value of each kind that is checked. Shorter values are too common to match.
const MIN_LENGTH = { name: 3, id: 4, time: 19, note: 12 } as const;
type Kind = keyof typeof MIN_LENGTH;

interface Term {
  kind: Kind;
  term: string;
  hash: string;
  re: RegExp;
}

// Hand-log entries name a player as "Name @ id" inside quotes (src/handlog.cpp).
const HAND_TOKEN = /"([^"]+?) @ ([^"]+?)"/g;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Accents and combining marks removed, lower-cased: "Renée" and "renee" match.
function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

// RFC 4180 style: quoted fields, doubled quotes, CRLF or LF rows.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// The app's normalizeName: letters only, lowercase; a name with no letters keeps its digits.
function normalizeName(name: string): string {
  const letters = name.replace(/[^A-Za-z]/g, "").toLowerCase();
  return letters !== "" ? letters : name.replace(/[^0-9]/g, "");
}

// Every .csv under dir, skipping the folders the app never searches for games.
function walkCsv(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name) && !entry.name.startsWith("cmake-build")) walkCsv(path, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv")) {
      out.push(path);
    }
  }
}

// Every .csv under Saved_Data, reports/ included.
function walkAllCsv(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkAllCsv(path, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv")) out.push(path);
  }
}

interface RealValues {
  found: Map<string, { kind: Kind; term: string }>; // key: kind and lower-cased term
  unrecognized: number; // game CSVs with no player_nickname column (only their count is reported)
}

function loadReal(dataRoot: string): RealValues {
  const found = new Map<string, { kind: Kind; term: string }>();
  const add = (kind: Kind, raw: string): void => {
    const term = raw.trim();
    if ([...term].length < MIN_LENGTH[kind]) return;
    found.set(`${kind}|${term.toLowerCase()}`, { kind, term });
  };
  // A name counts as written and as normalized.
  const addName = (raw: string): void => {
    add("name", raw);
    add("name", normalizeName(raw.trim()));
  };

  let unrecognized = 0;
  const games = existsSync(join(dataRoot, "Games")) ? join(dataRoot, "Games") : dataRoot;
  const files: string[] = [];
  walkCsv(games, files);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const stem = basename(file, ".csv").split(" ")[0] ?? ""; // "ledger_pglX (1)" -> "ledger_pglX"
    if (stem.startsWith("poker_now_log_")) {
      add("id", stem);
      add("id", stem.slice("poker_now_log_".length));
      // The hand log's own entries name people: "Name @ id".
      for (const row of parseCsv(text)) {
        for (const cell of row) {
          for (const m of cell.matchAll(HAND_TOKEN)) {
            addName(m[1] ?? "");
            add("id", m[2] ?? "");
          }
        }
      }
      continue;
    }
    const rows = parseCsv(text);
    const header = (rows[0] ?? []).map((h) => h.trim());
    const nick = header.indexOf("player_nickname");
    if (nick < 0) {
      unrecognized++;
      continue;
    }
    const playerId = header.indexOf("player_id");
    const timeColumns = [...TIME_COLUMNS].map((c) => header.indexOf(c)).filter((i) => i >= 0);
    add("id", stem);
    add("id", stem.replace(/^ledger_/, ""));
    for (const row of rows.slice(1)) {
      addName(row[nick] ?? "");
      if (playerId >= 0) add("id", row[playerId] ?? "");
      for (const i of timeColumns) add("time", row[i] ?? "");
    }
  }

  const saved = join(dataRoot, "Saved_Data");
  if (existsSync(saved)) {
    const savedFiles: string[] = [];
    walkAllCsv(saved, savedFiles);
    for (const file of savedFiles) {
      const rows = parseCsv(readFileSync(file, "utf8"));
      const header = (rows[0] ?? []).map((h) => h.trim());
      for (const row of rows.slice(1)) {
        header.forEach((column, i) => {
          const value = (row[i] ?? "").trim();
          if (value === "") return;
          if (NORMALIZED_COLUMNS.has(column)) add("name", value);
          else if (DISPLAY_COLUMNS.has(column)) addName(value);
          else if (ID_COLUMNS.has(column)) add("id", value);
          else if (TIME_COLUMNS.has(column)) add("time", value);
          else if (FREE_TEXT_COLUMNS.has(column)) add("note", value);
          else if (column === "value" && (row[0] === "me" || row[0] === "banker")) add("name", value);
        });
      }
    }
  }
  return { found, unrecognized };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// Whole word, for names: "Ada" matches "ada" and "ADA" but not "adagio".
function wordPattern(term: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(fold(term))}(?![\\p{L}\\p{N}])`, "u");
}

// Anywhere in the text, for ids, timestamps and notes.
function substringPattern(term: string): RegExp {
  return new RegExp(escapeRegex(fold(term)), "u");
}

// First letter of each word kept, the rest starred: the hit is shown without the term.
function mask(term: string): string {
  return term
    .split(/(\s+)/)
    .map((part) => (part.trim() === "" ? part : [...part].map((ch, i) => (i === 0 ? ch : "*")).join("")))
    .join("");
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function main(): number {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--data");
  const dataRoot = at >= 0 && argv[at + 1] ? resolve(argv[at + 1] ?? "") : resolve(REPO, "..", "Poker_Ledger_Reader");
  if (!existsSync(dataRoot) || !statSync(dataRoot).isDirectory()) {
    console.error(`privacy check: no real data folder at --data ${dataRoot}`);
    return 2;
  }

  const real = loadReal(dataRoot);
  if (real.unrecognized > 0) {
    console.log(
      `FAIL: ${real.unrecognized} CSV file(s) in the game folder have no player_nickname column, ` +
        "so their values cannot be checked. Fix or move them, then run again.",
    );
    return 1;
  }
  const terms: Term[] = [...real.found.values()].map(({ kind, term }) => ({
    kind,
    term,
    hash: sha256(term.toLowerCase()),
    re: kind === "name" ? wordPattern(term) : substringPattern(term),
  }));
  if (terms.length === 0) {
    console.log("privacy check: no real values were loaded, so nothing can be checked. Refusing to pass.");
    return 2;
  }

  const active = terms.filter((t) => !ALLOW_HASHES.has(t.hash));
  const allowed = terms.length - active.length;
  const matchesIn = (text: string): Term[] => {
    const folded = fold(text);
    return active.filter((t) => t.re.test(folded));
  };
  const describe = (t: Term): string => `${t.kind} "${mask(t.term)}" (sha256 ${t.hash.slice(0, 12)})`;

  // Every file git would commit: tracked files plus untracked ones that are not ignored.
  const listed = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
  const files = [...new Set(listed)];
  let scanned = 0;
  let binary = 0;
  const hits: string[] = [];

  for (const path of files) {
    const full = join(REPO, path);
    if (!existsSync(full) || statSync(full).isDirectory()) continue;
    const bytes = readFileSync(full);
    scanned++;
    if (bytes.subarray(0, 8000).includes(0)) {
      binary++;
      continue;
    }
    // A path that itself holds a real value is not printed, only counted as a hit.
    const pathHits = matchesIn(path);
    const shown = pathHits.length > 0 ? "(path hidden: it holds a real value)" : path;
    for (const t of pathHits) hits.push(`${shown}: in the file name, ${describe(t)}`);
    const lines = bytes.toString("utf8").split("\n");
    lines.forEach((line, i) => {
      for (const t of matchesIn(line)) hits.push(`${shown}:${i + 1}: ${describe(t)}`);
    });
  }

  // The history of the checked-out branch: commit messages, authors and every diff line.
  const history = git(["log", "-p", "--no-color", "--format=commit %h%n%an <%ae>%n%B"]);
  const historyLines = history.split("\n");
  historyLines.forEach((line, i) => {
    for (const t of matchesIn(line)) hits.push(`git history line ${i + 1}: ${describe(t)}`);
  });
  const commits = git(["rev-list", "--count", "HEAD"]).trim();

  const count = (kind: Kind): number => terms.filter((t) => t.kind === kind).length;
  console.log(
    `privacy check: ${scanned} files scanned (${binary} binary, skipped) and ${commits} commit(s) of history; ` +
      `${terms.length} real values (${count("name")} names, ${count("id")} ids, ${count("time")} timestamps, ` +
      `${count("note")} notes); ${allowed} allow-listed.`,
  );
  if (hits.length > 0) {
    for (const hit of hits) console.log(hit);
    console.log(`FAIL: ${hits.length} hit(s). Remove the value, or allow-list an ordinary word by its SHA-256.`);
    return 1;
  }
  console.log("PASS: no real names, ids, timestamps or notes in anything git would commit or in the history.");
  return 0;
}

process.exitCode = main();
