# Amazon Dispatch "Edit assignments" — DOM notes for the roster filler (new view; Legacy view at the end)

Checked 2026-10-09 in Jose's Chrome on
`logistics.amazon.com/dispatch?date=2026-10-10&serviceAreaId=38cd…` (WWV9), new
(non-legacy) view. Oct 10 was "Routes pending": 1 cycle, 2 waves (10:25 AM = 8 routes,
10:45 AM = 23 routes), every route code `—`, every DA empty. Nothing was saved (see
the end).

The page is React + Amazon's "Meridian" design system (`mdn-*` attributes). Class
names (`css-1h2ruwl`, …) are emotion hashes: **unstable, never use them**. Element
ids like `select--r1l-`, `options-list--r1m-`, `expandable--r4-` come from React
`useId`: they change on every render tree. Use them only *at runtime* (read an
`aria-controls`, then `getElementById`), never hard-code them.

No iframes. Only 2 shadow roots (`LP-BANNER-CONTAINER`, `COMPANION-FLOATING-WIDGET`,
the site chrome); the dispatch table is in the normal DOM.

## 1. Is Edit assignments open? Which date?

- **View mode**: toolbar button text `Edit assignments`; the DA cell is
  `<div data-tour-anchor="da-hours"><div><p mdn-text>—</p></div></div>` (a name
  instead of `—` when assigned).
- **Edit mode** (after clicking it): toolbar shows `Cancel` + `Save changes`
  (Save is `disabled` until something changes, and again while any conflict alert
  shows), a blue banner `Editing assignments — changes are saved when you click
  "Save changes"` with an `Auto-roster Vehicle` button (never touch), and every
  route row has a Select DA combobox.
  Stable test:
  ```js
  const isEditing = () => !!document.querySelector('input[role="combobox"][aria-label="Select DA"]')
    && [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Save changes');
  ```
- **Legacy view**: a switch `input[role="switch"]` labelled "Legacy view" in the
  header. Everything in sections 1–7 is for Legacy view **off** (`checked === false`).
  With it on, `/dispatch` redirects to the old Scheduling page — see **Legacy view**
  at the end; that is the page `roster.js` fills since 2026-10-23.
- **Date**: URL `?date=YYYY-MM-DD` (`new URLSearchParams(location.search).get('date')`).
  (Not checked: whether the prev/next arrows rewrite the URL. Comparing it with the
  picker text below and refusing on a mismatch is cheap.) Fallback:
  the `<p>` between `button[aria-label="Previous day"]` and
  `button[aria-label="Next day"]`, text `Saturday, October 10, 2026`.
- Header search box `input[placeholder^="Search associates"]` (id `search-field-N`)
  filters the table; warn if it isn't empty.

## 2. Structure: cycles, waves, rows

```
div  ── cycle bar: <p>"CYCLE 1"</p><p>"2 waves"</p><span>"Routes pending"</span> … <p>"31 routes"</p>
div
  div[role=button][aria-expanded][aria-controls="expandable--r4-"][aria-label="10:25 AM  - 8 routes"]   ← wave header
     span[mdn-expander-title] > div > div > p "10:25 AM" | p (empty) | p "8 routes"
  div[aria-hidden=false]
     div#expandable--r4- > div > table[data-mdn-table][aria-label="Dispatch routes"]
        thead th: Route | Service Type | Duration | DA | Staging | Vehicle | Asset | (menu)
        tbody tr[role=row][data-mdn-table-row][aria-level=1] … one per route
```

- **Wave label**: `header.querySelector('[mdn-expander-title] p').textContent.trim()`
  → exactly `"10:25 AM"` / `"10:45 AM"` (h:mm AM/PM, no leading zero). The header's
  `aria-label` is `"10:25 AM  - 8 routes"` (note the **two** spaces). These are Amazon
  block times = schedule time + 20 min, so they match the payload's `portal`.
- **Wave → rows**: for each `div[role="button"][aria-controls]`, take
  `document.getElementById(aria-controls)`; if it contains
  `table[aria-label="Dispatch routes"]`, its `tbody tr` that contain a Select DA input
  are the routes (filter by the input — `tr[aria-expanded]` rows could grow child
  rows). Only one cycle was on the page; with several cycles the same scan returns
  every wave of every cycle, in page order (a wave time could repeat across cycles —
  group by label and warn on duplicates).
