#!/usr/bin/env python3
"""Generate a synthetic fixture week for testing the schedule builder end-to-end.

Produces, under tests/fixtures/:
  - Week-40-availability.xlsx   (this week's uploaded "Shifts & Availability")
  - Week-39-Schedule.xlsx       (prior week, for the consecutive-day carryover)
  - Driver-Preferences.csv
  - Week-40-config.json         (a config the solver can run directly)

The roster deliberately exercises every tier/role path:
  Top performers + Solid (most_days), Fair (free pool), Underperforming
  (reduced_days), a <5-routes driver (exact_days 3), a training pair, a
  dispatch driver (extra_worked_days), a benched driver (exact_days 0), and an
  excluded management name that must be pruned from the sheet.
"""
import csv
import datetime
import json
import os

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
os.makedirs(FIX, exist_ok=True)

ALL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
HEADER = ["Associate Name", "Transporter ID"] + ALL

# start_date must be a Sunday.
START = datetime.date(2026, 8, 2)
assert START.weekday() == 6, f"{START} is not a Sunday"
PREV_START = START - datetime.timedelta(days=7)


def _sheet(wb, title="Shifts & Availability"):
    ws = wb.active
    ws.title = title
    ws.append(HEADER)
    return ws


# name -> {unavail: [days], seed: [days], meeting: {day: text}}
ROSTER = {
    # Top performers / Solid -> most_days (maximize road days)
    "Daniel Lynch":       {"unavail": ["Wed"]},
    "Cara Amos":          {},
    "Matthew Dutton":     {"seed": ["Sun", "Mon"]},
    # Fair -> free pool (no target)
    "Aaron Bell":         {},
    "Bianca Cole":        {"unavail": ["Sat"]},
    "Colin Drake":        {"seed": ["Tue"]},
    # Underperforming / Termination review -> reduced_days target 2 (Sun+Sat)
    "Casey Church":       {},
    # <5 routes in last 30 days -> exact_days 3
    "Joshua Workman":     {},
    # Meeting day (do-not-touch) + otherwise normal driver
    "Grace Nolan":        {"meeting": {"Mon": "9:00 AM Meeting"}},
    # Training pair: trainer + brand-new trainee (2 back-to-back days)
    "Alex Keller":        {},          # trainer (also a normal driver otherwise)
    "Jessica Jett":       {},          # trainee (new hire) -> exact_days 3
    # Dispatch duty Fri+Sat -> extra_worked_days
    "Connor Stephenson":  {},
    # Benched, kept on sheet, zero shifts -> exact_days 0
    "Karl Berkley":       {"unavail": ["Sun", "Mon", "Tue", "Wed", "Thu"]},
    # Excluded management name -> pruned from the output sheet entirely
    "Zackary McDonald":   {},
}


def write_avail():
    wb = openpyxl.Workbook()
    ws = _sheet(wb)
    for i, (name, spec) in enumerate(ROSTER.items(), start=1):
        row = {d: "" for d in ALL}
        for d in spec.get("unavail", []):
            row[d] = "Unavailable"
        for d in spec.get("seed", []):
            row[d] = "10:45 AM"
        for d, txt in spec.get("meeting", {}).items():
            row[d] = txt
        ws.append([name, f"A{i:04d}"] + [row[d] for d in ALL])
    path = os.path.join(FIX, "Week-40-availability.xlsx")
    wb.save(path)
    return path


def write_prev():
    """Prior week: give a couple of drivers a Fri+Sat tail so the consecutive
    rule has something real to carry across the week boundary."""
    wb = openpyxl.Workbook()
    ws = _sheet(wb)
    tails = {
        "Daniel Lynch": ["Thu", "Fri", "Sat"],
        "Cara Amos":    ["Fri", "Sat"],
    }
    for i, name in enumerate(ROSTER, start=1):
        row = {d: "" for d in ALL}
        for d in tails.get(name, []):
            row[d] = "10:45 AM"
        ws.append([name, f"A{i:04d}"] + [row[d] for d in ALL])
    path = os.path.join(FIX, "Week-39-Schedule.xlsx")
    wb.save(path)
    return path


