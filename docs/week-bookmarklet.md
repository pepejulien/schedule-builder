# Week bookmark (Schedule Builder → Amazon Scheduling)

Jose 2026-10-09. A bookmark dragged off the **Live board** (`📅 Week to Amazon`, next to
`🧾 Roster to Amazon`). On Amazon's **Scheduling** page in the **Week** view
(logistics.amazon.com/scheduling/calendar-view/week?date=…&serviceAreaId=…), go to the week and
click it: it fills each driver's empty day cells with their shifts from that week's Live board.
Same structure as the Roster bookmark (docs/roster-bookmarklet.md): the bookmark only injects
`<APP>/schedweek.js?<time>`.

## What goes in (Jose: "everything")
| Live board cell | Amazon shift (button title in the cell's menu) |
|---|---|
| route `10:05 AM`, trainee `… (TRAIN drives w/ …)`, backup `10:05 AM Backup` | `Driver • 10:05 AM • 9h 50m` |
| trainer `… (TRAIN helper w/ …)` | `Helper 10:05 AM` / `Helper • 10:45 AM • 10h 50m` |
| `Dispatch` | `Dispatcher • 9:15 AM • 12h` (the first Dispatcher shift) |
| `… Meeting` | `Meeting` |
| blank, Unavailable, call-off / no-show / day off, left the company | nothing |

Our times are **schedule** times and match Amazon's Scheduling shifts directly (Dispatch's route
blocks are 20 min later — that is the Roster bookmark's conversion, not this one's).

## Amazon's page (read 2026-10-09)
- Header: `Week 42: Oct 11 - Oct 17, 2026`; day headers `Sun, Oct 11` … `Sat, Oct 17`.
- One row per associate: the name in `<p title="First Middle Last <email>">`; the row element has
  2 children, the second wraps a div with **7 day cells**, Sun..Sat. An empty cell is bare divs; the
  inner box has a React 16 `onMouseEnter`: hovering adds a box with an `onClick` holding
  `<span role="img" aria-label="Assign">` ("+"), and clicking THAT opens the shift menu (clicking the
  cell itself does nothing). React 16 makes mouseenter from a `mouseover` with **no relatedTarget** —
  a synthetic one with a relatedTarget is ignored (the first version's bug). A filled cell shows the time ("10:05 AM",
  "4 PM") or "Unavailable"/"Meeting", and clicking it opens a different menu (delete, repeat…).
- The shift menu: `[role=dialog][aria-expanded=true]` (`popover-N`) with "Apply weekly pattern",
  the text "Apply single shift", and one button per shift with `<p title="Driver • 10:05 AM • 9h 50m">`.
- The **Shifts** panel lists the same titles as `p[title]` outside any dialog — read first, so a
  menu is only opened when its shift exists.
- **Picking a shift applies it immediately** (unpublished; "Publish until …" sends it to AtoZ).
  There is no Save. On 2026-10-09 an Escape + outside click on an open menu left "Unavailable" in
  the cell — so the bookmark never closes a menu any other way than by picking its shift, and stops
  if a menu is open when it shouldn't be.

## Hand-off (window.postMessage, like the Roster bookmark)
`schedweek.js` opens `APP?r=<time>#schedweek=<Sunday>` (window `jajbWeek`); the app
(`public/app/week-send.js`) posts `{type:"jajb-week-ready"}` to Amazon's origin, gets
`{type:"jajb-week-request", week}`, answers
`{type:"jajb-week", week, rev, label, days:[{day,date,open}], drivers:[{name, tid, shifts:{Sun:{kind,time?,what}}}], error}`.

## Rules (schedweek.js)
- Names: exact (accents/case ignored), else same first + last word with every word of ours in
  Amazon's ("Cara Amos" ~ "Cara Lea Amos"); more than one match → not filled, listed.
- Never touches a non-empty cell (listed as "already has something else"; the same shift there =
  "already in Amazon"). Skips days already over. Never clicks Publish, Auto-roster or Apply weekly pattern.
- "Test: <first driver> only" fills one driver's week first; then Start over for the rest.

Local test: `tests/roster_mock/scheduling.html` + `seed-week.js` (see tests/roster_mock/README.md).
