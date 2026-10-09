# Amazon Dispatch "Edit assignments" — DOM notes for the roster filler

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
  header. Everything here is for Legacy view **off** (`checked === false`); with it on
  the DOM is different. The filler should refuse and say "turn off Legacy view".
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
