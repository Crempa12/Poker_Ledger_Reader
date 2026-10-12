#!/usr/bin/env python3
"""Helpers for reference/run.sh: folder and date picks, CSV reads, and the scenario records.

Run in isolated mode, so the environment and the current folder are not loaded:
    python3 -I reference/helpers.py <command> [options]
Reads CSV files. Writes only the file a command names. Standard library only.
"""

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# Folders the app never searches for ledgers (util.cpp isExcludedDir).
EXCLUDED = {"Saved_Data", ".git", ".idea", "build", "reports"}


def excluded_dir(name):
    return name in EXCLUDED or name.startswith("cmake-build")


def ledger_files(root):
    """CSVs under root whose first line names player_nickname (ledger.cpp discoverLedgerFiles)."""
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not excluded_dir(d))
        for name in sorted(filenames):
            if not name.lower().endswith(".csv"):
                continue
            path = os.path.join(dirpath, name)
            try:
                with open(path, encoding="utf-8", newline="") as fh:
                    first = fh.readline()
            except (OSError, UnicodeDecodeError):
                continue
            if "player_nickname" in first:
                found.append(path)
    return found


def folder_of(root, path):
    """The folder a ledger belongs to, relative to the games root. "(root)" when it sits there."""
    rel = os.path.relpath(os.path.dirname(path), root)
    return "(root)" if rel in (".", "") else rel.replace(os.sep, "/")


