"""Independent recomputation of playtime/showdown/playstyle stats straight from the
raw PokerNow hand logs and ledgers, per docs/specs/playtime-showdown.md.

This module does NOT look at the C++ implementation. It is a from-scratch reading of
the spec against the raw CSVs, meant to be compared against the app's own exports by
tools/validate.py (section 9). It reuses validate.py's own norm()/filed_as()/canon()/
owners/games so that person identity matches exactly.

Public entry point:

    compute(root, games, canon, filed_as, norm, owners) -> dict

`root` is the data root (the folder containing Games/ and Saved_Data/). `games` is
validate.py's own dict of kept ledgers (gid -> {"id","folder","rows","start","end",...}),
already deduplicated the same way the app dedupes ledgers. `canon`, `filed_as`, `norm`
and `owners` are validate.py's own objects, passed straight through so identity/merge
logic is identical to what validate.py uses for the money checks.

Returned dict:

    {
      "logs": {id: {"path", "gid", "hands": int, "first_hand_number": int}},
      "style":      {person: {"saw_flop","showdowns","showdowns_voluntary",
                               "showdown_wins","courtesy_reveals"}},
      "playstyle":  {person: {"limp","open","steal","cbet","donk","checkraise",
                               "wtsd","wsd"}}   # each value is (made, opportunities)
      "rivals":     {(loser, winner): [times, amount_cents]},
      "playtime":   {person: {"hands_dealt","nights_logged","seconds_dealt",
                               "seconds_estimated"}},
      "pool": {"showdown_hands", "at_showdown_seats", "showdown_wins_seats",
               "wsd_pct", "hands", "logs"},
    }
"""
import csv, os, re, glob, datetime, collections, sys, statistics

K_MAX_HAND_SECONDS = 600
K_DEFAULT_HAND_SECONDS = 36

# ---------------------------------------------------------------- small helpers

def parse_iso(s):
    """Same truncate-to-whole-seconds UTC parse as validate.py's parse_iso."""
    if not s:
        return None
    s = s.strip()
    if len(s) < 19:
        return None
    try:
        dt = datetime.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        return None
    return int(dt.timestamp())


ACCOUNT_LABEL_RE = re.compile(r'"([^"]*) @ ([^"]+)"')
HAND_START_RE = re.compile(
    r'^-- starting hand #(\d+) \(id: [^)]*\)\s+.*?'
    r'(?:\(dealer:\s*(?:"([^"]*)")?\s*\)|\(dead button\))\s*--$')
HAND_END_RE = re.compile(r'^-- ending hand #(\d+) --$')
STACKS_RE = re.compile(r'#(\d+)\s+"([^"]*)"\s+\(([\d.]+)\)')
ACTION_RE = re.compile(r'^"([^"]*)"\s+(.*)$')
COLLECTED_RE = re.compile(r'^collected ([\d.]+) from pot(?: with (.*))?$')
COLLECTED_BOUNTY_RE = re.compile(r'^collected ([\d.]+) from the 7-2 bounty$')
SHOWS_RE = re.compile(r'^shows a (.+)\.$')
BLIND_RE = re.compile(r'^posts a (missed |missing )?(small|big) blind of ([\d.]+)(?: and go all in)?$')
FOLD_RE = re.compile(r'^folds$')
CHECK_RE = re.compile(r'^checks$')
CALL_RE = re.compile(r'^calls ([\d.]+)(?: and go all in)?(\s*\(bomb pot bet\))?$')
BET_RE = re.compile(r'^bets ([\d.]+)(?: and go all in)?(\s*\(bomb pot bet\))?$')
RAISE_RE = re.compile(r'^raises to ([\d.]+)(?: and go all in)?$')
BOMBPOST_RE = re.compile(r'^posts a bet of ([\d.]+) \(bomb pot bet\)$')
UNCALLED_RE = re.compile(r'^Uncalled bet of ([\d.]+) returned to "([^"]*)"$')


def split_account_label(label):
    """'Name @ pid' -> (nick, pid). PokerNow ids never contain spaces."""
    i = label.rfind(' @ ')
    if i < 0:
        return label, ''
    return label[:i], label[i + 3:]


def cents(amount_dollars):
    return int(round(amount_dollars * 100))


# ---------------------------------------------------------------- ledger re-parse
#
# validate.py's games[gid]["rows"] tuples are (nick, pid, st, bi, net, owner) and
# deliberately do not carry session_end_at (other code in validate.py unpacks those
# tuples positionally). We need session_end_at for seat windows, so we re-read the
# winning ledger CSV for each gid ourselves, using the exact same discovery/tie-break
# rule validate.py uses, and re-derive `owner` the same way validate.py does.

