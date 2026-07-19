---
name: driver-schedule-builder
description: "GENERATE a new weekly Amazon DSP driver schedule from scratch — assign drivers to routes and waves for an upcoming week. Use when Jose says 'build/make/do the schedule for week NN', 'schedule my drivers/employees for next week', or gives route counts (per wave) for a week and wants names placed. He uploads that week's 'Shifts & Availability' xlsx carrying each driver's submitted Unavailable days, and states per-day route counts (often split by wave time like 10:45/11:05/11:25), backups, exclusions (dispatch/management), and per-driver day targets. This BUILDS a schedule; it is DISTINCT from `weekly-driver-schedule`, which only FORMATS an already-finished schedule into a by-day workbook."
---

# Driver Schedule Builder

Generates a balanced weekly driver schedule for JAJB (Amazon DSP, WWV9): assigns
who works which day and wave, plus backups, honoring availability, the consecutive-day
law, and Jose's per-driver day targets. Output is a `Shifts & Availability` xlsx in the
same shape as the inputs (ready to enter into the system) + a `By Day` sheet.

## RULE PRECEDENCE (canonical, Jose 2026-07-11 — when rules collide, higher wins)

1. **Hard rules** — never violated, the build fails instead: submitted
   `Unavailable` + standing days off · meeting cells (do-not-touch) · max 5
   consecutive worked days · exact per-wave counts · 4 road days / 40h road
   hours (sole exception: the 5th-day fallback backup, 42h) · 5 total worked
   days · backups only on >=2 road days, no backup-only weeks · training-pair
   mechanics (back-to-back, same trainer, solo AFTER training) · exclusions.
2. **Jose's named per-week overrides** ("give X 2 days") — beat every tier
   rule, but **die with the week**: every build starts from fresh board tiers
   and Jose restates anything he still wants.
3. **Exact quotas**: discipline tier 2 days (**preferring Sun+Sat** — see
   below) · new hires 3 (2 training + 1 solo) · benched/all-unavailable 0.
4. **Top/Solid road days 1–3.**
5. **Fair ROAD floor: every available Fair gets 2 road days** before any
   driver gets a 4th. (The tier ladder is also an hours ladder — a Fair must
   never end below the discipline tier; when demand shrinks, the top degrades
   gracefully: Top/Solid drop to 3+backup before Fair drops below 2, and the
   discipline tier drops to 1 first.)
6. **Top/Solid 4th day.**
7. **Discipline tier on a weekday** — only when Sun/Sat can't hold them.
8. **Fair 3rd/4th day** (shapes 3+1 / 2+2).
9. **Within a same-priority group, the better board RATE gets more hours**
   (a -14 always outranks a -24, even in the same tier). Config `driver_rates`.
10. **Soft placement** (which days, never how many): Jose's pre-made days →
    weekend spread (~1 weekend day) → **compactness** (prefer days adjacent
    to already-assigned days — no Sun-Tue-Thu-Sat zigzags) → usual days.

**Tier overlaps are never resolved silently:** if a driver matches two
day-count categories (e.g. Top performer AND <5 routes), list every such name
and **ask Jose to rule per driver before building**.

> Not to be confused with **`weekly-driver-schedule`**, which takes a schedule that
> already exists and formats/audits it. This skill *creates* the schedule.

## Inputs Jose provides (per week)

1. **The week's availability export / pre-made schedule** — a `Week-NN` xlsx (sheet
   `Shifts & Availability`) where each driver's cells contain `Unavailable` on days
   they can't work — the **hard** constraint (blank = available). Any **pre-filled
   shift cell** in the same file is a **seed**: Jose's pre-made schedule. Seed days
   are the strongest *soft* preference — keep every one the rules allow, drop freely
   when a tier cap / wave count / consecutive rule forces it (times in seed cells are
   ignored; waves are re-assigned as needed). The verification block reports the %
   of pre-entered days kept and lists every drop.
2. **Route demand — comes ONLY from Jose** (portal wave counts, often a screenshot),
   e.g. *"Tuesday: 8 at 10:25, 25 at 10:45, 5 at 11:05."* Days he omits (e.g. a
   holiday) are **closed**. **If Jose doesn't give the wave counts, STOP and PROMPT
   him — never derive demand from the pre-entered blocks in the uploaded file**
   (those are his draft roster, not the demand; Jose 2026-07-10).
   **Wave-time offset:** roster blocks start 20 min after the schedule, so
   **schedule time = portal block − 20 min** (a driver rostered at portal 10:45
   is scheduled at 10:25). Convert portal counts to schedule times for `waves`.
