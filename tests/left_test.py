#!/usr/bin/env python3
"""Live board "left the company" (2026-10-09): set_left takes every shift off from a
day on (slots left open, nothing counts), marks those days 'left' with the shift they
had, blanks their cells for the other apps, blocks new shifts; clear_left and undo.

Run:  python tests/gen_fixtures.py   (once)  then  python tests/left_test.py
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

DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
LATE = DAYS[3:]
row = lambda r, name: next(x for x in r['drivers'] if x['name'] == name)
fill = lambda r: {d['day']: d['routes_filled'] for d in r['days']}
train = lambda c: 'TRAIN' in (c or '')
# someone with shifts both before Wed and from Wed on, no training day
who = next(x for x in built['drivers']
           if any(x['cells'].get(d) for d in DAYS[:3]) and sum(1 for d in LATE if x['cells'].get(d)) >= 2
           and not any(train(c) for c in x['cells'].values())
           and not any(x['cells'].get(d) in ('Unavailable', 'Dispatch') for d in LATE))
N = who['name']
print('driver:', N, who['cells'])
road_late = [d for d in LATE if who['cells'].get(d) and 'Backup' not in who['cells'][d]]

r = J(runner.set_left, {'name': N, 'day': 'Wed', 'note': 'quit'})
ok(r.get('ok'), 'set_left ok')
me = row(r, N)
ok(me['left'] == 'Wed', 'left = Wed')
ok(all(me['cells'].get(d, '') == '' for d in LATE), 'cells from Wed blank (other apps: not working)')
ok(all(me['cells'].get(d) == who['cells'].get(d) for d in DAYS[:3]), 'days before Wed unchanged')
ok(me['hours'] < who['hours'], f"hours went down ({who['hours']} -> {me['hours']})")
ok(not any(d in me['road_days'] or d in me['backup_days'] for d in LATE), 'no shifts from Wed on')
for d in road_late:
    ok(fill(r)[d] == fill(built)[d] - 1, f'{d}: one route fewer filled (slot open)')
    ok(any(ln.startswith(f'P1 INFEASIBLE {d}') for ln in r['infeasible']), f'{d}: shows an open route')
mk = {m['day']: m for m in r['marks'] if m['name'] == N}
ok(set(mk) >= {d for d in LATE if d in [x['day'] for x in built['days'] if x['open']]}, 'every open day from Wed marked')
ok(all(m['kind'] == 'left' and m['note'] == 'quit' for m in mk.values()), "marks are 'left' with the note")
ok(all(mk[d]['was'].startswith(who['cells'][d]) for d in LATE if who['cells'].get(d) and d in mk), 'marks keep the shift they had')
ok(r['edits'][-1].startswith(f'{N} left the company - off the schedule from Wed'), 'logged: ' + r['edits'][-1])

day = road_late[0]
opts = J(runner.add_options, {'name': N})
dd = next(x for x in opts['days'] if x['day'] == day)
ok(dd['road']['status'] == 'blocked' and 'left the company' in dd['road']['reasons'], f'{day}: blocked, "left the company"')
ok(not J(runner.apply_mark, {'name': N, 'day': 'Mon', 'kind': 'left'}).get('ok'), "apply_mark won't take 'left'")
ok('already marked as left' in J(runner.set_left, {'name': N, 'day': 'Wed'}).get('message', ''), 'twice refused')

# saved and reloaded: the same
st = J(runner.export_state)
runner.use_slot('live')
lv = J(runner.load_state, {'state': st['state'], 'out': os.path.join(tmp, 'live.xlsx')})
ok(row(lv, N)['left'] == 'Wed' and row(lv, N)['cells'] == me['cells'], 'survives save + reload')

r2 = J(runner.clear_left, {'name': N})
ok(r2.get('ok') and row(r2, N)['left'] is None, 'clear_left: not left any more')
ok(not any(m['name'] == N and m['kind'] == 'left' for m in r2['marks']), 'left marks gone')
ok(not any(d in row(r2, N)['road_days'] for d in LATE), 'shifts not put back')
r3 = J(runner.undo_last)
ok(row(r3, N)['left'] == 'Wed', 'undo puts the left mark back')
ok(not J(runner.clear_left, {'name': 'Nobody Here'}).get('ok'), 'clear for someone not left refused')

if fails:
    print(f'\n{len(fails)} FAILED')
    sys.exit(1)
print('\nALL PASS')
