"""Thin driver the Pyodide worker calls. Wraps the canonical solver
(build_weekly_schedule.py) and returns a JSON-serializable report so the
browser never has to scrape stdout.

Usage (in Pyodide OR under CPython for parity testing):
    import runner
    report_json = runner.run('/work/config.json')

The output xlsx is written to cfg['out'] (the worker reads its bytes back).

MANUAL EDITS (2026-08): after run() the built Result stays in _STATE, so the
UI can change assignments without a rebuild:
    runner.candidates(json)       -> who can take a given (day, role) slot, and why not
    runner.apply_edit(json)       -> move/fill/remove a slot, re-verify, rewrite xlsx
    runner.add_options(json)      -> which days a named driver could be GIVEN a shift on
    runner.swap_candidates(json)  -> who on a full day's routes could step down to backup
    runner.apply_add(json)        -> give a driver an extra shift (plain / via swap / extra route)
    runner.wave_options(json)     -> which other waves a driver's shift could move to that day
    runner.apply_wave(json)       -> move a shift to another wave (roads swap; backups relabel)
    runner.undo_last(json)        -> restore the state before the most recent edit
All take/return JSON strings. The rules mirrored here are the same invariants
check_invariants() enforces -- after every edit the verifier reruns, so even a
rule this mirror missed would still surface in the report banner.

OVERRIDES (2026-10): edits are gated by _assess(): compliance rules are
refused outright, a submitted day off needs payload.confirm_unavailable, and
tier-policy breaks are allowed but logged; _verify() reports the errors those
approved overrides cause as chk["overridden"] instead of a FAILED build.

LIVE BOARD (2026-10-06): the engine keeps one state per SLOT -- 'build' (the
wizard) and 'live' (a published week on the Live board) -- so working on this
week never clobbers next week's build. use_slot(name) picks one before a call.
    runner.export_state(json)  -> the whole live Result as a JSON string (Firestore)
    runner.load_state(json)    -> rehydrate a saved week into the current slot
    runner.apply_mark(json)    -> call-out / no-show / day off: frees that day's shift
    runner.clear_mark(json)    -> remove a mark (the shift is NOT put back)
    runner.export_xlsx(json)   -> write the workbook on demand (the live slot
                                  skips the per-edit rewrite)

HOURS + 6-DAYS (2026-10-06, Jose): two HARD limits everywhere, on the clock
hours (route 10h, backup 2h, meeting 2h, dispatch 12h; last week from its Live
board when published, else 10h per worked day): never over 12h in a day, never
over 60h in ANY 7-day window (last week included). And 7 days in a row is
never allowed. On the LIVE board only, a 6-day (6 in a row or a 6th worked
day in the week) and overtime (road over 40h / over the road-day cap) are
allowed after a pop-up: _assess() puts them in `limits`, the edit must carry
confirm_limits, and the verifier lists them as approved overrides.

AUTO TRAINERS (2026-10): cfg["auto_training"] = [{trainee, pool}] is resolved
to concrete training_pairs by rotation before the build (see
_build_with_auto_trainers).
"""
import contextlib
import copy
import datetime
import io
import json
import re

from build_weekly_schedule import (
    load_config, build_schedule, write_xlsx, check_invariants, print_summary,
    ScheduleConfigError, FREE_name, norm, ALL as ALL_DAYS, Result,
)

WEEKEND = {'Sat', 'Sun'}
ONE = datetime.timedelta(days=1)

# The live build this session (res mutates in place as edits are applied).
# 'undo' holds one snapshot of the mutable state per applied edit, newest last.
# 'marks' = {day: {norm_name: {name, kind, was, note}}} -- call-outs etc.
# 'write' = rewrite the xlsx after every edit (the wizard needs it; the Live
# board downloads on demand instead).
def _new_state(write=True, live=False):
    return {'cfg': None, 'res': None, 'edits': [], 'undo': [],
            'ovr_unav': set(), 'ovr_policy': set(), 'ovr_limits': set(),
            'marks': {}, 'write': write, 'live': live}


_SLOTS = {'build': _new_state()}
_STATE = _SLOTS['build']


def use_slot(name):
    """Point every call that follows at one engine state ('build' | 'live')."""
    global _STATE
    if name not in _SLOTS:
        _SLOTS[name] = _new_state(write=(name == 'build'), live=name.startswith('live'))
    _STATE = _SLOTS[name]
    return name


MARK_LABEL = {'callout': 'Called out', 'noshow': 'No-show', 'off': 'Day off'}


def _classify(dr, res):
    n = norm(dr["name"])
    if n in getattr(res, "REDS", set()):
        return "reduced"
    if n in res.MOST:
        return "most"
    if n in res.TARGET:
        return "exact"
    return "free"


def _driver_rows(res):
    rows = []
    for i, dr in enumerate(res.roster):
        n = norm(dr["name"])
        prim = sorted(dr["prim"])
        bk = sorted(dr["bk"])
        helper = sorted(dr["helper"])
        extra = sorted(dr["extra"])
        meet = sorted(dr["meet"])
        hours = (len(prim) + len(helper)) * res.PH + len(bk) * res.BH
        # Per-day assignment text (exact wave / Backup / Dispatch / meeting /
        # TRAIN note), for the driver-notice CSV. Falls back to Unavailable /
        # blank so every day has a value.
        cells = {}
        for d in ALL_DAYS:
            mk = _STATE["marks"].get(d, {}).get(n)
            if d in res.cell and i in res.cell[d]:
                cells[d] = res.cell[d][i]
            elif mk:
                cells[d] = MARK_LABEL.get(mk["kind"], mk["kind"])
            elif d in dr["meet"]:
                cells[d] = dr["meet_txt"].get(d, "Meeting")
            elif d in dr["extra"]:
                cells[d] = "Dispatch"
            elif d in dr["unav"]:
                cells[d] = "Unavailable"
            else:
                cells[d] = ""
        rows.append(dict(
            name=dr["name"],
            cls=_classify(dr, res),
            target=res.TARGET.get(n),
            road_days=prim,
            backup_days=bk,
            helper_days=helper,
            dispatch_days=extra,
            meeting_days=meet,
            unavailable=sorted(dr["unav"]),
            hours=hours,
            cells=cells,
            worked_dates=sorted(x.isoformat() for x in _worked_dates(res, dr)),
            streak=_streak(res, dr),
            day_hours={k.isoformat(): v for k, v in sorted(_day_hours(res, dr).items())},
            # rounded: real hours (11.37 + 9.65 …) would otherwise show as 51.0199999
            clock_hours=_num(sum(v for k, v in _day_hours(res, dr).items()
                                 if k >= res.DATEALL["Sun"])),
            max7=_num(_max7(_day_hours(res, dr), [res.DATEALL[d] for d in ALL_DAYS])[0]),
            # days this week whose hours are ACTUAL (Route Tracker clock-outs), not planned
            act_dates=sorted(k.isoformat() for k in (dr.get("h_act") or {})),
        ))
    rows.sort(key=lambda r: (-r["hours"], r["name"]))
    return rows


def _sched_dates(res, dr):
    """This week's SCHEDULED worked dates (road, backup, training, dispatch, meeting)."""
    s = set()
    for k in ("prim", "bk", "helper", "extra", "meet"):
        s |= {res.DATEALL[d] for d in dr[k] if d in res.DATEALL}
    return s


def _act_dates(dr):
    """Dates Route Tracker says the driver really worked this week (clock-outs)."""
    return {d for d, h in (dr.get("h_act") or {}).items() if h}


def _worked_dates(res, dr):
    """This week's worked dates: scheduled ones plus any day with a real clock-out
    (an extra shift nobody put on the schedule still counts toward days in a row)."""
    return _sched_dates(res, dr) | _act_dates(dr)


def _streak(res, dr):
    """Longest run of consecutive worked days, prior-week tail included."""
    s = set(dr["w_prev"]) | _worked_dates(res, dr)
    best = 0
    for x in s:
        if x - ONE in s:
            continue
        n = 1
        while x + n * ONE in s:
            n += 1
        best = max(best, n)
    return best


def _days_info(res, chk):
    pd = chk.get("per_day", {}) if chk else {}
    return [dict(day=d, date=res.DATEALL[d].isoformat(),
                 open=d in res.DAYS,
                 routes=res.routes.get(d, 0), backup=res.backup.get(d, 0),
                 routes_filled=pd.get(d, {}).get("routes", 0),
                 backup_filled=pd.get(d, {}).get("backup", 0),
                 waves=dict(res.waves.get(d, {})))
            for d in ALL_DAYS]


