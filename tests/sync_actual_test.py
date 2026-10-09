#!/usr/bin/env python3
"""Route Tracker -> the schedule (Jose 2026-10-08).

Part A: a day that already has real hours (h_act) is not counted twice by the
edit rules (no "~20h" 12h-lock, no false 6th day); days without real hours give
exactly the same answers as before (checked against runner.py at a3f57d9, before the fix).
Part B: runner.sync_actual adds Route Tracker's routes / backups on blank cells,
reports everything else, takes back off only what it added, survives
export/load, and stays off the dispatcher's undo stack.

Run:  python tests/gen_fixtures.py   (once)  then  python tests/sync_actual_test.py
"""
import datetime
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SOLVER = os.path.join(HERE, '..', 'public', 'solver')
sys.path.insert(0, SOLVER)
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
ST = J(runner.export_state)['state']
DATE = {d['day']: d['date'] for d in built['days']}
OPEN = [d['day'] for d in built['days'] if d['open']]
cells = lambda r: {d['name']: d['cells'] for d in r['drivers']}  # noqa: E731
C0 = cells(built)


def drv(rep, name):
    return next(x for x in rep['drivers'] if x['name'] == name)


def day(rep, d):
    return next(x for x in rep['days'] if x['day'] == d)


def blank(name, d):
    return C0[name][d] == ''


def key(name):
    t = name.lower().split()
    return f'{t[0]}|{t[-1]}'


def E(name, d, role, **kw):
    return dict(name=name, keys=[key(name)], tid='', date=DATE[d], role=role, **kw)


def load(slot, actual=None):
    runner.use_slot(slot)
    return J(runner.load_state, {'state': ST, 'out': os.path.join(tmp, slot + '.xlsx'), 'actual': actual})


# ---------------------------------------------------------------- Part A ----
print('Part A: a day with real hours is not counted twice')
# someone with 4 scheduled worked days, a blank open day, and a backup day
pa = next(r for r in built['drivers']
          if len([v for v in r['cells'].values() if v and v != 'Unavailable']) == 4
          and any(r['cells'][d] == '' for d in OPEN) and r['backup_days']
          and not any('TRAIN' in v for v in r['cells'].values()))
free = next(d for d in OPEN if pa['cells'][d] == '')
bkd = pa['backup_days'][0]
actual = [{'name': pa['name'], 'keys': [key(pa['name'])], 'tid': '',
           'days': {DATE[free]: 9, DATE[bkd]: 11}}]
live = load('live', actual)
ok(live['ok'], f"load_state with {pa['name']}'s real hours ({free} 9h unscheduled, {bkd} 11h backup)")
opt = J(runner.add_options, {'name': pa['name']})
road = next(x for x in opt['days'] if x['day'] == free)['road']
ok(not any('on the clock' in r for r in road['reasons']),
   f"a {free} route is not locked by 9h + 10h: {road['reasons']}")
ok(not any('6th worked day' in r for r in road['reasons']),
   f"the real {free} shift is not counted as a 6th day: {road['reasons']}")
ok(road['status'] != 'blocked', f"a {free} route can be given ({road['status']})")
m = J(runner.set_role, {'name': pa['name'], 'day': bkd, 'to': 'road', 'confirm_limits': True,
                        'confirm_unavailable': True})
ok(m.get('ok'), f"backup -> route on {bkd} (11h real) is not locked by ~21h: {m.get('message', '')[:160]}")
if m.get('ok'):
    ok(drv(m, pa['name'])['day_hours'][DATE[bkd]] == 11, f'{bkd} still shows the real 11h')

# days WITHOUT real hours: exactly what runner.py said before this fix (commit a3f57d9)
try:
    src = subprocess.run(['git', 'show', 'a3f57d9:public/solver/runner.py'], cwd=HERE,
                         capture_output=True, text=True, encoding='utf-8', check=True).stdout
    hp = os.path.join(tmp, 'runner_head.py')
    open(hp, 'w', encoding='utf-8').write(src)
    spec = importlib.util.spec_from_file_location('runner_head', hp)
    old = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(old)