def write_prefs():
    path = os.path.join(FIX, "Driver-Preferences.csv")
    rows = [
        {"driver": "Daniel Lynch", "usual_days": "Mon|Tue|Wed|Thu",
         "often_off_soft": "Sun", "unavailable_hard": "", "weeks_present": "12"},
        {"driver": "Cara Amos", "usual_days": "Sun|Mon|Tue|Wed",
         "often_off_soft": "Sat", "unavailable_hard": "", "weeks_present": "12"},
        {"driver": "Aaron Bell", "usual_days": "Tue|Wed|Thu",
         "often_off_soft": "", "unavailable_hard": "", "weeks_present": "8"},
    ]
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(
            f, fieldnames=["driver", "usual_days", "often_off_soft",
                           "unavailable_hard", "weeks_present"])
        w.writeheader()
        for r in rows:
            w.writerow(r)
    return path


def write_config(avail, prev, prefs):
    # Modest, coverable route demand across 6 operating days (Sat closed-ish is
    # left open here; the fixture keeps demand small so the roster can cover it).
    waves = {
        "Sun": {"10:45 AM": 4, "11:05 AM": 2},
        "Mon": {"10:45 AM": 4, "11:05 AM": 2},
        "Tue": {"10:45 AM": 4, "11:05 AM": 2},
        "Wed": {"10:45 AM": 3, "11:05 AM": 2},
        "Thu": {"10:45 AM": 4, "11:05 AM": 2},
        "Sat": {"10:45 AM": 3, "11:05 AM": 1},
    }
    cfg = {
        "week_label": "Week-40 (Aug 2 - Aug 8, 2026)",
        "company": "JAJB LOGISTICS LLC",
        "station": "WWV9",
        "start_date": START.isoformat(),
        "closed_days": ["Fri"],
        "max_consecutive": 5,
        "primary_hours": 10,
        "backup_hours": 2,
        "free_primary_cap": 3,
        "max_primary_days": 4,
        "weekly_hours_cap": 40,
        "max_total_days": 5,
        "free_total_days": 4,
        "waves": waves,
        "backup_pct": 0.15,
        "exclude": ["Zackary McDonald"],
        "exact_days": {"Joshua Workman": 3, "Jessica Jett": 3, "Karl Berkley": 0},
        "reduced_days": {"target": 2, "names": ["Casey Church"],
                         "prefer_days": ["Sun", "Sat"]},
        "most_days": ["Daniel Lynch", "Cara Amos", "Matthew Dutton"],
        "driver_rates": {"Daniel Lynch": -4.0, "Cara Amos": -8.0,
                         "Matthew Dutton": -12.0},
        "use_premade_shifts": True,
        "weekend_spread": True,
        "training_pairs": [{"trainer": "Alex Keller", "trainee": "Jessica Jett"}],
        "extra_worked_days": {"Connor Stephenson": ["Fri", "Sat"]},
        "backup_eligible_extra": [],
        "backup_fallback": [
            ["Daniel Lynch", "Cara Amos"],
            ["Matthew Dutton"],
            ["Casey Church"],
        ],
        "strict_names": True,
        "prev_week_file": prev,
        "prefs_csv": prefs,
        "avail_file": avail,
        "out": os.path.join(FIX, "Week-40-Schedule.xlsx"),
    }
    path = os.path.join(FIX, "Week-40-config.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    return path


if __name__ == "__main__":
    avail = write_avail()
    prev = write_prev()
    prefs = write_prefs()
    cfg = write_config(avail, prev, prefs)
    print("Wrote fixtures to", FIX)
    for p in (avail, prev, prefs, cfg):
        print("  ", os.path.basename(p))
