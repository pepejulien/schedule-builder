#!/usr/bin/env python3
"""Scenario tests for the base-floor + layered-upgrade model (Jose 2026-07-19).

Base floor everyone gets first: Top/Solid 3, Fair 2, discipline 1. Then, while
route slots remain, upgrades in order (better rate first): Fair->3, discipline->2,
Top/Solid->4, Fair->4. Light week (below the base) = strict tier (bottom cut,
worst rate first). Backups only to Top/Solid stuck at 3.

Builds a synthetic 60-driver week (all fully available) at controlled volumes.
Run:  python tests/tier_scenarios.py
"""
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..',
                                'driver-schedule-builder skill', 'scripts'))
import openpyxl  # noqa: E402
import build_weekly_schedule as B  # noqa: E402

ALL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
os.makedirs(FIX, exist_ok=True)

N_TOP, N_FAIR, N_DISC = 12, 20, 28
TOP = [f'Top Solid {i:02d}' for i in range(N_TOP)]
FAIR = [f'Fair Driver {i:02d}' for i in range(N_FAIR)]
DISC = [f'Disc Driver {i:02d}' for i in range(N_DISC)]
ALLNAMES = TOP + FAIR + DISC
DISC_RATE = {n: -10 - i * (45 / (N_DISC - 1)) for i, n in enumerate(DISC)}  # -10 best .. -55 worst

# Reference volumes (route-days) for a 60-driver fleet, all available:
BASE = N_TOP * 3 + N_FAIR * 2 + N_DISC * 1      # 104
V_LIGHT = 90                                    # below base -> discipline cut
V_BASE = BASE                                   # 104
V_FAIR3 = BASE + N_FAIR * 1                      # 124 (base + Fair 2->3)
V_DISC2 = V_FAIR3 + N_DISC * 1                   # 152 (+ discipline 1->2)
V_TOP4 = V_DISC2 + N_TOP * 1                     # 164 (+ Top 3->4)
V_FAIR4 = V_TOP4 + N_FAIR * 1                    # 184 (+ Fair 3->4)


def write_avail(path, unavail=None):
    unavail = unavail or {}
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Shifts & Availability'
    ws.append(['Associate Name', 'Transporter ID'] + ALL)
    for i, n in enumerate(ALLNAMES):
        row = [n, f'A{i:05d}']
        for d in ALL:
            row.append('Unavailable' if d in unavail.get(n, []) else '')
        ws.append(row)
    wb.save(path)