except Exception as e:  # noqa: BLE001
    old = None
    print(f'  skip same-as-before check (runner.py at a3f57d9 not found: {e})')
if old is not None:
    load('live', actual)
    old._STATE = runner._STATE
    res = runner._STATE['res']
    diff, n = [], 0
    for dr in res.roster:
        for d in res.DAYS:
            if res.DATEALL[d] in (dr.get('h_act') or {}):
                continue
            for role in ('road', 'backup', 'dispatch', 'meeting', 'trainer'):
                n += 1
                if runner._assess(res, dr, d, role) != old._assess(res, dr, d, role):
                    diff.append((dr['name'], d, role))
    ok(not diff and n > 100, f'{n} checks on days without real hours: same as before {diff[:3]}')
    _, pdr = runner._find(res, pa['name'])
    was = old._assess(res, pdr, free, 'road')[1]
    ok(any('on the clock' in r for r in was) and any('6th worked day' in r for r in was),
       f'(the old rules did lock it: {[r for r in was if "clock" in r or "6th" in r]})')

print('Part A: TODAY is not final - every check runs, the day counted once')
runner.use_slot('live')
J(runner.load_state, {'state': ST, 'out': os.path.join(tmp, 'live.xlsx'), 'actual': actual,
                      'today': DATE[free]})
opt = J(runner.add_options, {'name': pa['name']})
road = next(x for x in opt['days'] if x['day'] == free)['road']
ok(not any('on the clock' in r or '6th worked day' in r for r in road['reasons']),
   f"today {free} (9h so far): a route counts max(9, 10)h and the day once: {road['reasons']}")

# a backup today (Route Tracker shows 2h at once) turned into a route: the 60h lock still holds
tb = next(r for r in built['drivers'] if 'Backup' in r['cells']['Sat'] and len(r['road_days']) == 3
          and any(r['cells'][d] == '' for d in OPEN if d != 'Sat'))
tb_free = next(d for d in OPEN if d != 'Sat' and tb['cells'][d] == '')


def today_case(per_road, extra_day, today):
    days = {DATE[d]: per_road for d in tb['road_days']}
    days[DATE[tb_free]] = extra_day
    days[DATE['Sat']] = 2
    runner.use_slot('live')
    J(runner.load_state, {'state': ST, 'out': os.path.join(tmp, 'live.xlsx'), 'today': today,
                          'actual': [{'name': tb['name'], 'keys': [key(tb['name'])], 'tid': '', 'days': days}]})
    return J(runner.set_role, {'name': tb['name'], 'day': 'Sat', 'to': 'road', 'confirm_limits': True})


lock = today_case(13, 13, DATE['Sat'])                       # 4 x 13 + max(2, 10) = 62h
ok(not lock.get('ok') and lock.get('kind') == 'compliance' and '62h in 7 days' in lock.get('message', ''),
   f"today's 2h backup -> route: still locked at 62h in 7 days ({lock.get('message', '')[:90]})")
ok(next(x for x in J(runner.add_options, {'name': tb['name']})['days'] if x['day'] == 'Sat')['current'] == 'backup',
   'the backup stays when locked')
fine = today_case(12, 13, DATE['Sat'])                       # 3 x 12 + 13 + 10 = 59h (double count: 61h)
ok(fine.get('ok'), f"59h in 7 days: allowed, today counted once ({fine.get('message', '')[:90]})")
past = today_case(13, 13, (datetime.date.fromisoformat(DATE['Sat']) + datetime.timedelta(days=1)).isoformat())
ok(past.get('ok'), f"the same day once it is over: a plan change, the clock stays ({past.get('message', '')[:90]})")
if past.get('ok'):
    ok(drv(past, tb['name'])['day_hours'][DATE['Sat']] == 2, 'a past day keeps its real 2h')

# ---------------------------------------------------------------- Part B ----
print('Part B: sync_actual')
live = load('live')
TODAY = DATE['Thu']
# a route slot opened by a call-out, so one Route Tracker route fills it (not an extra)
vic = next(r['name'] for r in live['drivers']
           if 'Mon' in r['road_days'] and 'TRAIN' not in r['cells']['Mon'])
