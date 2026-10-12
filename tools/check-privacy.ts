// Checks that nothing git would commit in this repo contains a real nickname, normalized name,
// player id or ledger id from the real data. The real values are read at run time and kept in
// memory only: they are never written to disk and never printed. Run: npm run check:privacy
//   node tools/check-privacy.ts [--data <real data root>]     (default: ../Poker_Ledger_Reader)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// SHA-256 (lowercase hex) of ordinary English words that happen to be someone's nickname.
// Only hashes are stored, never the words. Add a hash only after a hit is read in context.
const ALLOW_HASHES = new Set<string>([
  "9f584196e7fe6de85d3898bc0b11c78b1d0a1d49530ee5eaf7c26c3939cf043d",
  "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e",
  "3547cb112ac4489af2310c0626cdba6f3097a2ad5a3b42ddd3b59c76c7a079a3",
  "bc16f5825a9dafc8c245dc7cd93f4e671a9885035a73e6ef29c04f2d3863bfab",
  "c28f28a284eadc147f0a50c19219b7d3784af2603c1496e53707ab206ec3fb84",
]);

// Folders the app never searches for ledgers (util.cpp isExcludedDir).
const EXCLUDED_DIRS = new Set(["Saved_Data", ".git", ".idea", "build", "reports"]);

// Saved_Data columns that hold a person's normalized name, a display name, or an id.
const NORMALIZED_COLUMNS = new Set([
  "alias_normalized", "canonical_normalized", "payer_normalized", "payee_normalized",
  "owner_normalized", "player_normalized", "from_normalized", "to_normalized",
]);
const DISPLAY_COLUMNS = new Set(["nickname", "from_display", "to_display"]);
const ID_COLUMNS = new Set(["player_id", "ledger_id"]);

type Term = { kind: "name" | "id"; term: string; hash: string; re: RegExp | null };

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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

interface RealValues {
  names: Set<string>;        // nicknames and display names, as written
  normalized: Set<string>;   // normalized names
  ids: Set<string>;          // player ids and ledger ids
}

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

function loadReal(dataRoot: string): RealValues {
  const values: RealValues = { names: new Set(), normalized: new Set(), ids: new Set() };
  const addName = (raw: string): void => {
    const name = raw.trim();
    if ([...name].length >= 3) values.names.add(name);
    const norm = normalizeName(name);
    if ([...norm].length >= 3) values.normalized.add(norm);
  };
  const addNormalized = (raw: string): void => {
    const norm = raw.trim().toLowerCase();
    if ([...norm].length >= 3) values.normalized.add(norm);
  };
  const addId = (raw: string): void => {
    const id = raw.trim();
    if ([...id].length >= 4) values.ids.add(id);
  };

  const games = existsSync(join(dataRoot, "Games")) ? join(dataRoot, "Games") : dataRoot;
  const files: string[] = [];
  walkCsv(games, files);
  for (const file of files) {
    const stem = basename(file, ".csv").split(" ")[0] ?? "";   // "ledger_pglX (1)" -> "ledger_pglX"
    if (stem.startsWith("poker_now_log_")) {
      addId(stem);
      addId(stem.slice("poker_now_log_".length));
      continue;
    }
    const rows = parseCsv(readFileSync(file, "utf8"));
    const header = (rows[0] ?? []).map((h) => h.trim());
    const nick = header.indexOf("player_nickname");
    const playerId = header.indexOf("player_id");
    if (nick < 0) continue;
    addId(stem);
    addId(stem.replace(/^ledger_/, ""));
    for (const row of rows.slice(1)) {
      addName(row[nick] ?? "");
      if (playerId >= 0) addId(row[playerId] ?? "");
    }
  }

  const saved = join(dataRoot, "Saved_Data");
  if (existsSync(saved)) {
    for (const name of readdirSync(saved)) {
      if (!name.toLowerCase().endsWith(".csv")) continue;
      const rows = parseCsv(readFileSync(join(saved, name), "utf8"));
      const header = (rows[0] ?? []).map((h) => h.trim());
      for (const row of rows.slice(1)) {
        header.forEach((column, i) => {
          const value = (row[i] ?? "").trim();
          if (value === "") return;
          if (NORMALIZED_COLUMNS.has(column)) addNormalized(value);
          else if (DISPLAY_COLUMNS.has(column)) addName(value);
          else if (ID_COLUMNS.has(column)) addId(value);
          else if (column === "value" && (row[0] === "me" || row[0] === "banker")) addNormalized(value);
        });
      }
    }
  }
  return values;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// Whole word, any case. "Ada" matches "ada" and "ADA" but not "adagio".
function wordPattern(term: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term)}(?![\\p{L}\\p{N}])`, "iu");
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
  const terms = new Map<string, Term>();
  const add = (kind: Term["kind"], term: string): void => {
    const key = `${kind}:${term.toLowerCase()}`;
    if (terms.has(key)) return;
    const hash = sha256(term.toLowerCase());
    terms.set(key, { kind, term, hash, re: kind === "name" ? wordPattern(term) : null });
  };
  for (const name of real.names) add("name", name);
  for (const name of real.normalized) add("name", name);
  for (const id of real.ids) add("id", id);

  const active = [...terms.values()].filter((t) => !ALLOW_HASHES.has(t.hash));
  const allowed = terms.size - active.length;

  // Every file git would commit: tracked files plus untracked ones that are not ignored.
  const listed = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
  const files = [...new Set(listed)];
  let scanned = 0;
  let binary = 0;
  const hits: string[] = [];

  // Ids are exact substrings; names are whole words in any case.
  const matchesIn = (text: string): Term[] =>
    active.filter((t) => (t.kind === "id" ? text.includes(t.term) : t.re !== null && t.re.test(text)));
  const describe = (t: Term): string => `${t.kind} "${mask(t.term)}" (sha256 ${t.hash.slice(0, 12)})`;

  for (const path of files) {
    const full = join(REPO, path);
    if (!existsSync(full) || statSync(full).isDirectory()) continue;
    const bytes = readFileSync(full);
    scanned++;
    if (bytes.subarray(0, 8000).includes(0)) {
      binary++;
      continue;
    }
    for (const t of matchesIn(path)) hits.push(`${path}: in the file name, ${describe(t)}`);
    const lines = bytes.toString("utf8").split("\n");
    lines.forEach((line, i) => {
      for (const t of matchesIn(line)) hits.push(`${path}:${i + 1}: ${describe(t)}`);
    });
  }

  const names = [...terms.values()].filter((t) => t.kind === "name").length;
  const ids = terms.size - names;
  console.log(`privacy check: ${scanned} files scanned (${binary} binary, skipped); ` +
    `${terms.size} real values (${names} names, ${ids} ids); ${allowed} allow-listed.`);
  if (hits.length > 0) {
    for (const hit of hits) console.log(hit);
    console.log(`FAIL: ${hits.length} hit(s). Remove the value, or allow-list an ordinary word by its SHA-256.`);
    return 1;
  }
  console.log("PASS: no real names or ids in anything git would commit.");
  return 0;
}

process.exitCode = main();