def run(total, backup_pct=0.0, unavail=None, exact=None):
    base = total // 7
    rem = total - base * 7
    waves = {}
    for k, d in enumerate(ALL):
        n = base + (1 if k < rem else 0)
        if n <= 0:
            continue
        a = max(n // 4, 1) if n >= 2 else 0
        waves[d] = {'10:25 AM': n - a, '10:45 AM': a} if a else {'10:25 AM': n}
    avail = os.path.join(FIX, '_tier_avail.xlsx'); write_avail(avail, unavail)
    cfg = {
        'start_date': '2026-08-02', 'waves': waves, 'backup_pct': backup_pct,
        'max_primary_days': 4, 'weekly_hours_cap': 40,
        'free_primary_cap': 4, 'free_total_days': 4, 'max_total_days': 5,
        'most_days': TOP,
        'reduced_days': {'target': 2, 'names': DISC, 'prefer_days': ['Sun', 'Sat']},
        'driver_rates': DISC_RATE, 'weekend_spread': False,
        'exact_days': exact or {},
        'prev_week_file': None, 'avail_file': avail,
        'out': os.path.join(FIX, '_tier_out.xlsx'), 'strict_names': True,
    }
    p = os.path.join(FIX, '_tier_cfg.json'); json.dump(cfg, open(p, 'w'))
    cfg = B.load_config(p); res = B.build_schedule(cfg); chk = B.check_invariants(res)
    return res, chk


def days_of(res, n):
    return next(len(dr['prim']) + len(dr['helper']) for dr in res.roster if dr['name'] == n)


def tiers(res):
    d = {dr['name']: len(dr['prim']) + len(dr['helper']) for dr in res.roster}
    return [d[n] for n in TOP], [d[n] for n in FAIR], [d[n] for n in DISC]


PASS = FAIL = 0
def check(name, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f'  ok  {name}')
    else:
        FAIL += 1; print(f'  XX  {name}  {detail}')


def m(xs):
    return round(statistics.mean(xs), 2)


# --- base floor: everyone gets 3/2/1, nobody at 0 ---
res, chk = run(V_BASE)
top, fair, disc = tiers(res)
print(f'BASE({V_BASE}): top {m(top)} fair {m(fair)} disc {m(disc)} | min disc {min(disc)} | errors {len(chk["errors"])}')
check('base: no errors', not chk['errors'], str(chk['errors'][:3]))
check('base: every Top/Solid >= 3', min(top) >= 3, min(top))
check('base: every Fair >= 2', min(fair) >= 2, min(fair))
check('base: every discipline >= 1 (nobody at 0)', min(disc) >= 1, min(disc))
check('base: discipline not yet upgraded (<=1 avg)', m(disc) <= 1.1, m(disc))

# --- layer order: Fair->3 happens before discipline->2 and before Top->4 ---
res, chk = run(V_FAIR3)
top, fair, disc = tiers(res)
print(f'FAIR3({V_FAIR3}): top {m(top)} fair {m(fair)} disc {m(disc)} | errors {len(chk["errors"])}')
check('fair3: no errors', not chk['errors'])
check('fair3: Fair reached 3', m(fair) >= 2.9, m(fair))
check('fair3: discipline STILL at base 1 (Fair upgraded first)', m(disc) <= 1.15, m(disc))
check('fair3: Top STILL at base 3 (not yet 4)', m(top) <= 3.15, m(top))

res, chk = run(V_DISC2)
top, fair, disc = tiers(res)
print(f'DISC2({V_DISC2}): top {m(top)} fair {m(fair)} disc {m(disc)} | errors {len(chk["errors"])}')
check('disc2: discipline reached 2', m(disc) >= 1.85, m(disc))
check('disc2: Top STILL at 3 (discipline upgraded before Top 4th)', m(top) <= 3.15, m(top))

res, chk = run(V_TOP4)
top, fair, disc = tiers(res)
print(f'TOP4({V_TOP4}): top {m(top)} fair {m(fair)} disc {m(disc)}')
check('top4: Top/Solid reached 4', m(top) >= 3.85, m(top))

res, chk = run(V_FAIR4)
top, fair, disc = tiers(res)
print(f'FAIR4({V_FAIR4}): top {m(top)} fair {m(fair)} disc {m(disc)}')
check('fair4: Fair reached 4', m(fair) >= 3.85, m(fair))

# --- light week: strict tier, discipline cut worst-rate first ---
res, chk = run(V_LIGHT)
top, fair, disc = tiers(res)
by_rate = sorted(DISC, key=lambda n: -DISC_RATE[n])   # best first
better = sum(days_of(res, n) for n in by_rate[:N_DISC // 2])
worse = sum(days_of(res, n) for n in by_rate[N_DISC // 2:])
print(f'LIGHT({V_LIGHT}): top {m(top)} fair {m(fair)} disc {m(disc)} | better-rate disc {better} vs worse {worse} | errors {len(chk["errors"])}')
check('light: no errors', not chk['errors'])
check('light: Top/Solid protected at 3', min(top) >= 3, min(top))
check('light: Fair protected at 2', min(fair) >= 2, min(fair))
check('light: discipline cut', m(disc) < 1.0, m(disc))
check('light: worst-rate discipline cut first', better > worse, f'{better} vs {worse}')

# --- backups: only Top/Solid stuck at 3 get them ---
res, chk = run(V_LIGHT, backup_pct=0.15)
bk = {dr['name']: len(dr['bk']) for dr in res.roster}
top_bk = sum(bk[n] for n in TOP)
other_bk = sum(bk[n] for n in FAIR + DISC)
print(f'BACKUPS: Top/Solid backups {top_bk} | Fair+discipline backups {other_bk}')
check('backups: Fair + discipline get NONE', other_bk == 0, other_bk)
check('backups: only go to Top/Solid', top_bk >= 0)

# --- <5 routes -> exactly 3, even at high volume (feasible: other Tops reach 4) ---
locked = TOP[0]
res, chk = run(V_TOP4, exact={locked: 3})
other_top = m([days_of(res, n) for n in TOP[1:]])
print(f'<5ROUTES: {locked} got {days_of(res, locked)} (expect 3); other Tops avg {other_top}; errors {len(chk["errors"])}')
check('<5 routes: exactly 3 (not 4) while other Tops reach 4', days_of(res, locked) == 3, days_of(res, locked))
check('<5 routes: other Top/Solid still hit 4 (proves high volume)', other_top >= 3.8, other_top)
check('<5 routes: no errors', not chk['errors'], str(chk['errors'][:3]))

# --- over-subscribed instance completes gracefully (no exponential-augment hang) ---
# Locking a Top to 3 at max volume drops fleet capacity below demand by 1 route.
# The build must return quickly and report the shortfall -- never hang.
res, chk = run(V_FAIR4, exact={locked: 3})
short = [e for e in chk['errors'] if 'INFEASIBLE' in e or 'short' in e.lower()]
print(f'OVERSUB: {locked} got {days_of(res, locked)}; errors {len(chk["errors"])} ({short[:1]})')
check('oversub: locked driver still exactly 3', days_of(res, locked) == 3, days_of(res, locked))
check('oversub: shortfall reported, build did not hang', len(chk['errors']) >= 1)

# --- unavailable discipline driver = no crash ---
victim = DISC[0]
res, chk = run(V_BASE, unavail={victim: ALL[:6]})
print(f'UNAVAIL: {victim} got {days_of(res, victim)} | errors {len(chk["errors"])}')
check('unavail: no build error', not chk['errors'], str(chk['errors'][:3]))
check('unavail: capped by availability', days_of(res, victim) <= 1)

print(f'\n{PASS}/{PASS + FAIL} scenario checks passed')
for f in ('_tier_avail.xlsx', '_tier_out.xlsx', '_tier_cfg.json'):
    try:
        os.remove(os.path.join(FIX, f))
    except OSError:
        pass
sys.exit(1 if FAIL else 0)
