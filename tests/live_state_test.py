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

print()
print('PASS' if not fails else f'{len(fails)} FAILED')
sys.exit(1 if fails else 0)