def _ledger_gid_for_path(path):
    return os.path.splitext(os.path.basename(path))[0].split(" ", 1)[0].strip()


def _read_ledger_rows(path, norm):
    """Rows kept the same way validate.py keeps them, but with end times too.
    Returns (rows, end) where rows = [(nick, pid, st, end, bi, net)], in file order,
    and end = the ledger's own overall end (latest end, else latest start)."""
    with open(path, encoding="utf-8", newline='') as f:
        raw = list(csv.DictReader(f))
    if not raw or "player_nickname" not in raw[0]:
        return None
    rows = []
    end = None
    for row in raw:
        st = parse_iso(row["session_start_at"])
        net = int(row["net"])
        if st is None and net == 0:
            continue
        e = parse_iso(row.get("session_end_at", ""))
        rows.append((row["player_nickname"], row["player_id"], st, e, int(row["buy_in"]), net))
        last = e or st
        if last is not None and (end is None or last > end):
            end = last
    return rows, end


def build_ledger_full(root, games, canon, filed_as, norm, owners):
    """gid -> {"rows": [(nick,pid,st,end,bi,net,owner)], "end": overall end}
    for every gid present in `games`, re-deriving the same "kept" file validate.py
    would have kept (more rows, then later end), but keeping session_end_at."""
    data_dir = os.path.join(root, "Games") if os.path.isdir(os.path.join(root, "Games")) else root
    candidates = collections.defaultdict(list)  # gid -> [path]
    for path in glob.glob(os.path.join(data_dir, "**", "*.csv"), recursive=True):
        base = os.path.basename(path)
        if "Saved_Data" in path or base.startswith("poker_now_log_"):
            continue
        gid = _ledger_gid_for_path(path)
        if gid in games:
            candidates[gid].append(path)

    out = {}
    for gid, paths in candidates.items():
        best = None
        for path in paths:
            parsed = _read_ledger_rows(path, norm)
            if parsed is None:
                continue
            rows, end = parsed
            if not rows:
                continue
            key = (len(rows), end or 0)
            if best is None or key > best[0]:
                best = (key, rows, end)
        if best is None:
            continue
        _, rows, end = best
        full_rows = []
        for idx, (nick, pid, st, e, bi, net) in enumerate(rows):
            owner = owners.get((gid, pid, st, norm(nick)))
            if owner is not None and canon(owner) == canon(filed_as(nick, pid)):
                owner = None
            full_rows.append({"nick": nick, "pid": pid, "start": st, "end": e,
                               "buy_in": bi, "net": net, "owner": owner, "idx": idx})
        out[gid] = {"rows": full_rows, "end": end}
    return out


def person_of_row(row, canon, filed_as):
    return canon(row["owner"] or filed_as(row["nick"], row["pid"]))


# ---------------------------------------------------------------- log discovery

def discover_logs(root, games):
    """id -> path of the winning log (more hands wins), restricted to ids whose
    'ledger_'+id is a kept game. Returns dict id -> {"path", "hands"}."""
    data_dir = os.path.join(root, "Games") if os.path.isdir(os.path.join(root, "Games")) else root
    by_id = collections.defaultdict(list)
    for path in glob.glob(os.path.join(data_dir, "**", "poker_now_log_*.csv"), recursive=True):
        stem = os.path.splitext(os.path.basename(path))[0].split(" ", 1)[0]
        log_id = stem[len("poker_now_log_"):]
        by_id[log_id].append(path)

    out = {}
    for log_id, paths in by_id.items():
        gid = "ledger_" + log_id
        if gid not in games:
            continue
        best_path, best_hands = None, -1
        for path in paths:
            with open(path, encoding="utf-8", newline='') as f:
                n = sum(1 for row in csv.DictReader(f) if row["entry"].startswith("-- starting hand #"))
            if n > best_hands:
                best_path, best_hands = path, n
        out[log_id] = {"path": best_path, "hands": best_hands, "gid": gid}
    return out


# ---------------------------------------------------------------- hand-log parsing

class Hand:
    __slots__ = ("number", "dealer", "start", "seats", "bomb_pot",
                 "folded", "collected", "collected_with", "shown_all", "shown_before_end",
                 "actions", "reached_showdown", "seated_accounts", "saw_street")

    def __init__(self, number, dealer, start):
        self.number = number
        self.dealer = dealer
        self.start = start
        self.seats = []            # [(seat_num, account_label)], seat_num ascending
        self.seated_accounts = []  # account labels, in seat order
        self.bomb_pot = False
        self.folded = set()        # account labels that folded at any point
        self.collected = collections.defaultdict(float)       # account -> total "from pot" $ (incl. "with")
        self.collected_with = collections.defaultdict(bool)   # account -> had >=1 "...with ..." line
        self.shown_all = collections.defaultdict(set)         # account -> set of card tokens, whole hand
        self.shown_before_end = collections.defaultdict(set)  # account -> set of card tokens, before end marker
        self.actions = []          # [(street, account, kind, amount)] in chronological order
        self.reached_showdown = False
        # whether the board actually reached this street (a "Flop:"/"Turn:"/"River:"
        # line was seen), independent of whether anyone had an action to take there
        # (an all-in hand runs the board with zero further actions).
        self.saw_street = {"flop": False, "turn": False, "river": False}


