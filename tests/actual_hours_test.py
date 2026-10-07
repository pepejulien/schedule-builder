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

print('an unscheduled real shift counts toward days in a row')
off_day = next((dd for dd in ('Sun','Mon','Tue','Wed','Thu','Fri','Sat') if dd not in d['road_days'] and dd not in d['backup_days'] and not d['cells'].get(dd)), None)
if off_day:
    live3 = J(runner.load_state, {'state': st['state'], 'out': os.path.join(tmp, 'live3.xlsx'),
              'actual': [{'name': name, 'days': {days[off_day]: 9}}]})
    r4 = next(x for x in live3['drivers'] if x['name'] == name)
    ok(days[off_day] in r4['worked_dates'], f'extra real shift on {off_day} is a worked date')
    ok(r4['streak'] >= d['streak'], 'streak counts it')
else:
    ok(True, '(driver works every day - skipped)')

print('overtime uses real hours')
dr = next(x for x in runner._STATE['res'].roster if x['name'] == name)
res = runner._STATE['res']
planned = runner._road_hours_real(res, dict(dr, h_act={}))
ok(planned == runner._pdays(dr) * res.PH, 'no clock-outs: same as before (road days x 10h)')
first_road = res.DATEALL[d['road_days'][0]]
real = runner._road_hours_real(res, dict(dr, h_act={first_road: 12.5}))
ok(real == planned + 2.5, 'a 12.5h real day adds 2.5h to the overtime count')

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

print("live slot: a tracked day without the driver's clock-out = they didn't work (Clint, 2026-10-07)")
runner.use_slot('live')
tue = days['Tue']
other = next((x for x in built['drivers'] if 'Tue' in x['road_days'] and x['name'] != name), None)
if other:
    of, ol = other['name'].lower().split()[0], other['name'].lower().split()[-1]
    # Route Tracker tracked Tuesday (the first driver has a clock-out); `other` is known to it
    # (a clock-out last Saturday) but has none on Tuesday
    act3 = [{'name': name, 'keys': [f'{first}|{last}'], 'days': {mon: 10, tue: 9}},
            {'name': other['name'], 'keys': [f'{of}|{ol}'], 'days': {prev_sat: 8}}]
    l3 = J(runner.load_state, {'state': st['state'], 'out': os.path.join(tmp, 'live3.xlsx'), 'actual': act3})
    r5 = next(x for x in l3['drivers'] if x['name'] == other['name'])
    ok(r5['day_hours'].get(tue) == 0, f"{other['name']} scheduled Tuesday, no clock-out: 0h")
    ok(tue not in r5['worked_dates'], 'and Tuesday is not a worked day')
    gone = other['day_hours'].get(mon, 0) + other['day_hours'].get(tue, 0)   # Monday is tracked too
    ok(abs(r5['clock_hours'] - (other['clock_hours'] - gone)) < 0.01, 'the week total drops by the days not worked')
    # someone Route Tracker doesn't know at all keeps the schedule (a name mismatch never hides risk)
    # same day, but Route Tracker says they were on a route with no out time yet ("open"): they worked
    act4 = [act3[0], dict(act3[1], open=[tue])]
    l4 = J(runner.load_state, {'state': st['state'], 'out': os.path.join(tmp, 'live4.xlsx'), 'actual': act4})
    r6 = next(x for x in l4['drivers'] if x['name'] == other['name'])
    ok(r6['day_hours'].get(tue) == 10 and tue in r6['worked_dates'], 'on a route with no out time: keeps the planned 10h')
    stranger = next(x for x in l3['drivers'] if x['name'] not in (name, other['name']) and 'Tue' in x['road_days'])
    ok(stranger['day_hours'].get(tue) == 10, 'a driver with no clock-outs at all keeps the planned 10h')
else:
    ok(True, '(no second Tuesday driver - skipped)')

print('\nFAIL: ' + '; '.join(fails) if fails else '\nPASS')
sys.exit(1 if fails else 0)