def _report(cfg, res, chk):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        print_summary(res, chk)
    return dict(
        ok=True,
        clean=(not chk["errors"] and not res.infeasible),
        out=cfg["out"],
        week_label=cfg.get("week_label", ""),
        check=chk,
        summary_text=buf.getvalue(),
        infeasible=list(res.infeasible),
        notes=list(res.notes),
        pairlog=[list(t) for t in res.PAIRLOG],
        fallback_used=[list(t) for t in res.fallback_used],
        drivers=_driver_rows(res),
        edits=list(_STATE["edits"]),
        can_undo=bool(_STATE["undo"]),
        days=_days_info(res, chk),
        limits=dict(max_consecutive=res.MAXC, primary_hours=res.PH,
                    backup_hours=res.BH, max_road_days=res.MAXPRIM,
                    weekly_hours_cap=res.HCAP, max_worked_days=res.MAXTOT,
                    max_day_hours=MAX_DAY_H, max_7day_hours=MAX_7DAY_H,
                    dispatch_hours=DISPATCH_H, live=bool(_STATE.get("live"))),
        marks=[dict(day=d, **m) for d in ALL_DAYS
               for m in _STATE["marks"].get(d, {}).values()],
    )


def _avail_days(res, name):
    _, dr = _find(res, name)
    if dr is None:
        return set()
    return {d for d in res.DAYS if d not in dr["unav"]}


def _build_with_auto_trainers(cfg):
    """Resolve cfg['auto_training'] = [{trainee, pool:[trainer names in
    rotation order]}] into concrete training_pairs, then build.

    Rotation (Jose 2026-10-03): the app hands each pool over already ordered
    least-recently-used first. Each auto trainee takes the first trainer in
    that order who isn't already training someone this week (if anyone else
    is left), and the pick moves to the back of the line. A pick that can't
    share a feasible day with the trainee is swapped for the next trainer and
    the week is rebuilt (bounded). Returns (cfg_used, res, notes)."""
    auto = [a for a in (cfg.get("auto_training") or []) if a.get("trainee")]
    if not auto:
        return cfg, build_schedule(cfg), []

    queue = []
    for a in auto:
        for t in a.get("pool") or []:
            if t not in queue:
                queue.append(t)
    fixed = {norm(p["trainer"]) for p in cfg.get("training_pairs", [])}
    tried = [set() for _ in auto]
    pick = [None] * len(auto)

    def _choose(k, used, avail_ok=None):
        pool = [t for t in queue if t in (auto[k].get("pool") or [])
                and norm(t) != norm(auto[k]["trainee"]) and t not in tried[k]]
        if avail_ok is not None:
            pool = [t for t in pool if avail_ok(t)] or pool
        fresh = [t for t in pool if norm(t) not in used]
        return (fresh or pool or [None])[0]

    used = set(fixed)
    for k in range(len(auto)):
        pick[k] = _choose(k, used)
        if pick[k]:
            used.add(norm(pick[k]))
            queue.remove(pick[k]); queue.append(pick[k])

    notes = []
    res = c = None
    for _attempt in range(8):
        c = copy.deepcopy(cfg)
        c["training_pairs"] = list(cfg.get("training_pairs", [])) + [
            dict(trainer=pick[k], trainee=a["trainee"])
            for k, a in enumerate(auto) if pick[k]]
        res = build_schedule(c)
        placed = {norm(t[1]) for t in res.PAIRLOG}
        failed = [k for k, a in enumerate(auto)
                  if pick[k] and norm(a["trainee"]) not in placed]
        if not failed:
            break
        changed = False
        for k in failed:
            tried[k].add(pick[k])
            mine = _avail_days(res, auto[k]["trainee"])
            if not mine:
                continue           # the trainee has no open day - no trainer helps
            used ={norm(p) for j, p in enumerate(pick) if p and j != k} | fixed
            nxt = _choose(k, used, lambda t: bool(mine & _avail_days(res, t)))
            if nxt and nxt != pick[k]:
                pick[k] = nxt
                changed = True
        if not changed:
            break
    for k, a in enumerate(auto):
        if not pick[k]:
            notes.append(f"TRAINING: no trainer available for {a['trainee']} - "
                         "mark trainers in Step 7.")
        elif norm(a["trainee"]) in {norm(t[1]) for t in res.PAIRLOG}:
            notes.append(f"Auto-picked trainer for {a['trainee']}: {pick[k]} "
                         "(rotation)")
    return c, res, notes


def run(config_path):
    """Return a JSON string. On success: {ok:true, ...report}. On a config
    error: {ok:false, kind:'config', message}. On any other crash:
    {ok:false, kind:'crash', message} (with a traceback)."""
    try:
        cfg = load_config(config_path)
        cfg, res, tnotes = _build_with_auto_trainers(cfg)
        res.notes = list(res.notes) + tnotes
        if _apply_actual(res, cfg.get("actual")):   # last week's REAL hours (Route Tracker)
            res.notes = list(res.notes) + ["Last week's hours: actual clock-outs from Route Tracker"]
        write_xlsx(res)                       # -> cfg['out']
        _STATE.update(cfg=cfg, res=res, edits=[], undo=[],
                      ovr_unav=set(), ovr_policy=set(), ovr_limits=set(), marks={})
        chk = _verify(res)
        # Shortfalls straight from the finished grid (routes AND backups), so
        # the on-screen warnings match the workbook's totals row.
        res.infeasible = ([ln for ln in res.infeasible if not ln.startswith(("P1 ", "P2 "))]
                          + _recount_short(res, chk))
        # json.dumps turns int dict keys (Counter distributions) into strings
        # and tuples into lists automatically -> browser-safe.
        return json.dumps(_report(cfg, res, chk), default=str)
    except ScheduleConfigError as e:
        return json.dumps(dict(ok=False, kind="config", message=str(e)))
    except Exception:  # noqa: BLE001 - report any solver crash to the UI
        import traceback
        return json.dumps(dict(ok=False, kind="crash",
                               message=traceback.format_exc()))


# ------------------------------------------------------------ edit helpers ----
def _pdays(dr):
    # primary-day count for caps: driver-of-record + training-helper days
    return len(dr["prim"]) + len(dr["helper"])


def _hours(res, dr):
    # same H the verifier uses (road + backup hours)
    return _pdays(dr) * res.PH + len(dr["bk"]) * res.BH


def _road_hours_real(res, dr):
    """This week's road hours for the overtime check: the REAL hours of days already
    worked (Route Tracker), planned 10h for road days still to come. With no clock-outs
    this is exactly _pdays * PH, as before."""
    act = dr.get("h_act") or {}
    road = {res.DATEALL[d] for k in ("prim", "helper") for d in dr[k] if d in res.DATEALL}
    return sum(act.get(d, 0) for d in act) + sum(res.PH for d in road if d not in act)


def _run_len(res, dr, day):
    """Longest consecutive worked run through `day` if the driver also worked
    `day` -- prior-week tail included, same as the solver's runok()."""
    dt = res.DATEALL[day]
    s = set(dr["w_prev"])
    for k in ("prim", "bk", "helper"):
        s |= {res.DATEALL[d] for d in dr[k]}
    s |= {res.DATEALL[d] for d in dr["extra"] if d in res.DATEALL}
    s |= {res.DATEALL[d] for d in dr["meet"] if d in res.DATEALL}
    s |= _act_dates(dr)                      # real clock-outs on unscheduled days
    s.add(dt)
    n = 0
    c = dt
    while c in s:
        n += 1
        c -= ONE
    f = dt + ONE
    while f in s:
        n += 1
        f += ONE
    return n


def _wknd_used(dr):
    return (sum(1 for x in dr["prim"] + dr["bk"] + dr["helper"] if x in WEEKEND)
            + sum(1 for x in dr["extra"] | dr["meet"] if x in WEEKEND))


def _no_state():
    return json.dumps(dict(
        ok=False, kind="no_state",
        message="The engine has no schedule in memory (the page was reloaded "
                "or the engine restarted). Rebuild first, then make manual edits."))


MAX_DAY_H = 12        # on the clock in one day
MAX_7DAY_H = 60       # on the clock in any 7 days in a row
DISPATCH_H = 12       # a dispatch day (Amazon's Dispatcher shift is 12h)


def _day_hours(res, dr):
    """{date: hours on the clock} for this week AND last week's tail."""
    out = dict(dr.get("h_prev") or {d: res.PH for d in dr["w_prev"]})
    for k, h in (("prim", res.PH), ("helper", res.PH), ("bk", res.BH),
                 ("meet", res.BH), ("extra", DISPATCH_H)):
        for d in dr[k]:
            if d in res.DATEALL:
                dt = res.DATEALL[d]
                out[dt] = out.get(dt, 0) + h
    # days already worked: the real hours from Route Tracker's clock-outs win (_apply_actual)
    for dt, h in (dr.get("h_act") or {}).items():
        out[dt] = h
    return out


# ---- actual hours (2026-10-07): Route Tracker -> Schedule ------------------
# Route Tracker publishes every driver's real on-the-clock hours per day
# (Firestore actual_hours/{Sunday}, from dispatch's out times). For days already
# worked they replace the planned 10h / 2h: this week -> dr["h_act"], last week
# -> dr["h_prev"] (and w_prev). Drivers match by Amazon Transporter Id, else by
# first + last name; a name two people share is skipped (never guessed).
_SUFFIX = {"jr", "sr", "ii", "iii", "iv"}


def _fl_key(name):
    t = norm(str(name or "")).replace(".", "").replace(",", " ").split()
    if len(t) > 2 and t[-1] in _SUFFIX:
        t = t[:-1]
    if not t:
        return ""
    return t[0] + "|" + t[-1] if len(t) > 1 else t[0]


