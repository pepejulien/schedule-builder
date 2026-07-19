# JAJB Weekly Schedule Builder

A web app that lets an HR person build the weekly Amazon DSP driver schedule for
JAJB Logistics (station WWV9) without touching Claude Code: fill in the week's
inputs, click **Build**, download the finished `Week-NN-Schedule.xlsx`.

It wraps the exact same deterministic solver the `driver-schedule-builder` skill
uses — the Python in `driver-schedule-builder skill/scripts/build_weekly_schedule.py`
— and runs it **in the browser** via Pyodide (WebAssembly Python). No Python
server is needed; the whole thing is a static site plus three small Netlify
Functions.

---

## How it works (architecture)

| Piece | What it does |
|---|---|
| **Static front-end** (`public/`) | A 9-step wizard (Preact + htm, no build step). |
| **Pyodide worker** (`public/app/worker/solver.worker.js`) | Loads the canonical solver + `openpyxl` in the browser and runs the build. Warms up in the background the moment you upload availability. |
| **Board fetch** (`public/app/lib/board-fetch.js` + `board-metrics.js`) | Pulls driver tiers straight from the JAJB driver board's own encrypted data feed and re-derives the tiers with the board's own scoring code — no scraping, no browser automation. The board password stays on the device. |
| **Netlify Functions** (`netlify/functions/`) | `auth` (shared-password login), `store` (Netlify Blobs — app settings only), `parse-screenshot` (optional AI reading of a portal screenshot via the Anthropic API). |
| **Persistence** | **The built schedules stay in your own files — the app keeps no hidden copies.** Netlify Blobs stores only app *settings* (standing config, name aliases, the optional preferences CSV). The in-progress build auto-saves to the browser (IndexedDB) so you can close the tab and resume. |

The solver file is the single source of truth: `scripts/copy-solver.mjs` copies
it into `public/solver/` at deploy time, so the app always ships the identical
logic the skill runs.

---

## One-time setup

You need a free Netlify account and (optionally) an Anthropic API key.

### 1. Put this folder on Netlify

Two options:

- **Git (recommended):** `git init` here, push to GitHub, then in Netlify
  "Add new site → Import from Git". Netlify reads `netlify.toml` automatically.
- **CLI:** install Node + the Netlify CLI on any machine, then `netlify init`
  from this folder.

Build settings come from `netlify.toml` (build command `node scripts/copy-solver.mjs`,
publish directory `public`, functions in `netlify/functions`). Netlify's build
runs `npm install` (for `@netlify/blobs`) and the copy step for you.

### 2. Set environment variables (Netlify → Site settings → Environment variables)

| Variable | Required? | What to set it to |
|---|---|---|
| `APP_PASSWORD` | **Yes** | The password your HR person types to sign in. |
| `AUTH_SECRET` | **Yes** | Any long random string (used to sign the login cookie). Generate one, e.g. `openssl rand -hex 32`. |
| `ANTHROPIC_API_KEY` | Optional | Only needed for the "parse a screenshot" button. Create it at console.anthropic.com (pay-as-you-go; parsing one screenshot a week costs a few cents/month). Without it, HR just types the route counts — everything else still works. |

> The Claude **Max** subscription cannot power a deployed web app — Max covers
> interactive use (claude.ai / Claude Code) only. A regular API key is required
> for the optional screenshot parsing.

### 3. Enable Netlify Blobs

Blobs is on by default for new Netlify sites — no action needed. The `store`
function uses it automatically.

### 4. First run

1. Open the site, sign in with `APP_PASSWORD`.
2. (Optional) Go to **Settings** and upload your `Driver-Preferences.csv`.
3. In **Step 3 (Tiers)** enter the driver-board password once (stored on the
   device only).
4. In **Step 4 (Prior week)** upload last week's built schedule from your files.

---

## The HR workflow, week to week

The home screen is a **readiness dashboard** — it shows which steps are ready,
warnings to resolve, and the key numbers, and lets you jump to any step or
**Continue** where you left off (progress auto-saves in the browser).

1. **Week** — week number + the Sunday it starts.
2. **Availability** — upload the `Week-NN` availability workbook drivers submitted.
3. **Tiers & names** — click "Fetch tiers from board"; review the tier grid.
   Any driver matching two rules (e.g. Top performer *and* under 5 routes) is
   flagged and must be resolved before continuing.
