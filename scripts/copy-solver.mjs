// Prebuild step (runs in Netlify's cloud build): copy the canonical solver
// into public/solver/ byte-for-byte, so the deployed app always ships the exact
// same solver the Claude Code skill uses — one source of truth.
//
// runner.py is authored directly in public/solver/ and is NOT overwritten here.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'driver-schedule-builder skill', 'scripts', 'build_weekly_schedule.py');
const destDir = join(root, 'public', 'solver');
const dest = join(destDir, 'build_weekly_schedule.py');

if (!existsSync(src)) {
  // Source skill folder wasn't included in the deploy. That's fine as long as
  // the already-committed copy is present — don't fail the whole build.
  if (existsSync(dest)) {
    console.warn(`[copy-solver] source not found (${src}); using the committed copy at ${dest}`);
    process.exit(0);
  }
  console.error(`[copy-solver] solver not found at: ${src} and no committed copy at ${dest}`);
  process.exit(1);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-solver] copied solver -> ${dest}`);
