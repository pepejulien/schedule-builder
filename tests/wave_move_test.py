#!/usr/bin/env python3
"""Roster bookmark (Jose 2026-10-23): apply_wave with move_count moves a driver's
route to another wave with no swap -- one route count moves with them (one less at
their wave, one more at the new one, the day's total stays) -- logs it, and undo
puts it back. A training pair is refused; without move_count a swap is still needed.

Run:  python tests/gen_fixtures.py   (once)  then  python tests/wave_move_test.py
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

# the live slot, like the Live board (a saved week loaded back)
st = J(runner.export_state)['state']
runner.use_slot('live')
r0 = J(runner.load_state, {'state': st, 'out': os.path.join(tmp, 'live.xlsx')})
ok(r0.get('ok'), 'loaded into the live slot')

day = next(d for d in r0['days'] if d['open'] and len(d['waves']) >= 2
           and any(x['cells'].get(d['day']) == sorted(d['waves'])[0] for x in r0['drivers']))
D, waves = day['day'], dict(day['waves'])
w0, w1 = sorted(waves)[0], sorted(waves)[1]
mover = next(x for x in r0['drivers'] if x['cells'].get(D) == w0)
print(f'{D}: {waves}; moving {mover["name"]} {w0} -> {w1}')
cells0 = {x['name']: dict(x['cells']) for x in r0['drivers']}

# without move_count a route still needs someone to trade times with
r = J(runner.apply_wave, {'day': D, 'name': mover['name'], 'wave': w1})
ok(not r.get('ok') and 'trades times' in r.get('message', ''), 'no swap, no move_count: refused')

r = J(runner.apply_wave, {'day': D, 'name': mover['name'], 'wave': w1, 'move_count': True, 'note': 'to match Amazon'})
ok(r.get('ok'), 'moved with move_count')
d1 = next(d for d in r['days'] if d['day'] == D)
ok(d1['waves'][w0] == waves[w0] - 1 and d1['waves'][w1] == waves[w1] + 1, f'counts moved: {d1["waves"]}')
ok(d1['routes'] == day['routes'], 'the day keeps its total')
ok(d1['routes_filled'] == day['routes_filled'], 'same number of routes filled')
cells1 = {x['name']: dict(x['cells']) for x in r['drivers']}
ok(cells1[mover['name']][D] == w1, 'the driver is in the new wave')
changed = [(n, dd) for n, c in cells1.items() for dd, v in c.items() if cells0.get(n, {}).get(dd) != v]
ok(changed == [(mover['name'], D)], f'nothing else changed: {changed}')
want = f"Moved {mover['name']} {D} {w0} -> {w1} to match Amazon (routes {w0} {waves[w0]}->{waves[w0] - 1}, {w1} {waves[w1]}->{waves[w1] + 1})"
ok(r['edits'][-1] == want, 'logged: ' + r['edits'][-1])
ok(not any(e.startswith('WAVE ') for e in r['check']['errors']), 'no wave errors')

# saved and read back (the Live board's save) keeps it
st2 = J(runner.export_state)['state']
r2 = J(runner.load_state, {'state': st2, 'out': os.path.join(tmp, 'live.xlsx')})
d2 = next(d for d in r2['days'] if d['day'] == D)
ok(d2['waves'] == d1['waves'] and next(x for x in r2['drivers'] if x['name'] == mover['name'])['cells'][D] == w1,
   'export/load keeps the move')

# undo puts it back (one step)
r = J(runner.apply_wave, {'day': D, 'name': mover['name'], 'wave': w0, 'move_count': True})
ok(r.get('ok') and next(d for d in r['days'] if d['day'] == D)['waves'] == waves, 'moved back, counts back')
r = last = J(runner.undo_last)
ok(next(d for d in r['days'] if d['day'] == D)['waves'] == d1['waves'], 'undo: one step back')

# same wave / unknown wave refused
ok(not J(runner.apply_wave, {'day': D, 'name': mover['name'], 'wave': w1, 'move_count': True}).get('ok'), 'already there: refused')
ok(not J(runner.apply_wave, {'day': D, 'name': mover['name'], 'wave': '9:99 AM', 'move_count': True}).get('ok'), 'unknown wave refused')
ok(not J(runner.apply_wave, {'day': D, 'name': mover['name'], 'wave': 'soon', 'move_count': True}).get('ok'), 'junk wave refused')
ok(not J(runner.apply_wave, {'day': D, 'name': mover['name'], 'wave': '12:35 PM'}).get('ok'), 'a new start time needs move_count')

# a start time the day has no wave at yet (Jose 2026-10-29): the wave is added, the count goes along
r = J(runner.apply_wave, {'day': D, 'name': mover['name'], 'wave': '12:35 PM', 'move_count': True})
dn = next(d for d in r['days'] if d['day'] == D) if r.get('ok') else {}
ok(r.get('ok') and dn['waves'].get('12:35 PM') == 1 and dn['waves'][w1] == d1['waves'][w1] - 1
   and dn['routes'] == day['routes'], f'new wave added with the count: {dn.get("waves")}')
ok(r.get('ok') and not any(e.startswith('WAVE ') for e in r['check']['errors']), 'new wave: no wave errors')
J(runner.undo_last)

# the count doesn't fit (Fri 10-23 "has no 10:45 AM route count"): a wave with fewer routes
# than drivers -- the mover was an extra, so no count goes along and the move still works
import runner as _r  # noqa: E402
_r._STATE['res'].waves[D][w1] = 0                                     # like a board whose count was never set
r = J(runner.apply_wave, {'day': D, 'name': mover['name'], 'wave': w0, 'move_count': True})
dz = next(d for d in r['days'] if d['day'] == D) if r.get('ok') else {}
ok(r.get('ok') and dz['waves'][w1] == 0 and dz['waves'][w0] == d1['waves'][w0],
   f'over-filled wave: moves as an extra, counts stay: {dz.get("waves")}')
ok(r.get('ok') and 'an extra route' in r['edits'][-1], 'logged as an extra: ' + (r.get('edits') or ['-'])[-1])
J(runner.undo_last)
_r._STATE['res'].waves[D][w1] = d1['waves'][w1]

# wave_options says whether the count goes along
wo = J(runner.wave_options, {'day': D, 'name': mover['name']})
ok(wo.get('ok') and wo['carry'] is True and all('count' in w and 'filled' in w for w in wo['waves']), 'wave_options: carry + counts')

# a training pair is refused (it can't be split)
pair = next(((dd, x) for x in r0['drivers'] for dd, v in x['cells'].items() if 'TRAIN drives' in (v or '')), None)
if pair:
    dd, x = pair
    other = next((w for w in next(d for d in r0['days'] if d['day'] == dd)['waves'] if not x['cells'][dd].startswith(w)), None)
    if other:
        r = J(runner.apply_wave, {'day': dd, 'name': x['name'], 'wave': other, 'move_count': True})
        ok(not r.get('ok') and 'training' in r.get('message', ''), 'trainee refused: ' + r.get('message', ''))
else:
    print('  (no training pair in the fixture week)')

# a backup with move_count just relabels (backups don't count toward routes)
bk = next(((d['day'], x) for d in r0['days'] if d['open'] and len(d['waves']) >= 2
           for x in r0['drivers'] if 'Backup' in (x['cells'].get(d['day']) or '')), None)
if bk:
    bd, x = bk
    bw = dict(next(d for d in last['days'] if d['day'] == bd)['waves'])
    tgt = next(w for w in bw if not x['cells'][bd].startswith(w))
    rb = J(runner.apply_wave, {'day': bd, 'name': x['name'], 'wave': tgt, 'move_count': True})
    ok(rb.get('ok') and next(d for d in rb['days'] if d['day'] == bd)['waves'] == bw, 'backup relabels, counts stay')

if fails:
    print(f'\n{len(fails)} FAILED')
    sys.exit(1)
print('\nALL PASS')