def _apply_actual(res, actual):
    """actual: [{name, keys: ["first|last", ...], tid, days: {ISO: hours}}].
    Returns how many roster drivers got actual hours."""
    if not actual:
        return 0
    by_tid, by_key, dup = {}, {}, set()
    for a in actual:
        if not isinstance(a, dict):
            continue
        if a.get("tid"):
            by_tid[str(a["tid"]).strip()] = a
        for k in {_fl_key(a.get("name"))} | {str(x) for x in (a.get("keys") or []) if x}:
            if not k:
                continue
            if k in by_key and by_key[k] is not a:
                dup.add(k)
            by_key[k] = a
    start = res.DATEALL["Sun"]
    lo, hi = start - 7 * ONE, start + 7 * ONE
    n = 0
    for dr in res.roster:
        a = by_tid.get(str(dr.get("tid")).strip()) if dr.get("tid") else None
        if a is None:
            k = _fl_key(dr["name"])
            a = None if k in dup else by_key.get(k)
        if a is None:
            continue
        act, prev = {}, {}
        for iso, h in (a.get("days") or {}).items():
            try:
                d, h = datetime.date.fromisoformat(iso), _num(h)
            except Exception:  # noqa: BLE001
                continue
            if start <= d < hi:
                act[d] = h
            elif lo <= d < start:
                prev[d] = h
        dr["h_act"] = act
        if prev:
            hp = dict(dr.get("h_prev") or {x: res.PH for x in dr["w_prev"]})
            hp.update(prev)
            dr["h_prev"] = {k: v for k, v in hp.items() if v}
            dr["w_prev"] = set(dr["w_prev"]) | {d for d, h in prev.items() if h}
        n += 1
    return n


def _num(h):
    h = float(h)
    return int(h) if h.is_integer() else round(h, 2)


def _max7(hours, dates=None):
    """Worst 7-day total among the windows that touch `dates` (default: every
    window in `hours`). Returns (total, first_day_of_window)."""
    if not hours:
        return 0, None
    keys = dates if dates is not None else list(hours)
    best, at = 0, None
    for d in keys:
        for k in range(7):
            s0 = d - k * ONE
            tot = sum(hours.get(s0 + j * ONE, 0) for j in range(7))
            if tot > best:
                best, at = tot, s0
    return _num(best), at


def _hour_limits(res, dr, day, role):
    """Hard on-the-clock limits for adding (day, role): 12h in a day, 60h in
    any 7 days (last week included). Returns block reasons."""
    hrs = _day_hours(res, dr)
    dt = res.DATEALL[day]
    add = {"road": res.PH, "trainer": res.PH, "dispatch": DISPATCH_H}.get(role, res.BH)
    hrs[dt] = hrs.get(dt, 0) + add
    out = []
    if hrs[dt] > MAX_DAY_H:
        out.append(f"would be on the clock {hrs[dt]}h on {day} (max {MAX_DAY_H}h)")
    tot, s0 = _max7(hrs, [dt])
    if tot > MAX_7DAY_H:
        e = s0 + 6 * ONE
        out.append(f"would be on the clock {tot}h in 7 days ({s0:%a %m/%d}-{e:%a %m/%d}; "
                   f"max {MAX_7DAY_H}h)")
    return out


def _assess(res, dr, day, role):
    """Return (status, reasons, notes) for giving `dr` the (day, role) slot.

    Manual edits sort every rule into one of three buckets (Jose 2026-10-03):
      'blocked' - COMPLIANCE / hard rule (consecutive days, overtime, worked-day
                  caps, an untrained new hire driving solo, a same-day clash).
                  Never overridable by hand.
      'unavail' - the driver submitted the day off. Allowed only through a
                  deliberate, typed confirmation in the UI.
      'warn'    - company POLICY (tier pins, Fair caps, backup eligibility,
                  weekend spread). Allowed; logged and flagged.
      'ok'      - nothing breaks.
    LIVE board (2026-10-06): a 6-day and overtime go to `limits` instead of
    'blocked' -- status 'confirm', allowed after a pop-up (confirm_limits).
    Returns (status, reasons, notes, limits)."""
    n = norm(dr["name"])
    blocks, unav, warns, notes, limits = [], [], [], [], []
    live = _STATE.get("live", False)
    HCAP = res.HCAP
    BKCAP = HCAP if HCAP else 4 * res.PH

    # hard day conflicts
    if day in dr["meet"]:
        blocks.append("has a meeting that day (do-not-touch)")
    elif day in dr["extra"]:
        blocks.append("on dispatch duty that day")
    elif n in _STATE["marks"].get(day, {}):
        mk = _STATE["marks"][day][n]
        unav.append(f"{MARK_LABEL.get(mk['kind'], mk['kind']).lower()} that day")
    elif day in dr["unav"]:
        if day in dr.get("std_added", set()):
            unav.append("standing day off (from preferences)")
        else:
            unav.append("marked Unavailable that day")
    if day in dr["prim"] or day in dr["helper"]:
        blocks.append("already on a route that day")
    if day in dr["bk"]:
        blocks.append("already a backup that day")
    td = dr.get("train_done")
    if td is not None and ALL_DAYS.index(day) < td:
        blocks.append(f"new hire - can't work before their training day "
                      f"({ALL_DAYS[td]})")

    # consecutive-days rule (incl. prior-week tail)
    if not blocks:
        rl = _run_len(res, dr, day)
        if rl > res.MAXC:
            if live and rl == res.MAXC + 1:
                limits.append(f"6-day: would work {rl} days in a row (usual max {res.MAXC})")
            else:
                blocks.append(f"would work {rl} days in a row (max "
                              f"{res.MAXC + 1 if live else res.MAXC})")
        blocks += _hour_limits(res, dr, day, role)

    # total worked-days caps
    tot = (_pdays(dr) + len(dr["bk"]) + len(dr["extra"]) + len(dr["meet"])
           + len(_act_dates(dr) - _sched_dates(res, dr)))     # + real unscheduled shifts
    if tot + 1 > res.MAXTOT:
        if live and tot + 1 == res.MAXTOT + 1:
            limits.append(f"6-day: a 6th worked day this week (usual max {res.MAXTOT})")
        else:
            blocks.append(f"already at {tot} worked days")
    if FREE_name(dr, res.TARGET, res.MOST) and _pdays(dr) + len(dr["bk"]) + 1 > res.FREETOT:
        warns.append(f"Fair drivers normally max out at {res.FREETOT} total days")

    # weekend cap (only when the config enables it)
    if res.weekend_rule and day in WEEKEND and _wknd_used(dr) + 1 > res.MAXWKND:
        warns.append(f"over the {res.MAXWKND}-weekend-day limit")

    if role in ("road", "trainer"):          # a trainer day counts as a road day
        wk = _road_hours_real(res, dr) + res.PH    # real hours for days already worked
        if HCAP and wk > HCAP:
            (limits if live else blocks).append(
                f"overtime: road hours go to {_num(wk)}h (over {HCAP}h)")
        elif _pdays(dr) + 1 > res.MAXPRIM:
            (limits if live else blocks).append(f"at the {res.MAXPRIM} road-day cap")
        capx = (getattr(res, "CAPX", {}) or {}).get(n, 0)
        if n in res.TARGET and n not in res.REDS:
            pin = min(res.TARGET[n] + capx, res.MAXPRIM)
            if _pdays(dr) + 1 > pin:
                warns.append("benched this week (0 shifts)" if res.TARGET[n] == 0
                             else f"set to {res.TARGET[n]} road day(s) - this adds one more")
    elif role == "backup":
        xbk = getattr(res, "XBK", set()) or set()
        if _pdays(dr) < 2 and n not in xbk:
            warns.append("backups normally go to drivers with 2+ road days")
        if n in res.TARGET and n not in res.REDS and n not in xbk:
            warns.append("exact-days driver - normally no backups")
        if not blocks and _hours(res, dr) + res.BH > BKCAP:
            # 40h of road + a backup = the Jose-approved 42h fifth-day pattern:
            # allowed, but the verifier will flag it, so surface it as a warning.
            warns.append(f"lands at {_hours(res, dr) + res.BH}h - over the "
                         f"{BKCAP}h line (fifth-day backup, allowed but flagged)")

    # soft context, never blocking
    if day in dr.get("seed", set()):
        notes.append("was pre-scheduled this day in the uploaded sheet")
    if day in dr.get("usual", []):
        notes.append("usually works this day")
    if day in dr.get("soft", []):
        notes.append("usually has this day off")

    status = ("blocked" if blocks else "unavail" if unav
              else "confirm" if limits else "warn" if warns else "ok")
    return status, blocks + unav + limits + warns, notes, (limits if not blocks else [])