vic_wave = C0[vic]['Mon']
mk = J(runner.apply_mark, {'name': vic, 'day': 'Mon', 'kind': 'callout'})
ok(mk['ok'] and mk['can_undo'], f'{vic} called out Mon ({vic_wave} slot open)')
n_edits = len(mk['edits'])

names = [r['name'] for r in live['drivers']]
fill_mon = next(x for x in names if blank(x, 'Mon') and x != vic)
bk_sun = next(x for x in names if blank(x, 'Sun'))
road_wed = next(x for x in names if blank(x, 'Wed') and x not in (fill_mon,))
nostart = next(x for x in names if blank(x, 'Tue') and x not in (fill_mon, road_wed))
future = next(x for x in names if blank(x, 'Sat'))
unav = next((x, d) for x in names for d in OPEN if C0[x][d] == 'Unavailable' and DATE[d] <= TODAY)
meet = next(((x, d) for x in names for d in OPEN if 'Meeting' in C0[x][d] and DATE[d] <= TODAY), None)
train = next((x, d) for x in names for d in OPEN if 'TRAIN' in C0[x][d] and DATE[d] <= TODAY)
on_road = next((x, d) for x in names for d in OPEN if DATE[d] <= TODAY and d != 'Mon'
               and C0[x][d] and 'Backup' not in C0[x][d] and 'TRAIN' not in C0[x][d]
               and 'Meeting' not in C0[x][d] and C0[x][d] not in ('Unavailable', 'Dispatch'))
on_bk = next((x, d) for x in names for d in OPEN if DATE[d] <= TODAY and 'Backup' in C0[x][d]
             and x != on_road[0])
same = next((x, d) for x in names for d in OPEN if DATE[d] <= TODAY and d != 'Mon'
            and C0[x][d] and 'Backup' not in C0[x][d] and 'TRAIN' not in C0[x][d]
            and 'Meeting' not in C0[x][d] and C0[x][d] not in ('Unavailable', 'Dispatch')
            and (x, d) != on_road)
waves = lambda d: sorted(built['days'][[x['day'] for x in built['days']].index(d)]['waves'],  # noqa: E731
                         key=runner._mins)
bkwave = {}
for x in names:
    v = C0[x]['Sun']
    if 'Backup' in v:
        bkwave[runner._cell_wave(v)] = bkwave.get(runner._cell_wave(v), 0) + 1
want_bk = max(waves('Sun'), key=lambda t: (bkwave.get(t, 0), -runner._mins(t)))
w_wed = waves('Wed')[-1]
h, mi = divmod(runner._mins(w_wed) + 3, 60)                  # 3 minutes off -> nearest wave

entries = [
    E(bk_sun, 'Sun', 'backup'),
    E(fill_mon, 'Mon', 'road', start=f'{runner._mins(vic_wave) // 60}:{runner._mins(vic_wave) % 60:02d}', code='CX12'),
    E(road_wed, 'Wed', 'road', start=f'{h}:{mi:02d}'),
    E(nostart, 'Tue', 'road'),
    E(future, 'Sat', 'road'),                                   # after today: ignored
    E(vic, 'Mon', 'backup'),                                    # called out
    E(unav[0], unav[1], 'road'),
    E(train[0], train[1], 'road'),
    E(on_bk[0], on_bk[1], 'road'),                             # backup sent out: Amazon's way
    E(same[0], same[1], 'road'),
    dict(name='Nobody Atall', keys=['nobody|atall'], tid='', date=DATE['Mon'], role='road'),
    dict(name='Old Week', keys=[], tid='', date='2020-01-01', role='road'),
]
if meet:
    entries.append(E(meet[0], meet[1], 'road'))
r1 = J(runner.sync_actual, {'today': TODAY, 'entries': entries})
ok(r1.get('ok') and r1.get('changed'), 'sync ran and changed the schedule')
data = r1['data']
got = {(a['name'], a['day']): a for a in data['applied']}
ok(set(got) == {(bk_sun, 'Sun'), (fill_mon, 'Mon'), (road_wed, 'Wed'), (nostart, 'Tue')},
   f"applied exactly the 4 blank cells: {sorted(got)}")