def _extract_cards(text):
    # "K♥, J♣" -> ["K♥","J♣"]; strip stray whitespace
    return [c.strip() for c in text.split(",") if c.strip()]


def parse_log(path):
    """Parse one poker_now_log_*.csv into a list of Hand objects (in file/hand order,
    which after sorting by 'order' is chronological), plus a dict pid -> last nickname
    used anywhere in the whole log (by order), for the no-ledger-seat fallback."""
    with open(path, encoding="utf-8", newline='') as f:
        rows = list(csv.DictReader(f))
    rows.sort(key=lambda r: int(r["order"]))

    last_nick = {}
    for r in rows:
        for nick, pid in ACCOUNT_LABEL_RE.findall(r["entry"]):
            last_nick[pid] = nick

    hands = []
    cur = None
    seen_end = False
    street = "preflop"

    for r in rows:
        entry = r["entry"]
        m = HAND_START_RE.match(entry)
        if m:
            if cur is not None:
                hands.append(cur)
            cur = Hand(int(m.group(1)), m.group(2), parse_iso(r["at"]))
            seen_end = False
            street = "preflop"
            continue
        if cur is None:
            continue  # entries before the first hand start: not part of any hand

        if HAND_END_RE.match(entry):
            seen_end = True
            continue

        m = STACKS_RE.findall(entry) if entry.startswith("Player stacks:") else None
        if m:
            seats = [(int(num), label) for num, label, _stack in m]
            cur.seats = sorted(seats, key=lambda s: s[0])
            cur.seated_accounts = [lbl for _n, lbl in cur.seats]
            continue

        if entry.startswith("Flop"):
            street = "flop"
            cur.saw_street["flop"] = True
            continue
        if entry.startswith("Turn"):
            street = "turn"
            cur.saw_street["turn"] = True
            continue
        if entry.startswith("River"):
            street = "river"
            cur.saw_street["river"] = True
            continue

        m = UNCALLED_RE.match(entry)
        if m:
            amt, acct = float(m.group(1)), m.group(2)
            cur.actions.append((street, acct, "uncalled_return", amt))
            continue

        m = ACTION_RE.match(entry)
        if not m:
            continue
        acct, rest = m.group(1), m.group(2).strip()   # all-in posts end in a stray space: "... and go all in "

        mm = BLIND_RE.match(rest)
        if mm:
            live = mm.group(1) is None
            amt = float(mm.group(3))
            dead = mm.group(1) == "missing " and mm.group(2) == "small"   # a missing small blind is dead money
            cur.actions.append((street, acct, "blind_sb_dead" if dead else "blind_sb" if mm.group(2) == "small" else "blind_bb", amt))
            if live:
                cur.actions.append((street, acct, "live_" + mm.group(2), amt))
            continue

        if FOLD_RE.match(rest):
            cur.folded.add(acct)
            cur.actions.append((street, acct, "folds", 0.0))
            continue
        if CHECK_RE.match(rest):
            cur.actions.append((street, acct, "checks", 0.0))
            continue
        mm = CALL_RE.match(rest)
        if mm:
            if mm.group(2):
                cur.bomb_pot = True
            cur.actions.append((street, acct, "calls", float(mm.group(1))))
            continue
        mm = BET_RE.match(rest)
        if mm:
            if mm.group(2):
                cur.bomb_pot = True
            cur.actions.append((street, acct, "bets", float(mm.group(1))))
            continue
        mm = RAISE_RE.match(rest)
        if mm:
            cur.actions.append((street, acct, "raises_to", float(mm.group(1))))
            continue
        mm = BOMBPOST_RE.match(rest)
        if mm:
            cur.bomb_pot = True
            cur.actions.append((street, acct, "bets", float(mm.group(1))))
            continue
        mm = COLLECTED_RE.match(rest)
        if mm:
            amt = float(mm.group(1))
            cur.collected[acct] += amt
            if mm.group(2):
                cur.collected_with[acct] = True
            continue
        if COLLECTED_BOUNTY_RE.match(rest):
            continue  # not part of the hand's pot accounting
        mm = SHOWS_RE.match(rest)
        if mm:
            cards = _extract_cards(mm.group(1))
            cur.shown_all[acct].update(cards)
            if not seen_end:
                cur.shown_before_end[acct].update(cards)
            continue
        # everything else (rebuys, sit/stand, admin lines, run-it-twice chatter,
        # "Dead Small Blind", Game Config Changes, ...) doesn't affect these stats.

    if cur is not None:
        hands.append(cur)

    # finalize reached_showdown per hand
    for h in hands:
        if any(h.collected_with.values()):
            h.reached_showdown = True
        else:
            tabled = sum(1 for a in h.seated_accounts
                         if a not in h.folded and len(h.shown_before_end.get(a, ())) >= 2)
            h.reached_showdown = tabled >= 2

    return hands, last_nick


