# Roster bookmark — local mock (TEST ONLY)

Runs `public/roster.js` end to end on this PC against a copy of Amazon's Dispatch
"Edit assignments" screen (`dispatch.html`, built from `docs/amazon-roster-dom.md`).

1. Start both servers (two origins, like Amazon and the app):
   - `python tests/live_mock/serve.py` → app + mock JAJB on http://localhost:8777
   - `python -m http.server 8791 --directory tests/roster_mock` → this page
   (`.claude/launch.json`: `live-mock` and `roster-mock`).
2. In a tab on http://localhost:8777, paste `seed.js` into the console: it writes the
   Live board week 2026-10-04 that matches the mock page and sets
   `localStorage['jajb-roster-test-origin'] = 'http://localhost:8791'` (the app then also
   answers that origin). Remove the key when done.
3. Open http://localhost:8791/dispatch.html?date=2026-10-10 , click **Edit assignments**,
   then **Run the bookmark (test)** (same injection as the real bookmark, from
   `?app=` — default http://localhost:8777/).

`dispatch.html` sets `window.__jajbRosterTest = true`; roster.js then skips only its
"is this logistics.amazon.com/dispatch" check. Options: `?frame=1` (an iframe named
`jajbRoster` catches roster.js's own `window.open(…, "jajbRoster")` — for the built-in
preview browser, which has no pop-ups), `?legacy=1`, `?search=x`, `?date=…`.
`window.__mock.log` records any click on Save changes / Auto-roster Vehicle / Cancel
(roster.js must leave it empty).

What the mock day holds: 10:25 AM (5 routes; Olga Pre and Pat Quinn already on two),
10:45 AM (8; Steven Dale Heilmann already on one), 11:05 AM (2, nobody scheduled).
Expected fill: 8 boxes planned, 7 filled — Hank Hours trips a fake "Over the weekly hours
limit" warning and that box is cleared; Nora Notlisted not in Amazon's list; Dora Moss
left over; Sam Lee ambiguous (Sam Lee / Sam K Lee); Mike Rowe matched to "Michael  Rowe" by
Transporter ID (fake React `daPool`); Jose Nunez matched to "José Núñez"; Zed Late's
11:25 AM wave doesn't exist on the page.
