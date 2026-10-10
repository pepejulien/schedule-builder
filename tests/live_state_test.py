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
import datetime
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
# 6 worked days in any 7 (Jose 2026-10-07): locked by the builder; on the Live board
# a 6th day in 7 goes through after the pop-up (and is reported as an approved override)
runner.use_slot('live3')
r3 = J(runner.load_state, {'state': st['state']})
days_open = [x['day'] for x in r3['days'] if x['open']]
pick = None
for d in r3['drivers']:
    for day in days_open:
        c = J(runner.candidates, {'day': day, 'role': 'backup'})
        me = next(x for x in c['candidates'] if x['name'] == d['name'])
        if me['status'] == 'confirm' and any('days in 7' in l for l in me['limits']):
            pick = (d['name'], day, me)
            break
    if pick:
        break
ok(pick is not None, 'the live board offers a 6th day in 7 as a pop-up (status confirm)')
if pick:
    nm, day, me = pick
    ok(sum(l.startswith('6-day') for l in me['limits']) == 1, f"one 6-day line in the pop-up: {me['limits']}")
    e = J(runner.apply_add, {'name': nm, 'day': day, 'role': 'backup'})
    ok(e.get('kind') == 'needs_limits' and e.get('limits'), f'{nm} {day}: refused without the pop-up OK')
    a = J(runner.apply_add, {'name': nm, 'day': day, 'role': 'backup', 'confirm_limits': True})
    ok(a['ok'], 'allowed with the pop-up OK')
    ok(any("OK'D" in x for x in a['edits']), "the change log says it was OK'd")
    ok(not any(nm in x for x in a['check']['errors']), "no rule error for the OK'd 6 days in 7")
    ok(any(nm in x and x.startswith('DAYS7') for x in a['check']['overridden']), 'listed as an approved override')
    ok(next(x for x in a['drivers'] if x['name'] == nm)['max_days7'] == 6, 'the report shows 6 in 7')
    runner.use_slot('build')
    b = J(runner.candidates, {'day': day, 'role': 'backup'})
    bm = next(x for x in b['candidates'] if x['name'] == nm)
    ok(bm['status'] == 'blocked', 'the builder still locks 6 days in 7')
# last week Wed-Sat + this week Mon-Tue (not 6 in a row): the 6th day in those 7 needs the pop-up
runner.use_slot('live3b')
dates = {x['day']: x['date'] for x in r3['days']}
sun = datetime.date.fromisoformat(dates['Sun'])
who = next(d for d in r3['drivers'] if all(d['cells'].get(x) in ('', 'Unavailable') for x in ('Sun', 'Mon', 'Tue')))
prev = {who['name']: [(sun - datetime.timedelta(days=k)).isoformat() for k in (1, 2, 3, 4)]}   # Wed-Sat last week
r3b = J(runner.load_state, {'state': st['state'], 'prev_worked': prev})
c = J(runner.candidates, {'day': 'Mon', 'role': 'backup'})
me = next(x for x in c['candidates'] if x['name'] == who['name'])
ok(me['status'] != 'blocked', f"{who['name']}: Wed-Sat last week + Mon is 5 in 7 - allowed")
J(runner.apply_add, {'name': who['name'], 'day': 'Mon', 'role': 'backup', 'confirm_unavailable': True, 'confirm_limits': True})
c = J(runner.candidates, {'day': 'Tue', 'role': 'backup'})
me = next(x for x in c['candidates'] if x['name'] == who['name'])
ok(me['status'] == 'confirm' and any('days in 7' in l for l in me['limits']),
   f"...and Tue would be 6 in 7 - a pop-up ({'; '.join(me['reasons'])})")
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

print('a route in a chosen wave, full waves, route <-> backup (2026-10-06)')
runner.use_slot('live5')
r5 = J(runner.load_state, {'state': st['state']})
dd = next(x for x in r5['days'] if x['open'] and x['routes_filled'] >= x['routes'])
wave = max(dd['waves'], key=lambda w: dd['waves'][w])
who = next(x for x in J(runner.candidates, {'day': dd['day'], 'role': 'road'})['candidates'] if x['status'] in ('ok', 'warn'))
a = J(runner.apply_add, {'name': who['name'], 'day': dd['day'], 'role': 'road', 'wave': wave})
ok(a['ok'], f"{who['name']} put on {dd['day']} {wave} although the day was full")
nd = next(x for x in a['days'] if x['day'] == dd['day'])
ok(nd['routes'] == dd['routes'] + 1 and nd['waves'][wave] == dd['waves'][wave] + 1, 'that wave got one more route')
ok(next(x for x in a['drivers'] if x['name'] == who['name'])['cells'][dd['day']] == wave, 'in exactly that wave')
ok('EXTRA route' in a['edits'][-1], 'the log says it was an extra route')
ok(not a['check']['errors'], 'no rule errors after the extra route')
b = J(runner.set_role, {'name': who['name'], 'day': dd['day'], 'to': 'backup'})
ok(b['ok'] and next(x for x in b['drivers'] if x['name'] == who['name'])['cells'][dd['day']] == wave + ' Backup',
   'route turned into a backup in the same wave')