c1 = cells(r1)
ok(c1[bk_sun]['Sun'] == want_bk + ' Backup', f"backup in the day's most common backup wave ({c1[bk_sun]['Sun']})")
ok(c1[fill_mon]['Mon'] == vic_wave and not got[(fill_mon, 'Mon')]['extra'],
   f'route start = wave {vic_wave}: fills the open slot, not an extra')
ok(day(r1, 'Mon')['routes'] == day(built, 'Mon')['routes'], 'Mon route count unchanged')
ok(got[(fill_mon, 'Mon')]['code'] == 'CX12', 'route code carried')
ok(c1[road_wed]['Wed'] == w_wed and got[(road_wed, 'Wed')]['extra'],
   f'start 3 min off -> nearest wave {w_wed}; full wave -> EXTRA')
ok(day(r1, 'Wed')['routes'] == day(built, 'Wed')['routes'] + 1, 'Wed is one route more')
ok(c1[nostart]['Tue'] == waves('Tue')[0], f'no start -> earliest wave ({c1[nostart]["Tue"]})')
ok(c1[future]['Sat'] == '', 'a date after today is not applied')
ok(data['ignored'] == 2, f"future + other-week entries ignored ({data['ignored']})")
others = [(x, d) for x in names for d in OPEN if (x, d) not in got and not (x == vic and d == 'Mon')]
ok(all(c1[x][d] == C0[x][d] for x, d in others), 'nobody else lost or changed a cell')

sk = {(s['name'], s['day']): s for s in data['skipped']}
ok(sk[(vic, 'Mon')]['kind'] == 'mark' and 'called out' in sk[(vic, 'Mon')]['reason'],
   f"called out -> {sk[(vic, 'Mon')]['reason']}")
ok(sk[unav]['kind'] == 'unavailable' and sk[unav]['reason'] in
   ('asked for the day off', 'standing day off (from preferences)'), f"Unavailable -> {sk[unav]['reason']}")
ok(sk[train]['kind'] == 'training', f"training -> {sk[train]['reason']}")
if meet:
    ok(sk[meet]['kind'] == 'duty', f"meeting -> {sk[meet]['reason']}")
ok(sk[on_bk]['kind'] == 'agree' and 'sent out' in sk[on_bk]['reason'],
   f"backup vs RT route -> agree ({sk[on_bk]['reason']})")
ok(sk[same]['kind'] == 'agree', f"same role -> {sk[same]['reason']}")
ok(sk[('Nobody Atall', 'Mon')]['kind'] == 'unmatched', 'unknown name reported as unmatched')
ok(all({'name', 'date', 'day', 'cell', 'role', 'reason', 'code'} <= set(s) for s in data['skipped']),
   'skipped rows carry name/date/day/cell/role/reason/code')

new = r1['edits'][n_edits:]
ok(len(new) == 4 and all('added from Route Tracker' in x for x in new), f'one log line per add: {new[:1]}')
ok(f"{bk_sun}: backup {want_bk} on Sun added from Route Tracker" in new[0] or
   any(x.startswith(f"{bk_sun}: backup {want_bk} on Sun added from Route Tracker") for x in new),
   'worded for Jose')

# dispatch duty skip (needs a set_duty first)
sd, dd = {}, None
for x, d in [(x, d) for x in names for d in OPEN if DATE[d] <= TODAY and c1[x][d] == ''
             and x not in (bk_sun, fill_mon, road_wed, nostart)]:
    sd = J(runner.set_duty, {'name': x, 'day': d, 'kind': 'dispatch', 'confirm_limits': True,
                             'confirm_unavailable': True})
    if sd.get('ok'):
        dd = (x, d)
        break
ok(sd.get('ok'), f'{dd} on dispatch')
r1b = J(runner.sync_actual, {'today': TODAY, 'entries': entries + [E(dd[0], dd[1], 'road')]})
s = next(x for x in r1b['data']['skipped'] if (x['name'], x['day']) == dd)
ok(s['kind'] == 'duty' and 'dispatch' in s['reason'], f"dispatch -> {s['reason']}")