def _gate(res, dr, day, role, payload):
    """Server-side enforcement of _assess for an edit about to be applied.
    Returns (error_json_or_None, status, reasons)."""
    _STATE.pop("_pending_limits", None)
    status, reasons, _, limits = _assess(res, dr, day, role)
    if status == "blocked":
        return json.dumps(dict(ok=False, kind="compliance",
            message=f"Can't give {dr['name']} {day}: " + "; ".join(reasons)
                    + ". That's a compliance rule - it can't be overridden by hand.")
        ), status, reasons
    if status == "unavail" and not payload.get("confirm_unavailable"):
        return json.dumps(dict(ok=False, kind="needs_confirm",
            message=f"{dr['name']} is marked Unavailable on {day}. Confirm the "
                    "override first.")), status, reasons
    if limits and not payload.get("confirm_limits"):
        return json.dumps(dict(ok=False, kind="needs_limits", limits=limits,
            message=f"{dr['name']} on {day}: " + "; ".join(limits)
                    + ". Confirm the pop-up first.")), status, reasons
    if limits:
        _STATE["_pending_limits"] = (norm(dr["name"]), limits)
    return None, status, reasons


def _note_override(dr, day, status, reasons):
    """Remember an approved override so the verifier reports it as an
    acknowledged override instead of a failed rule. Returns a suffix for the
    edit-log line."""
    n = norm(dr["name"])
    pend = _STATE.pop("_pending_limits", None)
    lim = pend[1] if pend and pend[0] == n else []
    if lim:
        _STATE["ovr_limits"].add(n)
    if status == "unavail":
        _STATE["ovr_unav"].add((n, day))
    if status in ("unavail", "warn"):
        _STATE["ovr_policy"].add(n)
    tag = f"  [OK'D: {'; '.join(lim)}]" if lim else ""
    if status == "unavail":
        return f"  [OVERRIDE: {reasons[0]}]" + tag
    if status == "warn":
        return f"  [flagged: {'; '.join(reasons)}]" + tag
    return tag


_OVR_RES = (
    (re.compile(r"^UNAVAIL violated: (.+) (\w{3})$"), "unav"),
    (re.compile(r"^TARGET (.+): want \d+ got \d+ \(over\)$"), "policy"),
    (re.compile(r"^FAIR-SHAPE: (.+) roads\+backups over"), "policy"),
    (re.compile(r"^BACKUP<2PRIMARY: (.+)$"), "policy"),
    (re.compile(r"^BACKUP-ONLY: (.+)$"), "policy"),
    (re.compile(r"^CONSEC>\d+: (.+) run=(\d+)$"), "limits"),
    (re.compile(r"^OT: (.+) road days over"), "limits"),
    (re.compile(r"^DAYCAP: (.+) over"), "limits"),
    (re.compile(r"^TOTDAYS: (.+) over"), "limits"),
)


_WAVE_SHORT = re.compile(r"^WAVE \w+ .+: (\d+) != (\d+)$")


def _verify(res):
    """check_invariants(), with errors caused by an approved manual override
    moved to chk['overridden'] (shown, but not a FAILED build)."""
    chk = check_invariants(res)
    keep, ovr = [], []
    for e in chk["errors"]:
        # a wave SHORT of its count is an open slot (call-out, removed shift),
        # already reported by _recount_short -- not a broken rule
        m = _WAVE_SHORT.match(e)
        if m and int(m.group(1)) < int(m.group(2)):
            continue
        hit = False
        for rx, kind in _OVR_RES:
            m = rx.match(e)
            if not m:
                continue
            nm = norm(m.group(1))
            if kind == "unav":
                hit = (nm, m.group(2)) in _STATE["ovr_unav"]
            elif kind == "limits":
                # an OK'd 6-day; 7 in a row is never OK
                hit = nm in _STATE.get("ovr_limits", set()) and not (
                    e.startswith("CONSEC") and int(m.group(2)) > res.MAXC + 1)
            else:
                hit = nm in _STATE["ovr_policy"]
            break
        (ovr if hit else keep).append(e)
    # the hard on-the-clock limits (last week included)
    for dr in res.roster:
        hrs = _day_hours(res, dr)
        week = [res.DATEALL[d] for d in ALL_DAYS]
        for dt in week:
            if hrs.get(dt, 0) > MAX_DAY_H:
                keep.append(f"HOURS-DAY: {dr['name']} {hrs[dt]}h on {dt:%a %m/%d} (max {MAX_DAY_H}h)")
        tot, s0 = _max7(hrs, week)
        if tot > MAX_7DAY_H:
            keep.append(f"HOURS-7DAY: {dr['name']} {tot}h in 7 days from {s0:%a %m/%d} (max {MAX_7DAY_H}h)")
    chk["errors"] = keep
    chk["overridden"] = ovr
    return chk


def candidates(payload_json):
    """payload: {day, role: 'road'|'backup', from_name?}. Returns every roster
    driver with an eligibility status for taking that slot."""
    try:
        p = json.loads(payload_json)
        res = _STATE.get("res")
        if res is None:
            return _no_state()
        day, role = p.get("day"), p.get("role")
        if day not in res.DAYS or role not in ("road", "backup"):
            return json.dumps(dict(ok=False, kind="edit",
                                   message=f"Bad slot: {day} / {role}"))
        from_n = norm(p["from_name"]) if p.get("from_name") else None
        out = []
        for dr in res.roster:
            if norm(dr["name"]) == from_n:
                continue
            status, reasons, notes, limits = _assess(res, dr, day, role)
            h = _hours(res, dr)
            out.append(dict(
                name=dr["name"], cls=_classify(dr, res),
                hours=h,
                new_hours=h + (res.PH if role == "road" else res.BH),
                road_days=sorted(dr["prim"]), backup_days=sorted(dr["bk"]),
                status=status, reasons=reasons, notes=notes, limits=limits))
        rank = {"ok": 0, "warn": 1, "confirm": 2, "unavail": 3, "blocked": 4}
        out.sort(key=lambda c: (rank[c["status"]], c["hours"], norm(c["name"])))
        return json.dumps(dict(ok=True, day=day, role=role, candidates=out))
    except Exception:  # noqa: BLE001
        import traceback
        return json.dumps(dict(ok=False, kind="crash",
                               message=traceback.format_exc()))


def _find(res, name):
    n = norm(name)
    for i, dr in enumerate(res.roster):
        if norm(dr["name"]) == n:
            return i, dr
    return None, None


def _fill_label(res, day, role):
    """Wave label for a slot added without a donor: the wave that is shortest
    against its target (roads) / has the fewest backups (backups)."""
    times = list(res.waves[day].keys())
    if not times:
        return "Backup" if role == "backup" else ""
    if role == "backup":
        cnt = {t: 0 for t in times}
        for v in res.cell[day].values():
            m = re.match(r"(\d{1,2}:\d{2} [AP]M)", v)
            if m and "Backup" in v and m.group(1) in cnt:
                cnt[m.group(1)] += 1
        t = min(times, key=lambda t: cnt[t])
        return t + " Backup"
    cnt = {t: 0 for t in times}
    for v in res.cell[day].values():
        m = re.match(r"(\d{1,2}:\d{2} [AP]M)", v)
        if m and "Backup" not in v and "TRAIN helper" not in v and m.group(1) in cnt:
            cnt[m.group(1)] += 1
    short = [t for t in times if cnt[t] < res.waves[day].get(t, 0)]
    return (short[0] if short else times[0])


def _snapshot(res):
    """Everything a manual edit can mutate, deep-copied. Small: lists of day
    names per driver plus the per-day cell/wave maps."""
    return dict(
        assign=[dict(prim=list(dr["prim"]), bk=list(dr["bk"]), helper=list(dr["helper"]),
                     extra=set(dr["extra"]), meet=set(dr["meet"]), unav=set(dr["unav"]),
                     meet_txt=dict(dr["meet_txt"])) for dr in res.roster],
        pairlog=list(res.PAIRLOG),
        cell=copy.deepcopy(res.cell),
        waves=copy.deepcopy(res.waves),
        routes=dict(res.routes),
        backup=dict(res.backup),
        infeasible=list(res.infeasible),
        edits=list(_STATE["edits"]),
        ovr_unav=set(_STATE["ovr_unav"]),
        ovr_policy=set(_STATE["ovr_policy"]),
        ovr_limits=set(_STATE.get("ovr_limits", set())),
        marks=copy.deepcopy(_STATE["marks"]),
    )


def _restore(res, snap):
    for dr, a in zip(res.roster, snap["assign"]):
        dr["prim"][:] = a["prim"]
        dr["bk"][:] = a["bk"]
        if "helper" in a:
            dr["helper"][:] = a["helper"]
            dr["extra"], dr["meet"], dr["unav"] = set(a["extra"]), set(a["meet"]), set(a["unav"])
            dr["meet_txt"] = dict(a["meet_txt"])
    if "pairlog" in snap:
        res.PAIRLOG = list(snap["pairlog"])
    res.cell = snap["cell"]
    res.waves = snap["waves"]
    res.routes = snap["routes"]
    res.backup = snap["backup"]
    res.infeasible = snap["infeasible"]
    _STATE["edits"] = snap["edits"]
    _STATE["ovr_unav"] = snap["ovr_unav"]
    _STATE["ovr_policy"] = snap["ovr_policy"]
    _STATE["marks"] = snap.get("marks", {})
    _STATE["ovr_limits"] = snap.get("ovr_limits", set())


