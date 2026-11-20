#!/usr/bin/env python3
"""Locked days in the solver + runner (Jose 2026-11-20, schedule_locks).

Config: locked_days = [{name, day, training?, trainer?, note?}]; a training pair
with a 'day' (or an auto_training entry with one) is a locked training day.
  * placed before anyone else, never moved by any later pass
  * wins over the driver's days off (that day only) and their own Drivers-page
    limits (max days / in a row) -- the runner lists those as approved
  * max_consecutive / max_days_in_7 still hold; no free route = not placed,
    kept on res.LOCKS with a reason and a note (never dropped silently)
  * a locked day counts toward the driver's week
Run:  python tests/locked_days_test.py
"""
import contextlib
import io
import json
import os
import random
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'public', 'solver'))
import openpyxl  # noqa: E402
import build_weekly_schedule as B  # noqa: E402
import runner  # noqa: E402

ALL = B.ALL
fails = []
tmp = tempfile.mkdtemp()


def ok(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        fails.append(msg)


def J(fn, payload=None):
    return json.loads(fn(json.dumps(payload or {})))


def synth_week(names, per_day, tag, unav=None, prev=None, **extra):
    """Every driver available unless `unav` says otherwise; `prev` = {name: [days worked LAST week]}."""
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Shifts & Availability'
    ws.append(['Associate Name', 'Transporter ID'] + ALL)
    for i, n in enumerate(names):
        ws.append([n, f'T{i:04d}'] + ['Unavailable' if d in (unav or {}).get(n, ()) else '' for d in ALL])
    avail = os.path.join(tmp, f'{tag}-avail.xlsx'); wb.save(avail)
    pf = None
    if prev:
        wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Shifts & Availability'
        ws.append(['Associate Name', 'Transporter ID'] + ALL)
        for i, n in enumerate(names):
            ws.append([n, f'T{i:04d}'] + ['10:45 AM' if d in prev.get(n, ()) else '' for d in ALL])
        pf = os.path.join(tmp, f'{tag}-prev.xlsx'); wb.save(pf)
    cfg = dict(start_date='2026-08-02', waves={d: {'10:25 AM': per_day} for d in ALL},
               backup_per_day={d: 0 for d in ALL}, max_primary_days=4, weekly_hours_cap=40,
               max_total_days=5, free_total_days=4, prev_week_file=pf, avail_file=avail,
               out=os.path.join(tmp, f'{tag}-out.xlsx'), weekend_spread=False)
    cfg.update(extra)
    return cfg


def build(cfg):
    p = os.path.join(tmp, 'c.json')
    json.dump(cfg, open(p, 'w', encoding='utf-8'))
    res = B.build_schedule(B.load_config(p))
    return res, B.check_invariants(res)


def run(cfg):
    p = os.path.join(tmp, 'r.json')
    json.dump(cfg, open(p, 'w', encoding='utf-8'))
    runner.use_slot('build')
    with contextlib.redirect_stdout(io.StringIO()):
        return json.loads(runner.run(p))


def days_on(dr):
    return set(dr['prim']) | set(dr['bk']) | set(dr['helper'])


def drv(res, name):
    return next(dr for dr in res.roster if dr['name'] == name)


def lock_of(res, name, day):
    return next(lk for lk in res.LOCKS if lk['name'] == name and lk['day'] == day)


FIRST = ['Ann', 'Ben', 'Cal', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jon', 'Kim', 'Lou', 'Max', 'Ned', 'Oda', 'Pam']
LAST = ['Avery', 'Brooks', 'Chen', 'Dunn', 'Ellis', 'Fox', 'Gray', 'Hart', 'Irwin', 'Judd', 'Kent', 'Lane',
        'Moss', 'Nash', 'Ortiz', 'Price']
NAMES = [f'{f} {l}' for f, l in zip(FIRST, LAST)][:12]
HARD = ('UNAVAIL', 'CONSEC', 'DAYS7', 'DUP-DAY')

print('L1 a lock beats a day off from the preferences / the availability file (that day only)')
cfg = synth_week(NAMES, 6, 'l1', unav={'Ann Avery': ['Tue', 'Wed']},
                 extra_unavailable={'Ben Brooks': {'Thu': 'days', 'Fri': 'timeoff'}},
                 locked_days=[{'name': 'Ann Avery', 'day': 'Tue'}, {'name': 'ben brooks', 'day': 'Thu'}])
res, chk = build(cfg)
a, b = drv(res, 'Ann Avery'), drv(res, 'Ben Brooks')
ok('Tue' in a['prim'] and 'Wed' not in days_on(a), f"Ann works the locked Tue, not Wed: {sorted(days_on(a))}")
ok('Wed' in a['unav'] and 'Tue' not in a['unav'], f"Ann's other day off stays: {sorted(a['unav'])}")
ok('Thu' in b['prim'] and 'Fri' not in days_on(b), f"Ben works the locked Thu, not Fri: {sorted(days_on(b))}")
ok(b['unav_why'] == {'Fri': 'timeoff'}, f"Ben's Fri time off kept as is: {b['unav_why']}")
ok(all(lk['why'] is None for lk in res.LOCKS), f'both placed: {res.LOCKS}')
ok(lock_of(res, 'Ben Brooks', 'Thu')['name'] == 'Ben Brooks', 'the lock takes the roster spelling')
ok(not [e for e in chk['errors'] if e.startswith(HARD)], f"no hard errors: {chk['errors']}")

print('L2 a locked day counts toward the week and caps the rest')
cfg = synth_week(NAMES, 6, 'l2', locked_days=[{'name': 'Cal Chen', 'day': d} for d in ('Sun', 'Mon', 'Wed')],
                 exact_days={'Cal Chen': 3})
res, chk = build(cfg)
c = drv(res, 'Cal Chen')
ok(set(c['prim']) == {'Sun', 'Mon', 'Wed'}, f"Cal (exactly 3) works only the 3 locked days: {sorted(c['prim'])}")
ok(not c['bk'], 'no backup on top')

print("L3 past the driver's own max days / max in a row: kept, approved in the runner")
cfg = synth_week(NAMES, 6, 'l3', driver_max_days={'Dee Dunn': 2}, driver_max_row={'Dee Dunn': 2},
                 locked_days=[{'name': 'Dee Dunn', 'day': d} for d in ('Mon', 'Tue', 'Wed')])
res, chk = build(cfg)
d_ = drv(res, 'Dee Dunn')
ok({'Mon', 'Tue', 'Wed'} <= set(d_['prim']) and len(days_on(d_)) == 3,
   f"Dee keeps all 3 locks, nothing more: {sorted(days_on(d_))}")
rep = run(cfg)
ok(rep['ok'] and not [e for e in rep['check']['errors'] if 'Dee Dunn' in e],
   f"runner: no failed rule for Dee: {rep['check']['errors']}")
ok(any('Dee Dunn' in e for e in rep['check']['overridden']), f"listed as approved: {rep['check']['overridden']}")
row = next(r for r in rep['drivers'] if r['name'] == 'Dee Dunn')
ok(row['locked'] == ['Mon', 'Tue', 'Wed'], f"driver row carries the locked days: {row['locked']}")
ok(len(rep['locks']) == 3 and all(lk['working'] for lk in rep['locks']), f"report locks: {rep['locks']}")

print('L4 no free route: flagged "no route", kept on the list, never dropped silently')
cfg = synth_week(NAMES, 1, 'l4', closed_days=['Sat'], waves={d: {'10:25 AM': 1} for d in ALL if d != 'Sat'},
                 locked_days=[{'name': 'Eve Ellis', 'day': 'Mon'}, {'name': 'Fay Fox', 'day': 'Mon'},
                              {'name': 'Gus Gray', 'day': 'Sat'}, {'name': 'Nobody Here', 'day': 'Tue'}])
res, chk = build(cfg)
ok('Mon' in drv(res, 'Eve Ellis')['prim'], 'the first lock takes the only Mon route')
ok(lock_of(res, 'Fay Fox', 'Mon')['why'] == 'no route' and 'Mon' not in days_on(drv(res, 'Fay Fox')),
   'the second Mon lock: no route')
ok(lock_of(res, 'Gus Gray', 'Sat')['why'] == 'no route', 'a closed day: no route')
ok(lock_of(res, 'Nobody Here', 'Tue')['why'].startswith('not on'), 'a name not on the roster: said so')
ok(sum(1 for n in res.notes if n.startswith('LOCKED, NOT PLACED')) == 3, f"three notes: {res.notes}")
rep = run(cfg)
lf = next(lk for lk in rep['locks'] if lk['name'] == 'Fay Fox')
ok(not lf['working'] and lf['why'] == 'no route', f'report: {lf}')

print('L5 the hard days-in-a-row rule still holds (last week counts)')
cfg = synth_week(NAMES, 6, 'l5', prev={'Hal Hart': ['Tue', 'Wed', 'Thu', 'Fri', 'Sat']},
                 locked_days=[{'name': 'Hal Hart', 'day': 'Sun'}])
res, chk = build(cfg)
ok(lock_of(res, 'Hal Hart', 'Sun')['why'] == 'days in a row' and 'Sun' not in days_on(drv(res, 'Hal Hart')),
   'a 6th day in a row is not placed, and said why')
ok(not [e for e in chk['errors'] if e.startswith(('CONSEC', 'DAYS7'))], f"no run errors: {chk['errors']}")

print('L6 a locked training day with a trainer: both that day, even on a day off')
cfg = synth_week(NAMES, 6, 'l6', exact_days={'Ivy Irwin': 3},
                 extra_unavailable={'Jon Judd': {'Wed': 'days'}},
                 training_pairs=[{'trainer': 'Jon Judd', 'trainee': 'Ivy Irwin', 'day': 'Wed', 'manual': True}],
                 locked_days=[{'name': 'Ivy Irwin', 'day': 'Wed', 'training': True, 'trainer': 'Jon Judd'}])
res, chk = build(cfg)
ivy, jon = drv(res, 'Ivy Irwin'), drv(res, 'Jon Judd')
ok(res.PAIRLOG == [('Jon Judd', 'Ivy Irwin', 'Wed')], f'pair on the locked Wed: {res.PAIRLOG}')
ok('Wed' in ivy['prim'] and 'Wed' in jon['helper'], 'trainee drives, trainer rides along')
ok(lock_of(res, 'Ivy Irwin', 'Wed')['why'] is None, 'the lock is placed')
ok(all(ALL.index(x) > ALL.index('Wed') for x in ivy['prim'] if x != 'Wed'),
   f"solo days only after training: {sorted(ivy['prim'], key=ALL.index)}")

print('L7 training on, no trainer: the rotation picks, the trainee keeps the date')
cfg = synth_week(NAMES, 6, 'l7', exact_days={'Kim Kent': 3},
                 auto_training=[{'trainee': 'Kim Kent', 'pool': ['Ann Avery', 'Ben Brooks'], 'day': 'Thu'}],
                 extra_unavailable={'Ann Avery': {'Thu': 'days'}},
                 locked_days=[{'name': 'Kim Kent', 'day': 'Thu', 'training': True}])
rep = run(cfg)
ok(rep['ok'] and [p[1:] for p in rep['pairlog']] == [['Kim Kent', 'Thu']], f"trains on Thu: {rep['pairlog']}")
ok(rep['pairlog'] and rep['pairlog'][0][0] == 'Ben Brooks', f"Ann is off Thu: the next in line, Ben: {rep['pairlog']}")
ok(any(n.startswith('Auto-picked trainer for Kim Kent: Ben Brooks') for n in rep['notes']), 'auto-picked note')
k = next(r for r in rep['drivers'] if r['name'] == 'Kim Kent')
ok('Thu' in k['road_days'], 'Kim drives Thu')

print('L8 no trainer can ride along: the trainee still works the locked date')
cfg = synth_week(NAMES, 6, 'l8', exact_days={'Lou Lane': 3},
                 auto_training=[{'trainee': 'Lou Lane', 'pool': ['Ann Avery'], 'day': 'Fri'}],
                 extra_unavailable={'Ann Avery': {'Fri': 'days'}},
                 locked_days=[{'name': 'Lou Lane', 'day': 'Fri', 'training': True}])
rep = run(cfg)
lr = next(r for r in rep['drivers'] if r['name'] == 'Lou Lane')
ok('Fri' in lr['road_days'], f"Lou drives the locked Fri: {lr['road_days']}")
ok(any(n.startswith('TRAINING:') for n in rep['notes'] + rep['infeasible']), 'the missing ride-along is said')

print('L9 no locks = the build exactly as before')
base = synth_week(NAMES, 6, 'l9', unav={'Ann Avery': ['Tue']})
r0, _ = build(base)
r1, _ = build(dict(base, locked_days=[]))
ok([sorted(dr['prim']) + sorted(dr['bk']) for dr in r0.roster]
   == [sorted(dr['prim']) + sorted(dr['bk']) for dr in r1.roster], 'same week')

print('L10 export_state / load_state keep the locks')
rep = run(synth_week(NAMES, 6, 'l10', locked_days=[{'name': 'Ann Avery', 'day': 'Mon', 'note': 'ride-along'}]))
st = J(runner.export_state)['state']
runner.use_slot('live')
ok(J(runner.load_state, {'state': st}).get('ok'), 'loads')
res = runner._STATE['res']
ok(res.LOCKS and res.LOCKS[0]['note'] == 'ride-along' and 'Mon' in drv(res, 'Ann Avery')['locked'], 'kept')
runner.use_slot('build')

print('L11 bad shapes fail loudly')
for bad in ([{'name': 'Ann Avery', 'day': 'Funday'}], {'Ann Avery': 'Mon'}, [{'day': 'Mon'}]):
    try:
        build(synth_week(NAMES, 6, 'l11', locked_days=bad))
        ok(False, f'{bad!r} accepted')
    except B.ScheduleConfigError:
        ok(True, f'{bad!r} refused')

print('L12 random sweep: a placed lock is never moved, the hard rules always hold')
rng = random.Random(1120)
bad = 0
for it in range(60):
    names = [f'{f} {l}' for f, l in zip(FIRST, LAST)][:rng.randint(10, 16)]
    unav = {n: rng.sample(ALL, rng.randint(0, 3)) for n in names}
    prev = {n: rng.sample(ALL, rng.randint(0, 5)) for n in names}
    locks = [{'name': rng.choice(names), 'day': rng.choice(ALL)} for _ in range(rng.randint(1, 8))]
    cfg = synth_week(names, rng.randint(3, 7), f's{it}', unav=unav, prev=prev, locked_days=locks,
                     backup_per_day={d: rng.randint(0, 2) for d in ALL},
                     driver_max_days={rng.choice(names): rng.randint(1, 3)},
                     most_days=rng.sample(names, 3))
    res, chk = build(cfg)
    for lk in res.LOCKS:
        dr = drv(res, lk['name'])
        if lk['why'] is None and lk['day'] not in dr['prim']:
            bad += 1
            print('    moved:', it, lk)
    hard = [e for e in chk['errors'] if e.startswith(HARD)]
    if hard:
        bad += 1
        print('    hard:', it, hard)
ok(not bad, f'60 random weeks, {bad} problem(s)')

print()
print('PASS' if not fails else f'FAILED ({len(fails)})')
sys.exit(1 if fails else 0)
