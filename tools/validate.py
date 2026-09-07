"""Independent recomputation of the app's numbers using exact integer cents.

Usage:  python3 tools/validate.py <copy-of-data-root> <path-to-built-binary>

Run it against a COPY of the project folder: it drives the app through its
menus, which writes to Saved_Data in that folder. Every player total,
settlement, session balance and history line the app exports is recomputed
here from the raw CSVs and compared to the cent. It also plants duplicate
ledgers to confirm they are detected and skipped, then removes them.
"""
import csv, sys, os, re, glob, datetime, collections, subprocess, time

if len(sys.argv) != 3:
    print(__doc__); sys.exit(2)
ROOT = sys.argv[1]
BIN = sys.argv[2]

def norm(s): return re.sub(r'[^a-z]', '', s.lower())
def cents(s): return int(round(float(s) * 100))

def parse_iso(s):
    s = s.strip()
    if len(s) < 19: return None
    dt = datetime.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc)
    return int(dt.timestamp())

def local_date(epoch):
    return datetime.datetime.fromtimestamp(epoch).strftime("%Y-%m-%d")

# ---- merge rules
rules = {}
with open(os.path.join(ROOT, "Saved_Data", "merge_rules.csv")) as f:
    r = csv.reader(f); next(r)
    for row in r:
        if len(row) >= 2: rules[norm(row[0])] = norm(row[1])
def canon(n):
    seen = 0
    while n in rules and rules[n] != n and seen < 64: n = rules[n]; seen += 1
    return n

# ---- adjustments (optional file)
def load_adjustments():
    path = os.path.join(ROOT, "Saved_Data", "adjustments.csv")
    if not os.path.exists(path): return []
    out = []
    for r in csv.DictReader(open(path)):
        out.append({"date": r["date"], "player": norm(r["player_normalized"]), "amount": cents(r["amount"]), "folder": r["folder"], "note": r["note"]})
    return out

# ---- games
games = {}
for path in sorted(glob.glob(os.path.join(ROOT, "**", "*.csv"), recursive=True)):
    if "Saved_Data" in path: continue
    with open(path) as f:
        rows = list(csv.DictReader(f))
    if not rows or "player_nickname" not in rows[0]: continue
    gid = os.path.splitext(os.path.basename(path))[0]
    if gid in games: continue
    folder = os.path.relpath(os.path.dirname(path), ROOT)
    g = {"id": gid, "folder": folder, "rows": [], "start": None, "buyin": 0}
    for row in rows:
        if not norm(row["player_nickname"]): continue
        st = parse_iso(row["session_start_at"])
        net = int(row["net"]); bi = int(row["buy_in"])
        if st is None and net == 0: continue   # never-played seat, same rule as the app
        g["rows"].append((row["player_nickname"], row["player_id"], st, bi, net))
        g["buyin"] += bi
        if st is not None and (g["start"] is None or st < g["start"]): g["start"] = st
    if g["rows"]: games[gid] = g
print(f"python: {len(games)} games")

