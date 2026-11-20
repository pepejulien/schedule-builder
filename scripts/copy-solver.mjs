// Prebuild step (runs in Netlify's cloud build). The app's public/solver/build_weekly_schedule.py
// is the one source of the solver (2026-11-20, card #1370): it is what Firebase ships and where
// every change since the skill copy went stale was made. This step never puts an older solver
// over it:
//   * the skill copy (driver-schedule-builder skill/scripts/) only replaces the app's copy when it
//     is NEWER (last git commit, else file time) AND at least as long;
//   * a newer skill copy that is SHORTER fails the build (it would drop logic — someone has to
//     look), and so does any copy that comes out older or shorter than what it replaced;
//   * an older or identical skill copy leaves the app's copy alone (a warning says the skill copy
//     is stale).
// runner.py is authored directly in public/solver/ and is NOT touched here.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'driver-schedule-builder skill', 'scripts', 'build_weekly_schedule.py');
const destDir = join(root, 'public', 'solver');
const dest = join(destDir, 'build_weekly_schedule.py');
const tag = '[copy-solver]';

const lines = (p) => readFileSync(p, 'utf-8').split('\n').length;
// when a file last changed: its last git commit (a fresh clone gives every file the same file time),
// else the file time (not in git / no git)
function changedAt(p) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', p], { cwd: root, encoding: 'utf-8' }).trim();
    if (out) return Number(out) * 1000;
  } catch { /* no git here */ }
  return statSync(p).mtimeMs;
}

if (!existsSync(src)) {
  // Source skill folder wasn't included in the deploy. That's fine as long as
  // the already-committed copy is present — don't fail the whole build.
  if (existsSync(dest)) {
    console.warn(`${tag} source not found (${src}); using the committed copy at ${dest}`);
    process.exit(0);
  }
  console.error(`${tag} solver not found at: ${src} and no committed copy at ${dest}`);
  process.exit(1);
}
if (!existsSync(dest)) {
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  console.log(`${tag} no app copy yet: copied the skill's solver -> ${dest}`);
  process.exit(0);
}

const srcText = readFileSync(src, 'utf-8');
const destText = readFileSync(dest, 'utf-8');
if (srcText === destText) {
  console.log(`${tag} skill and app solver are the same; nothing to do`);
  process.exit(0);
}
const [sAt, dAt] = [changedAt(src), changedAt(dest)];
const [sN, dN] = [lines(src), lines(dest)];
const when = (ms) => new Date(ms).toISOString().slice(0, 10);

if (sAt <= dAt) {
  console.warn(`${tag} keeping the app's solver (${dN} lines, ${when(dAt)}): the skill copy is older ` +
    `(${sN} lines, ${when(sAt)}). Update the skill copy from public/solver/ when you can.`);
  process.exit(0);
}
if (sN < dN) {
  console.error(`${tag} STOP: the skill copy is newer (${when(sAt)}) but SHORTER (${sN} lines) than the app's ` +
    `solver (${dN} lines, ${when(dAt)}) — copying it could drop logic. Bring the two together by hand.`);
  process.exit(1);
}

copyFileSync(src, dest);
// check: what went in must be the file we meant, and never shorter than what it replaced
const nowN = lines(dest);
if (readFileSync(dest, 'utf-8') !== srcText || nowN < dN) {
  writeFileSync(dest, destText);                // put the app's solver back
  console.error(`${tag} STOP: the copied solver (${nowN} lines) is shorter than or different from what it ` +
    `should be (replaced ${dN} lines) — not shipping it.`);
  process.exit(1);
}
console.log(`${tag} copied the newer skill solver (${sN} lines, ${when(sAt)}) over the app's (${dN} lines, ${when(dAt)})`);
