#!/usr/bin/env python3
"""Randomized invariant sweep for the backup fill (Jose 2026-07-19 pay-order
model). Generates random fleets/volumes/backup-counts, runs the solver, and
asserts the invariants that must hold on EVERY schedule:

  1. discipline tier never gets a backup
  2. <=1 backup per driver; backups only with >=2 road days
  3. total worked days <= max_total_days; Fair roads+backups <= free_total_days
  4. per-day backups never exceed the requested count
  5. PAY ORDER: if any Top/Solid is stuck at 3 roads with no backup (30h),
     no Fair driver's hours may exceed 30h
  6. ORACLE: the number of Top/Solid-at-3 served equals an independent
     max-matching computation (nobody stranded by day-choice collisions)
  7. 5th-day backups only on Top/Solid at 4 roads; Fair never reach 5 total

Usage:  python tests/bk_sweep.py --seed 1 --runs 30 [--json]
Exit 0 if every run passes; 1 otherwise. --json prints a machine summary.
"""
import argparse
import datetime
import json
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..',
                                'driver-schedule-builder skill', 'scripts'))
import openpyxl  # noqa: E402
import build_weekly_schedule as B  # noqa: E402

ALL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
os.makedirs(FIX, exist_ok=True)
ONE = datetime.timedelta(days=1)