def _routes_filled(res, day):
    return sum(1 for v in res.cell[day].values()
               if "Backup" not in v and "TRAIN helper" not in v)


def _bk_filled(res, day):
    return sum(1 for v in res.cell[day].values() if "Backup" in v)


def _recount_short(res, chk):
    """Rebuild the unfilled-slot lines from the CURRENT grid, so a manual fill
    clears the warning (same formats translateInfeasible() parses)."""
    out = []
    for d in res.DAYS:
        pd = chk["per_day"].get(d, {})
        got_r, want_r = pd.get("routes", 0), res.routes[d]
        if got_r < want_r:
            out.append(f"P1 INFEASIBLE {d}: filled {got_r}/{want_r}")
        got_b, want_b = pd.get("backup", 0), res.backup[d]
        if got_b < want_b:
            out.append(f"P2 SHORT {d}: {got_b}/{want_b}")
    return out


def apply_edit(payload_json):
    """payload: {day, role, from_name?, to_name?}. Move a slot between drivers
    (both named), fill an open slot (no from_name), or unassign (no to_name).
    Structural validation only -- the verifier reruns after the change and any
    rule violation shows up in the report, so nothing can break silently."""
    try:
        p = json.loads(payload_json)
        res, cfg = _STATE.get("res"), _STATE.get("cfg")
        if res is None:
            return _no_state()
        day, role = p.get("day"), p.get("role")
        if day not in res.DAYS or role not in ("road", "backup"):
            return json.dumps(dict(ok=False, kind="edit",
                                   message=f"Bad slot: {day} / {role}"))
        key = "prim" if role == "road" else "bk"
        from_name, to_name = p.get("from_name"), p.get("to_name")
        if not from_name and not to_name:
            return json.dumps(dict(ok=False, kind="edit", message="Nothing to do."))

        label = None
        i_from = from_dr = None
        if from_name:
            i_from, from_dr = _find(res, from_name)
            if from_dr is None or day not in from_dr[key]:
                return json.dumps(dict(ok=False, kind="edit",
                    message=f"{from_name} no longer holds a {role} slot on {day} - "
                            "the schedule may have changed. Close and reopen the editor."))
            label = res.cell[day].get(i_from, "")
            if "TRAIN" in label:
                return json.dumps(dict(ok=False, kind="edit",
                    message="That is a training-pair day - training days can only "
                            "be changed by a rebuild."))

        i_to = to_dr = None
        st = why = None
        if to_name:
            i_to, to_dr = _find(res, to_name)
            if to_dr is None:
                return json.dumps(dict(ok=False, kind="edit",
                                       message=f"Driver not found: {to_name}"))
            err, st, why = _gate(res, to_dr, day, role, p)
            if err:
                return err

        # mutate the live result (snapshot first so undo can restore it)
        _STATE["undo"].append(_snapshot(res))
        if from_dr is not None:
            from_dr[key].remove(day)
            res.cell[day].pop(i_from, None)
        if to_dr is not None:
            to_dr[key].append(day)
            res.cell[day][i_to] = label if label else _fill_label(res, day, role)

        what = "route" if role == "road" else "backup"
        if from_name and to_name:
            desc = f"Moved {day} {what}: {from_name} -> {to_name}"
        elif to_name:
            desc = f"Assigned open {day} {what} to {to_name}"
        else:
            desc = f"Removed {from_name}'s {day} {what} (slot left open)"
        if to_dr is not None:
            desc += _note_override(to_dr, day, st, why)
        _STATE["edits"].append(desc)

        chk = _verify(res)
        res.infeasible = _recount_short(res, chk)
        _save_out(res)                        # -> cfg['out'], picked up by the worker
        return json.dumps(_report(cfg, res, chk), default=str)
    except Exception:  # noqa: BLE001
        import traceback
        return json.dumps(dict(ok=False, kind="crash",
                               message=traceback.format_exc()))


def add_options(payload_json):
    """payload: {name}. For each operating day, can this driver be GIVEN a
    route / a backup? Per role: status 'ok'|'warn'|'blocked', plus 'full' for
    a route on a day whose route slots are all taken (allowed via a swap) and
    an 'extra' note for a backup above the day's target."""
    try:
        p = json.loads(payload_json)
        res = _STATE.get("res")
        if res is None:
            return _no_state()
        i, dr = _find(res, p.get("name") or "")
        if dr is None:
            return json.dumps(dict(ok=False, kind="edit",
                                   message=f"Driver not found: {p.get('name')}"))
        days = []
        for d in res.DAYS:
            cur = ("route" if d in dr["prim"] else "helper" if d in dr["helper"]
                   else "backup" if d in dr["bk"] else "meeting" if d in dr["meet"]
                   else "dispatch" if d in dr["extra"]
                   else "unavailable" if d in dr["unav"] else "")
            road_st, road_why, _, road_lim = _assess(res, dr, d, "road")
            bk_st, bk_why, _, bk_lim = _assess(res, dr, d, "backup")
            duties = {}
            for k in ("trainer", "meeting", "dispatch"):
                st_, why_, _, lim_ = _assess(res, dr, d, k)
                duties[k] = dict(status=st_, reasons=why_, limits=lim_)
            r_filled, r_want = _routes_filled(res, d), res.routes[d]
            b_filled, b_want = _bk_filled(res, d), res.backup[d]
            full = road_st != "blocked" and r_filled >= r_want
            if full and road_st in ("ok", "warn"):
                road_st = "full"     # takeable, but only by swapping someone out
            days.append(dict(
                day=d, current=cur,
                road=dict(status=road_st, reasons=road_why, full=full, limits=road_lim,
                          filled=r_filled, want=r_want),
                duties=duties,
                backup=dict(status=bk_st, reasons=bk_why, limits=bk_lim,
                            filled=b_filled, want=b_want,
                            over_target=(bk_st != "blocked" and b_filled >= b_want)),
            ))
        return json.dumps(dict(ok=True, name=dr["name"], hours=_hours(res, dr),
                               ph=res.PH, bh=res.BH, days=days))
    except Exception:  # noqa: BLE001
        import traceback
        return json.dumps(dict(ok=False, kind="crash",
                               message=traceback.format_exc()))


def _swap_assess(res, dr, label):
    """Can `dr` step down from their route to a backup that day? Only the
    training-pair day is hard; the rest is tier policy (allowed, flagged)."""
    blocks, warns = [], []
    if "TRAIN" in label:
        blocks.append("training-pair day - can only change with a rebuild")
    n = norm(dr["name"])
    xbk = getattr(res, "XBK", set()) or set()
    if n in res.TARGET and n not in res.REDS:
        warns.append(f"set to {res.TARGET[n]} road day(s) - drops to {_pdays(dr) - 1}")
    if _pdays(dr) - 1 < 2 and n not in xbk:
        warns.append("drops under 2 road days but keeps a backup")
    if n in res.MOST and _pdays(dr) - 1 < 3:
        warns.append("drops a Top/Solid below 3 road days")
    return ("blocked" if blocks else "warn" if warns else "ok"), blocks + warns


def swap_candidates(payload_json):
    """payload: {day, for_name}. Who currently holds a ROUTE on `day` and
    could step down to a backup that same day, freeing their route slot for
    `for_name`? Their day count / streaks don't change, so the checks are the
    backup-side rules only."""
    try:
        p = json.loads(payload_json)
        res = _STATE.get("res")
        if res is None:
            return _no_state()
        day = p.get("day")
        if day not in res.DAYS:
            return json.dumps(dict(ok=False, kind="edit", message=f"Bad day: {day}"))
        for_n = norm(p.get("for_name") or "")
        out = []
        for i, dr in enumerate(res.roster):
            if day not in dr["prim"] or norm(dr["name"]) == for_n:
                continue
            status, reasons = _swap_assess(res, dr, res.cell[day].get(i, ""))
            h = _hours(res, dr)
            out.append(dict(
                name=dr["name"], cls=_classify(dr, res), hours=h,
                new_hours=h - res.PH + res.BH,
                road_days=sorted(dr["prim"]), backup_days=sorted(dr["bk"]),
                status=status, reasons=reasons, notes=[]))
        rank = {"ok": 0, "warn": 1, "unavail": 2, "blocked": 3}
        out.sort(key=lambda c: (rank[c["status"]], -c["hours"], norm(c["name"])))
        return json.dumps(dict(ok=True, day=day, candidates=out))
    except Exception:  # noqa: BLE001
        import traceback
        return json.dumps(dict(ok=False, kind="crash",
                               message=traceback.format_exc()))


