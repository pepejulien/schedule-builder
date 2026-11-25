# Roster bookmark (Schedule Builder → Amazon, legacy Dispatch page)

Jose 2026-10-09; moved to the legacy page 2026-10-23. A bookmark dispatch drags off the
**Live board** once. On Amazon **Dispatch with "Legacy view" on** — the old Scheduling day
page, `logistics.amazon.com/scheduling?serviceAreaId=…&date=YYYY-MM-DD&navMenuVariant=external`
— they click it: it fills the empty **Associate** boxes of the **Standard Parcel** service with
that day's drivers from the Live board, start time by start time, and lists anything it couldn't
place. **Amazon keeps nothing until the service's Save is pressed, and the bookmark never
presses it** — dispatch checks the screen and presses Save.

On the new Dispatch page (Legacy view off) it only says: turn on Legacy view (with a link to
the legacy page for that day). Amazon page notes: docs/amazon-roster-dom.md, section
"Legacy view".

Modeled on Morning Operations' `site/grab.js` (the "📦 Stops → Assigner" bookmark):
the bookmark only injects `<APP>/roster.js?<time>`, so fixing `roster.js` fixes every
computer without re-adding the bookmark.

## Re-running it, and the Live board vs Amazon's routes (Jose 2026-11-12)
The bookmark can be clicked again on a day that was already rostered (and saved): it picks up
whatever changed on the Live board since.

**Step 1 — the Live board checklist.** Before filling, `roster.js` counts Amazon's associate
rows for the day across **every** service (Standard Parcel, Electric, Nursery, Hub…) and sends
that number with its request (`rows`). The app window loads the week's rules engine and runs
`roster_plan` (runner.py). Route drivers = plain routes + trainees (a ride-along trainer needs
no row). If the numbers differ, or someone works 6 days in 7 with no backup day, the panel shows
a checklist before anything else:
- **More route drivers than Amazon rows** → the worst-ranked route drivers become backups
  (ticked).
- **Fewer** → the best-ranked of that day's **backups** get a route (ticked). A backup for whom it
  would be a 6th day is listed **unticked** ("only if you tick it"); a backup who asked for the day
  off is never offered. If that still isn't enough: "Still N routes short — add someone on the
  Live board or fill by hand".
- **6 days in 7, no backup day** (a 7-day window holding that day with 6+ worked days, every one a
  full shift — could go over 60 hours) → offered **unticked**: make them a backup, and the best
  backup left takes their route.
- Ranking (who keeps / gets a route), like "Who can work extra?": no rule breaks → goes past a
  soft limit → overtime → 6 days in 7 (never picked by itself) → compliance; then the board tier
  (Top performer, Solid, Fair, Unrated, Underperforming, Termination review; no board tier → the
  build group); then less overtime.
- **Overtime is money (Jose 2026-11-12).** Each driver's week is estimated in real clock hours:
  days already over at their real hours (Route Tracker), the rest at that driver's **own** usual
  day length (average of their last 10 real days over 4h, this week and last; 10h with fewer than
  2). Anyone that estimate puts over 40h is in the overtime group, even if the rules' 10h plan
  says not. Inside the overtime group the driver with less overtime wins only when it saves
  **3 hours or more** (`OT_SAVE_H` in runner.py); closer than that, the better tier wins. The
  checklist shows it: "about 46h this week with this route (days run ~11.4h), ~6h overtime".
- Training pairs are never touched (they change only by a rebuild).

**Change the Live board** sends the ticked items (`jajb-roster-apply`) to the app window, which
runs `roster_apply` — one undo step, one save (expected rev; a save someone beat is redone up to
3 times), one change-log line each ("… to match Amazon (Sat: 30 routes, 9 backups)"). The counts
follow: a route made a backup = one route less at its wave and one backup more; a backup made a
route = one route more (when the wave is full) and one backup less. The app answers
`jajb-roster-applied {date, results, payload}` with the day sent again, fresh, and the fill
preview is built from that. **Skip — fill as it is** changes nothing on the Live board. If the
engine can't load, the panel says so and fills as before.