print('  idempotent')
r2 = J(runner.sync_actual, {'today': TODAY, 'entries': entries})
ok(r2['ok'] and r2['changed'] is False and not r2['data']['applied'], 'second identical call: changed false')
ok(r2['edits'] == r1b['edits'], 'no new log lines')

print('  undo stays the dispatcher\'s')
u = J(runner.undo_last)                    # undoes the dispatch duty (the last human edit)
cu = cells(u)
ok(cu[dd[0]][dd[1]] == '', 'undo took back the dispatch duty')
ok(all(cu[x][d] == c1[x][d] for (x, d) in got), 'the Route Tracker adds survived the undo')
ok(sum('added from Route Tracker' in x for x in u['edits']) == 4, 'and so did their log lines')
u2 = J(runner.undo_last)                   # undoes the call-out
cu2 = cells(u2)
ok(cu2[vic]['Mon'] == vic_wave, f'undo puts {vic} back on Mon')
ok(cu2[fill_mon]['Mon'] == vic_wave and all(cu2[x][d] == c1[x][d] for (x, d) in got),
   'the Route Tracker adds are still there')
ok(day(u2, 'Mon')['routes'] == day(built, 'Mon')['routes'] + 1 and day(u2, 'Mon')['routes_filled'] == day(u2, 'Mon')['routes'],
   'in that snapshot the Mon add is an extra route (count +1, no overfill)')
ok(not u2['can_undo'], 'nothing left to undo: sync never pushed an undo step')
ok(runner._STATE['rt'][(runner.norm(fill_mon), 'Mon')]['extra'] is True, 'provenance knows it is an extra now')

print('  Route Tracker drops entries')
keep = [e for e in entries if e['name'] not in (bk_sun, fill_mon)
        and (e['name'], e['date']) != (vic, DATE['Mon'])]   # vic Mon: back on the route after the undo (Part C)
r3 = J(runner.sync_actual, {'today': TODAY, 'entries': keep})
rm = {(x['name'], x['day']) for x in r3['data']['removed']}
ok(rm == {(bk_sun, 'Sun'), (fill_mon, 'Mon')}, f'removed exactly what sync added and RT dropped: {sorted(rm)}')
c3 = cells(r3)
ok(c3[bk_sun]['Sun'] == '' and c3[fill_mon]['Mon'] == '', 'cells blank again')
ok(day(r3, 'Mon')['routes'] == day(built, 'Mon')['routes'], 'the extra Mon route went with it')
ok(any(x == f"{bk_sun}: backup {want_bk} on Sun removed (no longer in Route Tracker)" for x in r3['edits']),
   'removal logged')
ok(c3[vic]['Mon'] == vic_wave, 'a scheduled shift RT never had is untouched')

print('  a human changed it')
hm = J(runner.set_role, {'name': road_wed, 'day': 'Wed', 'to': 'backup'})
ok(hm.get('ok'), f'{road_wed} Wed route -> backup by hand')
keep2 = [e for e in keep if e['name'] != road_wed]
r4 = J(runner.sync_actual, {'today': TODAY, 'entries': keep2})
ok(not r4['data']['removed'] and 'Backup' in cells(r4)[road_wed]['Wed'], 'a cell a human changed is not removed')
ok((runner.norm(road_wed), 'Wed') not in runner._STATE['rt'], 'and is no longer remembered as ours')

print('  removed by hand, still in Route Tracker (no flip-flop)')
hr = J(runner.apply_edit, {'day': 'Tue', 'role': 'road', 'from_name': nostart})
ok(hr.get('ok') and cells(hr)[nostart]['Tue'] == '', f'{nostart} Tue route removed by hand')
r5 = J(runner.sync_actual, {'today': TODAY, 'entries': keep2})
s5 = next((x for x in r5['data']['skipped'] if (x['name'], x['day']) == (nostart, 'Tue')), None)
ok(s5 and s5['reason'] == runner.RT_OFF_WHY and cells(r5)[nostart]['Tue'] == '',
   'not added back; reported "removed by hand on the schedule - still in Route Tracker"')