def apply_add(payload_json):
    """payload: {name, day, role, swap_name?, extra_route?, wave?}. Give `name`
    an extra shift on `day`. For a route on a full day, either `swap_name` (that
    driver's route becomes a backup, freeing the slot) or `extra_route:true`
    (raise the day's route count by one) must be provided. `wave` (Live board,
    2026-10-06): a route in exactly that wave -- a full wave just gets one more
    route (Amazon may have handed out routes the app doesn't know yet)."""
    try:
        p = json.loads(payload_json)
        res, cfg = _STATE.get("res"), _STATE.get("cfg")
        if res is None:
            return _no_state()
        day, role = p.get("day"), p.get("role")
        if day not in res.DAYS or role not in ("road", "backup"):
            return json.dumps(dict(ok=False, kind="edit",
                                   message=f"Bad slot: {day} / {role}"))
        i_to, to_dr = _find(res, p.get("name") or "")
        if to_dr is None:
            return json.dumps(dict(ok=False, kind="edit",
                                   message=f"Driver not found: {p.get('name')}"))
        err, st, why = _gate(res, to_dr, day, role, p)
        if err:
            return err

        swap_name = p.get("swap_name")
        extra_route = bool(p.get("extra_route"))

        wave = p.get("wave")
        if wave and not re.fullmatch(r"\d{1,2}:\d{2} [AP]M", wave):
            return json.dumps(dict(ok=False, kind="edit", message=f"Not a wave time: {wave}"))

        if role == "backup":
            _STATE["undo"].append(_snapshot(res))
            to_dr["bk"].append(day)
            res.cell[day][i_to] = (wave + " Backup") if wave else _fill_label(res, day, "backup")
            desc = f"Added a {day} backup for {to_dr['name']}"
        elif wave:
            _STATE["undo"].append(_snapshot(res))
            desc = _put_route(res, i_to, to_dr, day, wave)
        elif swap_name:
            i_sw, sw_dr = _find(res, swap_name)
            if sw_dr is None or day not in sw_dr["prim"]:
                return json.dumps(dict(ok=False, kind="edit",
                    message=f"{swap_name} no longer holds a route on {day} - "
                            "close and reopen the editor."))
            label = res.cell[day].get(i_sw, "")
            sw_st, sw_why = _swap_assess(res, sw_dr, label)
            if sw_st == "blocked":
                return json.dumps(dict(ok=False, kind="edit",
                    message="That is a training-pair day - training days can only "
                            "be changed by a rebuild."))
            _STATE["undo"].append(_snapshot(res))
            if sw_st == "warn":
                _STATE["ovr_policy"].add(norm(sw_dr["name"]))
            sw_dr["prim"].remove(day)
            sw_dr["bk"].append(day)
            m = re.match(r"(\d{1,2}:\d{2} [AP]M)", label)
            res.cell[day][i_sw] = (m.group(1) + " Backup") if m else "Backup"
            to_dr["prim"].append(day)
            res.cell[day][i_to] = label
            desc = (f"Added a {day} route for {to_dr['name']} - "
                    f"{sw_dr['name']} stepped down to backup that day")
        elif extra_route:
            _STATE["undo"].append(_snapshot(res))
            label = _fill_label(res, day, "road")
            if label in res.waves[day]:
                res.waves[day][label] += 1
            res.routes[day] += 1
            to_dr["prim"].append(day)
            res.cell[day][i_to] = label
            desc = (f"Added a {day} route for {to_dr['name']} as an EXTRA route "
                    f"({day} is now {res.routes[day]} routes)")
        else:
            if _routes_filled(res, day) >= res.routes[day]:
                return json.dumps(dict(ok=False, kind="edit", full=True,
                    message=f"{day}'s {res.routes[day]} route(s) are already filled. "
                            "Move one of that day's route drivers to backup, or add "
                            "it as an extra route."))
            _STATE["undo"].append(_snapshot(res))
            to_dr["prim"].append(day)
            res.cell[day][i_to] = _fill_label(res, day, "road")
            desc = f"Added a {day} route for {to_dr['name']}"

        desc += _note_override(to_dr, day, st, why)
        _STATE["edits"].append(desc)
        chk = _verify(res)
        res.infeasible = _recount_short(res, chk)
        _save_out(res)
        return json.dumps(_report(cfg, res, chk), default=str)
    except Exception:  # noqa: BLE001
        import traceback
        return json.dumps(dict(ok=False, kind="crash",
                               message=traceback.format_exc()))


_WAVE_RE = re.compile(r"(\d{1,2}:\d{2} [AP]M)")


def _wave_filled(res, day, wave):
    """Routes driven in `wave` on `day` (trainees drive; ride-alongs don't)."""
    return sum(1 for v in res.cell[day].values()
               if "Backup" not in v and "TRAIN helper" not in v and _cell_wave(v) == wave)


def _put_route(res, i, dr, day, wave):
    """Give dr a route in `wave`; a full wave gets one more route. Returns the
    change-log text."""
    extra = _wave_filled(res, day, wave) >= res.waves[day].get(wave, 0)
    if extra:
        res.waves[day][wave] = res.waves[day].get(wave, 0) + 1
        res.routes[day] += 1
    dr["prim"].append(day)
    res.cell[day][i] = wave
    return (f"Added a {day} {wave} route for {dr['name']}"
            + (f" - an EXTRA route ({day} is now {res.routes[day]} routes)" if extra else ""))


def _short(name):
    p = name.split()
    return p[0] + " " + p[-1] if len(p) > 1 else name


DUTY_LABEL = {"dispatch": "dispatch", "meeting": "a meeting", "trainer": "a trainer day"}


def set_duty(payload_json):
    """payload: {name, day, kind: 'dispatch'|'meeting'|'trainer', with_name?
    (trainer: who they ride along with), time? (meeting, default 1:00 PM),
    confirm_*?}. Live board, 2026-10-06: the duties beside routes. Same rules
    as a shift (hours: dispatch 12h, meeting 2h, trainer 10h)."""
    try:
        p = json.loads(payload_json)
        res, cfg = _STATE.get("res"), _STATE.get("cfg")
        if res is None:
            return _no_state()
        day, kind = p.get("day"), p.get("kind")
        i, dr = _find(res, p.get("name") or "")
        if dr is None or day not in res.DAYS or kind not in DUTY_LABEL:
            return json.dumps(dict(ok=False, kind="edit", message="Bad request."))
        j = tr = None
        if kind == "trainer":
            j, tr = _find(res, p.get("with_name") or "")
            if tr is None or j == i or day not in tr["prim"]:
                return json.dumps(dict(ok=False, kind="edit",
                    message=f"Pick someone who drives a route on {day} to ride along with."))
            if "TRAIN" in res.cell[day].get(j, ""):
                return json.dumps(dict(ok=False, kind="edit",
                    message=f"{tr['name']} already has a trainer on {day}."))
        err, st, why = _gate(res, dr, day, kind, p)
        if err:
            return err
        snap = _snapshot(res)
        if kind == "dispatch":
            dr["extra"].add(day)
            dr["unav"].add(day)
            desc = f"Put {dr['name']} on dispatch {day}"
        elif kind == "meeting":
            t = str(p.get("time") or "1:00 PM").strip()[:12]
            dr["meet"].add(day)
            dr["meet_txt"][day] = f"{t} Meeting"
            dr["unav"].add(day)
            desc = f"Put {dr['name']} in a {t} meeting {day}"
        else:
            w = _cell_wave(res.cell[day].get(j, "")) or res.cell[day].get(j, "")
            dr["helper"].append(day)
            res.cell[day][i] = f"{w} (TRAIN helper w/ {_short(tr['name'])})"
            res.cell[day][j] = f"{w} (TRAIN drives w/ {_short(dr['name'])})"
            res.PAIRLOG = list(res.PAIRLOG) + [(dr["name"], tr["name"], day)]
            desc = f"{dr['name']} trains {tr['name']} {day} {w} (rides along)"
        desc += _note_override(dr, day, st, why)
        _STATE["undo"].append(snap)
        _STATE["edits"].append(desc)
        chk = _verify(res)
        res.infeasible = _recount_short(res, chk)
        _save_out(res)
        return json.dumps(_report(cfg, res, chk), default=str)
    except Exception:  # noqa: BLE001
        return _crash()


def clear_duty(payload_json):
    """payload: {name, day}. Take a driver off dispatch / a meeting / a
    training pair that day (the trainee then drives alone)."""
    try:
        p = json.loads(payload_json)
        res, cfg = _STATE.get("res"), _STATE.get("cfg")
        if res is None:
            return _no_state()
        day = p.get("day")
        i, dr = _find(res, p.get("name") or "")
        if dr is None or day not in res.DAYS:
            return json.dumps(dict(ok=False, kind="edit", message="Bad request."))
        snap = _snapshot(res)
        lab = res.cell[day].get(i, "")
        if "TRAIN" in lab:
            pair = next((t for t in res.PAIRLOG if t[2] == day and norm(dr["name"]) in (norm(t[0]), norm(t[1]))), None)
            if not pair:
                return json.dumps(dict(ok=False, kind="edit", message="Couldn't find that training pair."))
            ti, trn = _find(res, pair[0])
            ni, nee = _find(res, pair[1])
            w = _cell_wave(lab) or ""
            if trn is not None:
                if day in trn["helper"]:
                    trn["helper"].remove(day)
                res.cell[day].pop(ti, None)
            if nee is not None and ni in res.cell[day]:
                res.cell[day][ni] = w
            res.PAIRLOG = [t for t in res.PAIRLOG if t is not pair and tuple(t) != tuple(pair)]
            desc = f"Ended the {day} training pair: {pair[1]} drives alone, {pair[0]} is off that day"
        elif day in dr["extra"]:
            dr["extra"].discard(day)
            dr["unav"].discard(day)
            desc = f"Took {dr['name']} off dispatch {day}"
        elif day in dr["meet"]:
            dr["meet"].discard(day)
            dr["meet_txt"].pop(day, None)
            dr["unav"].discard(day)
            desc = f"Took {dr['name']} out of the {day} meeting"
        else:
            return json.dumps(dict(ok=False, kind="edit", message=f"{dr['name']} has no duty on {day}."))
        _STATE["undo"].append(snap)
        _STATE["edits"].append(desc)
        chk = _verify(res)
        res.infeasible = _recount_short(res, chk)
        _save_out(res)
        return json.dumps(_report(cfg, res, chk), default=str)
    except Exception:  # noqa: BLE001
        return _crash()


