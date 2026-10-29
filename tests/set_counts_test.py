#!/usr/bin/env python3
"""Live board day counts (2026-10-09): set_counts sets a day's per-wave routes
and backups, can go below the routes already in a wave (it shows over), logs the change, and
undo puts it back.

Run:  python tests/gen_fixtures.py   (once)  then  python tests/set_counts_test.py
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


def ok(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
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
built = json.loads(runner.run(cpath))
ok(built['ok'], 'build ran')

day = next(d for d in built['days'] if d['open'] and len(d['waves']) >= 1 and d['routes'] > 0)
D, waves = day['day'], day['waves']
w0 = sorted(waves)[0]
print(f'{D}: {waves}, backups {day["backup"]}')

# someone added to a full wave -> the count stays put, only set by hand (2026-10-11)
free = next(x for x in built['drivers'] if not x['cells'].get(D) and D not in x['unavailable'])
r = J(runner.apply_add, {'name': free['name'], 'day': D, 'role': 'road', 'wave': w0,
                         'confirm_limits': True, 'confirm_unavailable': True})
ok(r.get('ok'), 'added a driver to a full wave')
d1 = next(d for d in r['days'] if d['day'] == D)
ok(d1['routes'] == day['routes'] and d1['waves'][w0] == waves[w0], 'the count stayed put')
ok(d1['routes_filled'] == day['routes_filled'] + 1, 'the day shows one over')
# raise it by hand to match
r = J(runner.set_counts, {'day': D, 'waves': {**waves, w0: waves[w0] + 1}})
ok(r.get('ok'), 'raised the count by hand')
d1 = next(d for d in r['days'] if d['day'] == D)
ok(d1['routes'] == day['routes'] + 1 and d1['waves'][w0] == waves[w0] + 1, 'the count went up by one')

# below what's in the wave is allowed (Jose 2026-10-29): the wave just shows over
r = J(runner.set_counts, {'day': D, 'waves': {w0: waves[w0]}})
ok(r.get('ok') and next(d for d in r['days'] if d['day'] == D)['waves'][w0] == waves[w0], 'below the routes in the wave is allowed')
ok(not any(e.startswith('WAVE ') for e in r['check']['errors']), 'over its count is not a rule error')
r = J(runner.undo_last)

# take the added driver off: the slot is open, then lower the count back
r = J(runner.apply_edit, {'day': D, 'role': 'road', 'from_name': free['name']})
ok(r.get('ok'), 'removed the added driver')
ok(any(ln.startswith(f'P1 INFEASIBLE {D}') for ln in r['infeasible']), 'one route shows open')
r = J(runner.set_counts, {'day': D, 'waves': {w0: waves[w0]}, 'backup': day['backup'] + 2})
ok(r.get('ok'), 'set the counts back')
d2 = next(d for d in r['days'] if d['day'] == D)
ok(d2['routes'] == day['routes'] and d2['waves'] == waves, 'routes back to the original')
ok(d2['backup'] == day['backup'] + 2, 'backups set')
ok(not any(ln.startswith(f'P1 INFEASIBLE {D}') for ln in r['infeasible']), 'no open route left')
ok(r['edits'][-1].startswith(f'Set {D} to {day["routes"]} routes (was {day["routes"] + 1}'), 'logged: ' + r['edits'][-1])
ok(not any(e.startswith('WAVE ') for e in r['check']['errors']), 'no wave errors')

# bad input / nothing changed
ok(not J(runner.set_counts, {'day': D, 'waves': {'9:99 AM': 1}}).get('ok'), 'unknown wave refused')
ok(not J(runner.set_counts, {'day': D, 'waves': {w0: -1}}).get('ok'), 'negative refused')
ok(not J(runner.set_counts, {'day': D, 'backup': 'x'}).get('ok'), 'bad backup refused')
ok('Nothing changed' in J(runner.set_counts, {'day': D, 'waves': dict(waves)}).get('message', ''), 'no-op refused')

# undo
r = J(runner.undo_last)
d3 = next(d for d in r['days'] if d['day'] == D)
ok(d3['routes'] == day['routes'] + 1 and d3['backup'] == day['backup'], 'undo puts the counts back')

if fails:
    print(f'\n{len(fails)} FAILED')
    sys.exit(1)
print('\nALL PASS')
