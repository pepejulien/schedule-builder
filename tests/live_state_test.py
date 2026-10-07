#!/usr/bin/env python3
"""Live board engine checks (2026-10-06): a built week saved with
export_state() and reloaded with load_state() into the 'live' slot must be the
SAME schedule (same cells, same verifier result), the two slots must not touch
each other, and call-out marks / undo / prev-week carryover must behave.

Run:  python tests/gen_fixtures.py   (once)  then  python tests/live_state_test.py
"""
import copy
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

print('build slot')
runner.use_slot('build')
built = json.loads(runner.run(cpath))
ok(built['ok'], 'build ran')
st = J(runner.export_state)
ok(st['ok'] and len(st['state']) < 900000, f"export_state ok, {len(st['state'])} bytes (< 900 KB)")

print('live slot round trip')
runner.use_slot('live')
ok(J(runner.candidates, {'day': 'Mon', 'role': 'road'}).get('kind') == 'no_state',
   'live slot starts empty')
live = J(runner.load_state, {'state': st['state'], 'out': os.path.join(tmp, 'live.xlsx')})
ok(live['ok'], 'load_state ok')
cells = lambda r: {d['name']: d['cells'] for d in r['drivers']}
ok(cells(live) == cells(built), 'same cells after reload')
ok(live['check']['errors'] == built['check']['errors'], 'same verifier errors')
ok(live['infeasible'] == built['infeasible'], 'same unfilled-slot lines')
ok({d['name']: d['hours'] for d in live['drivers']} == {d['name']: d['hours'] for d in built['drivers']},
   'same hours')
ok(len(live['days']) == 7 and all('date' in d for d in live['days']), 'days info present')
ok(all('streak' in d and 'worked_dates' in d for d in live['drivers']), 'streak + worked dates present')

# a second round trip is byte-identical
st2 = J(runner.export_state)
ok(json.loads(st2['state'])['res']['cell'] == json.loads(st['state'])['res']['cell'],
   'export after load matches the original')

print('edits in the live slot')
day = next(d['day'] for d in live['days'] if d['open'])
victim = next(d for d in live['drivers'] if day in d['road_days'] and 'TRAIN' not in d['cells'][day])
before_routes = next(d for d in live['days'] if d['day'] == day)['routes_filled']
m = J(runner.apply_mark, {'name': victim['name'], 'day': day, 'kind': 'callout', 'note': 'sick'})
ok(m['ok'], f"call-out {victim['name']} {day}")
ok(next(d for d in m['days'] if d['day'] == day)['routes_filled'] == before_routes - 1, 'route slot opened')
ok(next(d for d in m['drivers'] if d['name'] == victim['name'])['cells'][day] == 'Called out',
   'cell shows Called out')
ok(any(x['name'] == victim['name'] and x['kind'] == 'callout' for x in m['marks']), 'mark listed')
ok(any(f'P1 INFEASIBLE {day}' in ln for ln in m['infeasible']), 'open slot reported')
ok(not any(e.startswith('WAVE') for e in m['check']['errors']), 'an open slot is not a rule error')
ok(not os.path.exists(os.path.join(tmp, 'live.xlsx')), 'live slot did not rewrite the xlsx per edit')

c = J(runner.candidates, {'day': day, 'role': 'road'})
vc = next(x for x in c['candidates'] if x['name'] == victim['name'])
ok(vc['status'] == 'unavail' and 'called out' in vc['reasons'][0], 'called-out driver needs a confirm')
pick = next((x for x in c['candidates'] if x['status'] == 'ok'), None)
if pick:
    f = J(runner.apply_edit, {'day': day, 'role': 'road', 'to_name': pick['name']})
    ok(f['ok'] and not any(f'P1 INFEASIBLE {day}' in ln for ln in f['infeasible']),
       f"filled the gap with {pick['name']}")
    u = J(runner.undo_last)
    ok(u['ok'] and any(f'P1 INFEASIBLE {day}' in ln for ln in u['infeasible']), 'undo re-opens the gap')

cm = J(runner.clear_mark, {'name': victim['name'], 'day': day})
ok(cm['ok'] and not cm['marks'], 'mark cleared')
ok(day not in next(d for d in cm['drivers'] if d['name'] == victim['name'])['road_days'],
   'clearing a mark does not put the shift back')

x = J(runner.export_xlsx)
ok(x['ok'] and os.path.exists(x['out']), 'export_xlsx writes the workbook on demand')

print('slots are independent')
runner.use_slot('build')
b2 = J(runner.candidates, {'day': day, 'role': 'road'})
ok(b2['ok'], 'build slot still answers')
bs = json.loads(J(runner.export_state)['state'])
ok(bs['marks'] == {} and bs['res']['cell'] == json.loads(st['state'])['res']['cell'],
   'build slot never saw the live call-out')

