#!/usr/bin/env python3
"""Scenario tests for the tier-priority rework (Jose 2026-07-19).

Builds a synthetic ~60-driver week (all fully available, to isolate the tier
logic) at three route volumes and asserts the intended priority:
  Top/Solid maximize (4) > Fair target 3 (->4 in excess) > discipline 2 (->0,
  worst board-rate first), with soft targets (no build-failing errors).

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

N_TOP, N_FAIR, N_DISC = 12, 20, 28   # discipline = 16 Underperforming + 12 Term

TOP = [f'Top Solid {i:02d}' for i in range(N_TOP)]
FAIR = [f'Fair Driver {i:02d}' for i in range(N_FAIR)]
DISC = [f'Disc Driver {i:02d}' for i in range(N_DISC)]
ALLNAMES = TOP + FAIR + DISC
# discipline rates: -10 (best) .. -55 (worst), so worst-rate loses days first.
DISC_RATE = {n: -10 - i * (45 / (N_DISC - 1)) for i, n in enumerate(DISC)}


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


def make_config(total_route_days, unavail=None):
    per = total_route_days / 7
    waves = {}
    for k, d in enumerate(ALL):
        n = int(round(per)) + (1 if k < (total_route_days - int(round(per)) * 7) else 0)
        n = max(n, 1)
        a = max(n // 4, 1); waves[d] = {'10:25 AM': n - a, '10:45 AM': a}
    avail = os.path.join(FIX, '_tier_avail.xlsx')
    write_avail(avail, unavail)
    cfg = {
        'start_date': '2026-08-02',
        'waves': waves,
        'backup_pct': 0.0,           # isolate ROAD-day allocation
        'max_primary_days': 4, 'weekly_hours_cap': 40,
        'free_primary_cap': 4, 'free_total_days': 4, 'max_total_days': 5,
        'most_days': TOP,
        'reduced_days': {'target': 2, 'names': DISC, 'prefer_days': ['Sun', 'Sat']},
        'driver_rates': DISC_RATE,
        'weekend_spread': False,
        'prev_week_file': None,
        'avail_file': avail,
        'out': os.path.join(FIX, '_tier_out.xlsx'),
        'strict_names': True,
    }
    p = os.path.join(FIX, '_tier_cfg.json')
    json.dump(cfg, open(p, 'w'))
    return p


def run(total, unavail=None):
    cfg = B.load_config(make_config(total, unavail))
    res = B.build_schedule(cfg)
    chk = B.check_invariants(res)
    days = {dr['name']: len(dr['prim']) + len(dr['helper']) for dr in res.roster}
    tier = lambda names: [days[n] for n in names]  # noqa: E731
    return res, chk, tier


def days_of(res, n):
    return next(len(dr['prim']) + len(dr['helper']) for dr in res.roster if dr['name'] == n)


PASS, FAIL = 0, 0
def check(name, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f'  ok  {name}')
    else:
        FAIL += 1; print(f'  XX  {name}  {detail}')


# ---------------- IDEAL volume ----------------
res, chk, tier = run(12 * 4 + 20 * 3 + 28 * 2)   # 164
top, fair, disc = tier(TOP), tier(FAIR), tier(DISC)
print('IDEAL: top avg %.2f | fair avg %.2f | disc avg %.2f | errors %d'
      % (statistics.mean(top), statistics.mean(fair), statistics.mean(disc), len(chk['errors'])))
check('ideal: no errors', not chk['errors'], str(chk['errors'][:3]))
check('ideal: Top/Solid near 4', statistics.mean(top) >= 3.6, statistics.mean(top))
check('ideal: Fair near 3', 2.6 <= statistics.mean(fair) <= 3.4, statistics.mean(fair))
check('ideal: discipline near 2', 1.4 <= statistics.mean(disc) <= 2.1, statistics.mean(disc))
check('ideal: Fair >= discipline (avg)', statistics.mean(fair) >= statistics.mean(disc))

# ---------------- LOW volume (discipline is the shock absorber) ----------------
res, chk, tier = run(12 * 4 + 20 * 3 + 14)        # 122: room for ~half the discipline days
top, fair, disc = tier(TOP), tier(FAIR), tier(DISC)
# split discipline by rate: better half vs worse half
disc_by_rate = sorted(DISC, key=lambda n: -DISC_RATE[n])  # best rate first
better = sum(days_of(res, n) for n in disc_by_rate[:N_DISC // 2])
worse = sum(days_of(res, n) for n in disc_by_rate[N_DISC // 2:])
print('LOW: top avg %.2f | fair avg %.2f | disc avg %.2f | better-rate disc days %d vs worse %d | errors %d'
      % (statistics.mean(top), statistics.mean(fair), statistics.mean(disc), better, worse, len(chk['errors'])))
check('low: no errors (soft targets)', not chk['errors'], str(chk['errors'][:3]))
check('low: Top/Solid still near 4', statistics.mean(top) >= 3.6, statistics.mean(top))
check('low: Fair still near 3', statistics.mean(fair) >= 2.6, statistics.mean(fair))
check('low: discipline cut below 2', statistics.mean(disc) < 1.6, statistics.mean(disc))
check('low: worst-rate discipline cut first (better keep more days)', better > worse,
      f'{better} vs {worse}')

# ---------------- HIGH volume (Fair bumps to 4) ----------------
res, chk, tier = run(12 * 4 + 20 * 4 + 28 * 2)    # 184
top, fair, disc = tier(TOP), tier(FAIR), tier(DISC)
print('HIGH: top avg %.2f | fair avg %.2f (max %d) | disc avg %.2f | errors %d'
      % (statistics.mean(top), statistics.mean(fair), max(fair), statistics.mean(disc), len(chk['errors'])))
check('high: no errors', not chk['errors'], str(chk['errors'][:3]))
check('high: some Fair reach 4', max(fair) == 4)
check('high: Top/Solid at 4', statistics.mean(top) >= 3.8, statistics.mean(top))

# ---------------- mostly-unavailable discipline driver = no crash ----------------
victim = DISC[0]
res, chk, tier = run(12 * 4 + 20 * 3 + 28 * 2, unavail={victim: ALL[:6]})
got = days_of(res, victim)
short_names = [t[0] for t in chk.get('target_short', [])]
print('UNAVAIL: %s got %d road days | errors %d' % (victim, got, len(chk['errors'])))
check('unavail discipline: no build error (was the old "want 2 got 0" crash)', not chk['errors'],
      str(chk['errors'][:3]))
check('unavail discipline: capped by availability', got <= 1)

print(f'\n{PASS}/{PASS + FAIL} scenario checks passed')
# clean up temp fixtures
for f in ('_tier_avail.xlsx', '_tier_out.xlsx', '_tier_cfg.json'):
    try:
        os.remove(os.path.join(FIX, f))
    except OSError:
        pass
sys.exit(1 if FAIL else 0)