3. **Backups** — explicit counts, or a percent of routes. Jose's band is **10–20%; the
   standing default is 15%** (`backup_pct: 0.15`) when he doesn't say. Backups are extra,
   on top of routes.
4. **Exclusions** — dispatchers/management not to be scheduled.
5. **Per-driver day targets** — since Week 28 these are **tier-based** (see the
   "Tier-based day targets" section below), and since Week 29 **Claude pulls the
   tiers itself** (see "Pulling fresh tiers from the driver board") — Jose no
   longer pastes a board export unless he wants to override the pull. He may
   still name individual overrides ("do not schedule X", "give Y 2 days") — a
   named instruction always beats the tier.

## Procedure

### Step 1 — Read the request and the file
Parse the uploaded availability xlsx. If anything about the day-target groups is
ambiguous (a number under a "less days" heading, a missing list, a nickname that may be
two people), **say your interpretation and flag it** — don't silently guess. If Jose
asks you to "explain the logic first," lay out the steps before building.

### Step 2 — Write the config JSON
Build a config (see schema below) capturing: `start_date` (the Sunday), `closed_days`,
`waves` per operating day, `backup_per_day` (or `backup_pct`), `exclude`, `exact_days`,
`reduced_days`, `most_days`, `prev_week_file` (last week's built schedule — REQUIRED for
the consecutive-day carryover), `prefs_csv` (`Projects/Driver Schedule/Driver-Preferences.csv`),
`avail_file`, and `out`. Resolve nicknames yourself (e.g. **Kara→Cara**, **Grace→Greyson**)
or the matcher will flag them unmatched.

### Step 3 — Run the builder
```bash
python scripts/build_weekly_schedule.py --config "<path>/Week-NN-config.json"
```
It prints a verification block: per-day route/backup fill, whether every exact target
was met, the **regular-pool hours spread**, any backup-only weeks (should be none), the
**usual-day adherence %** (week-to-week stickiness), the **max consecutive run** (must
be ≤ cap), error count, and **name-resolution notes**.
**If there are unmatched/ambiguous names or any error, fix the config and re-run** before
delivering. A clean run = 0 errors, max consecutive ≤ 5, every wave count exact.

