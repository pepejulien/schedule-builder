# Roster bookmark (Schedule Builder → Amazon Dispatch)

Jose 2026-10-09. A bookmark dispatch drags off the **Live board** once. On Amazon's
Dispatch page (logistics.amazon.com/dispatch?date=…&serviceAreaId=…) → **Edit route
assignment** → *Edit assignments*, they click it: it fills every route's **Select DA**
box with that day's drivers from the Live board, wave by wave, and lists anything it
couldn't place. **It never presses Save** — dispatch checks the screen and saves.

Modeled on Morning Operations' `site/grab.js` (the "📦 Stops → Assigner" bookmark):
the bookmark only injects `<APP>/roster.js?<time>`, so fixing `roster.js` fixes every
computer without re-adding the bookmark.

## Who goes in the DA boxes
- Every driver whose cell that day is a route (a wave time, e.g. `10:25 AM`).
- Trainees: cell `10:25 AM (TRAIN drives w/ X)` → the trainee goes in a DA box.
- Left out: trainers (`(TRAIN helper w/ …)`), backups (`… Backup`), Dispatch,
  Meeting, Unavailable, marks (call-off etc.), blank.
- Wave: Amazon block = schedule time **+20 min** (`scheduleToPortal` in
  `public/app/lib/waves.js` — the only place that conversion lives).

## Pieces
| File | Role |
|---|---|
| `public/roster.js` | Runs inside Amazon's page. Panel, hand-off, filling. Plain script, no imports. |
| `public/app/roster-send.js` (+ hook in `main.js`) | App opened as `#roster=YYYY-MM-DD`: reads the Live board, sends the day. |
| Live board toolbar | The draggable `🧾 Roster to Amazon` bookmark link + one-line how-to. |

## Hand-off contract (window.postMessage)
1. `roster.js` reads the date from Amazon's URL (`?date=YYYY-MM-DD`, fallback: the
   page's date picker) and opens `APP + "#roster=" + date` in a small window named
   `jajbRoster` (`width=440,height=560`).
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
- Group Amazon's routes by wave time; match to the payload's `portal` time.
- Never touch a route that already has a DA. Never place a driver Amazon already
  shows on another route.
- Fill in the payload's order. Match a driver to an option of the Select DA search by
  name (normalized: case, accents, punctuation, middle names — "Barry Hughes" matches
  "Barry Len Hughes"), and by Transporter ID when the page shows one.
- Report in the panel: filled N of M; drivers not found in Amazon's list (likely not
  eligible that day); drivers left over (wave has fewer routes); routes left empty;
  waves on Amazon with no schedule wave (or the reverse).
- Last line, always: "Check the screen, then press **Save changes** yourself."