- **Route code**: `tr.cells[0].innerText.trim()` (`td > div > div > div > p > span`).
  While the cycle shows **Routes pending** it is `—` for every row, so the filler must
  not depend on route codes — fill by position within the wave. (Format once routes
  are published was not seen: Oct 10 had none yet.)
- Other cells: `cells[1]` service type ("Standard Parcel - Extra Large Van - US",
  "WW Hub Transport - Extra Large Van - US"), `cells[2]` duration ("10h", "8h").
- **Select DA input per row** (edit mode only):
  ```html
  <div mdn-input-box id="select--r1l-">
    <input role="combobox" aria-label="Select DA" aria-haspopup="listbox"
           aria-expanded="false" aria-autocomplete="list" placeholder="Select DA" value="">
    <div mdn-select-value id="select--r1l--value">Select DA</div>   ← shown value
  </div>
  ```
  Selector: `tr.querySelector('input[role="combobox"][aria-label="Select DA"]')`.
  The input's own `value` is only the **search text**; it is `""` even after a DA is
  chosen. The chosen DA is the text of `[mdn-select-value]`.
- A collapsed wave (header clicked) keeps its rows in the DOM; nothing to expand.

## 3. Does a route already have a DA? Is a DA used elsewhere?

- **Has a DA** (edit mode): the cell has
  `button[data-clear-btn][aria-label="Clear DA assignment"]` ("×", opacity 0 until
  hover, but present and clickable), and `[mdn-select-value]` holds the name. Empty:
  no clear button and `[mdn-select-value]` text is `Select DA`.
  ```js
  function currentDA(tr) {
    const v = (tr.querySelector('[mdn-select-value]')?.textContent || '').replace(/\s+/g, ' ').trim();
    const hasClear = !!tr.querySelector('button[aria-label="Clear DA assignment"]');
    return hasClear || (v && v !== 'Select DA') ? v : null;
  }
  ```
  Verified on rows I filled myself. Not verified on a route that was *saved* with a
  DA before opening edit mode (Oct 10 had none) — expected to look the same, but
  the filler should treat "any text other than `Select DA`" as taken (it does).
- **DA already used on another route**: in every other box's dropdown that DA moves
  out of the `Available` group into a group titled
  **`Assigned to an overlapping block`**. It is **still clickable** (not disabled). If
  it is picked anyway, *both* rows get an inline alert
  `<… role="alert">Assigned to an overlapping block</…>` under the box, and
  **Save changes becomes disabled**. Clearing one of them removes both alerts. So the
  filler must only pick options in the `Available` group. (In my test a 10:25 and a
  10:45 route counted as overlapping: both are 10 h blocks.)

## 4. Filling a Select DA box (tested)

- `input.focus()` alone does **not** open the list. A real mouse click on the box
  does; programmatically, the React `onChange` does:
  ```js
  const setVal = (inp, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, v);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  };
  ```
  After `setVal(inp, 'barry')` the combobox gets `aria-expanded="true"` and
  `aria-controls="options-list--rNN-"` and the list is filtered — no keyboard events
  needed. React ignores a "change" to the value it already has, so to re-run the
  same search (e.g. `""`), set something else first (`q + ' '`), then `q`.
- **The list** is portaled to the end of `<body>` (not inside the row). Find it with
  `document.getElementById(inp.getAttribute('aria-controls'))` (the attribute only
  exists while open). Shape:
  ```html
  <div role="listbox" id="options-list--r1m-">
    <div role="group"><span role="presentation">Available</span>
      <button role="option" aria-label="Adam James Scott" aria-selected="false" mdn-option-list-item>
        … <p><strong>Adam James Scott</strong></p> … <p>29.1h/60h</p>
      </button> …
    </div>
    <div role="group"><span role="presentation">Assigned to an overlapping block</span> … </div>
  </div>
  ```
  - Name: the option's `aria-label` (= the `<strong>` text). Hours: the 2nd `<p>`,
    format `29.1h/60h` (worked hours this week, 1 decimal / compliance limit). Text
    via `innerText` is `"Adam James Scott\n\n29.1h/60h"`.
  - Sorted A→Z. 70 options for Oct 10, all rendered (no virtualization; the popover
    itself scrolls).
  - **No Transporter ID anywhere in the DOM.**
