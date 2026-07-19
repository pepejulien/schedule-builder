"""Thin driver the Pyodide worker calls. Wraps the canonical solver
(build_weekly_schedule.py) and returns a JSON-serializable report so the
browser never has to scrape stdout.

Usage (in Pyodide OR under CPython for parity testing):
    import runner
    report_json = runner.run('/work/config.json')

The output xlsx is written to cfg['out'] (the worker reads its bytes back).
"""
import contextlib
import io
import json

from build_weekly_schedule import (
    load_config, build_schedule, write_xlsx, check_invariants, print_summary,
    ScheduleConfigError, FREE_name, norm, ALL as ALL_DAYS,
)


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


def run(config_path):
    """Return a JSON string. On success: {ok:true, ...report}. On a config
    error: {ok:false, kind:'config', message}. On any other crash:
    {ok:false, kind:'crash', message} (with a traceback)."""
    try:
        cfg = load_config(config_path)
        res = build_schedule(cfg)
        write_xlsx(res)                       # -> cfg['out']
        chk = check_invariants(res)

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            print_summary(res, chk)

        report = dict(
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
        )
        # json.dumps turns int dict keys (Counter distributions) into strings
        # and tuples into lists automatically -> browser-safe.
        return json.dumps(report, default=str)
    except ScheduleConfigError as e:
        return json.dumps(dict(ok=False, kind="config", message=str(e)))
    except Exception:  # noqa: BLE001 - report any solver crash to the UI
        import traceback
        return json.dumps(dict(ok=False, kind="crash",
                               message=traceback.format_exc()))