def gen_case(rng, tag):
    n_top = rng.randint(4, 20)
    n_fair = rng.randint(8, 35)
    n_disc = rng.randint(4, 25)
    # single-token names with no substring collisions (the fuzzy matcher
    # treats every query token as a substring pattern)
    top = [f'Topx{tag}x{i:02d}' for i in range(n_top)]
    fair = [f'Fairx{tag}x{i:02d}' for i in range(n_fair)]
    disc = [f'Discx{tag}x{i:02d}' for i in range(n_disc)]
    names = top + fair + disc
    rates = {n: -rng.uniform(5, 60) for n in disc}
    for n in top + fair:
        if rng.random() < 0.5:
            rates[n] = -rng.uniform(1, 30)
    unav = {}
    for n in names:
        k = rng.choice([0, 0, 0, 1, 1, 2, 3])
        if k:
            unav[n] = rng.sample(ALL, k)
    # volume: between half the base floor and ~90% of road capacity
    cap = sum(min(4, 7 - len(unav.get(n, []))) for n in names)
    base = n_top * 3 + n_fair * 2 + n_disc * 1
    total = rng.randint(max(7, base // 2), max(8, int(min(cap, base * 2) * 0.9)))
    weekend_cap = rng.choice([None] * 4 + [1, 2])
    if rng.random() < 0.5:
        bk = {'backup_pct': rng.choice([0.1, 0.15, 0.2])}
    else:
        bk = {'backup_per_day': {d: rng.randint(0, 4) for d in ALL}}
    return dict(top=top, fair=fair, disc=disc, names=names, rates=rates,
                unav=unav, total=total, weekend_cap=weekend_cap, bk=bk)


def run_case(case, tag):
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Shifts & Availability'
    ws.append(['Associate Name', 'Transporter ID'] + ALL)
    for i, n in enumerate(case['names']):
        ws.append([n, f'S{i:05d}'] + ['Unavailable' if d in case['unav'].get(n, [])
                                      else '' for d in ALL])
    avail = os.path.join(FIX, f'_sw{tag}.xlsx'); wb.save(avail)
    total = case['total']; base = total // 7; rem = total - base * 7
    waves = {}
    for k, d in enumerate(ALL):
        n = base + (1 if k < rem else 0)
        if n <= 0:
            continue
        a = max(n // 4, 1) if n >= 2 else 0
        waves[d] = {'10:25 AM': n - a, '10:45 AM': a} if a else {'10:25 AM': n}
    cfg = {
        'start_date': '2026-08-02', 'waves': waves, **case['bk'],
        'max_primary_days': 4, 'weekly_hours_cap': 40,
        'free_total_days': 4, 'max_total_days': 5,
        'most_days': case['top'],
        'reduced_days': {'target': 2, 'names': case['disc'],
                         'prefer_days': ['Sun', 'Sat']},
        'driver_rates': case['rates'], 'weekend_spread': True,
        'exact_days': {}, 'prev_week_file': None, 'avail_file': avail,
        'out': os.path.join(FIX, f'_swo{tag}.xlsx'), 'strict_names': True,
    }
    if case['weekend_cap'] is not None:
        cfg['max_weekend_days'] = case['weekend_cap']
    p = os.path.join(FIX, f'_swc{tag}.json'); json.dump(cfg, open(p, 'w'))
    cfg = B.load_config(p)
    res = B.build_schedule(cfg)
    chk = B.check_invariants(res)
    for f in (avail, cfg['out'], p):
        try:
            os.remove(f)
        except OSError:
            pass
    return res, chk


def pdy(dr):
    return len(dr['prim']) + len(dr['helper'])


def hours(dr):
    return pdy(dr) * 10 + len(dr['bk']) * 2


def wknd_used(dr):
    return sum(1 for x in list(dr['prim']) + list(dr['bk']) + list(dr['helper'])
               if x in ('Sat', 'Sun'))


def bk_feasible(res, dr, d, weekend_cap):
    if d in dr['unav'] or d in dr['prim'] or d in dr['helper']:
        return False
    if pdy(dr) >= 5:
        return False
    if weekend_cap is not None and d in ('Sat', 'Sun'):
        # mirror wkend_ok for a driver with no backup yet
        if sum(1 for x in list(dr['prim']) + list(dr['helper'])
               if x in ('Sat', 'Sun')) >= weekend_cap:
            return False
    s = ({res.DATEALL[x] for x in list(dr['prim']) + list(dr['helper'])}
         | set(dr['w_prev']) | {res.DATEALL[d]})
    dt = res.DATEALL[d]; n = 1
    c = dt - ONE
    while c in s:
        n += 1; c -= ONE
    c = dt + ONE
    while c in s:
        n += 1; c += ONE
    return n <= 5


def oracle_top3(res, top_names, weekend_cap):
    """Matroid-greedy oracle: walk Top-at-3 candidates in the solver's tier-1
    priority order (best board-rate first, then name) and keep each that the
    matching can still absorb. Returns the exact SET of names that must be
    served -- both maximum-size and priority-optimal."""
    def rate(dr):
        return res.RATE.get(B.norm(dr['name']), 0)

    cands = sorted((i for i, dr in enumerate(res.roster)
                    if dr['name'] in top_names and pdy(dr) == 3),
                   key=lambda i: (-rate(res.roster[i]),
                                  B.norm(res.roster[i]['name'])))
    assign = {d: [] for d in res.DAYS}

    def place(i, seen):
        dr = res.roster[i]
        for d in res.DAYS:
            if d in seen or not bk_feasible(res, dr, d, weekend_cap):
                continue
            if len(assign[d]) < res.backup[d]:
                assign[d].append(i); return True
        for d in res.DAYS:
            if d in seen or not bk_feasible(res, dr, d, weekend_cap):
                continue
            seen.add(d)
            for j in list(assign[d]):
                assign[d].remove(j)
                if place(j, seen):
                    assign[d].append(i); return True
                assign[d].append(j)
        return False

    total = sum(res.backup[d] for d in res.DAYS)
    served = set()
    for i in cands:
        if len(served) >= total:
            break
        if place(i, set()):
            served.add(res.roster[i]['name'])
    return served


def check_case(case, res, chk):
    errs = []
    top, fair, disc = set(case['top']), set(case['fair']), set(case['disc'])
    if any('INFEASIBLE' in e or 'WAVE' in e for e in chk['errors']):
        return None                      # over-constrained roster: not a backup test
    if chk['errors']:
        errs.append(f'verifier errors: {chk["errors"][:3]}')
    for dr in res.roster:
        n = dr['name']
        if len(dr['bk']) > 1:
            errs.append(f'>1 backup: {n}')
        if dr['bk'] and pdy(dr) < 2:
            errs.append(f'backup under 2 roads: {n}')
        if pdy(dr) + len(dr['bk']) > 5:
            errs.append(f'over 5 total: {n}')
        if n in fair and pdy(dr) + len(dr['bk']) > 4:
            errs.append(f'Fair over 4 total: {n}')
        if dr['bk'] and pdy(dr) == 4 and n not in top:
            errs.append(f'5th-day backup on non-Top: {n}')
    for d in res.DAYS:
        got = sum(1 for dr in res.roster if d in dr['bk'])
        if got > res.backup[d]:
            errs.append(f'day {d}: {got} > requested {res.backup[d]}')
    stuck = [dr for dr in res.roster
             if dr['name'] in top and pdy(dr) == 3 and not dr['bk']]
    if stuck:
        worst = min(hours(dr) for dr in stuck)
        over = [(dr['name'], hours(dr)) for dr in res.roster
                if dr['name'] in fair and hours(dr) > worst]
        if over:
            errs.append(f'PAY ORDER: stuck Top at {worst}h, Fair over: {over[:3]}')
    # Gate B: never a 5-day Top/Solid while any Top-at-3 or eligible Fair-at-2/3
    # sits without a backup
    low_unserved = any(
        not dr['bk'] and (
            (dr['name'] in top and pdy(dr) == 3)
            or (dr['name'] in fair and 2 <= pdy(dr) <= 3 and pdy(dr) < 4))
        for dr in res.roster)
    fifths = [dr['name'] for dr in res.roster if pdy(dr) == 4 and dr['bk']]
    if low_unserved and fifths:
        errs.append(f'5-DAY GATE: 5th days {fifths[:3]} while sub-4 drivers unserved')
    served = {dr['name'] for dr in res.roster
              if dr['name'] in top and pdy(dr) == 3 and dr['bk']}
    want = oracle_top3(res, top, case['weekend_cap'])
    if served != want:
        errs.append(f'PRIORITY SET: served {sorted(served - want)[:3]} instead of '
                    f'{sorted(want - served)[:3]} ({len(served)} vs {len(want)})')
    return errs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--runs', type=int, default=30)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    rng = random.Random(args.seed)
    failures, skipped, passed = [], 0, 0
    for k in range(args.runs):
        tag = f'{args.seed}_{k}'
        case = gen_case(rng, tag)
        try:
            res, chk = run_case(case, tag)
        except Exception as e:  # noqa: BLE001
            failures.append({'run': k, 'crash': repr(e)[:300]})
            continue
        errs = check_case(case, res, chk)
        if errs is None:
            skipped += 1
        elif errs:
            failures.append({'run': k, 'errors': errs[:6]})
        else:
            passed += 1
    out = dict(seed=args.seed, runs=args.runs, passed=passed,
               skipped_infeasible=skipped, failures=failures)
    if args.json:
        print(json.dumps(out))
    else:
        print(f'seed {args.seed}: {passed} passed, {skipped} skipped '
              f'(infeasible roster), {len(failures)} FAILED')
        for f in failures:
            print(' ', f)
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