def read_rows(path):
    with open(path, encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def iso_seconds(text):
    text = (text or "").strip()
    if len(text) < 19:
        return None
    try:
        when = datetime.strptime(text[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
    return when.replace(tzinfo=timezone.utc).timestamp()


def cents(text):
    return int(round(float((text or "").strip() or "0") * 100))


def cmd_folders(a):
    names = {folder_of(a.root, path) for path in ledger_files(a.root)}
    for name in sorted(names, key=lambda n: n.encode("utf-8")):
        print(name)


def cmd_range(a):
    zone = ZoneInfo(a.tz)
    dates = []
    for path in ledger_files(a.root):
        starts = [t for t in (iso_seconds(r.get("session_start_at")) for r in read_rows(path)) if t is not None]
        if starts:
            dates.append(datetime.fromtimestamp(min(starts), zone).date().isoformat())
    dates.sort()
    if not dates:
        sys.exit("no dated ledgers found")
    # The middle third of the game nights, the same picks tools/validate.py makes.
    print(f"{dates[len(dates) // 3]}\t{dates[2 * len(dates) // 3]}")


def cmd_players(a):
    print(len(read_rows(a.summary)))


def cmd_banker(a):
    best, games = "", -1
    for row in read_rows(a.summary):
        n = int(row.get("games") or 0)
        if n > games:   # a tie keeps the earlier row, which has the higher net
            best, games = row["normalized_name"], n
    if not best:
        sys.exit("no players in the summary")
    print(f"{best}\t{games}")


def cmd_partial(a):
    # Menu 10 numbers only the balances that are still open, in saved order.
    open_rows = [r for r in read_rows(a.balances) if cents(r.get("remaining_amount")) > 0]
    for index, row in enumerate(open_rows, start=1):
        if row.get("session_id") == a.session:
            pay = cents(row["remaining_amount"]) // 2
            if pay <= 0:
                sys.exit("the balance is too small to part-pay")
            print(f"{index}\t{pay // 100}.{pay % 100:02d}")
            return
    sys.exit("no open balance in that session")


def cmd_manifest(a):
    lines = []
    for dirpath, dirnames, filenames in os.walk(a.out):
        dirnames[:] = [d for d in dirnames if d != "work"]
        for name in filenames:
            if not name.endswith(".csv"):
                continue
            path = os.path.join(dirpath, name)
            with open(path, encoding="utf-8", newline="") as fh:
                rows = list(csv.reader(fh))
            rel = os.path.relpath(path, a.out).replace(os.sep, "/")
            header = ",".join(rows[0]) if rows else ""
            lines.append(f"{rel}\tdata_rows={max(len(rows) - 1, 0)}\theader={header}")
    print("\n".join(sorted(lines)))


def cmd_step(a):
    menu = None
    if a.menu:
        with open(a.menu, encoding="utf-8") as fh:
            menu = fh.read().splitlines()
    record = {
        "kind": a.kind,
        "log": a.log,
        "exit": a.exit,
        "args": a.arg or [],
        "menu_file": os.path.basename(a.menu) if a.menu else None,
        "menu": menu,
    }
    os.makedirs(os.path.dirname(a.steps), exist_ok=True)
    with open(a.steps, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def cmd_finish(a):
    steps = []
    if os.path.exists(a.steps):
        with open(a.steps, encoding="utf-8") as fh:
            steps = [json.loads(line) for line in fh if line.strip()]
    exports = []
    for dirpath, dirnames, filenames in os.walk(a.dir):
        dirnames[:] = sorted(d for d in dirnames if d not in ("logs", "menus", "work"))
        for name in sorted(filenames):
            if name == "scenario.json":
                continue
            path = os.path.join(dirpath, name)
            entry = {"file": os.path.relpath(path, a.dir).replace(os.sep, "/")}
            if name.endswith(".csv"):
                with open(path, encoding="utf-8", newline="") as fh:
                    entry["data_rows"] = max(sum(1 for _ in csv.reader(fh)) - 1, 0)
            exports.append(entry)
    have = {e["file"] for e in exports}
    missing = [f for f in (a.expect or []) if f not in have]
    failed_steps = [s["kind"] for s in steps if s["exit"] != 0]
    status = "failed" if missing or failed_steps else "ok"
    record = {
        "name": a.name,
        "description": a.description,
        "status": status,
        "code": a.code,
        "data": a.data,
        "tz": a.tz,
        "flags": a.flag or [],
        "notes": [n for n in (a.note or []) if n],
        "expected_exports": a.expect or [],
        "missing_exports": missing,
        "steps": steps,
        "exports": exports,
    }
    with open(os.path.join(a.dir, "scenario.json"), "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"{a.name}: {status}")


def cmd_summary(a):
    bad = 0
    for dirpath, dirnames, filenames in os.walk(a.out):
        dirnames[:] = [d for d in dirnames if d != "work"]
        if "scenario.json" not in filenames:
            continue
        with open(os.path.join(dirpath, "scenario.json"), encoding="utf-8") as fh:
            rec = json.load(fh)
        if rec["status"] != "ok":
            bad += 1
        csvs = ", ".join(f"{e['file']}={e.get('data_rows', '-')}" for e in rec["exports"] if e["file"].endswith(".csv"))
        print(f"{rec['name']}: {rec['status']}  [{csvs}]")
    sys.exit(1 if bad else 0)


def main(argv):
    p = argparse.ArgumentParser(prog="helpers.py", description=__doc__.splitlines()[1])
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("folders", help="folder names of the ledgers under a games root")
    f.add_argument("root")
    f.set_defaults(fn=cmd_folders)

    r = sub.add_parser("range", help="FROM and TO dates: the middle third of the game nights")
    r.add_argument("root")
    r.add_argument("tz")
    r.set_defaults(fn=cmd_range)

    n = sub.add_parser("players", help="number of players in a player_summary.csv")
    n.add_argument("summary")
    n.set_defaults(fn=cmd_players)

    b = sub.add_parser("banker", help="normalized name with the most games in a player_summary.csv")
    b.add_argument("summary")
    b.set_defaults(fn=cmd_banker)

    q = sub.add_parser("partial", help="menu choice and part-payment for a session's first open balance")
    q.add_argument("balances")
    q.add_argument("session")
    q.set_defaults(fn=cmd_partial)

    m = sub.add_parser("manifest", help="every CSV under an output folder: data rows and header")
    m.add_argument("out")
    m.set_defaults(fn=cmd_manifest)

    s = sub.add_parser("summary", help="one line per scenario record under an output folder")
    s.add_argument("out")
    s.set_defaults(fn=cmd_summary)

    st = sub.add_parser("step", help="append one app run (menu, arguments, exit code) to a steps file")
    st.add_argument("--steps", required=True)
    st.add_argument("--kind", required=True)
    st.add_argument("--log", required=True)
    st.add_argument("--menu")
    st.add_argument("--exit", type=int, required=True)
    st.add_argument("--arg", action="append")
    st.set_defaults(fn=cmd_step)

    fi = sub.add_parser("finish", help="write scenario.json for a scenario folder")
    fi.add_argument("--dir", required=True)
    fi.add_argument("--steps", required=True)
    fi.add_argument("--name", required=True)
    fi.add_argument("--description", required=True)
    fi.add_argument("--code", required=True)
    fi.add_argument("--data", required=True)
    fi.add_argument("--tz", required=True)
    fi.add_argument("--flag", action="append")
    fi.add_argument("--note", action="append")
    fi.add_argument("--expect", action="append")
    fi.set_defaults(fn=cmd_finish)

    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main(sys.argv[1:])