def set_role(payload_json):
    """payload: {name, day, to: 'backup'|'road', confirm_*?}. Turn a driver's
    route that day into a backup (same wave; the route slot is left open), or a
    backup into a route (checked like a new route; a full wave gets one more
    route). Live board, 2026-10-06."""
    try:
        p = json.loads(payload_json)
        res, cfg = _STATE.get("res"), _STATE.get("cfg")
        if res is None:
            return _no_state()
        day, to = p.get("day"), p.get("to")
        i, dr = _find(res, p.get("name") or "")
        if dr is None or day not in res.DAYS or to not in ("backup", "road"):
            return json.dumps(dict(ok=False, kind="edit", message="Bad request."))
        label = res.cell[day].get(i, "")
        if "TRAIN" in label:
            return json.dumps(dict(ok=False, kind="edit",
                message="That is a training-pair day - training days can only be changed by a rebuild."))
        wave = _cell_wave(label)
        snap = _snapshot(res)
        if to == "backup":
            if day not in dr["prim"]:
                return json.dumps(dict(ok=False, kind="edit", message=f"{dr['name']} has no route on {day}."))
            st, why = _swap_assess(res, dr, label)
            dr["prim"].remove(day)
            dr["bk"].append(day)
            res.cell[day][i] = (wave + " Backup") if wave else "Backup"
            if st == "warn":
                _STATE["ovr_policy"].add(norm(dr["name"]))
            desc = (f"Made {dr['name']}'s {day} {wave or ''} route a backup (route slot left open)"
                    .replace("  ", " "))
            if st == "warn":
                desc += f"  [flagged: {'; '.join(why)}]"
        else:
            if day not in dr["bk"]:
                return json.dumps(dict(ok=False, kind="edit", message=f"{dr['name']} has no backup on {day}."))
            dr["bk"].remove(day)                  # checked as if the backup weren't there
            res.cell[day].pop(i, None)
            err, st, why = _gate(res, dr, day, "road", p)
            if err:
                _restore(res, snap)
                return err
            w = wave if wave in res.waves[day] else _fill_label(res, day, "road")
            desc = _put_route(res, i, dr, day, w).replace("Added a", "Made", 1)
            desc = desc.replace(f" route for {dr['name']}", f" route for {dr['name']} (was a backup)", 1)
            desc += _note_override(dr, day, st, why)
        _STATE["undo"].append(snap)
        _STATE["edits"].append(desc)
        chk = _verify(res)
        res.infeasible = _recount_short(res, chk)
        _save_out(res)
        return json.dumps(_report(cfg, res, chk), default=str)
    except Exception:  # noqa: BLE001
        return _crash()


def _cell_wave(v):
    m = _WAVE_RE.match(str(v or ""))
    return m.group(1) if m else None


def wave_options(payload_json):
    """payload: {day, name}. Where could this driver's shift on `day` move,
    wave-wise? Roads keep exact per-wave counts, so moving means SWAPPING
    labels with a driver already in the target wave — each option lists them.
    Backup labels don't affect route counts, so backups relabel freely."""
    try:
        p = json.loads(payload_json)
        res = _STATE.get("res")
        if res is None:
            return _no_state()
        day = p.get("day")
        if day not in res.DAYS:
            return json.dumps(dict(ok=False, kind="edit", message=f"Bad day: {day}"))
        i, dr = _find(res, p.get("name") or "")
        if dr is None:
            return json.dumps(dict(ok=False, kind="edit",
                                   message=f"Driver not found: {p.get('name')}"))
        role = "backup" if day in dr["bk"] else "road" if day in dr["prim"] else None
        if role is None:
            return json.dumps(dict(ok=False, kind="edit",
                                   message=f"{dr['name']} has no route or backup on {day}."))
        label = res.cell[day].get(i, "")
        if "TRAIN" in label:
            return json.dumps(dict(ok=False, kind="edit",
                message="That is a training-pair day - training days can only "
                        "be changed by a rebuild."))
        cur = _cell_wave(label)
        out = []
        for t in res.waves[day]:
            if t == cur:
                continue
            if role == "backup":
                out.append(dict(wave=t, swap_with=None))
                continue
            occ = []
            for j, other in enumerate(res.roster):
                v = res.cell[day].get(j, "")
                if j == i or "Backup" in v or "TRAIN" in v:
                    continue
                if _cell_wave(v) == t:
                    occ.append(dict(name=other["name"], cls=_classify(other, res),
                                    hours=_hours(res, other)))
            occ.sort(key=lambda c: norm(c["name"]))
            out.append(dict(wave=t, swap_with=occ))
        return json.dumps(dict(ok=True, day=day, name=dr["name"], role=role,
                               current=cur, waves=out))
    except Exception:  # noqa: BLE001
        import traceback
        return json.dumps(dict(ok=False, kind="crash",
                               message=traceback.format_exc()))


def apply_wave(payload_json):
    """payload: {day, name, wave, swap_name?}. Move the driver's shift on
    `day` into `wave`. Roads require `swap_name` (a plain-route holder of the
    target wave) so per-wave counts stay exact; backups just relabel."""
    try:
        p = json.loads(payload_json)
        res, cfg = _STATE.get("res"), _STATE.get("cfg")
        if res is None:
            return _no_state()
        day, wave = p.get("day"), p.get("wave")
        if day not in res.DAYS or wave not in res.waves[day]:
            return json.dumps(dict(ok=False, kind="edit",
                                   message=f"Bad wave: {day} / {wave}"))
        i, dr = _find(res, p.get("name") or "")
        if dr is None:
            return json.dumps(dict(ok=False, kind="edit",
                                   message=f"Driver not found: {p.get('name')}"))
        label = res.cell[day].get(i, "")
        if "TRAIN" in label:
            return json.dumps(dict(ok=False, kind="edit",
                message="That is a training-pair day - training days can only "
                        "be changed by a rebuild."))
        cur = _cell_wave(label)
        if cur == wave:
            return json.dumps(dict(ok=False, kind="edit",
                                   message=f"{dr['name']} is already in the {wave} wave."))

        if day in dr["bk"]:
            _STATE["undo"].append(_snapshot(res))
            res.cell[day][i] = wave + " Backup"
            desc = f"Moved {dr['name']}'s {day} backup to the {wave} wave"
        elif day in dr["prim"]:
            j, sw = _find(res, p.get("swap_name") or "")
            vj = res.cell[day].get(j, "") if sw is not None else ""
            if sw is None or "Backup" in vj or "TRAIN" in vj or _cell_wave(vj) != wave:
                return json.dumps(dict(ok=False, kind="edit",
                    message=f"Pick who in the {wave} wave trades times - route "
                            "counts per wave must stay exact."))
            _STATE["undo"].append(_snapshot(res))
            res.cell[day][i] = wave
            res.cell[day][j] = cur
            desc = (f"Swapped {day} waves: {dr['name']} -> {wave}, "
                    f"{sw['name']} -> {cur}")
        else:
            return json.dumps(dict(ok=False, kind="edit",
                                   message=f"{dr['name']} has no route or backup on {day}."))

        _STATE["edits"].append(desc)
        chk = _verify(res)
        res.infeasible = _recount_short(res, chk)
        _save_out(res)
        return json.dumps(_report(cfg, res, chk), default=str)
    except Exception:  # noqa: BLE001
        import traceback
        return json.dumps(dict(ok=False, kind="crash",
                               message=traceback.format_exc()))


def undo_last(payload_json):  # noqa: ARG001 - uniform (json in, json out) signature
    """Restore the state saved before the most recent edit, re-verify, and
    rewrite the xlsx."""
    try:
        res, cfg = _STATE.get("res"), _STATE.get("cfg")
        if res is None:
            return _no_state()
        if not _STATE["undo"]:
            return json.dumps(dict(ok=False, kind="edit",
                                   message="Nothing to undo."))
        _restore(res, _STATE["undo"].pop())
        chk = _verify(res)
        res.infeasible = _recount_short(res, chk)
        _save_out(res)
        return json.dumps(_report(cfg, res, chk), default=str)
    except Exception:  # noqa: BLE001
        import traceback
        return json.dumps(dict(ok=False, kind="crash",
                               message=traceback.format_exc()))