ok(r5['changed'], 'the bookkeeping change is reported (so it gets saved)')
r5b = J(runner.sync_actual, {'today': TODAY, 'entries': keep2})
ok(not r5b['changed'] and cells(r5b)[nostart]['Tue'] == '', 'stays off on the next call')
keep3 = [e for e in keep2 if e['name'] != nostart]
J(runner.sync_actual, {'today': TODAY, 'entries': keep3})
ok((runner.norm(nostart), 'Tue', 'road') not in runner._STATE['rt_off'], 'RT let go -> forgotten')
r6 = J(runner.sync_actual, {'today': TODAY, 'entries': keep2})
ok(cells(r6)[nostart]['Tue'] != '', 'RT has it again later -> added again')

print('  export / load keeps provenance')
hr2 = J(runner.apply_edit, {'day': 'Tue', 'role': 'road', 'from_name': nostart})
keep4 = keep2 + [E(bk_sun, 'Sun', 'backup')]                   # RT has it again -> ours again
ra = J(runner.sync_actual, {'today': TODAY, 'entries': keep4})  # + nostart Tue -> rt_off
ok(cells(ra)[bk_sun]['Sun'] != '' and cells(ra)[nostart]['Tue'] == '', 'set up: one add, one hand removal')
st = J(runner.export_state)['state']
rt_before, off_before = dict(runner._STATE['rt']), set(runner._STATE['rt_off'])
runner.use_slot('live-reload')
J(runner.load_state, {'state': st, 'out': os.path.join(tmp, 'r.xlsx')})
ok(runner._STATE['rt'] == rt_before and (runner.norm(bk_sun), 'Sun') in runner._STATE['rt'],
   'provenance survives export_state -> load_state')
ok(runner._STATE['rt_off'] == off_before and (runner.norm(nostart), 'Tue', 'road') in runner._STATE['rt_off'],
   'rt_off survives too')
r7 = J(runner.sync_actual, {'today': TODAY, 'entries': keep4})
ok(r7['changed'] is False, 'reloaded week + same entries: changed false')
r9 = J(runner.sync_actual, {'today': TODAY, 'entries': keep2})
ok([x['name'] for x in r9['data']['removed']] == [bk_sun] and cells(r9)[bk_sun]['Sun'] == '',
   f"after reload, RT dropping {bk_sun} removes it (provenance was kept)")
ok(not r9['can_undo'], 'sync after load: still nothing on the undo stack')

# ---------------------------------------------------------------- Part C ----
print('Part C: a scheduled route, Route Tracker has a backup -> made a backup (Jose 2026-10-08)')
plain = lambda x, d: bool(C0[x][d]) and runner._cell_wave(C0[x][d]) == C0[x][d]  # noqa: E731
CNT = lambda rep, d: tuple(day(rep, d)[k] for k in ('routes', 'routes_filled', 'backup', 'backup_filled'))  # noqa: E731
bkt = next(x for x in names if 'Backup' in C0[x]['Tue'])            # called out below: an open backup slot
th = next(x for x in names if plain(x, 'Thu') and x != bkt)        # today
ps = next(x for x in names if plain(x, 'Tue') and x not in (th, bkt))  # a past day (an open backup slot)
dp = next(x for x in names if plain(x, 'Wed') and x not in (th, ps, bkt))
mo = next(x for x in names if plain(x, 'Mon') and x not in (th, ps, dp, bkt))
fu = next(x for x in names if plain(x, 'Sat'))                       # after today
trn = next((x, d) for x in names for d in OPEN if 'TRAIN' in C0[x][d] and DATE[d] <= TODAY and x != bkt)
load('swap')
mkc = J(runner.apply_mark, {'name': bkt, 'day': 'Tue', 'kind': 'callout'})   # a human edit: an undo step
ok(mkc['ok'] and day(mkc, 'Tue')['backup_filled'] == day(built, 'Tue')['backup_filled'] - 1,
   f'{bkt} (a Tue backup) called out: one open backup slot Tue')