4. **Prior week** — upload last week's schedule from your own files.
5. **Route demand** — type the portal wave times + counts (the app shows the
   −20 min schedule time), or upload a portal screenshot to pre-fill them.
6. **Backups** — 15% by default, or exact per-day counts.
7. **Standing settings** — exclusions, dispatch duty, trainers, training pairs
   (carried over week to week).
8. **Review** — a sanity check of everything, plus an **Advanced settings** panel
   for one-off, this-week-only overrides (day/hours caps, weekend cap, merge
   standing days-off, per-week backup exceptions — they reset next week).
9. **Build** — runs the solver in-browser. Download the **workbook** and the
   optional **driver-notices CSV**, and use **Adjust &amp; rebuild** to tweak a
   driver's days / backups / advanced settings and re-run without starting over.

---

## Verifying it works

- **Solver core** (already validated): `python tests/gen_fixtures.py` then
  `python "driver-schedule-builder skill/scripts/build_weekly_schedule.py" --config tests/fixtures/Week-40-config.json`
  produces a clean `Week-40-Schedule.xlsx`. This is the exact code Pyodide runs.
- **Module graph:** `python tests/check_modules.py` verifies every front-end
  import resolves.
- **Front-end logic (offline):** with a JS runtime (e.g. Deno),
  `deno run tests/js_selftest.mjs` runs 46 assertions on the board scoring, wave
  offset, names, config assembly, advanced overrides, the driver CSV, and the
  readiness dashboard. `deno run --allow-read --allow-write tests/assemble_integration.mjs`
  then feeds the assembled config to the real solver to prove it's valid end-to-end.
- **Front-end logic (in the browser):** after deploying, open **`/selftest.html`**
  on the live site. It runs the same assertions on the ported board scoring, the wave-time offset,
  name matching, and config assembly, and shows pass/fail. All should pass.
- **End-to-end:** for the first week or two, build in the app *and* the old
  Claude Code way in parallel and compare the two workbooks before switching
  over fully (a "shadow" period).

---

## Maintenance notes

- **The solver is canonical.** Edit `driver-schedule-builder skill/scripts/build_weekly_schedule.py`;
  the deploy copies it into `public/solver/`. Don't hand-edit the copy.
- **Board scoring can drift.** `public/app/lib/board-metrics.js` is a verbatim
  port of the board's scoring. If the board changes how it computes tiers, the
  app will mis-tier — the tier step has a "enter tiers manually" fallback, and
  `/selftest.html` will start failing, which is your signal to re-port.
- **Pyodide version** is a single constant (`PYODIDE_VERSION`) at the top of
  `public/app/worker/solver.worker.js`. If the runtime ever fails to load, bump
  it to the current release.
- **The `4 road days / 40 h` caps** (`max_primary_days` / `weekly_hours_cap`)
  are shipped as standing defaults in `config-assemble.js`. Confirm them against
  a real historical config during the shadow period.

---

## Repo layout

```
netlify.toml                 Netlify build/redirect/header config
package.json                 declares @netlify/blobs for the cloud build
scripts/copy-solver.mjs      copies the solver into public/solver at build time
public/
  index.html                 app shell (+ import map for Preact/htm)
  selftest.html              in-browser logic tests
  vendor/                    Preact, htm, SheetJS (vendored, no CDN at runtime)
  pyodide/                   openpyxl + et_xmlfile wheels (vendored)
  solver/
    build_weekly_schedule.py (generated) the canonical solver
    runner.py                thin wrapper the worker calls -> JSON report
  app/
    main.js app.js store.js api.js ui.js solver-client.js build-inputs.js settings.js
    draft.js                 IndexedDB auto-save/resume of the in-progress build
    readiness.js             computes the home-screen dashboard
    worker/solver.worker.js  owns Pyodide
    steps/step1..step9 + advanced-panel.js   the wizard
    lib/                     weeks, waves, names, board-fetch, board-metrics,
                             availability-parse, config-assemble, driver-csv
netlify/
  functions/auth.mjs store.mjs parse-screenshot.mjs
  lib/session.mjs            cookie signing (shared, not an endpoint)
tests/
  gen_fixtures.py            builds a synthetic test week
  check_modules.py           static ES-module graph check
  fixtures/                  generated test inputs/outputs
driver-schedule-builder skill/  the original skill (canonical solver lives here)
```
