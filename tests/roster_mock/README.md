# Roster bookmark — local mock (TEST ONLY)

Runs `public/roster.js` end to end on this PC against a copy of Amazon's legacy
Dispatch page — the old Scheduling day page (`scheduling-legacy.html`, built from
`docs/amazon-roster-dom.md` "Legacy view"; Jose 2026-10-23).

1. Start both servers (two origins, like Amazon and the app):
   - `python tests/live_mock/serve.py` → app + mock JAJB on http://localhost:8777
   - `python -m http.server 8791 --directory tests/roster_mock` → this page
   (`.claude/launch.json`: `live-mock` and `roster-mock`).
2. In a tab on http://localhost:8777, paste `seed.js` into the console: it writes the
   Live board week 2026-10-04 that matches the mock page and sets
   `localStorage['jajb-roster-test-origin'] = 'http://localhost:8791'` (the app then also
   answers that origin). Remove the key when done.
3. Open http://localhost:8791/scheduling-legacy.html?frame=1 (day 2026-10-10) and press
   **Run the bookmark (test)** (same injection as the real bookmark, from `?app=` —
   default http://localhost:8777/), then **Fill 7 rows**.

The page sets `window.__jajbRosterTest = true`; roster.js then skips only its "is this
logistics.amazon.com" check. `?frame=1`: an iframe named `jajbRoster` catches roster.js's
own `window.open(…, "jajbRoster")` (the built-in preview browser has no pop-ups).
`window.__mock.log` records clicks on Save / Cancel / SUBMIT / red X / Auto Roster / Bulk
Import / the pop-up (roster.js must leave it empty); `window.__mock.picked()` lists the
unsaved picks.

What the mock day holds: Standard Parcel (collapsed) — 10:25 am 4 rows (Olga Pre on one),
10:45 am 9 rows (Steven Dale Heilmann on one); WW Hub Transport CDV (1 empty row); Nursery
Route Level 1 (Pat Quinn); Nursery Route Level 3 (1 empty row); a hidden 0-route service.
Expected: Standard Parcel opened, 8 rows planned, 8 filled (Amy, Bea, Carl → "Carl Dee Fox",
an option with no phone; Barry → "Barry Len Hughes", Tina, Mike → "Michael Rowe" by
Transporter ID, Jose Nunez → "José Núñez"); Nora not in Amazon's list; Dora (10:25 AM has only 3 empty rows) moved to 10:45 AM and listed as moved — 8 filled;
Sam Lee ambiguous (Sam K Lee / Sam Lee); Hank Hours Inactive; Steven and Pat already on a
row (Pat on Nursery Route Level 1); Zed's 11:25 AM has no rows; the other services listed as
left for you; log empty.

Other checks: `?flag=A-TINA` (Amazon shows a red ! after Tina's pick → that row is emptied
again, 6 of 7), `?chosenonly=1` (the page ignores a plain change event → roster.js picks
through the Chosen box; same result), `?dirty=1` (Nursery Route Level 3 open with an unsaved
pick → Amazon's "discard?" pop-up shows and roster.js stops without answering it),
`?filter=1&open=sp` (warns to set the Filter back to All), `?bar=Sun%2011-Oct` (date bar
disagrees with the address → stops). `dispatch.html?date=2026-10-10&serviceAreaId=x` (the
old copy of the new Dispatch page) now only gets "turn on Legacy view" with a link.

With this seed (no rules engine saved) Dora's Live board move answers "Live board NOT updated for
Dora Moss: That Live board week has no rules engine saved — change it there by hand (to 10:25 AM)."

### Moved driver → the Live board follows (Jose 2026-10-23)
1. `python tests/live_mock/make_seed.py` once (writes `tests/fixtures/live-seed.json`, a real engine week).
2. In the http://localhost:8777 tab, paste `seed-moves.js` into the console: the engine week 2026-10-04
   (Sat Oct 10: 10:45 AM Alex Keller, Colin Drake, Casey Church; 11:05 AM Grace Nolan), its change log
   emptied, + the test origin.
3. Open http://localhost:8791/scheduling-legacy.html?frame=1&set=engine (Standard Parcel only: 11:05 am
   2 rows, 11:25 am 2 rows), **Run the bookmark (test)**, then **Fill 4 rows**. `?frame=1` also adds an
   iframe named `jajbRosterMoves` for the moves window.
Expected: Casey Church moved to 11:25 AM on the page; the moves window says "Live board updated to match
Amazon (1 driver)"; the panel adds "Live board updated: Casey Church → 11:05 AM" above the Save line. The
mock Live board week is then rev 2: Casey Sat `11:05 AM`, Sat waves `10:45 AM 2, 11:05 AM 2` (was 3 / 1),
total 4, change log "Moved Casey Church Sat 10:45 AM -> 11:05 AM to match Amazon (routes 10:45 AM 3->2,
11:05 AM 1->2)". Write another save of that week between Run and Fill (rev 2): still moved, saved as rev 3.
Put a copy where Casey is already at 11:05 AM there instead: "Live board NOT updated for Casey Church: the
Live board changed — not at 10:45 AM any more", nothing saved. Remove the test-origin key when done.

## Week bookmark (schedweek.js) — same servers
1. In the http://localhost:8777 tab, paste `seed-week.js` into the console (NEXT week + the test origin;
   the mock page shows the same week, so no day is "already over").
2. Open http://localhost:8791/scheduling.html?frame=1 and click **Run the bookmark (test)**. The tab
   must have a real size (the built-in preview: set a viewport, e.g. 1400x900) or no menu counts as open.
Expected: 13 to fill (12 to put in + Lou's Tue backup already in; Test: Cara only = 2), Nora not on the
page, Zed has no 2:00 PM shift, Una's Monday "Unavailable" left alone, Kim's Sunday already there.
Pass 1 "Putting in shifts 1/12…", then pass 2 "Ticking “Set as backup” 1/4…" (Cara Mon, Lou Tue, Bo Wed,
Bo Sat). At the end `window.__mock.cells()` shows `|BACKUP` on those 4 cells, no popover is left on
the page, and `window.__mock.log` (Publish / Auto-roster / Apply weekly pattern / "UNAVAILABLE TRAP")
stays empty. `window.__mock.applied` lists every pick and tick ("backup-LOST" = a tick on a shift
Amazon hadn't saved yet).
Like the real page (Jose 2026-10-23): popovers stay on screen a moment while closing, a picked shift
is saved and re-drawn after `?savems=900`, an Escape / outside click on an open shift-pick menu puts
"Unavailable" in the cell. Other checks: `?empty=1` (an empty week from scratch: 15 to put in, same 4
ticks), `?linger=1` (Amazon leaves the new shift's own menu open after a pick — the run closes it and
goes on), `?savems=4500` (slow saves), `?stuck=1` (a shift's menu won't close — the run stops at
Cara Amos — Mon and says to close the menu, then click the bookmark again).
