// Integration test: build a realistic wizard state, run it through the REAL
// config-assembler, point the file paths at the generated fixtures, and write
// the config so the Python solver can run it. Proves config-assemble produces a
// solver-valid config end-to-end (not just the expected shape).
//   deno run --allow-write tests/assemble_integration.mjs
import { assembleConfig } from '../public/app/lib/config-assemble.js';

const ROOT = 'C:/Claude Code/Schedule-Builder';
const FIX = ROOT + '/tests/fixtures';

// Roster matches tests/fixtures/Week-40-availability.xlsx (from gen_fixtures.py).
const roster = ['Daniel Lynch', 'Cara Amos', 'Matthew Dutton', 'Aaron Bell', 'Bianca Cole',
  'Colin Drake', 'Casey Church', 'Joshua Workman', 'Grace Nolan', 'Alex Keller',
  'Jessica Jett', 'Connor Stephenson', 'Karl Berkley', 'Zackary McDonald'];

const tierByDriver = {
  'Daniel Lynch': { tier: 'Top performer', routes: 15, rate: -4, groupValue: 'most' },
  'Cara Amos': { tier: 'Top performer', routes: 16, rate: -8, groupValue: 'most' },
  'Matthew Dutton': { tier: 'Solid', routes: 14, rate: -12, groupValue: 'most' },
  'Aaron Bell': { tier: 'Fair', routes: 12, rate: -20, groupValue: 'free' },
  'Bianca Cole': { tier: 'Fair', routes: 11, rate: -22, groupValue: 'free' },
  'Colin Drake': { tier: 'Fair', routes: 10, rate: -25, groupValue: 'free' },
  'Casey Church': { tier: 'Underperforming', routes: 8, rate: -45, groupValue: 'reduced' },
  'Joshua Workman': { tier: 'Solid', routes: 3, rate: -6, groupValue: 'exact:3' },
  'Grace Nolan': { tier: 'Fair', routes: 12, rate: -18, groupValue: 'free' },
  'Alex Keller': { tier: 'Fair', routes: 13, rate: -16, groupValue: 'free' },
  'Jessica Jett': { tier: 'Unrated', routes: null, rate: null, groupValue: 'exact:3' },
  'Connor Stephenson': { tier: 'Fair', routes: 9, rate: -24, groupValue: 'free' },
  'Karl Berkley': { tier: 'Unrated', routes: null, rate: null, groupValue: 'bench' },
};

// HR enters PORTAL times; assembler subtracts 20 min. portal 11:05 -> sched 10:45,
// portal 11:25 -> sched 11:05 (small, coverable demand across 6 days; Fri closed).
const day = (a, b) => [{ portalTime: '11:05 AM', count: String(a) }, { portalTime: '11:25 AM', count: String(b) }];
const demand = {
  Sun: day(4, 2), Mon: day(4, 2), Tue: day(4, 2), Wed: day(3, 2), Thu: day(4, 2), Sat: day(3, 1),
};

const state = {
  week: { num: '40', startISO: '2026-08-02', label: 'Week-40 (Aug 2 - Aug 8, 2026)' },
  availabilityRosterNames: roster,
  tierByDriver,
  demand,
  backups: { mode: 'pct', pct: 0.15 },
  standing: {
    exclude: ['Zackary McDonald', 'Rachel Rhoades', 'Greyson Turner'], // last two not on roster -> pruned
    bench: [],
    dispatch: { 'Connor Stephenson': ['Fri', 'Sat'] },
    trainingPairs: [{ trainer: 'Alex Keller', trainee: 'Jessica Jett' }],
    hasPrefs: true,
  },
  advanced: {},
  priorWeekAvailable: true,
};

const { config, nameProblems } = assembleConfig(state);
if (nameProblems.length) {
  console.error('NAME PROBLEMS:', nameProblems);
  Deno.exit(1);
}

// Point at the real fixture files instead of the /work/* runtime paths.
config.avail_file = FIX + '/Week-40-availability.xlsx';
config.prev_week_file = FIX + '/Week-39-Schedule.xlsx';
config.prefs_csv = FIX + '/Driver-Preferences.csv';
config.out = FIX + '/Week-40-assembled-out.xlsx';

Deno.writeTextFileSync(FIX + '/Week-40-assembled-config.json', JSON.stringify(config, null, 2));
console.log('Wrote assembled config. most_days=', config.most_days,
  '| exact=', config.exact_days, '| reduced=', config.reduced_days.names,
  '| exclude=', config.exclude, '| waves.Sun=', config.waves.Sun);
