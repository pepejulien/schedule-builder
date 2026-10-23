#!/usr/bin/env python3
"""Step 9 manual edits before publishing (Jose 2026-10-23): in the BUILDER, a 6-day
and overtime go through after the pop-up (the solver itself never makes one); two
drivers can trade shifts (apply_trade, undo restores both); a hand-edited build
survives export_state / load_state into the build slot (a page reload).

Run:  python tests/gen_fixtures.py   (once)  then  python tests/build_edits_test.py
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
ok(not any(e.startswith(('TOTDAYS', 'CONSEC', 'DAYS7')) for e in built['check']['errors']),
   'the solver itself schedules no 6-day')
st0 = J(runner.export_state)['state']
open_days = [x['day'] for x in built['days'] if x['open']]

print('a 6-day in the builder, after the pop-up')
pick = None
for d in built['drivers']:
    for day in open_days:
        c = J(runner.candidates, {'day': day, 'role': 'backup'})
        me = next(x for x in c['candidates'] if x['name'] == d['name'])
        if me['status'] == 'confirm' and any(lm.startswith('6-day') for lm in me['limits']):
            pick = (d['name'], day)
            break
    if pick:
        break
ok(pick is not None, 'some driver can get a 6th day as a pop-up (status confirm)')
if pick:
    nm, day = pick
    e = J(runner.apply_add, {'name': nm, 'day': day, 'role': 'backup'})
    ok(e.get('kind') == 'needs_limits', 'refused without the pop-up OK')
    a = J(runner.apply_add, {'name': nm, 'day': day, 'role': 'backup', 'confirm_limits': True,
                             'confirm_unavailable': True})
    ok(a['ok'], f'{nm} gets {day} with the OK')
    ok(not any(nm in x for x in a['check']['errors'] if x.startswith(('TOTDAYS', 'CONSEC', 'DAYS7'))),
       "no rule error for the OK'd 6-day")
    ok(any(nm in x for x in a['check']['overridden']), 'listed as an approved override')
    ok(J(runner.undo_last)['ok'], 'undo')
# 7 days in 7 is still locked: nobody is offered a 7th
seven = [x for day in open_days for x in J(runner.candidates, {'day': day, 'role': 'backup'})['candidates']
         if any('days in 7' in r and 'max 6' in r for r in x['reasons'])]
ok(all(x['status'] == 'blocked' for x in seven), f'7 days in 7 stays locked ({len(seven)} seen)')

print('trades')
r = built
row = {d['name']: d for d in r['drivers']}
a = next(d for d in r['drivers'] if d['road_days'] and not d['helper_days']
         and 'TRAIN' not in d['cells'][d['road_days'][0]])
day = a['road_days'][0]
t = J(runner.trade_options, {'name': a['name'], 'day': day})
ok(t['ok'] and t['role'] == 'road' and t['options'], f"{a['name']} {day}: {len(t.get('options', []))} trade options")
okx = next((o for o in t['options'] if o['status'] == 'ok' and o['day'] != day), None)
ok(okx is not None, 'a clean two-day trade exists')
if okx:
    b = okx['name']
    before = {n: (sorted(row[n]['road_days']), sorted(row[n]['backup_days'])) for n in (a['name'], b)}
    m = J(runner.apply_trade, {'name': a['name'], 'day': day, 'with_name': b, 'with_day': okx['day']})
    ok(m['ok'], f"traded with {b} ({okx['day']} {okx['role']})")
    after = {d['name']: d for d in m['drivers']}
    ka = 'road_days' if okx['role'] == 'road' else 'backup_days'
    ok(okx['day'] in after[a['name']][ka] and day not in after[a['name']]['road_days'],
       f"{a['name']} works {okx['day']} instead of {day}")
    ok(day in after[b]['road_days'] and okx['day'] not in after[b][ka], f"{b} works {day} instead of {okx['day']}")
    ok(after[a['name']]['cells'][okx['day']] == row[b]['cells'][okx['day']]
       and after[b]['cells'][day] == row[a['name']]['cells'][day], 'the wave labels went with the shifts')
    ok([x['routes_filled'] for x in m['days']] == [x['routes_filled'] for x in r['days']], 'route fills unchanged')
    ok(m['edits'][-1].startswith('Traded:'), 'logged: ' + m['edits'][-1])
    u = J(runner.undo_last)
    back = {d['name']: (sorted(d['road_days']), sorted(d['backup_days'])) for d in u['drivers'] if d['name'] in before}
    ok(back == before, 'undo puts both back')
# same day: a route and a backup change hands
bk = next((d for d in r['drivers'] if d['backup_days']), None)
if bk:
    bday = bk['backup_days'][0]
    t2 = J(runner.trade_options, {'name': bk['name'], 'day': bday})
    same = next((o for o in t2['options'] if o['day'] == bday and o['role'] == 'road'
                 and o['status'] in ('ok', 'warn')), None)
    ok(same is not None, f"{bk['name']}'s {bday} backup can trade with a {bday} route")
    if same:
        m = J(runner.apply_trade, {'name': bk['name'], 'day': bday, 'with_name': same['name'], 'with_day': bday})
        aft = {d['name']: d for d in m['drivers']}
        ok(m['ok'] and bday in aft[bk['name']]['road_days'] and bday in aft[same['name']]['backup_days'],
           'they swap route and backup')
        ok([x['routes_filled'] for x in m['days']] == [x['routes_filled'] for x in r['days']]
           and [x['backup_filled'] for x in m['days']] == [x['backup_filled'] for x in r['days']], 'counts unchanged')
        J(runner.undo_last)
# a locked trade is refused and changes nothing
t = J(runner.trade_options, {'name': a['name'], 'day': day})
bad = next((o for o in t['options'] if o['status'] == 'blocked'), None)
ok(bad is not None, 'some trade is locked (e.g. a day they already work)')
if bad:
    e = J(runner.apply_trade, {'name': a['name'], 'day': day, 'with_name': bad['name'], 'with_day': bad['day']})
    ok(not e['ok'] and e['kind'] == 'compliance', 'apply_trade refuses a locked trade')
    s_now = J(runner.export_state)['state']
    ok(json.loads(s_now)['res']['cell'] == json.loads(st0)['res']['cell'], '...and leaves the grid as it was')

print('a reload keeps the hand edits (export_state -> load_state, build slot)')
e1 = J(runner.apply_edit, {'day': day, 'role': 'road', 'from_name': a['name']})
ok(e1['ok'], 'an edit: a route left open')
saved = J(runner.export_state)['state']
runner._SLOTS['build'] = runner._new_state()        # what a fresh worker has
runner.use_slot('build')
ok(J(runner.candidates, {'day': day, 'role': 'road'}).get('kind') == 'no_state', 'fresh engine: nothing in memory')
os.remove(cfg["out"])
re_ = J(runner.load_state, {'state': saved})
ok(re_['ok'], 'load_state into the build slot')
ok({d['name']: d['cells'] for d in re_['drivers']} == {d['name']: d['cells'] for d in e1['drivers']}, 'same cells')
ok(re_['edits'] == e1['edits'], 'same edit log')
ok(re_['infeasible'] == e1['infeasible'], 'the open route is still listed')
ok(os.path.exists(cfg['out']), 'the workbook is written again')
ok(J(runner.candidates, {'day': day, 'role': 'road'})['ok'], 'edits work again')

print('\n%s' % ('ALL OK' if not fails else f'{len(fails)} FAILED'))
sys.exit(1 if fails else 0)