- **Search** is a case-insensitive *substring* match on the raw name: `barry`,
  `hughes`, `BARRY` find "Barry Len Hughes"; `barry hughes` finds **nothing**.
  23 of the 70 names contain a **double space** (e.g. `Steven  Dale Heilmann`), and
  `steven dale` finds nothing while `steven  dale` does. So don't rely on Amazon's
  search for matching: open with an empty search, read every option, match locally.
- **No match**: the combobox stays `aria-expanded="true"` but **no listbox element
  exists** (no "No results" text; just an empty popover edge). Treat "no element for
  aria-controls / 0 options" as not found.
- **Select**: `optionButton.click()` (its React `onClick`). The list closes
  (`aria-expanded="false"`), `[mdn-select-value]` shows the name, the clear "×"
  appears, Save changes enables. It settles well within the 300–400 ms waits I
  used; poll for `currentDA(tr) === name` up to ~1.5 s rather than a fixed wait.
- **Close without choosing**: `keydown` Escape on the input
  (`new KeyboardEvent('keydown', {key:'Escape', keyCode:27, bubbles:true})`) closes
  the list and clears the search text. `inp.blur()` does **not** close it.
- **Undo one box**: click `button[aria-label="Clear DA assignment"]` in that row.

## 5. Listing all eligible drivers at once

Yes: an empty search lists everyone eligible for that block, in groups. On the
first box of Oct 10: `Available` 70. After one test assignment, another box showed
`Available` 69 + `Assigned to an overlapping block` 1. Only these two group titles
were seen; other titles may exist (e.g. limits) — pick from `Available` only and
report any other group by its title.

Optional Transporter-ID hook (React internals, **unstable**, best-effort only): walk
the input's fiber (`inp[Object.keys(inp).find(k => k.startsWith('__reactFiber$'))]`,
then `.return`) until `memoizedProps.daPool` is an array. Each entry:
`{transporterId, name, complianceHours: 60, actualHours: 29.05,
currentlyRosteredTo: [], serviceAreaId, stationTag}`; `name` is the exact option
`aria-label` (same double spaces). The same props object has `rosterId` ("NEW_0"
for an empty row), `currentDriver` (null when empty) and `assignedTransporterIds`
(a `Set`, empty here even after a local pick). Component names are minified (`qc`),
but the prop names are not. If the walk fails, fall back to names.

## 6. Rendering, timing, pitfalls

- All 31 rows and all 70 options are in the DOM at once; no lazy rendering seen.
  Collapsed waves keep their rows.
- A list that just closed stays in the DOM for a moment (close animation). Always
  look it up through the *current* input's `aria-controls`, never a global
  `[role=listbox]` query.
- **Background tabs**: when the tab is hidden, Chrome throttles `setTimeout` (to 1 s,
  later ~1 min), and a filler loop of short sleeps stalls (this hit me: the run
  finished only when the tab was shown again). The bookmarklet runs in the visible
  tab, so it's normally fine; the snippet's `sleep` falls back to `MessageChannel`
  yields when `document.hidden`. React itself keeps rendering while hidden.
- Fill one box at a time and wait for it to settle. A picked DA moves to "Assigned to
  an overlapping block" in every other box, which is exactly the "don't place a
  driver Amazon already shows on another route" rule.
- Never click `Save changes` or `Auto-roster Vehicle`. `Cancel` discards with no
  dialog and returns to view mode.

## 7. Tested snippet

Ran in the page (as a bookmarklet would) on 2026-10-09 against date 2026-10-10,
in the two boxes "10:25 AM row 1" and "10:45 AM row 1":

| call | result |
|---|---|
| `fillOne(row0, 'Someone Else')` (row0 already holding a test pick) | `{ok:false, why:"route already has Barry Len Hughes"}` |
| `fillOne(row8, 'Barry Hughes')` | `{ok:false, why:"already used: Assigned to an overlapping block"}` |
| `fillOne(row8, 'Zed Nobody')` | `{ok:false, why:"not in Amazon's list"}` |
| `fillOne(row8, {name:'wrong name', tid:<Barry's TID>})` | `{ok:false, why:"already used: Assigned to an overlapping block"}` |
| `fillOne(row8, 'Steven Heilmann')` | `{ok:true, name:"Steven Dale Heilmann", hours:"30.3h/60h", alert:null}` |

Five calls took ~1.3 s in total.

