#!/usr/bin/env python3
"""Roster bookmark re-run (Jose 2026-11-12): roster_plan compares the Live board's route
drivers with Amazon's row count and says who goes to backup (too many) or who gets a
route (too few), ranked like "Who can work extra?" then tier; 6 days in 7 with no backup
is offered (unticked). roster_apply makes the ticked changes with the counts following,
one undo step. Training pairs are never touched.

Run:  python tests/gen_fixtures.py   (once)  then  python tests/roster_plan_test.py
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
st = J(runner.export_state)['state']
runner.use_slot('live')
TODAY = '2000-01-01'                      # every day of the fixture week is still to come
r0 = J(runner.load_state, {'state': st, 'out': os.path.join(tmp, 'live.xlsx'), 'today': TODAY})
ok(r0.get('ok'), 'loaded into the live slot')


def kinds(v):
    s = str(v or '')
    if not s or 'TRAIN helper' in s:
        return None
    if 'TRAIN drives' in s:
        return 'trainee'
    if 'Backup' in s:
        return 'backup'
    return 'route' if runner._cell_wave(s) else None


day = max((d for d in r0['days'] if d['open']),
          key=lambda d: sum(1 for x in r0['drivers'] if kinds(x['cells'].get(d['day'])) == 'backup'))
D = day['day']
live = sum(1 for x in r0['drivers'] if kinds(x['cells'].get(D)) in ('route', 'trainee'))
nbk = sum(1 for x in r0['drivers'] if kinds(x['cells'].get(D)) == 'backup')
print(f'{D}: {live} drivers on routes, {nbk} backups, counts {day["waves"]} / {day["backup"]}')

# same count: nothing to balance
p = J(runner.roster_plan, {'day': D, 'rows': live, 'today': TODAY})
ok(p.get('ok') and p['live'] == live and p['diff'] == 0, 'same count: diff 0')
ok(not [c for c in p['changes'] if c['kind'] != 'six'], 'same count: no backup / route changes')
ok(all(not c['checked'] for c in p['changes'] if c['kind'] == 'six'), '6-day offers start unticked')

# no Amazon count: only the 6-day check
p = J(runner.roster_plan, {'day': D, 'rows': None, 'today': TODAY})
ok(p.get('ok') and p['rows'] is None and p['diff'] == 0, 'no count: diff 0')

# 3 too many: 3 route drivers to backup, ticked, never a trainee
p = J(runner.roster_plan, {'day': D, 'rows': live - 3, 'today': TODAY})
bk = [c for c in p['changes'] if c['kind'] == 'backup']
ok(len(bk) == 3 and all(c['checked'] for c in bk), '3 too many: 3 ticked moves to backup')
cell = {x['name']: x['cells'].get(D) for x in r0['drivers']}
ok(all(kinds(cell[c['name']]) == 'route' for c in bk), 'only plain route drivers go to backup')
print('   ', [(c['name'], c['why']) for c in bk])

# the worst-ranked go: recompute the rank order and check the 3 are the 3 at the bottom
ranked = runner._rp_order([runner._rp_info(runner._STATE['res'], runner._STATE['cfg'], dr, D, None)
                 for i, dr in enumerate(runner._STATE['res'].roster)
                 if kinds(runner._STATE['res'].cell[D].get(i)) == 'route'
                 and runner.norm(dr['name']) not in runner._STATE['marks'].get(D, {})])
ok({c['name'] for c in bk} == {x['name'] for x in ranked[::-1][:3]}, 'the 3 at the bottom of the ranking go')

r = J(runner.roster_apply, {'day': D, 'picks': [{'kind': c['kind'], 'name': c['name']} for c in bk], 'today': TODAY})
ok(r.get('ok') and all(x['ok'] for x in r['roster_results']), 'applied the 3')
d1 = next(d for d in r['days'] if d['day'] == D)
ok(d1['routes'] == day['routes'] - 3, f'routes count went down by 3 ({day["routes"]} -> {d1["routes"]})')
ok(d1['backup'] == day['backup'] + 3, 'backups count went up by 3')
ok(all('Backup' in next(x for x in r['drivers'] if x['name'] == c['name'])['cells'][D] for c in bk), 'they are backups now')
ok(sum(1 for e in r['edits'] if 'to match Amazon' in e) == 3, 'one change-log line each')
p2 = J(runner.roster_plan, {'day': D, 'rows': live - 3, 'today': TODAY})
ok(p2['diff'] == 0, 're-run after the change: counts match')
u = J(runner.undo_last)
d2 = next(d for d in u['days'] if d['day'] == D)
ok(d2['routes'] == day['routes'] and d2['backup'] == day['backup'], 'one undo puts all 3 back')

# an EXTRA route made a backup again leaves the counts as they were (Jose 2026-11-14: Enoch's
# extra route made a backup took Sun from 27 routes to 26 and gave it a 6th backup slot)
bkd = next(x['name'] for x in r0['drivers'] if kinds(x['cells'].get(D)) == 'backup')
r = J(runner.set_role, {'day': D, 'name': bkd, 'to': 'road', 'confirm_limits': True, 'confirm_unavailable': True, 'today': TODAY})
if r.get('ok'):
    dx = next(d for d in r['days'] if d['day'] == D)
    ok(dx['routes'] == day['routes'], f'{bkd}: backup -> extra route, count stays {day["routes"]}')
    r = J(runner.roster_apply, {'day': D, 'picks': [{'kind': 'backup', 'name': bkd}], 'today': TODAY})
    ok(r.get('ok') and r['roster_results'][0]['ok'], 'extra route -> backup applied')
    dx = next(d for d in r['days'] if d['day'] == D)
    ok(dx['routes'] == day['routes'] and dx['waves'] == day['waves'], f'route counts unchanged ({dx["routes"]}, {dx["waves"]})')
    ok(dx['backup'] == day['backup'], f'no extra backup slot ({dx["backup"]} == {day["backup"]})')
    J(runner.undo_last)
    J(runner.undo_last)
else:
    ok(False, f'set_role to road refused: {r}')

# 2 too few: 2 backups get a route, best first
p = J(runner.roster_plan, {'day': D, 'rows': live + 2, 'today': TODAY})
rt = [c for c in p['changes'] if c['kind'] == 'route']
ok(len([c for c in rt if c['checked']]) + p['short'] + len([c for c in rt if not c['checked']]) >= 2, '2 too few: 2 offered or short')
ok(all(kinds(cell[c['name']]) == 'backup' for c in rt), 'only backups move up')
print('   ', [(c['name'], c['checked'], c['why']) for c in rt], 'short', p['short'])
if rt:
    r = J(runner.roster_apply, {'day': D, 'picks': [{'kind': 'route', 'name': c['name']} for c in rt if c['checked']], 'today': TODAY})
    ok(r.get('ok') and all(x['ok'] for x in r['roster_results']), 'applied the ticked routes')
    d1 = next(d for d in r['days'] if d['day'] == D)
    filled = sum(1 for x in r['drivers'] if kinds(x['cells'].get(D)) in ('route', 'trainee'))
    ok(filled == live + len([c for c in rt if c['checked']]), 'they drive now')
    ok(d1['routes'] >= filled, f'route count covers them ({d1["routes"]} >= {filled})')
    J(runner.undo_last)

# a change that went stale is refused, nothing else changes
r = J(runner.roster_apply, {'day': D, 'picks': [{'kind': 'route', 'name': 'Nobody Here'}], 'today': TODAY})
ok(r.get('ok') and not r['roster_results'][0]['ok'], 'unknown driver: refused, said why')
ok(not any('to match Amazon' in e for e in r['edits']), 'nothing logged')

# a trainee / trainer is never touched
tr = next((x for x in r0['drivers'] for d in r0['days'] if 'TRAIN' in str(x['cells'].get(d['day']) or '')), None)
if tr:
    td = next(d['day'] for d in r0['days'] if 'TRAIN' in str(tr['cells'].get(d['day']) or ''))
    r = J(runner.roster_apply, {'day': td, 'picks': [{'kind': 'backup', 'name': tr['name']}], 'today': TODAY})
    ok(not r['roster_results'][0]['ok'] and 'training' in r['roster_results'][0]['why'], 'training pair: refused')

# the 6-day check: give a route driver every day, then look
res = runner._STATE['res']
six = None
for i, dr in enumerate(res.roster):
    if kinds(res.cell[D].get(i)) == 'route' and not dr['bk']:
        six = dr
        break
if six:
    for d in res.DAYS:
        if d != D and d not in six['prim'] and runner.norm(six['name']) not in runner._STATE['marks'].get(d, {}):
            six['prim'].append(d)
    rk = runner._six_risk(res, six, D)
    ok(rk is not None and rk['days'] >= 6, f'{six["name"]}: 6+ days in 7 with no backup is a risk ({rk})')
    p = J(runner.roster_plan, {'day': D, 'rows': live, 'today': TODAY})
    c = next((c for c in p['changes'] if c['kind'] == 'six' and c['name'] == six['name']), None)
    ok(c is not None and not c['checked'] and '60 hours' in c['why'], '6-day offered, unticked, says 60 hours')
    if c and c.get('with'):
        r = J(runner.roster_apply, {'day': D, 'picks': [{'kind': 'six', 'name': c['name'], 'with': c['with']}], 'today': TODAY})
        x = r['roster_results'][0]
        ok(x['ok'] and x.get('with_ok'), f'6-day: made a backup and {c["with"]} took the route')
        d1 = next(d for d in r['days'] if d['day'] == D)
        ok(d1['routes'] == day['routes'], 'route count unchanged by a swap')

# overtime is money (Jose 2026-11-12): 3h+ less overtime beats tier; closer, tier wins
def X(name, trank, ot, rank=2):
    return dict(name=name, rank=rank, trank=trank, ot=ot, est=40 + ot)


top, fair = X('Hayden Top', 0, 6.0), X('Shawn Fair', 2, 3.5)
ok(runner._rp_order([top, fair])[0]['name'] == 'Hayden Top', 'OT 6h vs 3.5h (2.5h saved): the Top performer wins')
fair2 = X('Shawn Fair', 2, 1.0)
ok(runner._rp_order([top, fair2])[0]['name'] == 'Shawn Fair', 'OT 6h vs 1h (5h saved): the cheaper driver wins')
ok(runner._rp_order([X('A', 2, 0.0, rank=0), top])[0]['name'] == 'A', 'no overtime beats overtime')
ok(runner._rp_order([X('A', 1, 2.0), X('B', 1, 2.0)])[0]['name'] == 'A', 'same tier, same overtime: by name')

# each driver's own day length: long real days push the estimate up
res = runner._STATE['res']
D2 = res.DAYS[-1]
dr = next(d for d in res.roster if not d['prim'] and not d['bk'] and not d['helper'] and not d['extra'] and not d['meet'])
old = (dict(dr.get('h_act') or {}), dict(dr.get('h_prev') or {}))
first = res.DATEALL[res.DAYS[0]]
dr['h_prev'] = {first - 7 * runner.ONE: 11.5, first - 6 * runner.ONE: 11.5}
dr['h_act'] = {}
ok(abs(runner._rp_avg_day(res, dr) - 11.5) < 0.01, 'usual day length from real clock-outs (11.5h)')
est, avg = runner._rp_est(res, dr, D2)
ok(abs(est - 11.5) < 0.01, f'one route day planned at their own 11.5h ({est})')
dr['h_prev'] = {first - 7 * runner.ONE: 11.5}
ok(runner._rp_avg_day(res, dr) == res.PH, 'fewer than 2 real days: the planned 10h')
dr['h_act'], dr['h_prev'] = old

print('\nFAILED: ' + '; '.join(fails) if fails else '\nall ok')
sys.exit(1 if fails else 0)
