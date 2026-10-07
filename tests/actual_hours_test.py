#!/usr/bin/env python3
"""Actual hours from Route Tracker (Firestore actual_hours) replace planned hours.

Run:  python tests/gen_fixtures.py   (once)  then  python tests/actual_hours_test.py
"""
import datetime
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
st = J(runner.export_state)
days = {d['day']: d['date'] for d in built['days']}
sun = datetime.date.fromisoformat(days['Sun'])
prev_sat = (sun - datetime.timedelta(days=1)).isoformat()

# a driver on the road Monday
d = next(x for x in built['drivers'] if 'Mon' in x['road_days'])
name, mon = d['name'], days['Mon']
first, last = name.lower().split()[0], name.lower().split()[-1]
ok(d['day_hours'].get(mon) == 10, f'{name} planned 10h on Monday')

print('live slot with actual hours')
runner.use_slot('live')
actual = [{'name': name.upper(), 'keys': [f'{first}|{last}'], 'tid': '',
           'days': {mon: 11.5, prev_sat: 12}}]
live = J(runner.load_state, {'state': st['state'], 'out': os.path.join(tmp, 'live.xlsx'), 'actual': actual})
ok(live['ok'], 'load_state with actual ok')
r = next(x for x in live['drivers'] if x['name'] == name)
ok(r['day_hours'].get(mon) == 11.5, 'Monday shows the actual 11.5h')
ok(r['day_hours'].get(prev_sat) == 12, "last Saturday's actual 12h counts in the 7-day window")
ok(r['act_dates'] == [mon], 'Monday marked as actual')
ok(r['clock_hours'] == d['clock_hours'] + 1.5, 'week total uses the actual')
others = [x for x in live['drivers'] if x['name'] != name]
ok(all(not x['act_dates'] for x in others), 'nobody else changed')

# 11.5h already worked Monday: adding a 2h backup the same day would pass 12h -> blocked
cand = J(runner.candidates, {'day': 'Mon', 'role': 'backup'})
row = next((c for c in cand.get('candidates', []) if c.get('name') == name), None)
ok(row is None or row.get('status') == 'blocked', 'a backup on top of 11.5h is not offered')

print('ambiguous names are skipped')
twin = [{'name': name, 'days': {mon: 3}}, {'name': name + ' Jr', 'keys': [f'{first}|{last}'], 'days': {mon: 9}}]
live2 = J(runner.load_state, {'state': st['state'], 'out': os.path.join(tmp, 'live2.xlsx'), 'actual': twin})
r2 = next(x for x in live2['drivers'] if x['name'] == name)
ok(r2['act_dates'] == [], 'two people with one name: no actual applied')

print('build slot: last week actual hours')
cfg2 = dict(cfg, actual=[{'name': name, 'days': {prev_sat: 4}}])
json.dump(cfg2, open(cpath, 'w', encoding='utf-8'))
runner.use_slot('build')
b2 = json.loads(runner.run(cpath))
r3 = next(x for x in b2['drivers'] if x['name'] == name)
ok(r3['day_hours'].get(prev_sat) == 4, "next week's build uses last Saturday's actual 4h")

print('\nFAIL: ' + '; '.join(fails) if fails else '\nPASS')
sys.exit(1 if fails else 0)
