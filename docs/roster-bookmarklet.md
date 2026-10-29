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
   `{type: "jajb-roster-request", date}`.
4. The app checks `e.origin === "https://logistics.amazon.com"` (never sends to any
   other origin) and answers:
   ```js
   { type: "jajb-roster", date: "2026-10-10", week: "2026-10-04", rev: 12,
     label: "Week 41", dayName: "Sat",
     drivers: [ { name: "Barry Hughes", tid: "A1B2…"|null,
                  sched: "10:25 AM", portal: "10:45 AM", trainee: false,
                  trainer: null /* trainee → trainer's name */ } ],
     skipped: [ { name: "Cara Amos", why: "Trainer" | "Backup" } ],
     error: null /* or plain-words text: "No Live board for that week" … */ }
   ```
   Then shows "Sent Saturday Oct 10 to Amazon — this window closes by itself" and
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
- Never touch a row that already has an associate. Never place a driver Amazon already
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
  The panel says "Moved to 10:45 AM" / "Moved here from 10:25 AM". Once their pick is in,
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