**Step 2 — the fill, with swaps.** A Standard Parcel row holding someone who isn't a route
driver on the Live board any more ("stale" — matched the same way, Transporter ID then name; an
ambiguous match counts as on the board) is a free row: empty rows fill first, then a stale row
gets a Live board driver **in that person's place** ("Replaced: …"); a stale row nobody is
left for is **emptied** ("Taken off: …"). If Amazon won't take a swap (red ! etc.) the person is
put back. Rows holding a Live board route driver are never touched; other services are never
touched. Still nothing is saved until dispatch presses Save.

## Who goes in the Associate boxes
- Every driver whose cell that day is a route (a wave time, e.g. `10:25 AM`).
- Trainees: cell `10:25 AM (TRAIN drives w/ X)` → the trainee goes in a box (trainer rides along).
- Left out: trainers (`(TRAIN helper w/ …)`), backups (`… Backup`), Dispatch,
  Meeting, Unavailable, marks (call-off etc.), blank.
- Start time: Amazon block = schedule time **+20 min** (`scheduleToPortal` in
  `public/app/lib/waves.js` — the only place that conversion lives), sent as `portal`.

## Pieces
| File | Role |
|---|---|
| `public/roster.js` | Runs inside Amazon's page. Panel, hand-off, filling. Plain script, no imports. |
| `public/app/roster-send.js` (+ hook in `main.js`) | App opened as `#roster=YYYY-MM-DD`: reads the Live board, sends the day. |
| `public/app/roster-moves.js` (+ hook in `main.js`) | App opened as `#roster-moves=YYYY-MM-DD`: moves the drivers Amazon got at another start time on the Live board too (2026-10-23). |
| `public/solver/runner.py` `apply_wave` `move_count` | The engine op for that: the driver's route and one route count move to the new wave together. |
| Live board toolbar | The draggable `🧾 Roster to Amazon` bookmark link + one-line how-to. |
| `tests/roster_mock/scheduling-legacy.html` | Local copy of the legacy page for testing (README there). |

## Hand-off contract (window.postMessage) — unchanged
1. `roster.js` reads the date from Amazon's URL (`?date=YYYY-MM-DD`; checked against the
   date bar `Sat 24-Oct`, which is also the fallback) and opens `APP + "#roster=" + date` in
   a small window named `jajbRoster` (`width=440,height=560`).
2. The app page, once signed in and the summary is loaded, posts
   `{type: "jajb-roster-ready"}` to `window.opener` with targetOrigin
   `"https://logistics.amazon.com"`.
