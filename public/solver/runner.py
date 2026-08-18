"""Thin driver the Pyodide worker calls. Wraps the canonical solver
(build_weekly_schedule.py) and returns a JSON-serializable report so the
browser never has to scrape stdout.

Usage (in Pyodide OR under CPython for parity testing):
    import runner
    report_json = runner.run('/work/config.json')

The output xlsx is written to cfg['out'] (the worker reads its bytes back).

MANUAL EDITS (2026-08): after run() the built Result stays in _STATE, so the
UI can move individual road/backup days between drivers without a rebuild:
    runner.candidates(json)  -> who can take a given (day, role) slot, and why not
    runner.apply_edit(json)  -> perform a move/fill/remove, re-verify, rewrite xlsx
Both take/return JSON strings. The rules mirrored here are the same invariants
check_invariants() enforces -- after every edit the verifier reruns, so even a
rule this mirror missed would still surface in the report banner.
"""
import contextlib
import datetime
import io
import json
import re

from build_weekly_schedule import (
    load_config, build_schedule, write_xlsx, check_invariants, print_summary,
    ScheduleConfigError, FREE_name, norm, ALL as ALL_DAYS,
)

WEEKEND = {'Sat', 'Sun'}
ONE = datetime.timedelta(days=1)

# The live build this session (res mutates in place as edits are applied).
_STATE = {'cfg': None, 'res': None, 'edits': []}


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
            if d in res.cell and i in res.cell[d]:
                cells[d] = res.cell[d][i]
            elif d in dr["unav"]:
                cells[d] = "Unavailable"
            elif d in dr["extra"]:
                cells[d] = "Dispatch"
            elif d in dr["meet"]:
                cells[d] = dr["meet_txt"].get(d, "Meeting")
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
        ))
    rows.sort(key=lambda r: (-r["hours"], r["name"]))
    return rows


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
    )


def run(config_path):
    """Return a JSON string. On success: {ok:true, ...report}. On a config
    error: {ok:false, kind:'config', message}. On any other crash:
    {ok:false, kind:'crash', message} (with a traceback)."""
    try:
        cfg = load_config(config_path)
        res = build_schedule(cfg)
        write_xlsx(res)                       # -> cfg['out']
        chk = check_invariants(res)
        _STATE.update(cfg=cfg, res=res, edits=[])
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


def _run_len(res, dr, day):
    """Longest consecutive worked run through `day` if the driver also worked
    `day` -- prior-week tail included, same as the solver's runok()."""
    dt = res.DATEALL[day]
    s = set(dr["w_prev"])
    for k in ("prim", "bk", "helper"):
        s |= {res.DATEALL[d] for d in dr[k]}
    s |= {res.DATEALL[d] for d in dr["extra"] if d in res.DATEALL}
    s |= {res.DATEALL[d] for d in dr["meet"] if d in res.DATEALL}
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


def _assess(res, dr, day, role):
    """Return (status, reasons, notes) for giving `dr` the (day, role) slot.
    status: 'ok' | 'warn' (allowed, will be flagged) | 'blocked'."""
    n = norm(dr["name"])
    blocks, warns, notes = [], [], []
    HCAP = res.HCAP
    BKCAP = HCAP if HCAP else 4 * res.PH

    # hard day conflicts
    if day in dr["meet"]:
        blocks.append("has a meeting that day (do-not-touch)")
    elif day in dr["extra"]:
        blocks.append("on dispatch duty that day")
    elif day in dr["unav"]:
        if day in dr.get("std_added", set()):
            blocks.append("standing day off (from preferences)")
        else:
            blocks.append("marked Unavailable that day")
    if day in dr["prim"] or day in dr["helper"]:
        blocks.append("already on a route that day")
    if day in dr["bk"]:
        blocks.append("already a backup that day")

    # consecutive-days rule (incl. prior-week tail)
    if not blocks:
        rl = _run_len(res, dr, day)
        if rl > res.MAXC:
            blocks.append(f"would work {rl} days in a row (max {res.MAXC})")

    # total worked-days caps
    tot = _pdays(dr) + len(dr["bk"]) + len(dr["extra"]) + len(dr["meet"])
    if tot + 1 > res.MAXTOT:
        blocks.append(f"already at {res.MAXTOT} worked days")
    if FREE_name(dr, res.TARGET, res.MOST) and _pdays(dr) + len(dr["bk"]) + 1 > res.FREETOT:
        blocks.append(f"Fair drivers max out at {res.FREETOT} total days")

    # weekend cap (only when the config enables it)
    if res.weekend_rule and day in WEEKEND and _wknd_used(dr) + 1 > res.MAXWKND:
        blocks.append(f"at the {res.MAXWKND}-weekend-day cap")

    if role == "road":
        if HCAP and (_pdays(dr) + 1) * res.PH > HCAP:
            blocks.append(f"would put road hours over {HCAP}h (overtime)")
        capx = (getattr(res, "CAPX", {}) or {}).get(n, 0)
        if n in res.TARGET and n not in res.REDS:
            pin = min(res.TARGET[n] + capx, res.MAXPRIM)
            if _pdays(dr) + 1 > pin:
                blocks.append(f"pinned at exactly {res.TARGET[n]} road day(s)")
        if _pdays(dr) + 1 > res.MAXPRIM:
            blocks.append(f"at the {res.MAXPRIM} road-day cap")
    else:  # backup
        xbk = getattr(res, "XBK", set()) or set()
        if _pdays(dr) < 2 and n not in xbk:
            blocks.append("backups only go to drivers with 2+ road days")
        if n in res.TARGET and n not in res.REDS and n not in xbk:
            blocks.append("exact-days driver - no backups")
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

    status = "blocked" if blocks else ("warn" if warns else "ok")
    return status, blocks + warns, notes


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
            status, reasons, notes = _assess(res, dr, day, role)
            h = _hours(res, dr)
            out.append(dict(
                name=dr["name"], cls=_classify(dr, res),
                hours=h,
                new_hours=h + (res.PH if role == "road" else res.BH),
                road_days=sorted(dr["prim"]), backup_days=sorted(dr["bk"]),
                status=status, reasons=reasons, notes=notes))
        rank = {"ok": 0, "warn": 1, "blocked": 2}
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
        if to_name:
            i_to, to_dr = _find(res, to_name)
            if to_dr is None:
                return json.dumps(dict(ok=False, kind="edit",
                                       message=f"Driver not found: {to_name}"))
            if day in to_dr["prim"] or day in to_dr["bk"] or day in to_dr["helper"]:
                return json.dumps(dict(ok=False, kind="edit",
                    message=f"{to_name} already works {day}."))
            if day in to_dr["meet"] or day in to_dr["extra"]:
                return json.dumps(dict(ok=False, kind="edit",
                    message=f"{to_name} has a meeting/dispatch duty on {day}."))
            if day in to_dr["unav"]:
                return json.dumps(dict(ok=False, kind="edit",
                    message=f"{to_name} is marked Unavailable on {day} - that is "
                            "a hard rule."))

        # mutate the live result
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
        _STATE["edits"].append(desc)

        chk = check_invariants(res)
        res.infeasible = _recount_short(res, chk)
        write_xlsx(res)                       # -> cfg['out'], picked up by the worker
        return json.dumps(_report(cfg, res, chk), default=str)
    except Exception:  # noqa: BLE001
        import traceback
        return json.dumps(dict(ok=False, kind="crash",
                               message=traceback.format_exc()))