# ---------------------------------------------------------------- position / button

def seat_position(offset, n):
    if n == 2:
        return "BTN" if offset == 0 else "BB"
    if offset == 0:
        return "BTN"
    if offset == 1:
        return "SB"
    if offset == 2:
        return "BB"
    if offset == n - 1:
        return "CO"
    if offset == 3:
        return "UTG"
    return "MP"


def hand_positions(hand):
    """account_label -> position string, or {} if position is unknown for this hand
    (duplicate seat number, or no way to find the button)."""
    seats = hand.seats
    n = len(seats)
    if n < 2:
        return {}
    nums = [s[0] for s in seats]
    if len(set(nums)) != n:
        return {}
    index_of = {lbl: i for i, (_num, lbl) in enumerate(seats)}

    live_sb = live_bb = None
    for street, acct, kind, _amt in hand.actions:
        if kind == "live_small":
            live_sb = acct if live_sb is None else live_sb
        if kind == "live_big":
            live_bb = acct if live_bb is None else live_bb

    dealer_idx = index_of.get(hand.dealer) if hand.dealer else None
    button_idx = None
    if dealer_idx is not None:
        button_idx = dealer_idx
    else:
        sb_idx = index_of.get(live_sb) if live_sb else None
        bb_idx = index_of.get(live_bb) if live_bb else None
        if n == 2 and sb_idx is not None:
            button_idx = sb_idx
        elif bb_idx is not None:
            button_idx = (1 - bb_idx) if n == 2 else (bb_idx - 2) % n
        elif sb_idx is not None:
            button_idx = (sb_idx - 1) % n
    if button_idx is None:
        return {}

    positions = {}
    for i, (_num, lbl) in enumerate(seats):
        offset = (i - button_idx) % n
        positions[lbl] = seat_position(offset, n)
    return positions


# ---------------------------------------------------------------- person resolution

def resolve_person_for_account(gid, pid, nick_hint, t, ledger_full, last_nick_in_log, canon, filed_as, norm):
    """Section 0 'Person' rule."""
    ginfo = ledger_full.get(gid)
    seats = []
    if ginfo is not None:
        seats = [r for r in ginfo["rows"] if r["pid"] == pid and r["start"] is not None]
    if seats:
        covering = [s for s in seats if s["start"] <= t and (s["end"] is None or t <= s["end"])]
        if covering:
            # most specific: latest start <= t; ties broken by file order
            seat = max(covering, key=lambda s: (s["start"], -s["idx"]))
        else:
            def gap(s):
                if t <= s["start"]:
                    return s["start"] - t
                if s["end"] is not None:
                    return t - s["end"] if t > s["end"] else 0
                return t - s["start"]
            seat = min(seats, key=lambda s: (gap(s), s["idx"]))
        return canon(seat["owner"] or filed_as(seat["nick"], pid))
    # no ledger seats on this pid: fall back to the account's last nickname in the whole log
    nick = last_nick_in_log.get(pid, nick_hint)
    nm = norm(nick)
    return canon(nm) if nm else ("@" + pid)


# ---------------------------------------------------------------- playtime helpers

def union_seconds(intervals):
    """intervals: [(start, end)] with end possibly None meaning +inf for this call's
    purpose (caller resolves None beforehand). Returns total covered seconds."""
    ivs = sorted((s, e) for s, e in intervals if s is not None and e is not None and e > s)
    total = 0
    cur_s = cur_e = None
    for s, e in ivs:
        if cur_s is None:
            cur_s, cur_e = s, e
        elif s <= cur_e:
            cur_e = max(cur_e, e)
        else:
            total += cur_e - cur_s
            cur_s, cur_e = s, e
    if cur_s is not None:
        total += cur_e - cur_s
    return total