3. `roster.js` (checks `e.origin === APP_ORIGIN`) replies
   `{type: "jajb-roster-request", date, rows}` (rows = Amazon's associate rows, every service, or null — 2026-11-12).
4. The app checks `e.origin === "https://logistics.amazon.com"` (never sends to any
   other origin) and answers:
   ```js
   { type: "jajb-roster", date: "2026-10-10", week: "2026-10-04", rev: 12,
     label: "Week 41", dayName: "Sat",
     drivers: [ { name: "Barry Hughes", tid: "A1B2…"|null,
                  sched: "10:25 AM", portal: "10:45 AM", trainee: false,
                  trainer: null /* trainee → trainer's name */ } ],
     skipped: [ { name: "Cara Amos", why: "Trainer" | "Backup" } ],
     error: null /* or plain-words text: "No Live board for that week" … */,
     plan: { live, rows, diff, short, pairs, rev, changes: [ { id, kind: "backup"|"route"|"six",
             name, wave, why, checked, with?, with_wave?, with_why? } ] } | null,
     planError: null /* or why the engine couldn't check (2026-11-12) */ }
   ```
   With changes in the plan the window stays open for `jajb-roster-apply` (see "Re-running it").
   Otherwise it shows "Sent Saturday Oct 10 to Amazon — this window closes by itself" and
   closes after ~3 s.
5. Errors (not signed in, no access, week not published, day closed) are sent as
   `{type:"jajb-roster", error:"…"}` and also shown in the app window.

## Filling rules (roster.js)
- Only **Standard Parcel** services are filled. Nursery Route, WW Hub Transport and any
  other service are left alone and listed ("Left for you: Nursery Route Level 1 — 1 row,
  1 empty"). Amazon opens one service at a time, so the bookmark opens Standard Parcel with
  its "+" if needed; if a second Standard Parcel service has empty rows it says to Save
  first, open that one, and click again. If Amazon won't open it (it asks about unsaved
  changes elsewhere), the bookmark stops and dispatch answers Amazon.
- Rows are grouped by start time (`10:25 am`); each group gets the drivers whose `portal`
  is that time, in the payload's order, top row first.
- Never touch a row that already has a Live board route driver (a stale one is swapped / emptied — see "Re-running it" above). Never place a driver Amazon already
  shows on any row that day (any service).
- Matching, all local (Amazon's search can't match our names): the payload `tid` against
  the option value (Amazon's value is the Transporter ID), then the name — normalized
  case, accents, punctuation, middle names ("Barry Hughes" matches "Barry Len Hughes";
  the phone and station part of Amazon's option text are ignored). Two matches → not
  placed, listed. Inactive associates are never picked.
- Each pick is checked: the box must show the name; a red `!` from Amazon (e.g. an
  overlapping block) empties that row again and lists the driver.
- Another start time (Jose 2026-10-23): Amazon's wave split often differs from the
  schedule's. A driver left over at their start time, or whose start time has no rows on
  Amazon, goes into a spare empty row at the nearest other start time (later one on a tie).
  The panel names the same people once on each side (one move, never a swap; Jose 2026-11-14):
  the sending time "6 more drivers than Amazon has rows here, so these drivers go to **10:25 AM**
  instead: …", the receiving time "Amazon has 6 more rows here than drivers, so these drivers come
  over from **10:45 AM**: …". Each start time's header is "Amazon: 18 rows (N already have someone)
  · Live board: 12 drivers" - not "18 empty rows", which read as 18 short. Once their pick is in,
  the Live board is moved to match (next section).
- Report in the panel: filled N of M; not in Amazon's list; more than one match;
  already on a row; left over (fewer empty rows than drivers); empty rows left; start
  times with no rows on Amazon; services left for dispatch.
- Last line, always: "Nothing is saved yet. Check the screen, then press **Save** (under
  the Standard Parcel rows) yourself." Never Save, Cancel, SUBMIT, Auto Roster, Bulk
  Import or a red X.

## The Live board follows a moved driver (Jose 2026-10-23)
Example: Sat Oct 24, Tiamia Allen Schwalbe is `10:05 AM` on the Live board; Amazon has no
spare 10:25 am row, so the bookmark puts her on Amazon's 10:45 am (= schedule 10:25 AM).
After the fill the Live board shows her at 10:25 AM, so the two match.

**Rule.** Only a driver whose pick actually went in on Amazon (status "placed") is moved.
On the Live board their route moves to the new wave **with its count**: that day's wave
counts get one less at the old time and one more at the new one, the day's total stays
(the board's per-wave route counts are exact). One engine call per driver
(`apply_wave {day, name, wave, move_count: true, note: "to match Amazon"}`), all of them in
**one save** (expected rev, like any Live board change), one change-log line each:
`Moved Tiamia Allen Schwalbe Sat 10:05 AM -> 10:25 AM to match Amazon (routes 10:05 AM 9->8, 10:25 AM 11->12)`.
Since 2026-10-29 a count mismatch never stops a move: a driver who was an extra at the old time
(that wave had more drivers than routes, e.g. a count of 0 — Fri 10-23 "has no 10:45 AM route count")
moves as an extra and no count goes along (`... (an extra route - 10:25 AM is now 25/24)`), and a
start time the board has no wave at yet gets one. The Live board's own "Change wave" pop-up
has the same move ("Move to 10:25 AM") next to the old trade-times list.
Nothing else changes. Not moved (with a plain why, and dispatch changes it by hand):
- the driver isn't at the old time on the Live board any more ("the Live board changed — not
  at 10:05 AM any more"; a Live board saved since Amazon's page read it is read again and each
  driver checked again, and a save someone else beat is read again and redone, up to 3 tries);
- a trainee / trainer: the engine never splits a training pair (training days change only
  by a rebuild), so it's refused ("in a training pair with X — the trainee and trainer can't
  be moved apart");
- not on the week; no engine saved.
Like Amazon's own picks, this happens before dispatch presses Save on Amazon.

**Hand-off contract (window.postMessage)**
1. On **Fill**, when the plan has a moved driver, `roster.js` opens
   `APP + "?r=<time>#roster-moves=" + date` in a window named `jajbRosterMoves`
   (`width=440,height=560`) — inside the click, so pop-up blocking doesn't stop it.
2. The app page (`roster-moves.js`) checks sign-in + Schedule Builder access, reads that week
   and loads its rules engine while Amazon is filled, and posts
   `{type: "jajb-roster-moves-ready"}` to `window.opener` every second (targetOrigin Amazon's
   origin; the test origin too when `localStorage['jajb-roster-test-origin']` is set).
3. Once the fill is over (or stopped, or the panel closed mid-fill), `roster.js` answers the
   next ready (`e.origin === APP_ORIGIN`, `e.source` = the window it opened) once with
   ```js
   { type: "jajb-roster-moves", date: "2026-10-24", week: "2026-10-18", rev: 12 /* the roster hand-off's */,
     moves: [ { name: "Tiamia Allen Schwalbe", tid: "A1B2…"|null,
                from: "10:05 AM", to: "10:25 AM" /* schedule times */ } ] }
   ```
   `from` is the driver's schedule time from the roster hand-off; `to` is Amazon's start time
   −20 min (`toSched` in roster.js, checked against `portalToSchedule` by the test). An empty
   list is sent too, so the window closes itself.
4. The app accepts it only from `window.opener` at an allowed origin, checks it (that day,
   schedule times, at most 200), moves the drivers, and answers that origin only:
   `{type: "jajb-roster-moves-done", date, results: [{name, ok, why?}], error?}`.
   Full success: "Live board updated…" and it closes after ~4 s; any failure: it stays open.
5. `roster.js` waits up to 90 s for the ready / the answer (the engine may still be loading)
   and adds to the final panel, above the Save line (the Moved to / Moved here lines stay):
   "**Live board updated:** Tiamia Allen Schwalbe → 10:25 AM", or per driver
   "Live board NOT updated for X: <why> — change it there by hand (to 10:25 AM)."
   An answer that comes after the 90 s still replaces the line.

## EDV routes first (Jose 2026-11-24)

Amazon's "Standard Parcel Electric - Rivian MEDIUM" rows are EDV routes. The app window tags each
route driver (roster-send.js `tagEdv`): `list` = on the Vehicle Assigner's EDV drivers list (Fleet tab,
Firestore `assigner/edv`) and EDV-certified (or certification unknown), `cert` = EDV-certified
(dispatch/lists.driverInfo.cert) but not on the list, `nocert` = on the list but Amazon shows no EDV
certification (never put on an EDV row), `''` = anyone else and every trainee.

While the EDV service has an empty row and an EDV driver isn't on Amazon yet, the bookmark fills the
EDV service first:
1. List drivers go in at their own start time, else at the nearest EDV start time (the Live board
   follows, like any moved driver).
2. Rows still free: a pick list of the `cert` drivers on a route that day; dispatch ticks up to the
   number of free rows.
3. Dispatch presses Save under the EDV rows and clicks the bookmark again: Standard Parcel gets everyone
   else (EDV drivers are "already on Amazon").
"Skip EDV — fill Standard Parcel" goes straight to Standard Parcel; list drivers are then kept off it
while the EDV service has an empty row. Mock: `tests/roster_mock/seed-edv.js` + `scheduling-legacy.html?set=edv`.

## Routes Amazon moved to another time (Jose 2026-11-24)

When a day is rostered early and Amazon later moves a route to another start time, the rostered row
stays at the old time ("Over assigned" in the week view) and an empty row shows at the new one: more
rows than routes (Wed Nov 25: 41 rows, 38 routes). So the bookmark counts routes from Amazon's own
numbers, not rows: each service header's "N Confirmed" for the Live board check, and the "Confirmed
Routes" list (one `.schedule` per start time with its route count) per start time (`readCaps`; used only
when it adds up to the Confirmed number, else every row counts as before). At a start time holding more
drivers than routes, the extra drivers (someone the Live board has at another time first, then the last
rows) leave: their old row is emptied and they go into a free row at their own Live board time, else the
nearest one (the Live board follows, like any move). If the new row won't take them they're put back.
Mock: `scheduling-legacy.html?set=edv&moved=1` with `seed-edv.js` (Rita Reg 10:25 → 11:05).