### Step 4 — Deliver
`present_files` the output xlsx. Summarize: route+backup totals, that targets were met,
the hours balance (min/avg/max of the regular pool), and any driver capped below target
by their own availability. Save the config + a short summary alongside the xlsx in
`Projects/Driver Schedule/`. Move any spent download to `C:\Vault\Delete\`.

**Output formatting (Jose 2026-07-10, corrected same day):** day columns keep
their **normal width**; driver rows are **40px tall** (30 pt). Each shift cell
is colored by its **own wave time** (no portal offset): **10:05 blue, 10:25
yellow, 10:45 pink, 11:05 teal, 11:25 yellow**; helpers orange, Meeting
lavender, Dispatch yellow-green, Unavailable gray, backups shaded.

## Pulling fresh tiers from the driver board (REWRITTEN 2026-07-11 after the 90-day-window mistake)

Get tiers **fresh at build time** by calling the dashboard's **own tier
function** in-page — **NEVER scrape the rendered Fleet-ranking table**:

1. Open **https://jajb-driver-board.netlify.app/** with **Claude-in-Chrome**
   (the board is password-gated but *remembered on Jose's device*). **Never
   type the board password**; if the lock screen shows, ask Jose to unlock
   once and re-run.
2. Wait for the data to load (header shows `as of YYYY-MM-DD`), then run in
   the page: `DB.drivers.map(d => metrics(d, 30))` and read each driver's
   `tier` + `routes` + **`rate`** (the rate feeds within-tier hours ordering —
   config `driver_rates`). The window is the **function argument (30 = last 30
   days, the canonical window for day targets)** — the page's This week / 30 /
   90 toggle cannot contaminate it. Big results truncate: stash in a
   `window.__T` array and read in ~26-row chunks.
3. **Sanity-check before building anything:** (a) spot-check >=3 drivers
   against the visible badges with the "Last 30 days" toggle actually
   selected; (b) 30-day route counts must be plausible — a full-time driver
   runs ~13–19, so a max above ~25 means a wrong window; (c) match names by
   full-name token comparison, never substring (`Hunt` also matches `Hunter`).
4. Save the snapshot as `Projects/Driver Schedule/Driver-Board-Tiers-30d-YYYY-MM-DD.json`
   (date = the board's "as of") and cite it in the config `_NOTES`.
5. Map tiers to config groups per the rules below. Names on the board but not
   on the week's roster (departed, dispatch/management) get pruned; roster
   names missing from the board fall to the "not on the board" rule.

> **Why this exists (2026-07-10 incident):** the first Week-29 pull scraped
> the rendered table while the page's window toggle sat on **Last 90 days** —
> the whole week was initially built on 90-day tiers (Ricucci/Leidy wrongly on
> 2-day discipline treatment). DOM scraping also races async re-renders and
> invites substring name collisions. The in-page function call has none of
> these failure modes and always matches the badges Jose sees.

## Tier-based day targets (standing method since Week 28, Jose 2026-07-03)

The board rows carry Tier / Driver / Routes (30d). Map tiers to config groups:

- **Top performer + Solid** -> 4 road days (40h) -> `most_days` (not `exact_days`,
  so a driver whose own availability blocks a day is reported, not an error).
- **<5 routes in the last 30 days** (from the board's Routes column) -> 30h ->
  `exact_days: 3`. Applies to Top/Solid/Fair/unrated; a discipline cap below
  still wins (an Underperforming driver with <5 routes stays at 2).
  **Overlap = ask Jose (2026-07-11):** any driver matching two categories
  (e.g. Top performer AND <5 routes) is listed by name and Jose rules per
  driver before the build — never resolved silently.
- **Fair** -> the shapes are **3 roads + up to 1 backup, or 2 roads + up to
  2 backups** — total ≤ 4 worked days (`free_total_days`), never 3+2 and never
  backups alone. Leave them in the **free pool** with `free_primary_cap` 3
  (raise to 4 only if the fixed groups can't cover the route total). A Fair on
  2 road days gets a **1st backup guaranteed** (22h); the **2nd backup ranks
  below a 3-day Top/Solid's first backup** (revised 2026-07-16 — see the backup
  priority under "The rules the builder enforces"). The verification block
  flags any 2-road Fair left with no backup at all.
- **Underperforming + Termination review** -> exactly 2 road days ->
  `reduced_days` target 2, and **no backups except as the LAST resort** of the
  fallback ladder (Jose 2026-07-04: a backup day carries a chance of being
  sent on a route, and he does not want this tier's route exposure to grow).
  Leave `backup_eligible_extra` empty; put them in the last `backup_fallback`
  group instead (see below).
- **Not on the board** (brand-new drivers) -> ask Jose; default 3 days (`exact_days`).
- **Do-not-schedule names** -> `exact_days: 0` (kept on the sheet, no shifts).

Sanity-check capacity before running: fixed-group route-days vs the week's route
total — the free pool absorbs the difference, so make sure its min/max range can.

## New-hire training pairs (Jose 2026-07-10)

A **brand-new hire (never on the road)** rides **2 back-to-back days with the SAME
trainer**: day 1 the trainer drives and the new hire is the helper; day 2 the new
hire drives and the trainer is the helper. The pair shares one van, so each
training day consumes **exactly one route slot** (the driver-of-record's); a
helper day is a full worked 10h day for caps/hours/consecutive but **not** a wave
count. Rules:

- Config: `training_pairs: [{"trainer": "...", "trainee": "..."}]`. The solver
  picks the **EARLIEST feasible back-to-back window** per pair (train first —
  seeds/preferences never delay training; Jose 2026-07-10), preferring a window
  that leaves the trainee an available later day, and **locks** it (repair
  passes can't move training days). Infeasible pair -> loud report.
- **The trainee's solo day always falls AFTER day 2 of training** — a new hire
  never drives alone before being trained. Enforced as a hard rule, with a
  target-completion pass that swaps slots free when busier tiers saturate the
  trainee's only eligible days.
- A trainer **may take two trainees** — sequentially, never two on the same day
  (e.g. pair 1 Sun->Mon, pair 2 Tue->Wed). List the pair twice with different
  trainees.
- **New hires get 3 total days**: the 2 training days + 1 solo route ->
  `exact_days: 3` (training-helper days count toward the target).
- A trainer **without a trainee is just a normal driver** — no special handling.
- **Standing trainer roster (Jose 2026-07-10):** Alex Keller, Barry Hughes,
  Joseph Gebczyk, Jade Oakes, Lexie McMillan, Connor Stephenson, Matthew (Lee)
  Dutton.
- Output: both cells carry the shared wave + `(TRAIN drives w/ X)` /
  `(TRAIN helper w/ X)`; the verification block lists every pair and its days.

## Meeting days are DO-NOT-TOUCH (Jose 2026-07-10)

Any pre-entered cell containing **"meeting"** (e.g. a ~2h meeting) in the uploaded
file is untouchable: the cell text is **preserved verbatim** in the output, the
driver gets **no route or backup that day**, and the day still **counts as a
worked (2h) day** for the consecutive rule, the total-days cap, and the weekend
spread. The verification block lists every preserved meeting day, and touching
one is a hard ERROR. Whether attendees get extra road days on top is a
**per-week call from Jose**, not a standing rule (e.g. the Week-29 trainer
meeting: trainers still get their full 4 road days on top of the meeting —
one-time, because it's a trainer meeting, not a disciplinary review).

## Part-week dispatch duty (`extra_worked_days`)

For someone who dispatches part of the week (config
`extra_worked_days: {"name": ["Fri","Sat"]}`): those days show as **`Dispatch`**
in the output, take no route/backup, but **count as worked days** for the
consecutive rule, the 5-total-days cap, and the weekend spread.
**Standing (Jose 2026-07-10): Connor Stephenson dispatches Fri+Sat** -> max 3
road/training days Sun–Thu (2 dispatch + 3 road = 5 total). **Michael Robinson
is no longer dispatch** — schedule him as a normal driver under his board tier;
the exclude list is now just Zackary McDonald, Rachel Rhoades, Greyson Turner.

## The rules the builder enforces

- **Submitted `Unavailable` days are absolute** — never scheduled over. (They override the
  derived preferences.) In the output, a driver's hard-off days show as `Unavailable`.
- **Max consecutive worked days (default 5), carried over from the prior week.** It reads
  `prev_week_file`, computes each driver's trailing streak through last Saturday, and
  forbids any run > cap across the week boundary. **This is a CONSECUTIVE-day rule, not a
  per-week cap.** Backup days count as worked days for this purpose.
- **Exact per-wave route counts** are hit exactly.
- **Backups are a top-up, never a whole week — and a route-exposure knob.** A backup
  shift pays only `backup_hours` (≈2h) vs a primary's `primary_hours` (≈10h), **plus a
  chance of being sent out on a route**. Only drivers with ≥2 road days get backups.
  **A Top/Solid must always out-earn a Fair**, so the backup priority (revised
  2026-07-16) is:
  1. **Fair (free pool) at 2 road, 0 backups** → 1st backup (22h — no bare 20h week).
  2. **Top/Solid stuck at 3 road days** → **one** backup (32h), BEFORE any Fair takes
     a 2nd. (A Top/Solid at 3 wanted a 4th road day but demand ran out; the backup
     brings them to 32h so they beat a Fair's 24h.)
  3. **Fair at 2 road, 1 backup** → 2nd backup (24h) — only after every 3-day
     Top/Solid has one. With abundant backups everyone is served; when scarce, the
     Fair's 2nd is what gets dropped.
  4. Everyone else eligible, lowest-hours first.
  Fair shapes stay capped at 3+1 / 2+2 (`free_total_days: 4`); a 3-day Top/Solid
  takes at most 1 backup. **When this pool can't fill a day**, the `backup_fallback`
  ladder runs: **Top performers** (a 5th day = 42h, ~2h OT), then **Solid**, then
  **Underperforming / Termination review** as the LAST resort. **Nobody exceeds 5
  total worked days.** The verification block prints who each fallback group lent,
  names every 42h driver, and flags any 2-road Fair left with **no** backup.
- **Hours balance for the regular pool.** Everyone not on a target list is balanced toward
  a similar hours band (primaries distributed lowest-first). Result is typically a tight
  ~24–32h cluster, with the "most days" people highest and "fewer days" people lowest **by
  design**.
- **Day targets:** `exact_days` = exact primary-day count (incl. 0 to bench someone);
  `reduced_days` = a `target` (usually average−1) for the "give them fewer" group;
  `most_days` = maximize up to the consecutive cap. A "most" driver can land below the cap
  only when their own `Unavailable` days limit them — report that.
- **Soft placement preferences (tiebreaks only, but everywhere).** Every phase
  (greedy, repair, rebalance, backups) scores days with the same ladder — it
  decides WHICH days, never how many, and can never outweigh a rule, a day of
  need/imbalance, or the rate ordering:
  1. **Seed days** (Jose's pre-made schedule in the uploaded file) — strongest.
  2. **Weekend spread** (Jose 2026-07-04): when Sat+Sun both operate, aim for
     **~1 weekend day per driver**. Soft: coverage wins, and the discipline
     tier's Sun+Sat placement deliberately overrides it for that group.
     (`weekend_spread: true` default; `max_weekend_days` = separate HARD cap.)
  3. **Compactness** (Jose 2026-07-11): prefer days **adjacent** to a driver's
     already-assigned days (a 1–2 day gap is fine) — no more
     Sun-Tue-Thu-Sat zigzag weeks.
  4. **`usual_days`** from `Driver-Preferences.csv` — week-to-week stickiness.
  The verification block prints **usual-day adherence %**, **pre-made-schedule
  kept %** (every dropped seed listed), the **weekend-day distribution**, the
  **discipline-tier Sun/Sat placement count**, and the **Fair road-floor
  check** — watch them all.

## Config schema (example)

```json
{
  "week_label": "Week-27 (Jun 28 – Jul 4, 2026)",
  "start_date": "2026-06-28",          // the Sunday of the week
  "closed_days": ["Sat"],              // no routes (e.g. holiday)
  "max_consecutive": 5,
  "primary_hours": 10, "backup_hours": 2, "free_primary_cap": 4,
  "waves": { "Sun": {"10:45 AM":20, "11:05 AM":20, "11:25 AM":9}, "...": {} },
  "backup_per_day": {"Sun":6, "Mon":7, "...":0},   // or "backup_pct": 0.15 (the standing default)
  "exclude": ["Zackary McDonald", "Rachel Rhoades", "Greyson Turner"],  // Robinson off dispatch since 2026-07-10 -> normal driver
  "exact_days": {"Antony Frieson":5, "Joshua Workman":3, "Karl Berkley":0},
  "reduced_days": {"target":2, "names":["Casey Church", "Phillip McCloud"],
                   "prefer_days": ["Sun","Sat"]},  // discipline tier lands here first (default Sun+Sat)
  "most_days": ["Daniel Lynch", "Cara Amos", "Matthew Dutton"],
  "max_total_days": 5,     // hard cap: roads + backups, everyone
  "free_total_days": 4,    // free pool (Fair): 3+1 or 2+2 shapes only
  "driver_rates": {"Cara Amos": -3.2},  // board Rate per driver (closer to 0 = better) -> within-tier hours order
  "use_premade_shifts": true,  // honor pre-filled shift days in avail_file as seeds
  "weekend_spread": true,      // soft: ~1 weekend day per driver when Sat+Sun both open
  "training_pairs": [{"trainer": "Alex Keller", "trainee": "Jessica Jett"}],
  "extra_worked_days": {"Connor Stephenson": ["Fri", "Sat"]},  // dispatch duty: no routes, still worked days
  "backup_eligible_extra": [],  // TARGET/MOST drivers who may take backups in the MAIN fill. Standing rule: LEAVE EMPTY — use backup_fallback instead
  "backup_fallback": [     // ordered ladder when the free pool runs dry (one backup each)
    ["<Top performer names from the board>"],
    ["<Solid names>"],
    ["<Underperforming + Termination review names — LAST resort>"]
  ],  // prune names that aren't on this week's roster (departed/excluded) or the matcher flags them
  "prev_week_file": "<...>/Week-26-Schedule.xlsx",
  "prefs_csv": "<...>/Driver-Preferences.csv",
  "avail_file": "<...>/Week-27-Schedule unavailable days.xlsx",
  "out": "<...>/Week-27-Schedule.xlsx"
}
```

## Tuning
All knobs are in the config; deeper logic (scoring, caps) lives at the top of
`scripts/build_weekly_schedule.py`. To change hours values, the consecutive cap, or the
free-pool cap, edit the config — no code change needed.

## Do not
- Don't treat blank availability cells as unavailability — only the literal `Unavailable`.
- Don't put low-day drivers on backup-only weeks — backups are top-ups (the script enforces this).
- Don't give Underperforming/Termination-review drivers backup days except via the last `backup_fallback` group (`backup_eligible_extra` stays empty unless Jose names an exception that week).
- Don't let anyone reach 6 worked days or let a Fair carry 3 roads + 2 backups (`max_total_days` 5 / `free_total_days` 4 enforce this — never raise them without Jose).
- Don't skip `prev_week_file` — without it the consecutive-day carryover can't be checked.
- Don't deliver a run that has unmatched names, a >cap consecutive run, or any wave-count mismatch — fix and re-run first.
- Don't confuse this with `weekly-driver-schedule` (that one only formats an existing schedule).