B = {d: CNT(mkc, d) for d in ('Mon', 'Tue', 'Wed', 'Thu')}
n0 = len(mkc['edits'])
ents = [E(th, 'Thu', 'backup'), E(ps, 'Tue', 'backup', code='BK1'), E(dp, 'Wed', 'backup'),
        E(mo, 'Mon', 'backup'), E(fu, 'Sat', 'backup'), E(trn[0], trn[1], 'backup')]
rc = J(runner.sync_actual, {'today': TODAY, 'entries': ents})
ok(rc.get('ok') and rc.get('changed'), 'sync ran and changed the schedule')
ap = {(a['name'], a['day']): a for a in rc['data']['applied']}
ok(set(ap) == {(th, 'Thu'), (ps, 'Tue'), (dp, 'Wed'), (mo, 'Mon')} and all(a['kind'] == 'swap' for a in ap.values()),
   f'route -> backup on today + past days, nothing else: {sorted(ap)}')
cc = cells(rc)
for x, d in ap:
    ok(cc[x][d] == C0[x][d] + ' Backup', f'{x} {d}: {C0[x][d]!r} -> {cc[x][d]!r} (same wave)')
r_, rf, b_, bf = B['Thu']
full = bf >= b_
ok(CNT(rc, 'Thu') == (r_ - 1, rf - 1, b_ + (1 if full else 0), bf + 1),
   f"Thu: one route fewer, no open route; backups {'full -> one more backup' if full else 'had room'} {B['Thu']} -> {CNT(rc, 'Thu')}")
r_, rf, b_, bf = B['Tue']
ok(CNT(rc, 'Tue') == (r_ - 1, rf - 1, b_, bf + 1), f"Tue: the open backup slot is filled, backup need unchanged {B['Tue']} -> {CNT(rc, 'Tue')}")
ok(not ap[(ps, 'Tue')]['extra'] and ap[(ps, 'Tue')]['code'] == 'BK1', 'Tue: not an extra backup, code carried')
w_th = C0[th]['Thu']
line = (f"{th}: Thu {w_th} route made a backup from Route Tracker (no route from Amazon; Thu is now "
        f"{B['Thu'][0] - 1} routes{'; one more backup than planned' if full else ''})")
new = rc['edits'][n0:]
ok(len(new) == 4 and line in new, f'one log line per change, worded for Jose: {line!r}')
ok(cc[fu]['Sat'] == C0[fu]['Sat'], 'a date after today is untouched')
s_tr = next(x for x in rc['data']['skipped'] if (x['name'], x['day']) == trn)
ok(s_tr['kind'] in ('training', 'conflict') and cc[trn[0]][trn[1]] == C0[trn[0]][trn[1]],
   f"training cell left alone, reported ({s_tr['kind']}: {s_tr['reason']})")
ok(rc['can_undo'] and len(runner._STATE['undo']) == 1, 'not on the undo stack (only the call-out is)')
pv = runner._STATE['rt'][(runner.norm(th), 'Thu')]
ok(pv['kind'] == 'swap' and pv['orig'] == w_th and pv['cut'] is True and pv['bkx'] is full,
   f'provenance keeps the original cell + the count changes: {pv}')

print('  idempotent')
rc2 = J(runner.sync_actual, {'today': TODAY, 'entries': ents})
ok(rc2['changed'] is False and not rc2['data']['applied'] and rc2['edits'] == rc['edits'],
   'second identical call: changed false, no new lines')
ok(not any((x['name'], x['day']) == (th, 'Thu') for x in rc2['data']['skipped'] if x['kind'] == 'conflict'),
   'no longer reported as a conflict')

print('  undo stays the dispatcher\'s')
uc = J(runner.undo_last)                                             # takes back the call-out
cu = cells(uc)
ok(cu[bkt]['Tue'] == C0[bkt]['Tue'] and all(cu[x][d] == cc[x][d] for x, d in ap),
   'undo put the called-out backup back; the route -> backups stayed')
r_, rf, b_, bf = CNT(built, 'Tue')
ok(CNT(uc, 'Tue') == (r_ - 1, rf - 1, b_ + 1, bf + 1),
   f"in that snapshot Tue's backups were full: one more backup there {CNT(uc, 'Tue')}")
