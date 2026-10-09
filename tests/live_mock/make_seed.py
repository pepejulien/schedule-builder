#!/usr/bin/env python3
"""Live board speed test data (2026-10-08). TEST ONLY.

Builds the Week-40 fixture as week 2026-10-04 (rev 1) plus three "another
dispatcher" saves (one call-out each) and writes tests/fixtures/live-seed.json,
which serve.py hands out at /__fixtures/live-seed.json. perf-harness.js reads it.

    python tests/gen_fixtures.py        (once)
    python tests/live_mock/make_seed.py
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
sys.path.insert(0, os.path.join(ROOT, 'public', 'solver'))
import runner  # noqa: E402

FIX = os.path.join(ROOT, 'tests', 'fixtures')
tmp = tempfile.mkdtemp()
cfg = json.load(open(os.path.join(FIX, 'Week-40-config.json'), encoding='utf-8'))
for k in ('prev_week_file', 'prefs_csv', 'avail_file'):
    cfg[k] = os.path.join(FIX, os.path.basename(cfg[k]))
cfg['start_date'] = '2026-10-04'
cfg['week_label'] = 'Week-41 (Oct 4 - Oct 10, 2026)'
cfg['out'] = os.path.join(tmp, 'build.xlsx')
cp = os.path.join(tmp, 'c.json')
json.dump(cfg, open(cp, 'w', encoding='utf-8'))


def J(fn, p=None):
    return json.loads(fn(json.dumps(p or {})))


runner.use_slot('build')
b = json.loads(runner.run(cp))
assert b['ok'], b
st1 = J(runner.export_state)['state']
runner.use_slot('live')
r1 = J(runner.load_state, {'state': st1, 'out': os.path.join(tmp, 'l.xlsx')})
assert r1['ok']
remotes = []
days = [d for d in r1['days'] if d['open'] and d['date'] >= '2026-10-09']
day = days[0]['day'] if days else [d for d in r1['days'] if d['open']][-1]['day']
victims = [d for d in r1['drivers'] if day in d['road_days'] and 'TRAIN' not in d['cells'][day]]
for i in range(3):
    J(runner.load_state, {'state': st1, 'out': os.path.join(tmp, 'l.xlsx')})
    v = victims[i]
    m = J(runner.apply_mark, {'name': v['name'], 'day': day, 'kind': 'callout', 'note': 'remote test'})
    assert m['ok'], m
    remotes.append({'state': J(runner.export_state)['state'], 'report': m, 'name': v['name'], 'day': day})
out = {'week': '2026-10-04', 'label': cfg['week_label'], 'num': 41, 'state': st1, 'report': r1, 'remotes': remotes}
json.dump(out, open(os.path.join(FIX, 'live-seed.json'), 'w', encoding='utf-8'))
print('wrote tests/fixtures/live-seed.json; remote call-outs:', [(r['name'], r['day']) for r in remotes])