ok(any(f"P1 INFEASIBLE {dd['day']}" in l for l in b['infeasible']), 'its route slot is left open')
c2 = J(runner.set_role, {'name': who['name'], 'day': dd['day'], 'to': 'road'})
ok(c2['ok'] and next(x for x in c2['drivers'] if x['name'] == who['name'])['cells'][dd['day']] == wave,
   'and back into a route')
ok(not any(f"P1 INFEASIBLE {dd['day']}" in l for l in c2['infeasible']), 'filling the open slot again')
u = J(runner.undo_last)
ok(u['ok'] and next(x for x in u['drivers'] if x['name'] == who['name'])['cells'][dd['day']] == wave + ' Backup', 'undo works')

print('dispatch, meetings, trainers, any wave time (2026-10-06)')
runner.use_slot('live6')
r6 = J(runner.load_state, {'state': st['state']})
ok(all(d['cells'][x] != 'Unavailable' for d in r6['drivers'] for x in d['dispatch_days']),
   'a dispatch day shows as Dispatch, not Unavailable')
free = lambda rep, day: [d for d in rep['drivers'] if d['cells'].get(day) == '' and len(d['worked_dates']) < 4
                          and d['max_days7'] <= 3]
day = next(x['day'] for x in r6['days'] if x['open'] and len(free(r6, x['day'])) >= 3)
a, b, c = [d['name'] for d in free(r6, day)[:3]]
m = J(runner.set_duty, {'name': a, 'day': day, 'kind': 'dispatch'})
ok(m['ok'] and next(d for d in m['drivers'] if d['name'] == a)['cells'][day] == 'Dispatch', f'{a} on dispatch {day}')
ok(next(d for d in m['drivers'] if d['name'] == a)['day_hours'].get(next(x['date'] for x in m['days'] if x['day'] == day)) == 12,
   'dispatch counts 12h on the clock')
m = J(runner.set_duty, {'name': b, 'day': day, 'kind': 'meeting'})
ok(m['ok'] and next(d for d in m['drivers'] if d['name'] == b)['cells'][day] == '1:00 PM Meeting', f'{b} in a 1:00 PM meeting')
# a meeting is backup_hours (2h) on the clock and a day worked (2026-10-10): limits.js shiftHours
# now gives the same 2h (it gave 0), so the engine and the browser agree
mdate = next(x['date'] for x in m['days'] if x['day'] == day)
mb = next(d for d in m['drivers'] if d['name'] == b)
ok(mb['day_hours'].get(mdate) == m['limits']['backup_hours'] == 2, f"meeting counts 2h on the clock ({mb['day_hours'].get(mdate)})")
ok(mdate in mb['worked_dates'], 'a meeting day is a day worked')
nee = next(d for d in m['drivers'] if day in d['road_days'] and 'TRAIN' not in d['cells'][day])
m = J(runner.set_duty, {'name': c, 'day': day, 'kind': 'trainer', 'with_name': nee['name']})
ok(m['ok'], f"{c} trains {nee['name']} {day}")
cc = next(d for d in m['drivers'] if d['name'] == c)['cells'][day]
nn = next(d for d in m['drivers'] if d['name'] == nee['name'])['cells'][day]
ok('TRAIN helper' in cc and 'TRAIN drives' in nn, 'both cells show the pair')
ok(any(t[0] == c and t[1] == nee['name'] for t in m['pairlog']), 'in the training record')
ok(not m['check']['errors'], f"no rule errors {m['check']['errors'][:2]}")
blk = J(runner.candidates, {'day': day, 'role': 'road'})
ok(next(x for x in blk['candidates'] if x['name'] == a)['status'] == 'blocked', 'dispatch day blocks a route')
m = J(runner.clear_duty, {'name': nee['name'], 'day': day})
ok(m['ok'] and next(d for d in m['drivers'] if d['name'] == nee['name'])['cells'][day] == nn.split(' (')[0]
   and next(d for d in m['drivers'] if d['name'] == c)['cells'][day] == '', 'ending the pair: trainee drives alone')
m = J(runner.clear_duty, {'name': a, 'day': day})
ok(m['ok'] and next(d for d in m['drivers'] if d['name'] == a)['cells'][day] == '', 'off dispatch again')
u = J(runner.undo_last)
ok(u['ok'] and next(d for d in u['drivers'] if d['name'] == a)['cells'][day] == 'Dispatch', 'undo puts dispatch back')
nw = J(runner.apply_add, {'name': free(u, day)[-1]['name'] if free(u, day) else b, 'day': day, 'role': 'road', 'wave': '11:25 AM'})
ok(nw['ok'] and next(x for x in nw['days'] if x['day'] == day)['waves'].get('11:25 AM') == 1 and not nw['check']['errors'],
   'a route in a wave the day had no routes in')

print()
print('PASS' if not fails else f'{len(fails)} FAILED')
sys.exit(1 if fails else 0)
