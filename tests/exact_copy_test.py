#!/usr/bin/env python3
"""exact_copy: Amazon's Shifts & Availability sheet is taken as is (runner._force_exact).

Run:  python tests/exact_copy_test.py <path to an Amazon Week-NN-Schedule.xlsx>
(skips when no file is given - the sheets hold driver names, so none is in git)."""
import collections, json, os, re, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'public', 'solver'))
import runner  # noqa: E402
import openpyxl  # noqa: E402

if len(sys.argv) < 2 or not os.path.exists(sys.argv[1]):
    print('SKIP (no Amazon schedule file given)'); sys.exit(0)
SRC = sys.argv[1]
days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
want = {}
ws = openpyxl.load_workbook(SRC, data_only=True)['Shifts & Availability']
for r in ws.iter_rows(min_row=5, values_only=True):
    if not r[0] or str(r[0]).lower().startswith('total'):
        continue
    for i, d in enumerate(days):
        v = str(r[2 + i] or '')
        m = re.search(r'(\d{1,2}:\d{2} [AP]M)', v)
        if 'Driver' in v and m:
            want[(' '.join(str(r[0]).split()), d)] = m.group(1) + (' Backup' if 'Backup' in v else '')
cfg = json.load(open(os.path.join(HERE, 'fixtures', 'Week-40-config.json'), encoding='utf-8'))
for k in ('extra_worked_days', 'reduced_days', 'backup_fallback', 'driver_tiers', 'driver_rates', 'backup_eligible_extra', 'exclude', 'backup_pct'):
    cfg.pop(k, None)
tmp = tempfile.mkdtemp()
cfg.update(start_date='2026-10-04', avail_file=SRC, prev_week_file=None, prefs_csv=None, strict_names=False,
           out=os.path.join(tmp, 'o.xlsx'), exact_copy=True, waves={'Sun': {'10:25 AM': 1}}, training_pairs=[])
p = os.path.join(tmp, 'c.json'); json.dump(cfg, open(p, 'w'))
runner.use_slot('build')
out = json.loads(runner.run(p))
assert out['ok'], out
got = {(' '.join(d['name'].split()), dd): c for d in out['drivers'] for dd, c in d['cells'].items() if c and c != 'Unavailable'}
bad = [(k, v, got.get(k)) for k, v in want.items() if got.get(k) != v]
print(f'{len(want) - len(bad)}/{len(want)} shifts identical')
print('PASS' if not bad else 'FAIL ' + str(bad[:5]))
sys.exit(1 if bad else 0)