print('prev-week carryover from history')
runner.use_slot('live2')
# pretend the driver worked all of last week Mon-Sat: a 6-day tail
s = json.loads(st['state'])
start = runner._dec(s['res'])['DATEALL']['Sun']
tail = [(start - runner.ONE * k).isoformat() for k in range(1, 7)]
free = [d for d in built['drivers'] if d['cells'].get('Sun') == '' and 'Sun' in
        [x['day'] for x in built['days'] if x['open']]]
someone = free[0]['name']
lv = J(runner.load_state, {'state': st['state'], 'prev_worked': {someone: tail}})
ok(lv['ok'], 'load with prev_worked')
ok(next(d for d in lv['drivers'] if d['name'] == someone)['streak'] >= 6, 'streak counts last week')
c = J(runner.candidates, {'day': 'Sun', 'role': 'road'})
sc = next(x for x in c['candidates'] if x['name'] == someone)
ok(sc['status'] == 'blocked' and any('in a row' in r for r in sc['reasons']),
   f"last week's real days block a 7th day in a row ({someone})")

print('6-days, overtime and on-the-clock hours (2026-10-06)')
ok(not any(e.startswith('HOURS') for e in built['check']['errors']), 'the built week breaks no hour limit')
ok(all('max7' in d and 'day_hours' in d for d in built['drivers']), 'hours per day + max 7-day in the report')
# a driver whose 5th straight day is Thu -> Fri would be day 6
runner.use_slot('live3')
r3 = J(runner.load_state, {'state': st['state']})
days_open = [x['day'] for x in r3['days'] if x['open']]
pick = None
for d in r3['drivers']:
    for day in days_open:
        c = J(runner.candidates, {'day': day, 'role': 'backup'})
        me = next(x for x in c['candidates'] if x['name'] == d['name'])
        if me['status'] == 'confirm' and any(l.startswith('6-day') for l in me['limits']):
            pick = (d['name'], day, me)
            break
    if pick:
        break
ok(pick is not None, 'the live board offers some 6-day as a pop-up (status confirm)')
if pick:
    nm, day, me = pick
    e = J(runner.apply_add, {'name': nm, 'day': day, 'role': 'backup'})
    ok(e.get('kind') == 'needs_limits' and e.get('limits'), f'{nm} {day}: refused without the pop-up OK')
    a = J(runner.apply_add, {'name': nm, 'day': day, 'role': 'backup', 'confirm_limits': True})
    ok(a['ok'], 'allowed with the pop-up OK')
    ok(any("OK'D" in x for x in a['edits']), "the change log says it was OK'd")
    ok(not any(nm in x for x in a['check']['errors']), "no rule error for the OK'd 6-day")
    ok(any(nm in x for x in a['check']['overridden']), 'listed as an approved override')
    st6 = J(runner.export_state)['state']
    runner.use_slot('build')
    b = J(runner.candidates, {'day': day, 'role': 'backup'})
    bm = next(x for x in b['candidates'] if x['name'] == nm)
    ok(bm['status'] == 'blocked', 'the builder still locks that 6-day')
    runner.use_slot('live3')
# 60h in 7 days, counting last week's real hours
runner.use_slot('live4')
s0 = runner._dec(json.loads(st['state'])['res'])['DATEALL']['Sun']
victim = next(d for d in built['drivers'] if d['cells'].get('Sun') == '' and d['hours'] >= 30)
prev = {(s0 - runner.ONE * k).isoformat(): 12 for k in (1, 2, 3)}   # Thu-Sat at 12h
lv = J(runner.load_state, {'state': st['state'], 'prev_hours': {victim['name']: prev},
                            'prev_worked': {victim['name']: list(prev)}})
vd = next(d for d in lv['drivers'] if d['name'] == victim['name'])
ok(vd['max7'] >= 36, f"last week's hours count ({victim['name']} max 7-day {vd['max7']}h)")
c = J(runner.candidates, {'day': 'Sun', 'role': 'road'})
vc = next(x for x in c['candidates'] if x['name'] == victim['name'])
w7 = vd['max7'] + 10
print('     ', victim['name'], vc['status'], vc['reasons'][:2], 'max7 if added ~', w7)
ok(vc['status'] == 'blocked' if any('in 7 days' in r for r in vc['reasons']) else True,
   'a 60h break is locked (never a pop-up)')
heavy = {(s0 - runner.ONE * k).isoformat(): 12 for k in (1, 2, 3, 4, 5)}
J(runner.load_state, {'state': st['state'], 'prev_hours': {victim['name']: heavy}})
c = J(runner.candidates, {'day': 'Sun', 'role': 'backup'})
vc = next(x for x in c['candidates'] if x['name'] == victim['name'])
ok(vc['status'] == 'blocked' and any('in 7 days' in r for r in vc['reasons']),
   f"60h+ in 7 days is locked: {[r for r in vc['reasons'] if '7 days' in r]}")

print()
print('PASS' if not fails else f'{len(fails)} FAILED')
sys.exit(1 if fails else 0)