```js
const DA_INPUT = 'input[role="combobox"][aria-label="Select DA"]';

// setTimeout when visible; MessageChannel yields when the tab is hidden (timers are throttled there)
const tick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
async function sleep(ms) {
  if (!document.hidden) return new Promise((r) => setTimeout(r, ms));
  const end = performance.now() + ms;
  while (performance.now() < end) await tick();
}

function isEditing() {
  return !!document.querySelector(DA_INPUT) &&
    [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Save changes");
}

function pageDate() {
  const q = new URLSearchParams(location.search).get("date");
  if (/^\d{4}-\d{2}-\d{2}$/.test(q || "")) return q;
  const p = document.querySelector('button[aria-label="Previous day"]')?.parentElement?.querySelector("p");
  const d = p ? new Date(p.textContent.replace(/^[A-Za-z]+,\s*/, "")) : null; // "Saturday, October 10, 2026"
  if (!d || isNaN(d)) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

// [{label: "10:25 AM", header, rows: [tr, …]}] in page order
function readWaves() {
  return [...document.querySelectorAll('div[role="button"][aria-controls]')]
    .map((h) => {
      const body = document.getElementById(h.getAttribute("aria-controls"));
      const table = body && body.querySelector('table[aria-label="Dispatch routes"]');
      if (!table) return null;
      const label = (h.querySelector("[mdn-expander-title] p")?.textContent || "").trim();
      const rows = [...table.querySelectorAll("tbody tr")].filter((tr) => tr.querySelector(DA_INPUT));
      return { label, header: h, rows };
    })
    .filter(Boolean);
}

const routeCode = (tr) => (tr.cells[0]?.innerText || "").trim(); // "—" while routes are pending

function currentDA(tr) {
  const v = (tr.querySelector("[mdn-select-value]")?.textContent || "").replace(/\s+/g, " ").trim();
  const hasClear = !!tr.querySelector('button[aria-label="Clear DA assignment"]');
  return hasClear || (v && v !== "Select DA") ? v : null;
}

const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// same first + last word, and every word of `want` appears in `have`: "Barry Hughes" ~ "Barry Len Hughes"
function sameDriver(want, have) {
  const w = norm(want).split(" "), h = norm(have).split(" ");
  if (!w[0] || w[0] !== h[0] || w[w.length - 1] !== h[h.length - 1]) return false;
  return w.every((t) => h.includes(t));
}

// Optional, React internals (unstable): [{transporterId, name, actualHours, complianceHours, …}]
function daPool(inp) {
  const k = Object.keys(inp).find((k) => k.startsWith("__reactFiber$"));
  for (let f = k && inp[k], i = 0; f && i < 40; f = f.return, i++) {
    const p = f.memoizedProps;
    if (p && Array.isArray(p.daPool)) return p.daPool;
  }
  return null;
}

function setVal(inp, v) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(inp, v);
  inp.dispatchEvent(new Event("input", { bubbles: true }));
}

function closeList(inp) {
  inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
}

// Types q into the box ("" = everyone) and returns [{el, group, name, hours}] once the list is stable.
async function openList(inp, q) {
  inp.focus();
  if (inp.value === q) setVal(inp, q + " "); // React only re-searches on a real change
  setVal(inp, q);
  let last = -1, stable = 0;
  for (let t = 0; t < 40 && stable < 3; t++) {
    await sleep(50);
    const lb = document.getElementById(inp.getAttribute("aria-controls") || "");
    const n = lb ? lb.querySelectorAll('[role="option"]').length : 0;
    stable = n === last ? stable + 1 : 0;
    last = n;
  }
  const lb = document.getElementById(inp.getAttribute("aria-controls") || "");
  if (!lb) return []; // no match: Amazon renders no listbox at all
  return [...lb.querySelectorAll('[role="group"]')].flatMap((g) => {
    const group = (g.querySelector('[role="presentation"]')?.textContent || "").trim();
    return [...g.querySelectorAll('[role="option"]')].map((el) => ({
      el, group,
      name: el.getAttribute("aria-label"),                            // raw; may contain double spaces
      hours: (el.querySelectorAll("p")[1]?.textContent || "").trim(), // "29.1h/60h"
    }));
  });
}

// query: "Barry Hughes" or {name, tid}. Never touches a row that already has a DA.
async function fillOne(routeEl, query) {
  const want = typeof query === "string" ? { name: query } : query;
  const inp = routeEl.querySelector(DA_INPUT);
  if (!inp) return { ok: false, why: "no DA box" };
  const cur = currentDA(routeEl);
  if (cur) return { ok: false, why: "route already has " + cur };

  let exact = null;
  if (want.tid) {
    const hit = (daPool(inp) || []).find((d) => d.transporterId === want.tid);
    if (hit) exact = hit.name;
  }
  const opts = await openList(inp, "");
  const cands = exact ? opts.filter((o) => o.name === exact) : opts.filter((o) => sameDriver(want.name, o.name));
  if (!cands.length) { closeList(inp); return { ok: false, why: "not in Amazon's list" }; }
  const avail = cands.filter((o) => o.group === "Available");
  if (!avail.length) { closeList(inp); return { ok: false, why: "already used: " + cands[0].group }; }
  if (avail.length > 1) { closeList(inp); return { ok: false, why: "ambiguous: " + avail.map((o) => o.name).join(" / ") }; }

  const pick = avail[0];
  pick.el.click(); // closes the list and sets the value
  const target = pick.name.replace(/\s+/g, " ").trim();
  for (let t = 0; t < 30 && currentDA(routeEl) !== target; t++) await sleep(50);
  const got = currentDA(routeEl);
  const alert = (routeEl.querySelector('[role="alert"]')?.textContent || "").trim() || null;
  return { ok: got === target, name: got, hours: pick.hours, alert };
}
```