def hand_lengths(starts):
    """starts: sorted list of hand start epochs (may contain None -- filtered by caller
    before this is called). Returns list of lengths, one per hand, capped and with the
    special last-hand-of-night rule."""
    n = len(starts)
    if n == 0:
        return []
    if n == 1:
        return [K_DEFAULT_HAND_SECONDS]
    gaps = [min(starts[i + 1] - starts[i], K_MAX_HAND_SECONDS) for i in range(n - 1)]
    lengths = gaps[:]  # hand i's length = gap to hand i+1, for i = 0..n-2
    sg = sorted(gaps)
    m = len(sg)
    if m % 2 == 1:
        med = sg[m // 2]
    else:
        med = (sg[m // 2 - 1] + sg[m // 2]) / 2
    lengths.append(min(med, K_MAX_HAND_SECONDS))
    return lengths


# ---------------------------------------------------------------- main compute()

def compute(root, games, canon, filed_as, norm, owners):
    ledger_full = build_ledger_full(root, games, canon, filed_as, norm, owners)
    logs = discover_logs(root, games)

    style = collections.defaultdict(lambda: collections.Counter())
    playstyle_made = collections.defaultdict(lambda: collections.Counter())
    playstyle_opp = collections.defaultdict(lambda: collections.Counter())
    rivals = collections.defaultdict(lambda: [0, 0])  # (loser,winner) -> [times, cents]

    hands_dealt = collections.Counter()
    seconds_dealt = collections.defaultdict(float)
    seconds_estimated = collections.defaultdict(float)
    nights_logged = collections.defaultdict(set)  # person -> set of gid

    pool_showdown_hands = 0
    pool_at_showdown_seats = 0
    pool_showdown_win_seats = 0
    total_hands = 0

    log_info_out = {}

    for log_id, info in logs.items():
        gid = info["gid"]
        path = info["path"]
        hands, last_nick_in_log = parse_log(path)
        total_hands += len(hands)
        log_info_out[log_id] = {"path": path, "gid": gid, "hands": len(hands),
                                 "first_hand_number": hands[0].number if hands else None}

        def person_at(pid_label, t):
            nick, pid = split_account_label(pid_label)
            return resolve_person_for_account(gid, pid, nick, t, ledger_full, last_nick_in_log, canon, filed_as, norm)

        # ---- playtime: hands_dealt / seconds_dealt for this log
        starts = [h.start for h in hands if h.start is not None]
        lengths = hand_lengths(starts) if len(starts) == len(hands) else []
        night_persons_dealt = set()
        for h, length in zip(hands, lengths if lengths else [0] * len(hands)):
            persons_here = set()
            for acct in h.seated_accounts:
                nick, pid = split_account_label(acct)
                persons_here.add(resolve_person_for_account(gid, pid, nick, h.start, ledger_full, last_nick_in_log, canon, filed_as, norm))
            for p in persons_here:
                hands_dealt[p] += 1
                seconds_dealt[p] += length
                night_persons_dealt.add(p)
        for p in night_persons_dealt:
            nights_logged[p].add(gid)

        # seconds_estimated: pre-log-start time, only if this log starts late
        if hands and hands[0].number > 1 and gid in ledger_full:
            first_t = hands[0].start
            by_person = collections.defaultdict(list)
            for row in ledger_full[gid]["rows"]:
                if row["start"] is None:
                    continue
                p = person_of_row(row, canon, filed_as)
                end = row["end"]  # open end = forever for this computation
                s = row["start"]
                if end is not None and end <= first_t:
                    by_person[p].append((s, end))
                elif s < first_t:
                    by_person[p].append((s, first_t))
                # else: seat starts at/after the log's first hand -> no pre-log time
            for p, ivs in by_person.items():
                seconds_estimated[p] += union_seconds(ivs)

        # ---- per-hand style / playstyle / showdown / rivals
        for h in hands:
            if h.reached_showdown:
                pool_showdown_hands += 1
            at_showdown_accts = [a for a in h.seated_accounts if a not in h.folded] if h.reached_showdown else []
            pool_at_showdown_seats += len(at_showdown_accts)
            win_accts = [a for a in h.seated_accounts if h.collected_with.get(a)]
            pool_showdown_win_seats += len(win_accts)

            # person-level sets for this hand
            acct_person = {}
            for a in h.seated_accounts:
                nick, pid = split_account_label(a)
                acct_person[a] = resolve_person_for_account(gid, pid, nick, h.start, ledger_full, last_nick_in_log, canon, filed_as, norm)

            saw_flop_persons = set()
            if not h.bomb_pot and h.saw_street["flop"]:
                folded_preflop = set()
                for street, acct, kind, _amt in h.actions:
                    if street == "preflop" and kind == "folds":
                        folded_preflop.add(acct)
                for a in h.seated_accounts:
                    if a not in folded_preflop:
                        saw_flop_persons.add(acct_person[a])
                for p in saw_flop_persons:
                    style[p]["saw_flop"] += 1

            at_showdown_persons = {acct_person[a] for a in at_showdown_accts}
            for p in at_showdown_persons:
                style[p]["showdowns"] += 1
                playstyle_opp[p]["wsd"] += 1
            if not h.bomb_pot:
                for p in at_showdown_persons:
                    style[p]["showdowns_voluntary"] += 1
                    playstyle_made[p]["wtsd"] += 1
            if h.bomb_pot:
                pass  # saw_flop opportunity for WTSD stays excluded (bomb pot hand)
            win_persons = {acct_person[a] for a in win_accts}
            for p in win_persons:
                style[p]["showdown_wins"] += 1
                playstyle_made[p]["wsd"] += 1
            for p in saw_flop_persons:
                playstyle_opp[p]["wtsd"] += 1

            courtesy_persons = set()
            for a in h.seated_accounts:
                if len(h.shown_all.get(a, ())) == 1:
                    courtesy_persons.add(acct_person[a])
            for p in courtesy_persons:
                style[p]["courtesy_reveals"] += 1

            # ---- rivals
            if h.reached_showdown:
                loser_persons = at_showdown_persons - win_persons
                if loser_persons:
                    contributed, collected_total, uncalled = (collections.defaultdict(float) for _ in range(3))
                    street_committed = collections.defaultdict(lambda: collections.defaultdict(float))
                    # PokerNow's call/bet/raise amounts are what the player has in on that street in
                    # total ("calls 2.00" facing a raise to 2.00, whatever they had posted), so each
                    # action adds only the step up from what they already had in. Live blinds work the
                    # same way: a returning player who posts the small blind and then a missed big
                    # blind is in for the big blind, not both (stacks confirm: 72.62 -> 71.87 with a
                    # 0.25 dead small blind on top). A dead small blind ("posts a missing small
                    # blind") is extra money in the pot that does not count toward calling.
                    for street, acct, kind, amt in h.actions:
                        if kind == "blind_sb_dead":
                            contributed[acct] += amt
                        elif kind in ("blind_sb", "blind_bb", "calls", "bets", "raises_to"):
                            prior = street_committed[street][acct]
                            if amt > prior:
                                contributed[acct] += amt - prior
                                street_committed[street][acct] = amt
                        elif kind == "uncalled_return":
                            uncalled[acct] += amt
                    for acct, amt in h.collected.items():
                        collected_total[acct] += amt

                    net_by_person = collections.defaultdict(float)
                    for a in h.seated_accounts:
                        net_by_person[acct_person[a]] += collected_total.get(a, 0.0) + uncalled.get(a, 0.0) - contributed.get(a, 0.0)
                    win_collected = collections.defaultdict(float)
                    for a in win_accts:
                        win_collected[acct_person[a]] += collected_total.get(a, 0.0)
                    total_win_collected = sum(win_collected[p] for p in win_persons)

                    # Spec section 5: every loser is beaten by every winner once, whatever the amount.
                    # Amounts are kept in dollars and rounded to cents only at the end, like the app.
                    for loser in loser_persons:
                        loss = max(0.0, -net_by_person[loser])
                        for winner in win_persons:
                            share = (win_collected[winner] / total_win_collected if total_win_collected > 0
                                     else 1.0 / len(win_persons))
                            entry = rivals[(loser, winner)]
                            entry[0] += 1
                            entry[1] += loss * share

            if h.bomb_pot:
                continue  # limp/open/steal/cbet/donk/checkraise skip bomb-pot hands entirely

            positions = hand_positions(h)

            # ---- limp / open / steal
            pot_unopened = True
            decided = set()
            for street, acct, kind, amt in h.actions:
                if street != "preflop":
                    break
                if kind not in ("folds", "checks", "calls", "raises_to", "bets"):
                    continue
                p = acct_person.get(acct)
                if p is None:
                    continue
                if acct not in decided:
                    decided.add(acct)
                    if pot_unopened:
                        playstyle_opp[p]["limp"] += 1
                        playstyle_opp[p]["open"] += 1
                        pos = positions.get(acct)
                        is_steal_pos = pos in ("CO", "BTN", "SB")
                        if is_steal_pos:
                            playstyle_opp[p]["steal"] += 1
                        if kind == "calls":
                            playstyle_made[p]["limp"] += 1
                        elif kind in ("raises_to", "bets"):
                            playstyle_made[p]["open"] += 1
                            if is_steal_pos:
                                playstyle_made[p]["steal"] += 1
                if kind in ("calls", "raises_to", "bets"):
                    pot_unopened = False

            # ---- preflop aggressor (last preflop raiser)
            aggressor = None
            for street, acct, kind, amt in h.actions:
                if street != "preflop":
                    continue
                if kind == "raises_to":
                    aggressor = acct
            aggressor_person = acct_person.get(aggressor) if aggressor else None

            preflop_folded = {acct for street, acct, kind, _a in h.actions if street == "preflop" and kind == "folds"}
            aggressor_sees_flop = (aggressor is not None and aggressor not in preflop_folded and
                                    h.saw_street["flop"])

            if aggressor_sees_flop:
                flop_seen_first = set()
                no_bet_yet = True
                agg_acted = False
                for street, acct, kind, amt in h.actions:
                    if street != "flop" or agg_acted:
                        continue
                    if kind not in ("checks", "calls", "bets", "raises_to", "folds"):
                        continue
                    first_time = acct not in flop_seen_first
                    if acct == aggressor:
                        if first_time:
                            # opportunity only if nobody has bet the flop yet (else it's
                            # a donk bet into the aggressor, who had no c-bet chance)
                            if no_bet_yet:
                                p = aggressor_person
                                playstyle_opp[p]["cbet"] += 1
                                if kind == "bets":
                                    playstyle_made[p]["cbet"] += 1
                            agg_acted = True
                        flop_seen_first.add(acct)
                        continue
                    if first_time and no_bet_yet:
                        p = acct_person.get(acct)
                        if p is not None:
                            playstyle_opp[p]["donk"] += 1
                            if kind == "bets":
                                playstyle_made[p]["donk"] += 1
                    flop_seen_first.add(acct)
                    if kind == "bets":
                        no_bet_yet = False

            # ---- check-raise, per postflop street (flop, turn, river)
            for target_street in ("flop", "turn", "river"):
                checked = set()
                resolved = set()
                for street, acct, kind, amt in h.actions:
                    if street != target_street:
                        continue
                    if kind == "checks":
                        if acct not in resolved:
                            checked.add(acct)
                    elif kind in ("folds", "calls", "bets", "raises_to"):
                        # Spec section 2: acting again after a check (fold, call or raise) is the
                        # chance; only the raise is the check-raise.
                        if acct in checked and acct not in resolved:
                            p = acct_person.get(acct)
                            if p is not None:
                                playstyle_opp[p]["checkraise"] += 1
                                if kind == "raises_to":
                                    playstyle_made[p]["checkraise"] += 1
                            resolved.add(acct)
                            checked.discard(acct)

        # end for h in hands

    # ---- playtime: nights without a log, for every game in `games`
    for gid, g in games.items():
        if any(info["gid"] == gid for info in logs.values()):
            continue
        if gid not in ledger_full:
            continue
        game_end = g.get("end")
        by_person = collections.defaultdict(list)
        for row in ledger_full[gid]["rows"]:
            if row["start"] is None:
                continue
            p = person_of_row(row, canon, filed_as)
            end = row["end"]
            if end is None:
                end = game_end if game_end is not None else row["start"]
            by_person[p].append((row["start"], end))
        for p, ivs in by_person.items():
            seconds_estimated[p] += union_seconds(ivs)

    # ---- assemble output
    style_out = {}
    for p, c in style.items():
        style_out[p] = {
            "saw_flop": c["saw_flop"], "showdowns": c["showdowns"],
            "showdowns_voluntary": c["showdowns_voluntary"],
            "showdown_wins": c["showdown_wins"], "courtesy_reveals": c["courtesy_reveals"],
        }
    playstyle_out = {}
    people = set(playstyle_made) | set(playstyle_opp)
    for p in people:
        playstyle_out[p] = {}
        for stat in ("limp", "open", "steal", "cbet", "donk", "checkraise", "wtsd", "wsd"):
            playstyle_out[p][stat] = (playstyle_made[p][stat], playstyle_opp[p][stat])

    rivals_out = {k: [v[0], int(round(v[1] * 100))] for k, v in rivals.items() if v[0] >= 1}   # [times, cents]

    people_pt = set(hands_dealt) | set(seconds_dealt) | set(seconds_estimated)
    playtime_out = {}
    for p in people_pt:
        playtime_out[p] = {
            "hands_dealt": hands_dealt[p],
            "nights_logged": len(nights_logged.get(p, ())),
            "seconds_dealt": seconds_dealt[p],
            "seconds_estimated": seconds_estimated[p],
        }

    pool = {
        "logs": len(logs), "hands": total_hands,
        "showdown_hands": pool_showdown_hands,
        "at_showdown_seats": pool_at_showdown_seats,
        "showdown_win_seats": pool_showdown_win_seats,
        "wsd_pct": (100.0 * pool_showdown_win_seats / pool_at_showdown_seats) if pool_at_showdown_seats else None,
    }

    return {
        "logs": log_info_out,
        "style": style_out,
        "playstyle": playstyle_out,
        "rivals": rivals_out,
        "playtime": playtime_out,
        "pool": pool,
    }


# ---------------------------------------------------------------- __main__

def _self_contained_helpers():
    """A tiny copy of validate.py's norm/filed_as/canon/games-loading, used only by
    this module's __main__ so it can run standalone without importing validate.py's
    app-driving code (which requires a built binary)."""
    def norm(s):
        return re.sub(r'[^a-z]', '', s.lower()) or re.sub(r'[^0-9]', '', s)

    def filed_as(nick, pid):
        return norm(nick) or re.sub(r'[^a-z]', '', ("unnamed " + pid).lower())

    return norm, filed_as


def _load_games_and_owners(root):
    norm, filed_as = _self_contained_helpers()

    rules = {}
    mr_path = os.path.join(root, "Saved_Data", "merge_rules.csv")
    if os.path.exists(mr_path):
        with open(mr_path, encoding="utf-8") as f:
            r = csv.reader(f)
            next(r, None)
            for row in r:
                if len(row) >= 2:
                    rules[norm(row[0])] = norm(row[1])

    def canon(n):
        seen = 0
        while n in rules and rules[n] != n and seen < 64:
            n = rules[n]
            seen += 1
        return n

    owners = {}
    seats_path = os.path.join(root, "Saved_Data", "seat_owners.csv")
    if os.path.exists(seats_path):
        for r in csv.DictReader(open(seats_path, encoding="utf-8")):
            owners[(r["ledger_id"], r["player_id"], parse_iso(r["session_start_at"]), norm(r["nickname"]))] = norm(r["owner_normalized"])

    data_dir = os.path.join(root, "Games") if os.path.isdir(os.path.join(root, "Games")) else root
    games = {}
    for path in sorted(glob.glob(os.path.join(data_dir, "**", "*.csv"), recursive=True)):
        if "Saved_Data" in path or os.path.basename(path).startswith("poker_now_log_"):
            continue
        with open(path, encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        if not rows or "player_nickname" not in rows[0]:
            continue
        gid = os.path.splitext(os.path.basename(path))[0].split(" ", 1)[0].strip()
        folder = os.path.relpath(os.path.dirname(path), data_dir)
        g = {"id": gid, "folder": folder, "rows": [], "start": None, "end": None, "buyin": 0}
        for row in rows:
            st = parse_iso(row["session_start_at"])
            net = int(row["net"])
            bi = int(row["buy_in"])
            if st is None and net == 0:
                continue
            owner = owners.get((gid, row["player_id"], st, norm(row["player_nickname"])))
            if owner is not None and canon(owner) == canon(filed_as(row["player_nickname"], row["player_id"])):
                owner = None
            g["rows"].append((row["player_nickname"], row["player_id"], st, bi, net, owner))
            g["buyin"] += bi
            if st is not None and (g["start"] is None or st < g["start"]):
                g["start"] = st
            last = parse_iso(row["session_end_at"]) or st
            if last is not None and (g["end"] is None or last > g["end"]):
                g["end"] = last
        old = games.get(gid)
        if g["rows"] and (old is None or (len(g["rows"]), g["end"] or 0) > (len(old["rows"]), old["end"] or 0)):
            games[gid] = g
    return games, canon, filed_as, norm, owners


if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\Camer\CLionProjects\Poker_Ledger_Reader"
    games, canon, filed_as, norm, owners = _load_games_and_owners(root)
    result = compute(root, games, canon, filed_as, norm, owners)
    pool = result["pool"]

    total_dealt_sec = sum(p["seconds_dealt"] for p in result["playtime"].values())
    total_est_sec = sum(p["seconds_estimated"] for p in result["playtime"].values())

    print(f"logs: {pool['logs']}")
    print(f"hands: {pool['hands']}")
    print(f"showdown hands: {pool['showdown_hands']}")
    print(f"at-showdown seats (account level, summed over hands): {pool['at_showdown_seats']}")
    print(f"showdown win seats: {pool['showdown_win_seats']}")
    wsd = pool['wsd_pct']
    print(f"pool W$SD (win seats / at-showdown seats): {wsd:.1f}%" if wsd is not None else "pool W$SD: n/a")
    print(f"total hours dealt (sum of seconds_dealt / 3600): {total_dealt_sec/3600:.1f}")
    print(f"total hours estimated (sum of seconds_estimated / 3600): {total_est_sec/3600:.1f}")

    top_pairs = sorted(result["rivals"].items(), key=lambda kv: (-kv[1][0], -kv[1][1]))[:5]
    print("top 5 rival pairs (loser -> winner: times, amount):")
    for (loser, winner), (times, amt_cents) in top_pairs:
        print(f"  {loser} -> {winner}: {times}x, ${amt_cents/100:.2f}")
