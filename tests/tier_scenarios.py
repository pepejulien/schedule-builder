#!/usr/bin/env python3
"""Scenario tests for the base-floor + layered-upgrade model (Jose 2026-07-19).

Base floor everyone gets first: Top/Solid 3, Fair 2, discipline 1. Then, while
route slots remain, upgrades in order (better rate first): Fair->3, discipline->2,
Top/Solid->4, Fair->4. Light week (below the base) = strict tier (bottom cut,
worst rate first). Backups only to Top/Solid stuck at 3.

Builds a synthetic 60-driver week (all fully available) at controlled volumes.
Run:  python tests/tier_scenarios.py
"""
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..',
                                'driver-schedule-builder skill', 'scripts'))
import openpyxl  # noqa: E402
import build_weekly_schedule as B  # noqa: E402

ALL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
os.makedirs(FIX, exist_ok=True)

N_TOP, N_FAIR, N_DISC = 12, 20, 28
TOP = [f'Top Solid {i:02d}' for i in range(N_TOP)]
FAIR = [f'Fair Driver {i:02d}' for i in range(N_FAIR)]
DISC = [f'Disc Driver {i:02d}' for i in range(N_DISC)]
ALLNAMES = TOP + FAIR + DISC
DISC_RATE = {n: -10 - i * (45 / (N_DISC - 1)) for i, n in enumerate(DISC)}  # -10 best .. -55 worst

# Reference volumes (route-days) for a 60-driver fleet, all available:
BASE = N_TOP * 3 + N_FAIR * 2 + N_DISC * 1      # 104
V_LIGHT = 90                                    # below base -> discipline cut
V_BASE = BASE                                   # 104
V_FAIR3 = BASE + N_FAIR * 1                      # 124 (base + Fair 2->3)
V_DISC2 = V_FAIR3 + N_DISC * 1                   # 152 (+ discipline 1->2)
V_TOP4 = V_DISC2 + N_TOP * 1                     # 164 (+ Top 3->4)
V_FAIR4 = V_TOP4 + N_FAIR * 1                    # 184 (+ Fair 3->4)


def write_avail(path, unavail=None):
    unavail = unavail or {}
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Shifts & Availability'
    ws.append(['Associate Name', 'Transporter ID'] + ALL)
    for i, n in enumerate(ALLNAMES):
        row = [n, f'A{i:05d}']
        for d in ALL:
            row.append('Unavailable' if d in unavail.get(n, []) else '')
        ws.append(row)
    wb.save(path)