Notes for the filler built on this:
- `sameDriver` needs first and last name to match exactly; a schedule nickname
  ("Mike" vs "Michael") won't match → it shows up as "not in Amazon's list". That's
  where the TID path helps when the payload has a `tid`.
- If two Amazon names match one schedule name, `fillOne` refuses ("ambiguous")
  instead of guessing.
- For speed, the filler can read the full option list once from the first box
  (`openList(inp, "")`, then `closeList`) to pre-match every driver, then call
  `fillOne` per route.

## What I did on the page (safety record)

- Before: Oct 10, 31 routes, all DA `—`, route codes `—` (Routes pending).
- Opened Edit assignments, used only two boxes (10:25 AM row 1, 10:45 AM row 1):
  picked "Barry Len Hughes" in the first, tried the overlap case in the second, cleared
  it, then picked "Steven Dale Heilmann" there. Clicked **Cancel** (no dialog).
- After: reloaded the page — still 31 routes, every DA `—`, view mode. Nothing saved.
  `Save changes` and `Auto-roster Vehicle` were never clicked.

---

# Legacy view — the old Scheduling day page (what roster.js fills since 2026-10-23)

Checked 2026-10-23 in Jose's Chrome, **read only**, on
`logistics.amazon.com/scheduling?serviceAreaId=38cd…&date=2026-10-24&navMenuVariant=external`
(Sat Oct 24: Standard Parcel 24 confirmed / 0 rostered, WW Hub Transport CDV 1 / 0) and
the same page for Fri Oct 23 (everything rostered). Nothing was picked, cleared or saved
(see the safety record at the end).

## L1. How you get there, which page it is

- With Jose's **Legacy view** switch on, `logistics.amazon.com/dispatch?date=…` **redirects**
  to `/scheduling?serviceAreaId=…&date=YYYY-MM-DD&navMenuVariant=external`. It is a normal
  top-level page (no iframe). The preference is sticky per user; the page has an "A new
  Dispatch experience is available — SWITCH TO DISPATCH" banner that goes back.
- Path is exactly `/scheduling` — not `/scheduling/calendar-view/week` (that is the week
  view the 📅 Week bookmark fills, docs/week-bookmarklet.md).
- Old stack: **Knockout** (`data-bind` everywhere) + **jQuery 1.6.4** (in `noConflict`
  mode: `window.jQuery` / `window.ko` exist as keys but are `undefined`; modules load
  through Amazon's `P.when(…)`) + the **Chosen** select plugin (1.x, uses
  `chosen:updated`). Class names are hand-written (`selectAssociate`, `rowHeader`, …),
  not hashes — they are the stable hooks. Ids are rare.
- **Date**: URL `?date=YYYY-MM-DD`. The date bar `ul#datebar li.selected span.dateText`
  shows `Sat 24-Oct` (no year). Clicking another day submits the Region/Date form (reload).

## L2. Structure

