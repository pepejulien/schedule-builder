#!/usr/bin/env python3
"""Active drivers onto the schedule (Jose 2026-10-22): runner.add_driver puts a driver who isn't on
a saved week on it as an empty row (days before the hire date Unavailable, "Not hired yet"), they can
take shifts, undo takes the row off, a saved state keeps them; the build's extra_drivers adds active
drivers missing from the availability file (never twice, loose name match).

Run:  python tests/gen_fixtures.py   (once)  then  python tests/add_driver_test.py
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
names = [x['name'] for x in built['drivers']]
start = cfg['start_date']
import datetime  # noqa: E402
tue = (datetime.date.fromisoformat(start) + datetime.timedelta(days=2)).isoformat()
row = lambda r, name: next((x for x in r['drivers'] if x['name'] == name), None)

# ---- live: add_driver ----
st = J(runner.export_state)['state']
runner.use_slot('live_t')
r = J(runner.load_state, {'state': st, 'out': os.path.join(tmp, 'live.xlsx')})
ok(r.get('ok'), 'load_state ok')
NEW = 'Zelda Quinn Newhire'
r = J(runner.add_driver, {'name': NEW, 'tid': 'AZZTEST', 'hire_date': tue})
ok(r.get('ok'), 'add_driver ok')
me = row(r, NEW)
ok(me is not None, 'new hire is a row on the week')
ok(me and me['tid'] == 'AZZTEST', 'tid kept')
ok(me and me['cells'].get('Sun') == 'Unavailable' and me['cells'].get('Mon') == 'Unavailable',
   'days before the hire date Unavailable')
ok(me and not me['cells'].get('Tue') and not me['cells'].get('Sat'), 'from the hire date: blank, free to add')
ok(me and me['hours'] == 0, 'no shifts, no hours')
ok(any(NEW in e and 'added to the week' in e for e in r['edits']), 'change-log line')
ok(len(r['drivers']) == len(names) + 1, 'everyone else still there')

again = J(runner.add_driver, {'name': 'Zelda Newhire'})
ok(again.get('ok') is False and 'already' in again['message'], 'same person (no middle name) refused')
again = J(runner.add_driver, {'name': names[0]})
ok(again.get('ok') is False, 'someone already on the week refused')
if cfg.get('exclude'):
    ex = J(runner.add_driver, {'name': cfg['exclude'][0]})
    ok(ex.get('ok') is False and 'on purpose' in ex['message'], 'excluded (dispatch / management) refused')

# a shift for the new hire works like anyone's
opts = J(runner.add_options, {'name': NEW})
ok(opts.get('ok') is not False, 'add_options answers for the new hire')
sat_road = J(runner.apply_add, {'name': NEW, 'day': 'Sat', 'role': 'road', 'force_policy': True,
                                'force_unav': True, 'force_limits': True})
if sat_road.get('ok') is False:
    sat_road = J(runner.apply_add, {'name': NEW, 'day': 'Sat', 'role': 'backup', 'force_policy': True,
                                    'force_unav': True, 'force_limits': True})
ok(sat_road.get('ok') is not False and row(sat_road, NEW)['cells'].get('Sat'),
   'new hire takes a Saturday shift (' + str(sat_road.get('message') or row(sat_road, NEW)['cells'].get('Sat')) + ')')

# saved and loaded back: still there
st2 = J(runner.export_state)['state']
runner.use_slot('live_t2')
r2 = J(runner.load_state, {'state': st2, 'out': os.path.join(tmp, 'live2.xlsx')})
ok(r2.get('ok') and row(r2, NEW) is not None, 'saved week keeps the new hire')
ok(row(r2, NEW)['cells'].get('Sun') == 'Unavailable', '... and the not-hired days')

# undo takes the row off (undo the shift, then the add)
runner.use_slot('live_t')
J(runner.undo_last)
u = J(runner.undo_last)
ok(u.get('ok') is not False and row(u, NEW) is None, 'undo takes the added row off again')
ok(len(u['drivers']) == len(names), 'back to the built week')

# ---- build: extra_drivers ----
first = names[0]
fl = first.split()[0] + ' ' + first.split()[-1]
cfg2 = dict(cfg, out=os.path.join(tmp, 'build2.xlsx'),
            extra_drivers=[{'name': NEW, 'tid': 'AZZTEST', 'hire_date': tue}, fl, {'name': first}])
cpath2 = os.path.join(tmp, 'config2.json')
json.dump(cfg2, open(cpath2, 'w', encoding='utf-8'))
runner.use_slot('build2')
b2 = json.loads(runner.run(cpath2))
ok(b2.get('ok'), 'build with extra_drivers ran: ' + str(b2.get('message', ''))[:200])
if b2.get('ok'):
    n2 = [x['name'] for x in b2['drivers']]
    ok(NEW in n2, 'the active driver missing from the file is on the built week')
    ok(len(n2) == len(names) + 1, 'a name already in the file (with or without middle name) not added twice')
    me = row(b2, NEW)
    ok(me['cells'].get('Sun') == 'Unavailable' and me['cells'].get('Mon') == 'Unavailable',
       'build: not hired yet = Unavailable')
    ok(any('ACTIVE DRIVERS' in n and NEW in n for n in b2['notes']), 'build note names who was added')
    ok(me['hours'] > 0, f"build gives the new hire shifts ({me['hours']}h)")

print()
print('FAILED: %d' % len(fails) if fails else 'ALL OK')
sys.exit(1 if fails else 0)