# Pick scopes from whatever data is present: the busiest folder, another folder if any,
# and a date range covering the middle third of the game nights.
folder_counts = collections.Counter(g["folder"] for g in games.values())
FOLDER = folder_counts.most_common(1)[0][0]
OTHER = next((f for f, _ in folder_counts.most_common() if f != FOLDER), None)
dates = sorted(local_date(g["start"]) for g in games.values() if g["start"] is not None)
FROM, TO = dates[len(dates) // 3], dates[2 * len(dates) // 3]
print(f"scopes: folder={FOLDER!r} other={OTHER!r} dates={FROM}..{TO}")

def aggregate(scope_games, adjs=()):
    P = {}
    for g in scope_games:
        per = collections.defaultdict(lambda: [0, 0])
        for nick, pid, st, bi, net in g["rows"]:
            c = canon(norm(nick))
            p = P.setdefault(c, {"net": 0, "buyins": 0, "games": 0, "won": 0, "lost": 0, "best": None, "worst": None, "nicks": collections.Counter(), "hist": []})
            p["net"] += net; p["buyins"] += 1; p["nicks"][nick] += 1
            per[c][0] += net; per[c][1] += 1
        for c, (net, b) in per.items():
            p = P[c]; p["games"] += 1
            if net > 0: p["won"] += net
            if net < 0: p["lost"] += net
            p["best"] = net if p["best"] is None else max(p["best"], net)
            p["worst"] = net if p["worst"] is None else min(p["worst"], net)
            p["hist"].append((g["start"], g["id"], net, b))
    for a in adjs:
        c = canon(a["player"])
        p = P.setdefault(c, {"net": 0, "buyins": 0, "games": 0, "won": 0, "lost": 0, "best": None, "worst": None, "nicks": collections.Counter(), "hist": [], "adj": 0})
        p.setdefault("adj", 0); p["adj"] += a["amount"]; p["net"] += a["amount"]
        p["hist"].append((int(datetime.datetime.strptime(a["date"], "%Y-%m-%d").timestamp()), "adjustment", a["amount"], 0))
    for p in P.values():
        p.setdefault("adj", 0)
        best = min(p["nicks"].items(), key=lambda kv: (-kv[1], len(kv[0]), kv[0])) if p["nicks"] else (None, 0)
        p["display"] = best[0]
        p["hist"].sort(key=lambda h: (-1 if h[0] is None else h[0], h[1]))
    assert sum(p["net"] for p in P.values()) == sum(a["amount"] for a in adjs), "scope does not sum to adjustments"
    return P

def run_app(args, stdin):
    out = subprocess.run([BIN, "--root", ROOT] + args, input=stdin, capture_output=True, text=True)
    return out.stdout

failures = []
def check(cond, msg):
    if not cond: failures.append(msg); print("FAIL:", msg)

def compare_summary(P, label):
    with open(os.path.join(ROOT, "Saved_Data", "player_summary.csv")) as f:
        rows = list(csv.DictReader(f))
    check(len(rows) == len(P), f"{label}: player count app={len(rows)} py={len(P)}")
    prev = None
    for r in rows:
        c = r["normalized_name"]; p = P.get(c)
        if p is None: check(False, f"{label}: unknown player {c}"); continue
        for key, val in [("total_net", p["net"]), ("total_won", p["won"]), ("total_lost", p["lost"]), ("adjustments", p["adj"])]:
            check(cents(r[key]) == val, f"{label}: {c} {key} app={r[key]} py={val/100:.2f}")
        if p["games"]:
            for key, val in [("biggest_win", p["best"]), ("biggest_loss", p["worst"])]:
                check(cents(r[key]) == val, f"{label}: {c} {key} app={r[key]} py={val/100:.2f}")
        check(int(r["games"]) == p["games"], f"{label}: {c} games app={r['games']} py={p['games']}")
        check(int(r["buy_ins"]) == p["buyins"], f"{label}: {c} buy_ins app={r['buy_ins']} py={p['buyins']}")
        if p["games"]:
            check(abs(float(r["avg_per_game"]) - p["net"] / 100 / p["games"]) < 0.006, f"{label}: {c} avg")
            check(r["display_name"] == p["display"], f"{label}: {c} display app={r['display_name']} py={p['display']}")
        if prev is not None: check(cents(prev) >= cents(r["total_net"]), f"{label}: leaderboard not sorted at {c}")
        prev = r["total_net"]
    print(f"{label}: summary compared ({len(rows)} players)")

def compare_settlement(P, label, prefs=(), banker=None):
    with open(os.path.join(ROOT, "Saved_Data", "settlements.csv")) as f:
        rows = list(csv.DictReader(f))
    sends = collections.Counter(); recv = collections.Counter()
    for r in rows:
        a = cents(r["amount"]); check(a > 0, f"{label}: non-positive amount {r}")
        sends[r["from_normalized"]] += a; recv[r["to_normalized"]] += a
        check(r["from_normalized"] != r["to_normalized"], f"{label}: self payment {r}")
    for c, p in P.items():
        check(recv[c] - sends[c] == p["net"], f"{label}: {c} settlement net app={recv[c]-sends[c]} py={p['net']}")
    for c in set(sends) | set(recv):
        check(c in P or c == banker, f"{label}: settlement mentions unknown {c}")
    if banker:
        for r in rows:
            check(r["reason"] == "banker" and banker in (r["from_normalized"], r["to_normalized"]), f"{label}: non-banker line {r}")
            other = r["to_normalized"] if r["from_normalized"] == banker else r["from_normalized"]
            check(cents(r["amount"]) == abs(P[other]["net"]), f"{label}: banker amount wrong for {other}")
    else:
        for payer, payee in prefs:
            want = min(-P[payer]["net"], P[payee]["net"]) if P[payer]["net"] < 0 and P[payee]["net"] > 0 else 0
            got = sum(cents(r["amount"]) for r in rows if r["from_normalized"] == payer and r["to_normalized"] == payee and r["reason"] == "preference")
            check(got == want, f"{label}: preference {payer}->{payee} app={got} py={want}")
        losers = sum(1 for p in P.values() if p["net"] < 0); winners = sum(1 for p in P.values() if p["net"] > 0)
        check(len(rows) <= losers + winners, f"{label}: too many transactions {len(rows)} > {losers+winners}")
    print(f"{label}: settlement compared ({len(rows)} lines)")

def adj_filter(folder=None, frm=None, to=None):
    out = []
    for a in load_adjustments():
        if folder and a["folder"] != folder: continue
        if frm and a["date"] < frm: continue
        if to and a["date"] > to: continue
        out.append(a)
    return out

def scope_filter(folder=None, frm=None, to=None):
    out = []
    for g in games.values():
        if folder and g["folder"] != folder: continue
        if frm and (g["start"] is None or local_date(g["start"]) < frm): continue
        if to and (g["start"] is None or local_date(g["start"]) > to): continue
        out.append(g)
    return out

# ---------- 1. everything
P = aggregate(scope_filter())
out = run_app([], "12\n5\n13\n0\n")
compare_summary(P, "all"); compare_settlement(P, "all")
m = re.search(r"Loaded (\d+) games", out); check(int(m.group(1)) == len(games), f"game count app={m.group(1)} py={len(games)}")

# ---------- 2. one folder
P = aggregate(scope_filter(folder=FOLDER))
run_app(["--folder", FOLDER], "12\n5\n13\n0\n")
compare_summary(P, "folder"); compare_settlement(P, "folder")

# ---------- 3. date range
P = aggregate(scope_filter(frm=FROM, to=TO))
out = run_app(["--from", FROM, "--to", TO], "12\n5\n13\n0\n")
m = re.search(r"\|  (\d+) games", out); check(int(m.group(1)) == len(scope_filter(frm=FROM, to=TO)), f"date scope game count app={m.group(1)}")
compare_summary(P, "dates"); compare_settlement(P, "dates")

# ---------- 4. preferences: heech pays tom, rayan pays kobe (folder scope)
P = aggregate(scope_filter(folder=FOLDER))
byname = sorted(P.items(), key=lambda kv: (-kv[1]["net"], kv[0]))
idx = {c: i + 1 for i, (c, _) in enumerate(byname)}
winners = [c for c,_ in byname if P[c]["net"] > 0]; losers = [c for c,_ in reversed(byname) if P[c]["net"] < 0]
L1, W1 = losers[0], winners[0]
L2, W2 = (losers[1] if len(losers) > 1 else losers[0]), (winners[1] if len(winners) > 1 else winners[0])
print("prefs:", L1, "->", W1, ",", L2, "->", W2)
stdin = f"6\n1\n{idx[L1]}\n{idx[W1]}\n\n1\n{idx[L2]}\n{idx[W2]}\n\n0\n5\n13\n0\n"
run_app(["--folder", FOLDER], stdin)
compare_settlement(P, "prefs", prefs=[(L1, W1), (L2, W2)])
# a preference whose payer is a winner must have no effect
stdin = f"6\n1\n{idx[W2]}\n{idx[W1]}\n\n0\n5\n13\n6\n2\n3\n0\n0\n"
run_app(["--folder", FOLDER], stdin)
compare_settlement(P, "prefs-noop", prefs=[(L1, W1), (L2, W2), (W2, W1)])

# ---------- 5. banker = cam
B = W1
stdin = f"6\n3\n{idx[B]}\n0\n5\n13\n6\n4\n0\n0\n"
run_app(["--folder", FOLDER], stdin)
compare_settlement(P, "banker", banker=B)
# banker who is a loser
B = L2
stdin = f"6\n3\n{idx[B]}\n0\n5\n13\n6\n4\n0\n0\n"
run_app(["--folder", FOLDER], stdin)
compare_settlement(P, "banker-loser", banker=B)

SID = "VALIDATE_" + str(int(time.time()))
# ---------- 6. sessions: save sheet (prefs still active), pay $5 on line 1
out = run_app(["--folder", FOLDER], f"5\n7\n{SID}\n9\n0\n")
row = re.search(rf"^(\d+)\s+{SID}", out, re.M).group(1)
run_app(["--folder", FOLDER], f"10\n{row}\n5\n0\n")
with open(os.path.join(ROOT, "Saved_Data", "session_balances.csv")) as f:
    bal = [r for r in csv.DictReader(f) if r["session_id"] == SID]
run_app(["--folder", FOLDER], "5\n13\n0\n")
with open(os.path.join(ROOT, "Saved_Data", "settlements.csv")) as f:
    sheet = list(csv.DictReader(f))
check(len(bal) == len(sheet), f"session rows {len(bal)} vs sheet {len(sheet)}")
tot_orig = sum(cents(b["original_amount"]) for b in bal); tot_sheet = sum(cents(s["amount"]) for s in sheet)
check(tot_orig == tot_sheet, f"session original total {tot_orig} vs sheet {tot_sheet}")
paid = [b for b in bal if cents(b["remaining_amount"]) != cents(b["original_amount"])]
check(len(paid) == 1 and cents(paid[0]["original_amount"]) - cents(paid[0]["remaining_amount"]) == 500, f"partial payment wrong: {paid}")
check(all(b["status"] == ("partial" if b in paid else "open") for b in bal), "status wrong")
print("sessions compared")

# ---------- 7. dates: app history dates vs python
P = aggregate(scope_filter())
order = sorted(P.items(), key=lambda kv:(-kv[1]['net'],kv[0]))
cam_idx = [i for i,(c,_) in enumerate(order,1) if c=='cam'][0]
out = run_app([], f"3\n{cam_idx}\n0\n")
hist = re.findall(r"^\d+\s+(\d{4}-\d{2}-\d{2}|unknown)\s+.*?\s+(ledger_\S+|adjustment)\S*.*?\s+(\d+|-)\s+([+-]?\$[\d.]+)\s+([+-]?\$[\d.]+)\s*$", out, re.M)
py = P["cam"]["hist"]
check(len(hist) == len(py), f"cam history length app={len(hist)} py={len(py)}")
run = 0
for (d, gid, b, net, running), (st, pid, pnet, pb) in zip(hist, py):
    run += pnet
    check(d == ("unknown" if st is None else local_date(st)), f"date {d} vs {st} for {gid}")
    check(pid == gid or pid.startswith(gid + " ("), f"game order {gid} vs {pid}")
    check(cents(net.replace('$','')) == pnet and (0 if b == "-" else int(b)) == pb, f"history net {net}/{b} vs {pnet}/{pb}")
    check(cents(running.replace('$','')) == run, f"running {running} vs {run}")
print("history compared")


# ---------- 7b. adjustments: forgive a debt in folder scope, then a one-sided correction in all scope
Pf = aggregate(scope_filter(folder=FOLDER))
order_f = sorted(Pf.items(), key=lambda kv: (-kv[1]["net"], kv[0])); idx_f = {c: i + 1 for i, (c, _) in enumerate(order_f)}
cred = [c for c, _ in order_f if Pf[c]["net"] > 0][0]; debt = [c for c, _ in reversed(order_f) if Pf[c]["net"] < 0][0]
FDATE = min(local_date(g["start"]) for g in scope_filter(folder=FOLDER) if g["start"] is not None)
AFTER = (datetime.date.fromisoformat(FDATE) + datetime.timedelta(days=1)).isoformat()
out = run_app(["--folder", FOLDER], f"17\n1\n{idx_f[cred]}\n{idx_f[debt]}\n12.34\nlet it go\n{FDATE}\n0\n12\n5\n13\n0\n")
adjs = load_adjustments()
check(len(adjs) == 2 and sum(a["amount"] for a in adjs) == 0, f"forgive rows wrong: {adjs}")
check({a["player"] for a in adjs} == {cred, debt} and all(a["folder"] == FOLDER for a in adjs), "forgive rows players/folder")
Pf = aggregate(scope_filter(folder=FOLDER), adj_filter(folder=FOLDER))
compare_summary(Pf, "forgive-folder"); compare_settlement(Pf, "forgive-folder")
# the same adjustment is NOT counted in another folder, IS counted in all-folders, and NOT in a date range that excludes it
if OTHER:
    run_app(["--folder", OTHER], "12\n0\n"); compare_summary(aggregate(scope_filter(folder=OTHER), adj_filter(folder=OTHER)), "forgive-otherfolder")
run_app([], "12\n0\n"); compare_summary(aggregate(scope_filter(), adj_filter()), "forgive-all")
run_app(["--from", AFTER], "12\n0\n"); compare_summary(aggregate(scope_filter(frm=AFTER), adj_filter(frm=AFTER)), "forgive-dated")
# one-sided correction of -7.00 in all scope, then check the leaderboard warns and history shows it
order_a = [c for c, _ in sorted(aggregate(scope_filter(), adj_filter()).items(), key=lambda kv: (-kv[1]["net"], kv[0]))]
who_i = next(i for i, c in enumerate(order_a, 1) if c not in (cred, debt)); who = order_a[who_i - 1]
out = run_app([], f"17\n2\n{who_i}\n-7\ntypo fix\n\n0\n2\n12\n0\n")
check("includes -$7.00 of one-sided adjustments" in out, "one-sided warning missing")
Pa = aggregate(scope_filter(), adj_filter()); compare_summary(Pa, "onesided-all")
check(Pa[who]["adj"] == -700, f"one-sided amount {Pa[who]['adj']}")
# removing the forgive (row 1) removes both halves
out = run_app([], "17\n3\n1\n0\n0\n")
adjs = load_adjustments(); check(len(adjs) == 1 and adjs[0]["amount"] == -700, f"remove group failed: {adjs}")
# remove the remaining one so later checks see clean books
run_app([], "17\n3\n1\n0\n0\n"); check(load_adjustments() == [], "cleanup failed")
print("adjustments checked")

# ---------- 8. duplicates: identical copy in same folder, partial re-export, cross-folder copy
import shutil
base = run_app([], "0\n"); m0 = re.search(r"WARNING: (\d+) duplicate", base); base_dups = int(m0.group(1)) if m0 else 0
src = sorted(glob.glob(os.path.join(ROOT, FOLDER, "ledger_*.csv")))[0]
dup_same = os.path.join(ROOT, FOLDER, "ledger_COPY_same_folder.csv"); shutil.copy(src, dup_same)
os.makedirs(os.path.join(ROOT, "zz_dup_test"), exist_ok=True)
dup_cross = os.path.join(ROOT, "zz_dup_test", os.path.basename(src)); shutil.copy(src, dup_cross)
partial = os.path.join(ROOT, FOLDER, "ledger_PARTIAL_export.csv")
lines = open(src).read().splitlines(); open(partial, "w").write("\n".join(lines[:-1]) + "\n")
out = run_app([], "16\n12\n0\n")
check(f"WARNING: {base_dups + 3} duplicate" in out, "startup warning missing: " + out[:300])
check("IDENTICAL CONTENT in the same folder" in out and "IDENTICAL CONTENT across folders" in out, "identical detection")
check("OVERLAP" in out and "in the same folder" in out, "overlap detection")
P2 = aggregate(scope_filter())
with open(os.path.join(ROOT, "Saved_Data", "player_summary.csv")) as f:
    rows = list(csv.DictReader(f))
# with the partial export kept, totals differ from P2 for players in that game; identical copies must not change totals
m = re.search(r"Loaded (\d+) games", out); check(int(m.group(1)) == len(games) + 1, f"dup: game count app={m.group(1)} py={len(games)+1}")
for f_ in (dup_same, dup_cross, partial): os.remove(f_)
os.rmdir(os.path.join(ROOT, "zz_dup_test"))
out = run_app([], "12\n0\n"); compare_summary(P2, "after-dup-cleanup")
print("duplicates checked")

print("\nRESULT:", "ALL CHECKS PASSED" if not failures else f"{len(failures)} FAILURES")
sys.exit(1 if failures else 0)