ok(runner._STATE['rt'][(runner.norm(ps), 'Tue')]['bkx'] is True and not uc['can_undo'],
   'provenance follows the snapshot; nothing left to undo')

print('  Route Tracker has a route now / drops it -> put back exactly')
ents2 = [E(th, 'Thu', 'road'), E(dp, 'Wed', 'backup'), E(mo, 'Mon', 'backup')]  # ps Tue gone
rr = J(runner.sync_actual, {'today': TODAY, 'entries': ents2})
rm = {(x['name'], x['day']): x for x in rr['data']['removed']}
ok(set(rm) == {(th, 'Thu'), (ps, 'Tue')} and all(x['kind'] == 'swap' for x in rm.values()),
   f'put back exactly those two: {sorted(rm)}')
cr = cells(rr)
ok(cr[th]['Thu'] == C0[th]['Thu'] and cr[ps]['Tue'] == C0[ps]['Tue'], 'the original route cells are back')
ok(CNT(rr, 'Thu') == CNT(built, 'Thu') and CNT(rr, 'Tue') == CNT(built, 'Tue'),
   f"route + backup counts as they were (Thu {CNT(rr, 'Thu')}, Tue {CNT(rr, 'Tue')})")
ok(f"{th}: Thu back on the {w_th} route — Route Tracker has a route now" in rr['edits'], 'route-now revert logged')
ok(f"{ps}: Tue back on the {C0[ps]['Tue']} route — no longer a backup in Route Tracker" in rr['edits'],
   'dropped revert logged')
ok(not any((x['name'], x['day']) == (th, 'Thu') and x['kind'] != 'agree' for x in rr['data']['skipped']),
   'the route it went back to agrees with Route Tracker')

print('  a human changed it (no flip-flop)')
hc = J(runner.set_role, {'name': dp, 'day': 'Wed', 'to': 'road', 'confirm_limits': True, 'confirm_unavailable': True})
ok(hc.get('ok'), f"{dp}'s Wed backup made a route by hand ({hc.get('message', '')[:80]})")
rh = J(runner.sync_actual, {'today': TODAY, 'entries': ents2})
s_dp = next((x for x in rh['data']['skipped'] if (x['name'], x['day']) == (dp, 'Wed')), None)
ok(not rh['data']['removed'] and not rh['data']['applied'] and cells(rh)[dp]['Wed'] == cells(hc)[dp]['Wed'],
   "a cell a human changed is neither put back nor made a backup again")
ok((runner.norm(dp), 'Wed') not in runner._STATE['rt'] and (runner.norm(dp), 'Wed', 'backup') in runner._STATE['rt_off']
   and s_dp and s_dp['reason'] == runner.RT_OFF_WHY, 'forgotten as ours, remembered in rt_off')
rh2 = J(runner.sync_actual, {'today': TODAY, 'entries': ents2})
ok(rh2['changed'] is False and cells(rh2)[dp]['Wed'] == cells(hc)[dp]['Wed'], 'not redone on the next call')

print('  export / load keeps provenance')
stc = J(runner.export_state)['state']
rt_b = dict(runner._STATE['rt'])
runner.use_slot('swap-reload')
J(runner.load_state, {'state': stc, 'out': os.path.join(tmp, 's.xlsx')})
ok(runner._STATE['rt'] == rt_b and runner._STATE['rt'][(runner.norm(mo), 'Mon')]['kind'] == 'swap',
   'route -> backup provenance survives export_state -> load_state')
rl = J(runner.sync_actual, {'today': TODAY, 'entries': ents2})
ok(rl['changed'] is False, 'reloaded + same entries: changed false')
rl2 = J(runner.sync_actual, {'today': TODAY, 'entries': [E(dp, 'Wed', 'backup')]})   # mo Mon gone
ok([x['name'] for x in rl2['data']['removed']] == [mo] and cells(rl2)[mo]['Mon'] == C0[mo]['Mon']
   and CNT(rl2, 'Mon') == CNT(built, 'Mon'), 'after reload, RT dropping it puts the route back exactly')

print()
print('FAIL: ' + '; '.join(fails) if fails else 'PASS')
sys.exit(1 if fails else 0)
