#!/usr/bin/env python3
"""Training pairs from either side (Jose 2026-10-29): pair_options / set_pair.
Click the trainee and pick the trainer, or the other way round - anyone, on the
schedule that day or not. A trainer's route / backup turns into the ride-along,
a trainee's backup into their route, a free trainee gets one.

Run:  python tests/gen_fixtures.py   (once)  then  python tests/pair_test.py
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'public', 'solver'))
import runner  # noqa: E402

FIX = os.path.join(HERE, 'fixtures')
fails = []


def ok(cond, msg, why=None):
    print(('  ok   ' if cond else '  FAIL ') + msg + ('' if cond or why is None else f'  -> {why}'))
    if not cond:
        fails.append(msg)


def J(fn, payload=None):
    return json.loads(fn(json.dumps(payload or {})))


tmp = tempfile.mkdtemp()
cfg = json.load(open(os.path.join(FIX, 'Week-40-config.json'), encoding='utf-8'))
for k in ('prev_week_file', 'prefs_csv', 'avail_file'):
    cfg[k] = os.path.join(FIX, os.path.basename(cfg[k]))
cfg['out'] = os.path.join(tmp, 'build.xlsx')
cpath = os.path.join(tmp, 'config.json')
json.dump(cfg, open(cpath, 'w', encoding='utf-8'))
runner.use_slot('build')
ok(json.loads(runner.run(cpath))['ok'], 'build ran')
state = J(runner.export_state)['state']


def fresh(slot):
    runner.use_slot(slot)
    return J(runner.load_state, {'state': state})


cell = lambda rep, n, d: next(x for x in rep['drivers'] if x['name'] == n)['cells'].get(d, '')   # noqa: E731
dayinfo = lambda rep, d: next(x for x in rep['days'] if x['day'] == d)                              # noqa: E731
YES = lambda *names: {'ok_unav': list(names), 'ok_limits': list(names)}                           # noqa: E731


def pick(rep, day, want, n=1, skip=()):
    """n drivers whose cell that day is `want` ('' free / 'road' / 'backup') and who
    can take a trainer day / a route without a lock (pair_options says so)."""
    out = []
    for d in rep['drivers']:
        if d['name'] in skip or 'TRAIN' in d['cells'].get(day, ''):
            continue
        c = d['cells'].get(day, '')
        kind = ('' if c == '' else 'backup' if 'Backup' in c
                else 'road' if day in d['road_days'] else 'other')
        if kind != want:
            continue
        o = J(runner.pair_options, {'name': d['name'], 'day': day, 'as': 'trainer'})
        if o.get('ok') and o['me']['status'] in ('ok', 'warn'):
            out.append(d['name'])
        if len(out) == n:
            break
    return out


r = fresh('p1')
day = next(x['day'] for x in r['days'] if x['open'] and len(pick(r, x['day'], '', 2)) == 2
           and pick(r, x['day'], 'road', 2) and pick(r, x['day'], 'backup', 1))
print('day', day)

print('both free: the wave has to be picked, then a route is added')
a, b = pick(r, day, '', 2)
o = J(runner.pair_options, {'name': a, 'day': day, 'as': 'trainer'})
ok(o['ok'] and any(c['name'] == b and c['state'] == '' for c in o['candidates']),
   'the trainer\'s list has people who are not on the schedule that day')
ok(next(c for c in o['candidates'] if c['name'] == b)['wave'] is None, '...and says the wave needs picking')
e = J(runner.set_pair, {'trainer': a, 'trainee': b, 'day': day})
ok(e.get('kind') == 'needs_wave', 'no wave -> needs_wave')
w = sorted(dayinfo(r, day)['waves'])[0]
f0 = dayinfo(r, day)['routes_filled']
m = J(runner.set_pair, {'trainer': a, 'trainee': b, 'day': day, 'wave': w, **YES(a, b)})
ok(m['ok'], f'{a} trains {b} {day} {w}')
ok(cell(m, a, day) == f"{w} (TRAIN helper w/ {runner._short(b)})" and cell(m, b, day) == f"{w} (TRAIN drives w/ {runner._short(a)})",
   'both cells show the pair')
ok(dayinfo(m, day)['routes_filled'] == f0 + 1, 'the trainee drives one more route')
ok(any(t[0] == a and t[1] == b and t[2] == day for t in m['pairlog']), 'in the training record')
o2 = J(runner.pair_options, {'name': b, 'day': day, 'as': 'trainee'})
ok(o2.get('kind') == 'edit' and 'already in a training pair' in o2['message'], 'a paired trainee can\'t pair again')
ok(J(runner.set_pair, {'trainer': pick(m, day, '', 1, (a, b))[0], 'trainee': b, 'day': day, 'wave': w}).get('kind') == 'edit',
   'set_pair refuses a trainee who already has a trainer')
u = J(runner.undo_last)
ok(u['ok'] and cell(u, a, day) == '' and cell(u, b, day) == '', 'undo takes the pair off')

print('trainer on a route, trainee free: the trainee takes the route')
r = fresh('p2')
t = pick(r, day, 'road', 1)[0]
n = pick(r, day, '', 1)[0]
tw = cell(r, t, day)
f0 = dayinfo(r, day)['routes_filled']
o = J(runner.pair_options, {'name': n, 'day': day, 'as': 'trainee'})
ot = next(c for c in o['candidates'] if c['name'] == t)
ok(ot['takes'] and ot['wave'] == runner._cell_wave(tw), 'the trainee\'s list: the trainer on a route, "takes" his wave')
m = J(runner.set_pair, {'trainer': t, 'trainee': n, 'day': day, **YES(t, n)})
ok(m['ok'], f'{t} (on a route) trains {n}', m.get('message'))
ok('TRAIN helper' in cell(m, t, day) and cell(m, n, day).startswith(runner._cell_wave(tw)), 'same wave as the trainer\'s route')
ok(dayinfo(m, day)['routes_filled'] == f0, 'route count unchanged (the trainee took it)')
ok('takes' in m['edits'][-1], f"the log says so: {m['edits'][-1]}")
ok(not any(t in e for e in m['check']['errors']), 'no rule error for the trainer')

print('both on a route: the trainer\'s route is left open')
r = fresh('p3')
t, n = pick(r, day, 'road', 2)
f0 = dayinfo(r, day)['routes_filled']
m = J(runner.set_pair, {'trainer': t, 'trainee': n, 'day': day, **YES(t, n)})
ok(m['ok'] and dayinfo(m, day)['routes_filled'] == f0 - 1, 'one route opens')
ok(cell(m, n, day).startswith(cell(r, n, day)), 'the trainee keeps their wave')
ok('left open' in m['edits'][-1], 'the log says the route is open')

print('trainer on a backup, trainee on a backup: the backup becomes the route')
r = fresh('p4')
bday = day
for x in pick(r, bday, '', 2):        # the fixture week has few backups: make two
    r = J(runner.apply_add, {'name': x, 'day': bday, 'role': 'backup', 'confirm_unavailable': True, 'confirm_limits': True})
bks = [x['name'] for x in r['drivers'] if 'Backup' in x['cells'].get(bday, '')]
ok(len(bks) >= 2, f'two backups on {bday}')
if len(bks) >= 2:
    t, n = bks[:2]
    bw = sorted(dayinfo(r, bday)['waves'])[0]
    m = J(runner.set_pair, {'trainer': t, 'trainee': n, 'day': bday, 'wave': bw, **YES(t, n)})
    ok(m['ok'], f'{t} (backup) trains {n} (backup) {bday}', m.get('message'))
    if m['ok']:
        ok('TRAIN helper' in cell(m, t, bday) and 'TRAIN drives' in cell(m, n, bday), 'the pair is on')
        nd = next(x for x in m['drivers'] if x['name'] == n)
        ok(bday in nd['road_days'] and bday not in nd['backup_days'], 'the trainee\'s backup is now a route')
        ok(bday not in next(x for x in m['drivers'] if x['name'] == t)['backup_days'], 'the trainer is no longer a backup')

print('pop-ups name who they are about')
r = fresh('p5')
off = next((d['name'] for d in r['drivers'] if d['cells'].get(day) == 'Unavailable'), None)
if off:
    t = pick(r, day, '', 1)[0]
    e = J(runner.set_pair, {'trainer': t, 'trainee': off, 'day': day, 'wave': w, 'ok_limits': [t, off]})
    ok(e.get('kind') in ('needs_confirm', 'compliance') and e.get('who') == off, f"refusal names the trainee ({e.get('kind')})")
    if e.get('kind') == 'needs_confirm':
        m = J(runner.set_pair, {'trainer': t, 'trainee': off, 'day': day, 'wave': w, **YES(t, off)})
        ok(m['ok'] and 'OVERRIDE' in m['edits'][-1], 'OK\'d per name, logged as an override')
        ok(not any(off in x and x.startswith('UNAVAIL') for x in m['check']['errors']), 'reported as approved, not a failure')
else:
    print('     (no Unavailable driver that day - skipped)')

print('ending it, and a reload keeps it')
r = fresh('p6')
t, n = pick(r, day, '', 2)
m = J(runner.set_pair, {'trainer': t, 'trainee': n, 'day': day, 'wave': w, **YES(t, n)})
st2 = J(runner.export_state)['state']
runner.use_slot('p6b')
rl = J(runner.load_state, {'state': st2})
ok(cell(rl, t, day) == cell(m, t, day) and any(x[0] == t for x in rl['pairlog']), 'saved and reloaded the same')
c = J(runner.clear_duty, {'name': t, 'day': day})
ok(c['ok'] and cell(c, t, day) == '' and cell(c, n, day) == w, 'ending the pair: the trainee drives alone')

print()
print('PASS' if not fails else f'{len(fails)} FAILED')
sys.exit(1 if fails else 0)
