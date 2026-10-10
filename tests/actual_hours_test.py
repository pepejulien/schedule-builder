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
# summary rows carry the Transporter ID (str, '' when unknown) for the board's tid match (Jose 2026-10-08)
ok(all(isinstance(x.get('tid'), str) for x in built['drivers']), 'every driver row has a tid string')
ok(any(x['tid'] for x in built['drivers']), 'tids come through from the roster')
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

print('Transporter IDs separate two people with one name (2026-10-10)')
m = runner._matcher([{'name': 'John Smith', 'tid': 'B2', 'days': {}}])
ok(m({'name': 'John Smith', 'tid': 'A1'}) is None, 'same key, different TIDs (both set): no match')
ok(m({'name': 'John Smith', 'tid': ''}) is not None, 'no TID on the schedule side: the key still matches')
blank = {'name': 'John Smith', 'tid': '', 'days': {}}
b2 = {'name': 'John Smith', 'tid': 'B2', 'days': {}}
ok(runner._matcher([b2, blank])({'name': 'John Smith', 'tid': 'A1'}) is blank, 'B2 ruled out: the blank-TID record is the only one left')
ok(runner._matcher([b2, blank])({'name': 'John Smith', 'tid': ''}) is None, 'no TID + two records: never guessed')
a1 = {'name': 'John Smith', 'tid': 'A1', 'days': {}}
ok(runner._matcher([b2, a1])({'name': 'John Smith', 'tid': 'A1'}) is a1, 'A1 found by TID among two John Smiths')
dupt = [{'name': 'John Smith', 'tid': 'A1', 'days': {}}, {'name': 'Jane Doe', 'tid': 'A1', 'days': {}}]
ok(runner._matcher(dupt)({'name': 'Jane Doe', 'tid': 'A1'}) is dupt[1], 'a TID two records carry: falls back to the name')
print('one TID-less record two roster drivers share a key with: neither gets it (2026-10-10)')
js_a = {'name': 'John Smith', 'tid': 'A1'}
js_b = {'name': 'John Smith', 'tid': 'B2'}
rec = {'name': 'John Smith', 'tid': '', 'days': {}}
mr = runner._matcher([rec], [js_a, js_b])
ok(mr(js_a) is None and mr(js_b) is None, 'picked by two drivers: used for neither')
ok(runner._matcher([rec], [js_a])(js_a) is rec, 'one roster John Smith: still matched by name')
ok(runner._matcher([dict(rec, tid='B2')], [js_a, js_b])(js_b) is not None, 'the record with B2: B2 only')
# through _apply_actual: neither driver's planned hours change
sun_d = datetime.date(2026, 10, 4)
DA = {dd: sun_d + datetime.timedelta(days=i) for i, dd in enumerate(('Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'))}
ros = [dict(js_a, prim=['Mon'], bk=[], helper=[], extra=set(), meet=set(), w_prev=set()),
       dict(js_b, prim=['Tue'], bk=[], helper=[], extra=set(), meet=set(), w_prev=set())]
fake = runner.Result(roster=ros, DATEALL=DA, PH=10)
runner._STATE['today'] = datetime.date(2026, 10, 8)
napplied = runner._apply_actual(fake, [dict(rec, days={'2026-10-05': 13, '2026-10-06': 13})])
runner._STATE['today'] = None
ok(napplied == 0 and not ros[0].get('h_act') and not ros[1].get('h_act'), '_apply_actual: no hours laid on either')

if d['tid']:
    runner.use_slot('live')
    other_tid = [{'name': name, 'keys': [f'{first}|{last}'], 'tid': d['tid'] + 'X', 'days': {mon: 3}}]
    l5 = J(runner.load_state, {'state': st['state'], 'out': os.path.join(tmp, 'live5.xlsx'), 'actual': other_tid})
    r7 = next(x for x in l5['drivers'] if x['name'] == name)
    ok(r7['act_dates'] == [] and r7['day_hours'].get(mon) == 10, f"{name}: Route Tracker's same-name driver with another TID is not merged")
else:
    ok(True, '(driver has no tid - skipped)')

print('a past meeting / Dispatch day with no clock-out keeps its hours (2026-10-10)')
runner.use_slot('live')
J(runner.load_state, {'state': st['state'], 'out': os.path.join(tmp, 'live6.xlsx')})
DAYS7 = ('Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat')
duty = None
for x in built['drivers']:
    free = [dd for dd in DAYS7 if not x['cells'].get(dd) and dd in runner._STATE['res'].DAYS]
    if len(free) >= 2 and x['name'] != name:
        duty, (dm, dd2) = x, free[:2]
        break
if duty:
    cf = {'confirm_unavailable': True, 'confirm_limits': True}
    r_m = J(runner.set_duty, dict(cf, name=duty['name'], day=dm, kind='meeting'))
    r_d = J(runner.set_duty, dict(cf, name=duty['name'], day=dd2, kind='dispatch'))
    ok(r_m.get('ok') is not False and r_d.get('ok') is not False, f"meeting {dm} + dispatch {dd2} for {duty['name']}")
    st6 = J(runner.export_state)
    df, dl = duty['name'].lower().split()[0], duty['name'].lower().split()[-1]
    # Route Tracker tracked both days (someone else clocked out); it knows `duty` (last Saturday) but
    # has no clock-out for them on the meeting / dispatch day - it doesn't track those
    act6 = [{'name': name, 'keys': [f'{first}|{last}'], 'days': {days[dm]: 10, days[dd2]: 10}},
            {'name': duty['name'], 'keys': [f'{df}|{dl}'], 'days': {prev_sat: 8}}]
    l6 = J(runner.load_state, {'state': st6['state'], 'out': os.path.join(tmp, 'live6b.xlsx'), 'actual': act6})
    r8 = next(x for x in l6['drivers'] if x['name'] == duty['name'])
    ok(r8['day_hours'].get(days[dm]) == 2, f'meeting {dm}: keeps 2h (was zeroed)')
    ok(r8['day_hours'].get(days[dd2]) == 12, f'dispatch {dd2}: keeps 12h (was zeroed)')
    ok(days[dm] in r8['worked_dates'] and days[dd2] in r8['worked_dates'], 'both stay worked days')
    ok(days[dm] not in r8['act_dates'] and days[dd2] not in r8['act_dates'], 'and are not marked as actual hours')
    # a real clock-out on the dispatch day still wins
    act7 = [act6[0], dict(act6[1], days={prev_sat: 8, days[dd2]: 11})]
    l7 = J(runner.load_state, {'state': st6['state'], 'out': os.path.join(tmp, 'live7.xlsx'), 'actual': act7})
    r9 = next(x for x in l7['drivers'] if x['name'] == duty['name'])
    ok(r9['day_hours'].get(days[dd2]) == 11, 'a real clock-out on the dispatch day wins')
else:
    ok(True, '(no driver with two free days - skipped)')

print('\nFAIL: ' + '; '.join(fails) if fails else '\nPASS')
sys.exit(1 if fails else 0)