```
div#confirmedServiceRequestSection.section        "CONFIRMED SERVICES"
  div.confirmationButton  a#autoRosterBtn "Auto Roster", a#defaultScheduleBtn "Default Schedule"   ← never touch
  div.withRosterView                               [foreach: serviceTypeDurationStartLocations]
    div.row  (.open when expanded; display:none when 0 confirmed and 0 rostered)   ← one per SERVICE
      div.rowHeaderMain
        div.visualCues  span.greenCheckinTable "✓" | span.blueDotinTable "•"
        div.expandable                             ← the "+" (empty div, CSS icon); click toggles
        div.rowHeaderContainer
          div.rowHeader > span  "Standard Parcel - Extra Large Van - US - Default as station - 10 Hours"
          div.rowHeaderData > span "24"  " Confirmed"
          div.rowHeaderData > span "0"   " Rostered"
      div.rowData   [visible: displayChildren]     ← display:none while collapsed, rows still in the DOM
        div.rowSubHeader "Confirmed Routes" … one div.schedule per start time
           ("10:25 am" [Bulk Import Associates] 9 … "Modify DSP Capacity to decline routes")  ← never touch
        div.roster
          div.rosterAlertGroup   ("Action required" items, hidden when none)
          div.rowSubHeader "Associates"
          div.DAFilter   Filter: Start Time <select> (All | epoch-ms values) · Associate Name <select> (Chosen)
          div.associatesSection.rosterSection
            (header) Start Time | Associate | Routes
            div.associates
              div.associate                         ← one per ROW (one per confirmed route)
                div [visible: filterRosterByAssociateName() && filterRosterByStartTime()]
                  div.column.data.first   "10:25 am"            (start time, lower-case am/pm)
                  div.column.data.second
                    select.selectAssociate[name=selectAssociate]  (display:none — the real value)
                    div.chosen-container.chosen-container-single (style width:90%)
                      a.chosen-single > span "Select Associate To Roster" | "<option text>"
                      div.chosen-drop > div.chosen-search > input[type=text] ; ul.chosen-results
                    span.numErrorMsg "X"   [click: deselectDA]            ← red X, clears the row
                    span.numErrorMsg "!"   [visible: rosterError, attr data-tooltip]  ← error mark
                  div.column.data.third
                    input.displayRoute[disabled]  "No Route Generated" | "Route CX9"
                    div.routedNotRostered … (icons)
          div.rosterUpdateButtons
            a.typeFour.button.ajaxButton "Cancel"   [click: handleCancelButtonClick]
            a.typeFive.button.ajaxButton "Save"     [click: handleSaveButtonClick]   ← THE save
```

- Services seen: `Standard Parcel - Extra Large Van - US - Default as station - 10 Hours`,
  `WW Hub Transport - CDV 16FT - … - 10 Hours`, `WW Hub Transport - Extra Large Van - US -
  … - 8 Hours` (hidden, 0/0), `Nursery Route Level 1/2/3 - Default as station - 10 Hours`.
- Rows are grouped by start time in page order (Oct 24: 9 × `10:25 am`, then 15 ×
  `10:45 am`). The start times are Amazon block times = schedule time + 20 min, i.e.
  the payload's `portal` (compare upper-cased: `10:25 am` → `10:25 AM`).
- **All rows of all services are in the DOM even while collapsed** (24 selects in the
  collapsed Standard Parcel). Expanding only flips `display`.
- **Accordion**: `div.expandable` click runs `showConfirmationToSaveBeforeToggle`. If any
  service has unsaved work it shows a confirmation pop-up (its "yes" runs that service's
  Cancel = discards the picks, then toggles). Otherwise it collapses every service and
  toggles this one. So only one service is open at a time, and picks in one service must
  be saved before opening another.

## L3. The Associate box

- The real control is the hidden native `<select class="selectAssociate">`, Knockout
  `options: daOptions, optionsText: 'dropDownDisplay', optionsValue: 'personId',
  value: daSelection, optionsCaption: 'Select Associate To Roster', chosen: {width:'90%'}`.
