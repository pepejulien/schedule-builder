#!/usr/bin/env python3
"""The 6-day rebuild (Jose 2026-11-23).

When the normal rules (5 days in 7, tiers, day targets) leave routes or backups open, runner.run
rebuilds the week with six_day_mode: 6 worked days in 7 allowed, every driver treated the same,
but never more than 5 ROAD days in any 7 - so anyone on 6 days has a backup day. It's kept only
when it fills more, a note says so, and the normal limits come back after the build (the Live
board still flags each 6th day; those drivers show as approved).
Run:  python tests/six_day_test.py
"""
import datetime
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'public', 'solver'))
import openpyxl  # noqa: E402
import build_weekly_schedule as B  # noqa: E402
import runner  # noqa: E402

ALL = B.ALL
fails = []
tmp = tempfile.mkdtemp()


def ok(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        fails.append(msg)


def week(tag, names, routes, backups, prev_days, **extra):
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Shifts & Availability'
    ws.append(['Associate Name', 'Transporter ID'] + ALL)
    for i, n in enumerate(names):
        ws.append([n, f'T{i:04d}'] + [''] * 7)
    avail = os.path.join(tmp, f'{tag}-avail.xlsx'); wb.save(avail)
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Shifts & Availability'
    ws.append(['Associate Name', 'Transporter ID'] + ALL)
    for i, n in enumerate(names):
        ws.append([n, f'T{i:04d}'] + ['10:45 AM' if d in prev_days else '' for d in ALL])
    prev = os.path.join(tmp, f'{tag}-prev.xlsx'); wb.save(prev)
    cfg = dict(start_date='2026-08-02', waves={d: {'10:25 AM': routes} for d in ALL},
               backup_per_day={d: backups for d in ALL}, max_primary_days=5, weekly_hours_cap=None,
               max_total_days=5, free_total_days=4, prev_week_file=prev, avail_file=avail,
               out=os.path.join(tmp, f'{tag}-out.xlsx'), weekend_spread=False, strict_names=False,
               reduced_days={'names': names[:2], 'target': 2})
    cfg.update(extra)
    p = os.path.join(tmp, f'{tag}.json')
    json.dump(cfg, open(p, 'w', encoding='utf-8'))
    return p


def open_count(rep):
    return sum(max(0, x['routes_need'] - x['routes_got']) + max(0, x['bk_need'] - x['bk_got'])
               for x in rep['days']) if rep['days'] and 'routes_need' in rep['days'][0] else None


print('-- a tight week: everyone worked Thu-Sat last week, 9 routes + 2 backups a day, 14 drivers')
names = [f'Driver {chr(65 + i)} Test' for i in range(14)]
p = week('tight', names, 9, 2, {'Thu', 'Fri', 'Sat'})
rep = json.loads(runner.run(p))
ok(rep.get('ok'), 'build ran')
res = runner._STATE['res']
note = next((n for n in rep['notes'] if n.startswith('6-DAY WEEK') or n.startswith('6-day rebuild')), '')
print('     note:', note[:260])
ok(note.startswith('6-DAY WEEK'), 'the 6-day rebuild was kept (it filled more)')
opened = runner._open_slots(res)
ok('Open now: ' + str(opened) in note, f'the note says how many are open now ({opened})')

ONE = datetime.timedelta(days=1)
six = runner._six_days(res)
ok(len(six) > 0, f'{len(six)} drivers work 6 days in 7')
bad = []
for dr in res.roster:
    road = {res.DATEALL[d] for d in dr['prim'] + dr['helper']} | set(dr['w_prev'])   # last week: all route days
    worked = runner._all_worked(res, dr)
    for dt in [res.DATEALL[d] for d in ALL]:
        for k in range(7):
            a = dt - k * ONE
            win = [a + j * ONE for j in range(7)]
            if sum(1 for x in win if x in road) > 5:
                bad.append((dr['name'], 'road', a))
            if sum(1 for x in win if x in worked) > 6:
                bad.append((dr['name'], 'worked', a))
ok(not bad, f'no one has 6 route days in 7, or 7 worked days in 7 ({bad[:3]})')
ok(all(b >= 1 for _, _, b in six), 'everyone on 6 days has at least one backup day this week')
ok(res.MAX7D == 5 and res.MAXTOT == 5, 'normal limits back after the build (Live board still flags a 6th day)')
ok(all(runner.norm(n) in runner._STATE['ovr_limits'] for n, _, _ in six), "the 6-day drivers' 6th day shows as approved")
ok(not any(e.startswith('DAYS7') for e in rep['check']['errors']), 'no DAYS7 build error left (all approved)')
ok(rep['check']['errors'] == [] or all(not e.startswith(('DAYS7', 'TOTDAYS', 'CONSEC')) for e in rep['check']['errors']),
   f"errors left: {rep['check']['errors'][:3]}")

print('-- an easy week: plenty of drivers, nothing open -> no rebuild')
p = week('easy', [f'Easy {chr(65 + i)} Person' for i in range(30)], 6, 1, set())
rep = json.loads(runner.run(p))
ok(rep.get('ok') and not any('6-DAY' in n or '6-day rebuild' in n for n in rep['notes']), 'no 6-day rebuild when nothing is open')
ok(not getattr(runner._STATE['res'], 'six_ok', None), 'no 6-day approvals')

print('-- six_day_fallback: false turns it off')
p = week('off', names, 9, 2, {'Thu', 'Fri', 'Sat'}, six_day_fallback=False)
rep = json.loads(runner.run(p))
ok(rep.get('ok') and not any(n.startswith('6-DAY') for n in rep['notes']), 'off when asked')

print('\nall ok' if not fails else f'\n{len(fails)} FAILED')
sys.exit(1 if fails else 0)