# ------------------------------------------------------------- live board ----
def _save_out(res):
    """Rewrite the workbook after an edit -- the wizard slot only; the Live
    board asks for it on demand (export_xlsx) so edits stay quick."""
    if _STATE.get("write", True):
        write_xlsx(res)


def _enc(o):
    """Python value -> JSON-safe value that _dec() turns back into the same
    thing (sets, tuples, dates, int-keyed dicts survive the round trip)."""
    if o is None or isinstance(o, (bool, int, float, str)):
        return o
    if isinstance(o, datetime.datetime):
        return {"$dt": o.isoformat()}
    if isinstance(o, datetime.date):
        return {"$d": o.isoformat()}
    if isinstance(o, (set, frozenset)):
        return {"$s": [_enc(x) for x in o]}
    if isinstance(o, tuple):
        return {"$t": [_enc(x) for x in o]}
    if isinstance(o, list):
        return [_enc(x) for x in o]
    if isinstance(o, dict):
        if all(isinstance(k, str) and not k.startswith("$") for k in o):
            return {k: _enc(v) for k, v in o.items()}
        return {"$m": [[_enc(k), _enc(v)] for k, v in o.items()]}
    raise TypeError(f"can't save a {type(o).__name__} in the live schedule")


def _dec(o):
    if isinstance(o, list):
        return [_dec(x) for x in o]
    if isinstance(o, dict):
        if len(o) == 1:
            (k, v), = o.items()
            if k == "$d":
                return datetime.date.fromisoformat(v)
            if k == "$dt":
                return datetime.datetime.fromisoformat(v)
            if k == "$s":
                return {_dec(x) for x in v}
            if k == "$t":
                return tuple(_dec(x) for x in v)
            if k == "$m":
                return {_dec(a): _dec(b) for a, b in v}
        return {k: _dec(v) for k, v in o.items()}
    return o


def _crash():
    import traceback
    return json.dumps(dict(ok=False, kind="crash", message=traceback.format_exc()))


def export_state(payload_json):  # noqa: ARG001
    """The current slot's whole schedule as one JSON string -- what the Live
    board saves to Firestore and load_state() reads back."""
    try:
        res = _STATE.get("res")
        if res is None:
            return _no_state()
        st = dict(v=1, res=_enc(res.__dict__), edits=list(_STATE["edits"]),
                  ovr_unav=[list(x) for x in sorted(_STATE["ovr_unav"])],
                  ovr_policy=sorted(_STATE["ovr_policy"]),
                  ovr_limits=sorted(_STATE.get("ovr_limits", set())),
                  marks=_STATE["marks"])
        return json.dumps(dict(ok=True, state=json.dumps(st, separators=(",", ":"))))
    except Exception:  # noqa: BLE001
        return _crash()


def load_state(payload_json):
    """payload: {state, out?, prev_worked?: {name: [ISO dates]},
    prev_hours?: {name: {ISO date: hours}}, actual?: [see _apply_actual]}. Rehydrate a
    saved week into the current slot. prev_worked (last week's REAL worked
    days, from its own Live board) replaces the tail read from the uploaded
    file, so a midweek extra shift last Saturday still counts toward this
    week's days-in-a-row."""
    try:
        p = json.loads(payload_json)
        st = json.loads(p["state"])
        if st.get("v") != 1:
            return json.dumps(dict(ok=False, kind="edit",
                message="This saved week was made by a newer version of the app - reload the page."))
        res = Result(**_dec(st["res"]))
        res.cfg["out"] = p.get("out") or res.cfg.get("out") or "/work/live.xlsx"
        pw = p.get("prev_worked")
        if pw:
            start = res.DATEALL["Sun"]
            lo = start - 7 * ONE
            byn = {norm(k): {datetime.date.fromisoformat(x) for x in v} for k, v in pw.items()}
            for dr in res.roster:
                got = byn.get(norm(dr["name"]))
                if got is not None:
                    dr["w_prev"] = {x for x in got if lo <= x < start}
        ph = p.get("prev_hours")
        if ph:
            start = res.DATEALL["Sun"]
            lo = start - 7 * ONE
            byn = {norm(k): v for k, v in ph.items()}
            for dr in res.roster:
                got = byn.get(norm(dr["name"]))
                if got is not None:
                    dr["h_prev"] = {datetime.date.fromisoformat(k): _num(h) for k, h in got.items()
                                    if lo <= datetime.date.fromisoformat(k) < start and h}
        _apply_actual(res, p.get("actual"))
        _STATE.update(cfg=res.cfg, res=res, edits=list(st.get("edits", [])), undo=[],
                      ovr_unav={tuple(x) for x in st.get("ovr_unav", [])},
                      ovr_policy=set(st.get("ovr_policy", [])),
                      ovr_limits=set(st.get("ovr_limits", [])),
                      marks=st.get("marks") or {})
        chk = _verify(res)
        res.infeasible = ([ln for ln in res.infeasible if not ln.startswith(("P1 ", "P2 "))]
                          + _recount_short(res, chk))
        return json.dumps(_report(res.cfg, res, chk), default=str)
    except Exception:  # noqa: BLE001
        return _crash()


def export_xlsx(payload_json):  # noqa: ARG001
    """Write the current slot's workbook to cfg['out'] now."""
    try:
        res = _STATE.get("res")
        if res is None:
            return _no_state()
        with contextlib.redirect_stdout(io.StringIO()):
            write_xlsx(res)
        return json.dumps(dict(ok=True, out=res.cfg["out"]))
    except Exception:  # noqa: BLE001
        return _crash()


def apply_mark(payload_json):
    """payload: {name, day, kind: 'callout'|'noshow'|'off', note?}. Record
    that a driver won't work `day`. Their route/backup that day comes off and
    the slot is left OPEN (the board shows the gap to fill); for the rules the
    day then counts as a day off (overridable with the typed confirm)."""
    try:
        p = json.loads(payload_json)
        res, cfg = _STATE.get("res"), _STATE.get("cfg")
        if res is None:
            return _no_state()
        day, kind = p.get("day"), p.get("kind")
        if day not in res.DAYS or kind not in MARK_LABEL:
            return json.dumps(dict(ok=False, kind="edit", message=f"Bad mark: {day} / {kind}"))
        i, dr = _find(res, p.get("name") or "")
        if dr is None:
            return json.dumps(dict(ok=False, kind="edit",
                                   message=f"Driver not found: {p.get('name')}"))
        n = norm(dr["name"])
        if n in _STATE["marks"].get(day, {}):
            return json.dumps(dict(ok=False, kind="edit",
                message=f"{dr['name']} is already marked on {day}."))
        label = res.cell[day].get(i, "")
        if "TRAIN" in label:
            return json.dumps(dict(ok=False, kind="edit",
                message="That is a training-pair day - training days can only "
                        "be changed by a rebuild."))
        _STATE["undo"].append(_snapshot(res))
        was = ""
        if day in dr["prim"]:
            dr["prim"].remove(day)
            was = f"{label} route" if label else "route"
            res.cell[day].pop(i, None)
        elif day in dr["bk"]:
            dr["bk"].remove(day)
            was = label or "Backup"
            res.cell[day].pop(i, None)
        note = str(p.get("note") or "").strip()[:200]
        _STATE["marks"].setdefault(day, {})[n] = dict(
            name=dr["name"], kind=kind, was=was, note=note)
        desc = f"{dr['name']}: {MARK_LABEL[kind].lower()} {day}"
        if was:
            desc += f" (was {was} - slot left open)"
        if note:
            desc += f" - {note}"
        _STATE["edits"].append(desc)
        chk = _verify(res)
        res.infeasible = _recount_short(res, chk)
        _save_out(res)
        return json.dumps(_report(cfg, res, chk), default=str)
    except Exception:  # noqa: BLE001
        return _crash()


def clear_mark(payload_json):
    """payload: {name, day}. Remove a call-out / no-show / day-off mark. The
    shift it freed is NOT put back - assign it again if they're working."""
    try:
        p = json.loads(payload_json)
        res, cfg = _STATE.get("res"), _STATE.get("cfg")
        if res is None:
            return _no_state()
        day = p.get("day")
        n = norm(p.get("name") or "")
        mk = _STATE["marks"].get(day, {}).get(n)
        if not mk:
            return json.dumps(dict(ok=False, kind="edit",
                message=f"No mark for {p.get('name')} on {day}."))
        _STATE["undo"].append(_snapshot(res))
        del _STATE["marks"][day][n]
        if not _STATE["marks"][day]:
            del _STATE["marks"][day]
        _STATE["edits"].append(f"Cleared {mk['name']}'s "
                               f"{MARK_LABEL.get(mk['kind'], mk['kind']).lower()} mark on {day}")
        chk = _verify(res)
        res.infeasible = _recount_short(res, chk)
        _save_out(res)
        return json.dumps(_report(cfg, res, chk), default=str)
    except Exception:  # noqa: BLE001
        return _crash()