- **Options** (Oct 24: 66 + the caption, the same list in every row of every service, A→Z,
  no optgroups, nothing disabled; already-rostered people are NOT removed or grouped):
  - `value` = **personId = the Transporter ID** (`A4RS06DEVIJVJ`-style, 13–14 chars;
    27 of 30 TIDs from our fixtures were found among the values). So the payload's `tid`
    matches an option exactly.
  - text = `dropDownDisplay` = `name + " " + phoneNumber + " " + preferedServiceAreaName`,
    plus `" (Inactive)"` when the associate is inactive (none seen). E.g.
    `Adam James Scott +1304555xxxx Davisville (WWV9) - Amazon.com`. With no phone on file
    it is `Ashley Nicole Lusk  Davisville (WWV9) - Amazon.com` (two spaces; 3 of 66).
    `option.text` collapses spaces, `textContent` keeps them. No double spaces inside
    names were seen here (unlike the new view).
  - Caption option: value `""`, text `Select Associate To Roster`.
- **Has an associate**: `select.value !== ""`; the Chosen box then shows the full option
  text (`a.chosen-single span`). Empty: value `""`, box shows `Select Associate To Roster`.
  Both X and ! spans exist on every row; X is always shown, ! only on an error.
- **Chosen widget** (only the look): `mousedown` on `a.chosen-single` opens it
  (`chosen-with-drop`), building `ul.chosen-results > li.active-result[data-option-array-index=N]`
  (N = option index; the list is empty until first opened). `keyup` Escape on the search
  input closes it without picking (`keydown` Escape does not). A pick is `mouseup` on the
  `li`, which sets the option and fires jQuery `change` with `{selected: value}`.
- **Knockout's `chosen` binding** subscribes to `value`/`options` and triggers
  `chosen:updated`, so a change of `daSelection` redraws the box. The `value` binding
  listens to `change` on the select (jQuery-bound, i.e. a normal listener), so
  `select.value = tid; select.dispatchEvent(new Event('change', {bubbles:true}))` should
  set `daSelection` and redraw the box. **Not tried on the real page** (no picks allowed
  during the check); roster.js verifies the box shows the name and otherwise falls back
  to the Chosen mousedown/mouseup pick.

## L4. Does a pick save? — **No. It needs that service's Save button.**

- `daSelection.subscribe` (page script) only does local work: refresh the filter list
  (`fillAssociateOptions`), clear action errors, run the **local overlap check**
  (`overlapDaSelectionCheck`: the same personId on another row of any service whose block
  overlaps → `overlapError` → the red `!` on the row, tooltip from `rosterErrorMessage`),
  and `handlePopupToTerminateSession` (only when *replacing* a DA who has an active
  session — never the case for an empty row). No network call.
- Saving is `handleSaveButtonClick` on the service's **Save** (`div.rosterUpdateButtons
  a.typeFive`, label "SAVE"): it builds create/cancel/route maps and calls Amazon. Errors
  from that come back per row as `saveRosterError` (same `!`).
- **Cancel** (`a.typeFour` "CANCEL") throws the unsaved picks away.
- The top **SUBMIT** (`a#searchSubmitBtn` in `form#schedulingDSPCSearchbar`) is the
  Region/Date search, not a save. Also never touch: Auto Roster, Default Schedule,
  Bulk Import Associates, Modify DSP Capacity, the red X on filled rows.

## L5. Rules the filler follows here

- Fill only `Standard Parcel…` services; list the others (Nursery Route, WW Hub
  Transport, …) as left for the dispatcher. If more than one Standard Parcel service has
  empty rows, fill one (the open one, else the first) and say: Save, open the next, click
  the bookmark again (accordion + unsaved-work pop-up).
- Expand the service first (`div.expandable` click) while nothing is unsaved; if it does
  not open (the unsaved-work pop-up), stop and let the dispatcher answer it.
- "Taken" = every non-empty `select.selectAssociate` on the page, all services. Match
  payload `tid` to option `value` first, then the local name match on the name part of
  the option text. Inactive options are never picked.
- After each pick, a visible `!` on that row means Amazon flagged it → set it back to
  empty and report.
- Never press Save / Cancel / SUBMIT. Last line: check the screen, then press **Save**.

## Safety record (legacy check, 2026-10-23)

- Read the DOM and the page scripts (fetched the page's own script files to read the
  view-model code). Expanded Standard Parcel on Oct 24 with its "+" (display only),
  opened one Associate box's Chosen list and closed it with Escape: value stayed `""`,
  0 rows with a value anywhere before and after. On reload Standard Parcel was
  collapsed again.
- Never picked, never clicked X, Save, Cancel, SUBMIT, Auto Roster, Bulk Import. Did not
  touch the Legacy view switch (opening `/dispatch` just redirected because it was
  already on).