def run(total, backup_pct=0.0, unavail=None, exact=None, bk_per_day=None):
    base = total // 7
    rem = total - base * 7
    waves = {}
    for k, d in enumerate(ALL):
        n = base + (1 if k < rem else 0)
        if n <= 0:
            continue
        a = max(n // 4, 1) if n >= 2 else 0
        waves[d] = {'10:25 AM': n - a, '10:45 AM': a} if a else {'10:25 AM': n}
    avail = os.path.join(FIX, '_tier_avail.xlsx'); write_avail(avail, unavail)
    bk = ({'backup_per_day': {d: bk_per_day for d in waves}} if bk_per_day is not None
          else {'backup_pct': backup_pct})
    cfg = {
        'start_date': '2026-08-02', 'waves': waves, **bk,
        'max_primary_days': 4, 'weekly_hours_cap': 40,
        'free_primary_cap': 4, 'free_total_days': 4, 'max_total_days': 5,
        'most_days': TOP,
        'reduced_days': {'target': 2, 'names': DISC, 'prefer_days': ['Sun', 'Sat']},
        'driver_rates': DISC_RATE, 'weekend_spread': False,
        'exact_days': exact or {},
        'prev_week_file': None, 'avail_file': avail,
        'out': os.path.join(FIX, '_tier_out.xlsx'), 'strict_names': True,
    }
    p = os.path.join(FIX, '_tier_cfg.json'); json.dump(cfg, open(p, 'w'))
    cfg = B.load_config(p); res = B.build_schedule(cfg); chk = B.check_invariants(res)
    return res, chk


def days_of(res, n):
    return next(len(dr['prim']) + len(dr['helper']) for dr in res.roster if dr['name'] == n)


def tiers(res):
    d = {dr['name']: len(dr['prim']) + len(dr['helper']) for dr in res.roster}
    return [d[n] for n in TOP], [d[n] for n in FAIR], [d[n] for n in DISC]


def hours_of(res, dr):
    return (len(dr['prim']) + len(dr['helper'])) * 10 + len(dr['bk']) * 2


def _bk_feasible(res, dr, d):
    """Test-side mirror of the solver's backup-day feasibility (no meetings /
    extras / weekend cap in these synthetic fleets)."""
    import datetime
    if d in dr['unav'] or d in dr['prim'] or d in dr['helper']:
        return False
    if len(dr['prim']) + len(dr['helper']) >= 5:
        return False
    ONE = datetime.timedelta(days=1)
    s = ({res.DATEALL[x] for x in list(dr['prim']) + list(dr['helper'])}
         | set(dr['w_prev']) | {res.DATEALL[d]})
    dt = res.DATEALL[d]; n = 1
    c = dt - ONE
    while c in s:
        n += 1; c -= ONE
    c = dt + ONE
    while c in s:
        n += 1; c += ONE
    return n <= 5


def max_serve_top3(res):
    """Independent Kuhn's oracle: the true MAXIMUM number of Top/Solid-at-3
    that could be given a backup within the per-day slot counts. The solver's
    tier-1 fill must match this -- no one stranded by day-choice collisions."""
    cands = [i for i, dr in enumerate(res.roster) if dr['name'] in TOP
             and len(dr['prim']) + len(dr['helper']) == 3]
    assign = {d: [] for d in res.DAYS}

    def place(i, seen):
        dr = res.roster[i]
        for d in res.DAYS:
            if d in seen or not _bk_feasible(res, dr, d):
                continue
            if len(assign[d]) < res.backup[d]:
                assign[d].append(i); return True
        for d in res.DAYS:
            if d in seen or not _bk_feasible(res, dr, d):
                continue
            seen.add(d)
            for j in list(assign[d]):
                assign[d].remove(j)
                if place(j, seen):
                    assign[d].append(i); return True
                assign[d].append(j)
        return False

    return sum(1 for i in cands if place(i, set())), len(cands)


PASS = FAIL = 0
def check(name, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f'  ok  {name}')
    else:
        FAIL += 1; print(f'  XX  {name}  {detail}')


def m(xs):
    return round(statistics.mean(xs), 2)


# --- base floor: everyone gets 3/2/1, nobody at 0 ---
res, chk = run(V_BASE)
top, fair, disc = tiers(res)
print(f'BASE({V_BASE}): top {m(top)} fair {m(fair)} disc {m(disc)} | min disc {min(disc)} | errors {len(chk["errors"])}')
check('base: no errors', not chk['errors'], str(chk['errors'][:3]))
check('base: every Top/Solid >= 3', min(top) >= 3, min(top))
check('base: every Fair >= 2', min(fair) >= 2, min(fair))
check('base: every discipline >= 1 (nobody at 0)', min(disc) >= 1, min(disc))
check('base: discipline not yet upgraded (<=1 avg)', m(disc) <= 1.1, m(disc))

# --- layer order: Fair->3 happens before discipline->2 and before Top->4 ---
res, chk = run(V_FAIR3)
top, fair, disc = tiers(res)
print(f'FAIR3({V_FAIR3}): top {m(top)} fair {m(fair)} disc {m(disc)} | errors {len(chk["errors"])}')
check('fair3: no errors', not chk['errors'])
check('fair3: Fair reached 3', m(fair) >= 2.9, m(fair))
check('fair3: discipline STILL at base 1 (Fair upgraded first)', m(disc) <= 1.15, m(disc))
check('fair3: Top STILL at base 3 (not yet 4)', m(top) <= 3.15, m(top))

res, chk = run(V_DISC2)
top, fair, disc = tiers(res)
print(f'DISC2({V_DISC2}): top {m(top)} fair {m(fair)} disc {m(disc)} | errors {len(chk["errors"])}')
check('disc2: discipline reached 2', m(disc) >= 1.85, m(disc))
check('disc2: Top STILL at 3 (discipline upgraded before Top 4th)', m(top) <= 3.15, m(top))

res, chk = run(V_TOP4)
top, fair, disc = tiers(res)
print(f'TOP4({V_TOP4}): top {m(top)} fair {m(fair)} disc {m(disc)}')
check('top4: Top/Solid reached 4', m(top) >= 3.85, m(top))

res, chk = run(V_FAIR4)
top, fair, disc = tiers(res)
print(f'FAIR4({V_FAIR4}): top {m(top)} fair {m(fair)} disc {m(disc)}')
check('fair4: Fair reached 4', m(fair) >= 3.85, m(fair))

# --- light week: strict tier, discipline cut worst-rate first ---
res, chk = run(V_LIGHT)
top, fair, disc = tiers(res)
by_rate = sorted(DISC, key=lambda n: -DISC_RATE[n])   # best first
better = sum(days_of(res, n) for n in by_rate[:N_DISC // 2])
worse = sum(days_of(res, n) for n in by_rate[N_DISC // 2:])
print(f'LIGHT({V_LIGHT}): top {m(top)} fair {m(fair)} disc {m(disc)} | better-rate disc {better} vs worse {worse} | errors {len(chk["errors"])}')
check('light: no errors', not chk['errors'])
check('light: Top/Solid protected at 3', min(top) >= 3, min(top))
check('light: Fair protected at 2', min(fair) >= 2, min(fair))
check('light: discipline cut', m(disc) < 1.0, m(disc))
check('light: worst-rate discipline cut first', better > worse, f'{better} vs {worse}')

def bktotals(res):
    return (sum(len(dr['bk']) for dr in res.roster if dr['name'] in TOP),
            sum(len(dr['bk']) for dr in res.roster if dr['name'] in FAIR),
            sum(len(dr['bk']) for dr in res.roster if dr['name'] in DISC))

# --- RATE LADDER (Jose 2026-07-20): backups go best-rate-first among drivers
# under 40h. In this fleet Top/Fair have no rates (0 = best) so ties break by
# tier: every Top/Solid-at-3, then Fair; discipline (<2 roads here) ineligible.
res, chk = run(V_LIGHT, bk_per_day=3)
top_bk, fair_bk, disc_bk = bktotals(res)
print(f'BACKUPS: Top/Solid {top_bk}/{N_TOP} | Fair {fair_bk} | discipline {disc_bk} | errors {len(chk["errors"])}')
check('backups: every Top/Solid-at-3 backed before Fair', top_bk == N_TOP, f'top {top_bk}/{N_TOP}')
check('backups: Fair receive the remaining slots (after Top/Solid)', fair_bk > 0, fair_bk)
check('backups: discipline get none (below 2 roads in a light week)', disc_bk == 0, disc_bk)
check('backups: no errors', not chk['errors'], str(chk['errors'][:3]))

# --- stranding: scarce slots + patterned unavailability -> Top/Solid coverage
# must equal an independent max-matching oracle (nobody loses their only
# feasible day to a colleague who had alternatives) ---
unav_pat = {n: [ALL[(2 * i) % 7], ALL[(2 * i + 3) % 7]] for i, n in enumerate(TOP)}
res, chk = run(V_LIGHT, unavail=unav_pat, bk_per_day=1)
served = sum(1 for dr in res.roster if dr['name'] in TOP
             and len(dr['prim']) + len(dr['helper']) == 3 and dr['bk'])
best, ncand = max_serve_top3(res)
print(f'STRANDING: served {served} of {ncand} Top-at-3 | oracle max {best} | errors {len(chk["errors"])}')
check('stranding: Top/Solid coverage equals the max-matching oracle', served == best, f'{served} != {best}')
check('stranding: no errors', not chk['errors'], str(chk['errors'][:3]))

# --- ladder descends past an infeasible driver: a Top who CANNOT take any
# backup day stays 30h, the ladder moves on -- Fair still get theirs ---
stuck_name = TOP[0]
res, chk = run(V_FAIR3, unavail={stuck_name: [d for d in ALL if d not in ('Sun', 'Tue', 'Thu')]},
               bk_per_day=2)
stuck = next(dr for dr in res.roster if dr['name'] == stuck_name)
served_all = sum(1 for dr in res.roster if dr['name'] in TOP
                 and len(dr['prim']) + len(dr['helper']) == 3 and dr['bk'])
best, ncand = max_serve_top3(res)
top_bk2, fair_bk2, disc_bk2 = bktotals(res)
print(f'DESCEND: {stuck_name} {hours_of(res, stuck)}h bk={len(stuck["bk"])} | Tops served {served_all} '
      f'(oracle {best}) | Fair bk {fair_bk2} | disc bk {disc_bk2} | errors {len(chk["errors"])}')
check('descend: the blocked Top stays at 30h, no backup', not stuck['bk'] and hours_of(res, stuck) == 30,
      f'{hours_of(res, stuck)}h')
check('descend: every feasible Top/Solid served (oracle)', served_all == best, f'{served_all} != {best}')
check('descend: the ladder moves on -- Fair DO get backups', fair_bk2 > 0, fair_bk2)
check('descend: discipline (1 road) still get none', disc_bk2 == 0, disc_bk2)
check('descend: no errors', not chk['errors'], str(chk['errors'][:3]))

# --- everyone at 40h except discipline: the ladder = discipline only (under
# 40h), best rate first; NO 5th days while the ladder can still cover ---
res, chk = run(V_FAIR4, backup_pct=0.1)
req = sum(res.backup[d] for d in res.DAYS)
top_fifth = sum(1 for dr in res.roster if dr['name'] in TOP
                and len(dr['prim']) + len(dr['helper']) == 4 and len(dr['bk']) == 1)
fair_over4 = [dr['name'] for dr in res.roster if dr['name'] in FAIR
              and len(dr['prim']) + len(dr['helper']) + len(dr['bk']) > 4]
disc_srv = [dr for dr in res.roster if dr['name'] in DISC and dr['bk']]
disc_uns = [dr for dr in res.roster if dr['name'] in DISC and not dr['bk']
            and len(dr['prim']) + len(dr['helper']) >= 2]
under2_bk = [dr['name'] for dr in disc_srv if len(dr['prim']) + len(dr['helper']) < 2]
rate_ok = (not disc_srv or not disc_uns
           or max(DISC_RATE[dr['name']] for dr in disc_uns)
           <= min(DISC_RATE[dr['name']] for dr in disc_srv))
print(f'LADDER-TAIL: req {req} | disc served {len(disc_srv)} | Top 5th-days {top_fifth} | errors {len(chk["errors"])}')
check('ladder-tail: discipline (only ones under 40h) cover ALL slots', len(disc_srv) == req,
      f'{len(disc_srv)}/{req}')
check('ladder-tail: NO 5th days while the ladder still covers', top_fifth == 0, top_fifth)
check('ladder-tail: best rate first', rate_ok)
check('ladder-tail: no discipline backup below 2 roads', not under2_bk, under2_bk[:3])
check('ladder-tail: Fair never exceed 4 total worked days', not fair_over4, fair_over4[:3])
check('ladder-tail: no errors', not chk['errors'], str(chk['errors'][:3]))

# --- 2nd backups (Jose 2026-07-31): under-40h drivers take a SECOND backup
# before any 42h fifth-day. Everyone at 40h except discipline -> discipline
# take firsts, then seconds; zero 5th days ---
res, chk = run(V_FAIR4, bk_per_day=5)
req = sum(res.backup[d] for d in res.DAYS)
disc_bk_tot = sum(len(dr['bk']) for dr in res.roster if dr['name'] in DISC)
disc_2bk = [dr for dr in res.roster if dr['name'] in DISC and len(dr['bk']) == 2]
top_fifth = sum(1 for dr in res.roster if dr['name'] in TOP
                and len(dr['prim']) + len(dr['helper']) == 4 and dr['bk'])
print(f'SECONDS: req {req} | disc bk {disc_bk_tot} ({len(disc_2bk)} doubles) | '
      f'Top 5th-days {top_fifth} | errors {len(chk["errors"])}')
check('seconds: every slot covered (ladder + overflow remainder)',
      disc_bk_tot + top_fifth == req, f'{disc_bk_tot}+{top_fifth} != {req}')
check('seconds: some discipline take a 2nd backup (still under 40h)', len(disc_2bk) > 0,
      len(disc_2bk))
check('seconds: 5th-days only for the slots the ladder cannot reach', top_fifth <= 2, top_fifth)
check('seconds: no errors', not chk['errors'], str(chk['errors'][:3]))

# --- Top/Solid + Fair seconds come BEFORE any discipline backup (the 07-31
# complaint): tops take a 2nd backup (34h) before discipline get their 1st ---
res, chk = run(V_DISC2, bk_per_day=8)
top_2bk = sum(1 for dr in res.roster if dr['name'] in TOP and len(dr['bk']) == 2)
fair_1bk = sum(1 for dr in res.roster if dr['name'] in FAIR and len(dr['bk']) == 1)
fair_over = [dr['name'] for dr in res.roster if dr['name'] in FAIR
             and len(dr['prim']) + len(dr['helper']) + len(dr['bk']) > 4]
disc_srv = [dr for dr in res.roster if dr['name'] in DISC and dr['bk']]
disc_uns = [dr for dr in res.roster if dr['name'] in DISC and not dr['bk']]
rate_ok = (not disc_srv or not disc_uns
           or min(DISC_RATE[dr['name']] for dr in disc_srv)
           >= max(DISC_RATE[dr['name']] for dr in disc_uns))
print(f'TOP-SECONDS: Top doubles {top_2bk}/{N_TOP} | Fair singles {fair_1bk}/{N_FAIR} | '
      f'disc served {len(disc_srv)} | errors {len(chk["errors"])}')
check('top-seconds: every Top/Solid holds TWO backups (3rd+2bk = 34h, 5 days)',
      top_2bk == N_TOP, f'{top_2bk}/{N_TOP}')
check('top-seconds: every Fair holds one (3 roads + 1 = their 4-day cap)',
      fair_1bk == N_FAIR, f'{fair_1bk}/{N_FAIR}')
check('top-seconds: Fair never exceed 4 total days', not fair_over, fair_over[:3])
check('top-seconds: discipline get only what remains, best rate first',
      len(disc_srv) > 0 and rate_ok, f'{len(disc_srv)} rate_ok={rate_ok}')
check('top-seconds: no errors', not chk['errors'], str(chk['errors'][:3]))

# --- true overflow: EVERYONE at 40h (route coverage pushed discipline to 4
# roads too) -> only then do Top/Solid take a 42h fifth day ---
res, chk = run(240, bk_per_day=2)
top_fifth = sum(1 for dr in res.roster if dr['name'] in TOP
                and len(dr['prim']) + len(dr['helper']) == 4 and dr['bk'])
other_bk = sum(len(dr['bk']) for dr in res.roster if dr['name'] not in TOP)
open_note = any('slot(s) open' in x for x in res.notes)
print(f'OVERFLOW: Top 5th-days {top_fifth}/12 | other bk {other_bk} | open-note {open_note} | '
      f'errors {len(chk["errors"])}')
check('overflow: Top/Solid 5th days (42h) fire when everyone is at 40h',
      top_fifth > 0, top_fifth)
check('overflow: nobody else holds a backup (all at 40h)', other_bk == 0, other_bk)
check('overflow: the uncoverable slots are explained in a note', open_note, res.notes[:2])
check('overflow: no errors (42h is a note, not a violation)', not chk['errors'], str(chk['errors'][:3]))

# --- Fair before discipline (Jose 2026-07-20, the complaint): 30h Fair are
# served before ANY discipline driver; a blocked Fair doesn't stop the ladder ---
blocked_fair = FAIR[0]
res, chk = run(V_TOP4, unavail={blocked_fair: [d for d in ALL if d not in ('Sun', 'Tue', 'Thu')]},
               bk_per_day=4)
bf = next(dr for dr in res.roster if dr['name'] == blocked_fair)
fair_nobk = [dr['name'] for dr in res.roster if dr['name'] in FAIR
             and len(dr['prim']) + len(dr['helper']) == 3 and not dr['bk']
             and dr['name'] != blocked_fair]
disc_srv2 = [dr for dr in res.roster if dr['name'] in DISC and dr['bk']]
fifths = [dr['name'] for dr in res.roster
          if len(dr['prim']) + len(dr['helper']) == 4 and dr['bk']]
print(f'FAIR-FIRST: feasible Fair unserved {len(fair_nobk)} | disc {len(disc_srv2)} | '
      f'5th-days {len(fifths)} | errors {len(chk["errors"])}')
check('fair-first: every feasible 30h Fair served before discipline', not fair_nobk, fair_nobk[:3])
check('fair-first: discipline take only the remainder', len(disc_srv2) > 0, len(disc_srv2))
check('fair-first: no 5th days while the ladder covers', not fifths, fifths[:3])
check('fair-first: the blocked Fair is simply skipped (30h)', not bf['bk'], bf['bk'])
check('fair-first: no errors', not chk['errors'], str(chk['errors'][:3]))

# --- <5 routes -> exactly 3, even at high volume (feasible: other Tops reach 4) ---
locked = TOP[0]
res, chk = run(V_TOP4, exact={locked: 3})
other_top = m([days_of(res, n) for n in TOP[1:]])
print(f'<5ROUTES: {locked} got {days_of(res, locked)} (expect 3); other Tops avg {other_top}; errors {len(chk["errors"])}')
check('<5 routes: exactly 3 (not 4) while other Tops reach 4', days_of(res, locked) == 3, days_of(res, locked))
check('<5 routes: other Top/Solid still hit 4 (proves high volume)', other_top >= 3.8, other_top)
check('<5 routes: no errors', not chk['errors'], str(chk['errors'][:3]))

# --- ROUTE COVERAGE (Jose 2026-07-20): routes are the mission. Demand above
# the tier caps relaxes the SOFT caps -- discipline to 3 (best rate first) ---
V_COVER1 = V_FAIR4 + 16          # 200: needs 16 discipline 3rd days
res, chk = run(V_COVER1)
filled = sum(chk['per_day'][d]['routes'] for d in res.DAYS)
disc3 = [dr['name'] for dr in res.roster if dr['name'] in DISC
         and len(dr['prim']) + len(dr['helper']) == 3]
disc2 = [dr['name'] for dr in res.roster if dr['name'] in DISC
         and len(dr['prim']) + len(dr['helper']) == 2]
rate_ok = (not disc3 or not disc2
           or min(DISC_RATE[n] for n in disc3) >= max(DISC_RATE[n] for n in disc2))
note_ok = any('ROUTE COVERAGE' in x for x in res.notes)
print(f'COVER1({V_COVER1}): filled {filled} | disc at 3: {len(disc3)} | errors {len(chk["errors"])}')
check('cover1: EVERY route filled (soft caps relaxed)', filled == V_COVER1, f'{filled}/{V_COVER1}')
check('cover1: discipline supply the extra days', len(disc3) == 16, len(disc3))
check('cover1: extra days go best-rate-first', rate_ok)
check('cover1: ROUTE COVERAGE note emitted', note_ok, res.notes[:1])
check('cover1: no errors', not chk['errors'], str(chk['errors'][:3]))

# --- coverage stage 2: discipline all the way to 4 when needed ---
V_COVER2 = 236                   # needs disc avg > 3 (max capacity 240)
res, chk = run(V_COVER2)
filled = sum(chk['per_day'][d]['routes'] for d in res.DAYS)
disc4 = sum(1 for dr in res.roster if dr['name'] in DISC
            and len(dr['prim']) + len(dr['helper']) == 4)
print(f'COVER2({V_COVER2}): filled {filled} | disc at 4: {disc4} | errors {len(chk["errors"])}')
check('cover2: EVERY route filled at near-max volume', filled == V_COVER2, f'{filled}/{V_COVER2}')
check('cover2: some discipline reach 4 road days', disc4 > 0, disc4)
check('cover2: no errors', not chk['errors'], str(chk['errors'][:3]))

# --- exact pins yield LAST: only when even discipline-at-4 can't cover ---
res, chk = run(240, exact={locked: 3})   # capacity with the pin honored = 239
filled = sum(chk['per_day'][d]['routes'] for d in res.DAYS)
print(f'PIN-YIELDS(240): filled {filled} | {locked} got {days_of(res, locked)} | errors {len(chk["errors"])}')
check('pin-yields: EVERY route filled', filled == 240, f'{filled}/240')
check('pin-yields: the pin gave way (3 -> 4) as the last resort', days_of(res, locked) == 4,
      days_of(res, locked))
check('pin-yields: ROUTE COVERAGE note names the pinned driver',
      any('ROUTE COVERAGE' in x and locked in x for x in res.notes), res.notes[:1])
check('pin-yields: no errors (the bump is authorized, not a violation)',
      not chk['errors'], str(chk['errors'][:3]))

# --- but the pin holds when discipline can absorb the demand instead ---
res, chk = run(V_FAIR4, exact={locked: 3})   # 184: disc 3rd days cover the gap
filled = sum(chk['per_day'][d]['routes'] for d in res.DAYS)
print(f'PIN-HOLDS({V_FAIR4}): filled {filled} | {locked} got {days_of(res, locked)} | errors {len(chk["errors"])}')
check('pin-holds: EVERY route filled', filled == V_FAIR4, f'{filled}/{V_FAIR4}')
check('pin-holds: the pin stays at 3 (discipline absorbed the gap)',
      days_of(res, locked) == 3, days_of(res, locked))
check('pin-holds: no errors', not chk['errors'], str(chk['errors'][:3]))

# --- truly impossible demand still fails loudly and fast (no hang) ---
res, chk = run(246)              # 246 > 240 = every driver at the 4-day ceiling
print(f'INFEASIBLE(246): infeasible={len(res.infeasible)} errors={len(chk["errors"])}')
check('infeasible: shortfall reported, build did not hang',
      len(res.infeasible) >= 1 and len(chk['errors']) >= 1,
      f'{len(res.infeasible)} inf / {len(chk["errors"])} err')

# --- a day listed with NO wave times must be rejected loudly at load time
# (never reach the solver and divide by an empty wave list) ---
avail_p = os.path.join(FIX, '_tier_avail.xlsx'); write_avail(avail_p)
cfg_e = {
    'start_date': '2026-08-02',
    'waves': {'Sun': {'10:25 AM': 3}, 'Mon': {}},
    'backup_per_day': {'Sun': 1, 'Mon': 2},
    'max_primary_days': 4, 'most_days': TOP[:2],
    'reduced_days': {'target': 2, 'names': []}, 'exact_days': {},
    'prev_week_file': None, 'avail_file': avail_p,
    'out': os.path.join(FIX, '_tier_out.xlsx'), 'strict_names': True,
}
pe = os.path.join(FIX, '_tier_cfg.json'); json.dump(cfg_e, open(pe, 'w'))
try:
    B.build_schedule(B.load_config(pe))
    check('empty-wave day: rejected loudly at config load', False, 'no error raised')
except B.ScheduleConfigError as e:
    check('empty-wave day: rejected loudly at config load', 'waves' in str(e), str(e)[:80])
except Exception as e:  # noqa: BLE001
    check('empty-wave day: rejected loudly at config load', False, repr(e)[:120])

# --- unavailable discipline driver = no crash ---
victim = DISC[0]
res, chk = run(V_BASE, unavail={victim: ALL[:6]})
print(f'UNAVAIL: {victim} got {days_of(res, victim)} | errors {len(chk["errors"])}')
check('unavail: no build error', not chk['errors'], str(chk['errors'][:3]))
check('unavail: capped by availability', days_of(res, victim) <= 1)

print(f'\n{PASS}/{PASS + FAIL} scenario checks passed')
for f in ('_tier_avail.xlsx', '_tier_out.xlsx', '_tier_cfg.json'):
    try:
        os.remove(os.path.join(FIX, f))
    except OSError:
        pass
sys.exit(1 if FAIL else 0)
