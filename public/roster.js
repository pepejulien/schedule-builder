/* roster.js — the "🧾 Roster to Amazon" bookmark (Jose 2026-10-09; legacy page 2026-10-23;
 * spec: docs/roster-bookmarklet.md, Amazon page notes: docs/amazon-roster-dom.md "Legacy view").
 *
 * Runs in Amazon's old Scheduling day page — what Dispatch shows with "Legacy view" on
 * (logistics.amazon.com/scheduling?date=…). It opens the Schedule Builder in a small window
 * (APP#roster=<date>), which reads that day off the Live board and hands the drivers back
 * (window.postMessage). Then it shows what it will do, and on "Fill" picks each driver in an
 * empty Associate box of the Standard Parcel service, wave by wave (start time), one row at a time.
 *
 * Re-runs (Jose 2026-11-12): first the Live board is checked against Amazon's routes (a checklist:
 * who goes to backup / gets a route, 6 days in 7 with no backup) and the ticked changes are saved
 * there; then a Standard Parcel row holding someone who isn't on a route on the Live board any more
 * gets a Live board driver instead, or is emptied. Rows with a Live board route driver are never touched.
 *
 * Amazon keeps nothing until the service's Save button is pressed, and this file NEVER clicks
 * Save, Cancel, SUBMIT, Auto Roster, Bulk Import or a red X. Nursery Route, Hub Transport, Standard Parcel Electric (EDV routes - only for
 * EDV-certified drivers, Jose 2026-11-11) and other services are left alone (listed).
 * Dispatch checks the screen and presses Save themselves. On the new Dispatch page (Legacy view
 * off) it only says how to get to the legacy page.
 *
 * Loaded fresh on every click (the bookmark adds ?<time>), so fixing this file fixes every dispatch
 * computer — no re-adding the bookmark. The app it asks is wherever this file was loaded from.
 *
 * Local testing: a test page that copies Amazon's screen (tests/roster_mock/scheduling-legacy.html)
 * sets window.__jajbRosterTest = true before loading this file; that skips only the "is this
 * logistics.amazon.com" check. Everything else runs exactly as on Amazon.
 */
(() => {
  "use strict";
  const SELF = (document.currentScript && document.currentScript.src) || "";
  const APP = SELF.replace(/roster\.js(\?.*)?$/, "");          // the app's own folder
  const APP_ORIGIN = APP ? new URL(APP).origin : "";
  if (window.__jajbRoster) { window.__jajbRoster.show(); return; }

  /* ---------- small helpers ---------- */
  const SEL = "select.selectAssociate";                        // the real Associate box (hidden behind Chosen)
  const CAPTION = "Select Associate To Roster";                // what an empty box shows
  const SP_RE = /^Standard Parcel\b/i;                         // the only services we fill
  // ...but never "Standard Parcel Electric - Rivian MEDIUM": an EDV route needs an EDV-certified driver (2026-11-11)
  const ELECTRIC_RE = /electric|rivian|\bEDV\b/i;
  // setTimeout when visible; MessageChannel yields when the tab is hidden (timers are throttled there)
  const tick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
  async function sleep(ms) {
    if (!document.hidden) return new Promise((r) => setTimeout(r, ms));
    const end = performance.now() + ms;
    while (performance.now() < end) await tick();
  }
  async function waitFor(fn, ms = 1500, step = 50) {
    const end = performance.now() + ms;
    for (;;) {
      let v = null;
      try { v = fn(); } catch (e) { /* page mid-render */ }
      if (v) return v;
      if (performance.now() > end) return null;
      await sleep(step);
    }
  }
  const one = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const plural = (n, w, ws) => `${n} ${n === 1 ? w : (ws || w + "s")}`;
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  const isoOf = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  function dayLabel(iso) {                                     // "Saturday Oct 10"
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return String(iso || "");
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }
  const waveKey = (s) => one(s).toUpperCase().replace(/^0/, "");   // "10:45 am" → "10:45 AM"
  // "10:45 AM" -> minutes after midnight (9999 when it isn't a time)
  const waveMins = (k) => { const m = /(\d{1,2}):(\d{2}) ?([AP]M)/i.exec(String(k || "")); if (!m) return 9999;
    return ((+m[1] % 12) + (/p/i.test(m[3]) ? 12 : 0)) * 60 + +m[2]; };
  // Amazon's start time -> the schedule's, 20 minutes earlier ("10:45 AM" -> "10:25 AM"), like the app's
  // lib/waves.js portalToSchedule (tests/roster_moves_test.mjs checks they agree) (Jose 2026-10-23)
  function toSched(k) {
    const m = /(\d{1,2}):(\d{2}) ?([AP]M)/i.exec(String(k || ""));
    if (!m) return null;
    const t = (((+m[1] % 12) + (/p/i.test(m[3]) ? 12 : 0)) * 60 + +m[2] - 20 + 1440) % 1440, h = Math.floor(t / 60);
    return `${h % 12 || 12}:${String(t % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }

  /* ---------- the little panel, top-right on Amazon's page ---------- */
  const box = document.createElement("div");
  box.id = "jajb-roster";
  box.innerHTML = `
    <style>
      #jajb-roster{position:fixed;top:14px;right:14px;z-index:2147483647;width:360px;max-height:calc(100vh - 28px);
        overflow:auto;box-sizing:border-box;background:#fff;color:#1d2433;border:2px solid #243762;border-radius:12px;
        box-shadow:0 10px 30px rgba(0,0,0,.28);font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
        padding:12px 14px;text-align:left}
      #jajb-roster *{box-sizing:border-box}
      #jajb-roster b{font-weight:700}
      #jajb-roster ul{list-style:disc}
      #jajb-roster ol{list-style:decimal}
      #jajb-roster h3{margin:0 22px 6px 0;font-size:14px;color:#243762}
      #jajb-roster a{color:#243762;text-decoration:underline}
      #jajb-roster .bar{height:8px;background:#e6e9f0;border-radius:6px;overflow:hidden;margin:8px 0}
      #jajb-roster .bar i{display:block;height:100%;width:0;background:#df7332;transition:width .2s}
      #jajb-roster button{font:inherit;font-weight:600;border-radius:8px;padding:7px 12px;cursor:pointer;margin:6px 6px 0 0;
        border:1px solid #243762;background:#243762;color:#fff}
      #jajb-roster button.ghost{background:#fff;color:#243762}
      #jajb-roster .msg{white-space:normal}
      #jajb-roster .msg p{margin:0 0 6px}
      #jajb-roster .bad{color:#a12a1f}
      #jajb-roster .warn{color:#8a5a00}
      #jajb-roster .muted{color:#6b7280}
      #jajb-roster .wave{border-top:1px solid #e6e9f0;padding:6px 0 4px}
      #jajb-roster .wave ul{margin:2px 0 0;padding-left:18px}
      #jajb-roster .wave li{margin:1px 0}
      #jajb-roster details{margin-top:2px}
      #jajb-roster summary{cursor:pointer;color:#243762}
      #jajb-roster ol{margin:2px 0 0;padding-left:22px}
      #jajb-roster .x{position:absolute;top:6px;right:10px;cursor:pointer;color:#888;font-size:18px;line-height:1}
    </style>
    <span class="x" title="Close">×</span>
    <h3>🧾 Roster from the Schedule Builder</h3>
    <div class="msg"></div>
    <div class="bar" style="display:none"><i></i></div>
    <div class="btns"></div>`;
  document.body.appendChild(box);
  const $msg = box.querySelector(".msg"), $bar = box.querySelector(".bar"), $fill = box.querySelector(".bar i"),
        $btns = box.querySelector(".btns");
  let runId = 0, stopped = false;
  box.querySelector(".x").onclick = () => {
    stopped = true; runId++;
    window.removeEventListener("message", onMessage);
    clearTimeout(ask.timer);
    box.remove(); delete window.__jajbRoster;
  };
  window.__jajbRoster = { show: () => { box.style.display = ""; if (!box.isConnected) document.body.appendChild(box); } };
  const say = (html, cls) => { $msg.innerHTML = html; $msg.className = "msg" + (cls ? " " + cls : ""); };
  function btn(label, fn, ghost) {
    const b = document.createElement("button");
    b.textContent = label; if (ghost) b.className = "ghost";
    b.onclick = fn; $btns.appendChild(b); return b;
  }
  const clearBtns = () => { $btns.innerHTML = ""; };
  const progress = (frac) => { if (frac == null) { $bar.style.display = "none"; return; } $bar.style.display = ""; $fill.style.width = (100 * frac) + "%"; };

  /* ---------- reading Amazon's legacy page (docs/amazon-roster-dom.md "Legacy view") ---------- */
  // "legacy" (the old Scheduling day page), "dispatch" (the new page), or null
  function pageKind() {
    const p = location.pathname;
    if (/(^|\.)logistics\.amazon\.com$/.test(location.hostname)) {
      if (/^\/dispatch/.test(p)) return "dispatch";
      if (/^\/scheduling\/?$/.test(p)) return "legacy";
      return null;                                             // e.g. the week view /scheduling/calendar-view/week
    }
    if (window.__jajbRosterTest !== true) return null;
    if (document.getElementById("confirmedServiceRequestSection")) return "legacy";
    if (document.querySelector('input[role="switch"]')) return "dispatch";
    return null;
  }
  function urlDate() {
    const q = new URLSearchParams(location.search).get("date");
    return /^\d{4}-\d{2}-\d{2}$/.test(q || "") ? q : null;
  }
  // the date bar's chosen day, "Sat 24-Oct" (no year: the one nearest `near`, else today)
  function barDate(near) {
    const el = document.querySelector("#datebar li.selected .dateText") || document.querySelector("#datebar li.selected");
    const m = el && /(\d{1,2})-([A-Za-z]{3})/.exec(el.textContent || "");
    const mon = m ? MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase()) : -1;
    if (mon < 0) return null;
    const n = near ? new Date(+near.slice(0, 4), +near.slice(5, 7) - 1, +near.slice(8, 10)) : new Date();
    let best = null;
    for (const y of [n.getFullYear() - 1, n.getFullYear(), n.getFullYear() + 1]) {
      const d = new Date(y, mon, +m[1]);
      if (!best || Math.abs(d - n) < Math.abs(best - n)) best = d;
    }
    return isoOf(best);
  }
  const pageDate = () => urlDate() || barDate(null);

  const shortSvc = (h) => one(h).replace(/\s*-\s*Default as station\b.*$/i, "") || one(h);
  function isOpen(svcEl) {
    const d = svcEl.querySelector(".rowData");
    return d ? getComputedStyle(d).display !== "none" : svcEl.classList.contains("open");
  }
  // one service's Associate rows in page order: [{el, sel, time, key}]
  function readRows(svcEl) {
    return [...svcEl.querySelectorAll(SEL)].map((sel) => {
      const el = sel.closest(".associate") || sel.parentElement.parentElement;
      const time = one((el.querySelector(".column.data.first") || {}).textContent);
      return { el, sel, time, key: waveKey(time) };
    });
  }
  // the services Amazon shows for the day (hidden 0-confirmed ones left out), page order
  function readServices() {
    return [...document.querySelectorAll("#confirmedServiceRequestSection .withRosterView > div.row")]
      .filter((el) => getComputedStyle(el).display !== "none")
      .map((el) => {
        const heading = one((el.querySelector(".rowHeader span") || {}).textContent);
        return { el, heading, short: shortSvc(heading), sp: SP_RE.test(heading) && !ELECTRIC_RE.test(heading), rows: readRows(el) };
      });
  }
  const shown = (row) => one((row.el.querySelector(".chosen-single span") || {}).textContent);
  // the name in a row (Amazon's option text), or null when empty
  function currentDA(row) {
    if (row.sel.value) {
      const o = row.sel.options[row.sel.selectedIndex];
      return parseOpt(o ? o.textContent : row.sel.value).name;
    }
    const s = shown(row);                                      // box shows someone the select doesn't: leave it
    return s && s !== CAPTION ? s : null;
  }
  const isEmpty = (row) => !currentDA(row) && !row.sel.disabled;
  // the red "!" on a row (Amazon's own overlap / save error), or null
  function errMark(row) {
    const e = row.el.querySelector('.numErrorMsg[data-bind*="rosterError"]') ||
      [...row.el.querySelectorAll("span.numErrorMsg")].find((x) => one(x.textContent) === "!");
    if (!e || getComputedStyle(e).display === "none") return null;
    return one(e.getAttribute("data-tooltip")) || "Amazon marked that row with a red !";
  }

  // An option's text is "<name> <+phone> <station>" ("… (Inactive)" at the end when inactive);
  // with no phone on file it is "<name>  <station>" (two spaces). The station is learned from
  // the options that do have a phone.
  const PHONE_RE = /^(.*?)\s+\+?\d[\d\s().-]{6,}\d\s+(.*)$/;
  const areas = new Set();
  function parseOpt(raw) {
    let t = one(raw);
    const inactive = /\(Inactive\)$/i.test(t);
    t = t.replace(/\s*\(Inactive\)$/i, "");
    const m = PHONE_RE.exec(t);
    if (m) { areas.add(m[2]); return { name: m[1], inactive }; }
    for (const a of areas) if (t.endsWith(" " + a)) return { name: t.slice(0, -a.length - 1), inactive };
    return { name: one(String(raw || "").replace(/\s*\(Inactive\)\s*$/i, "").trim().split(/\s{2,}/)[0]), inactive };
  }
  // the Associate list of one box: [{idx, value, text, name, inactive}] (value = Transporter ID)
  function readOptions(sel) {
    const raw = [...sel.options].map((o, idx) => ({ idx, value: o.value, raw: o.textContent || "" })).filter((o) => o.value);
    for (const o of raw) { const m = PHONE_RE.exec(one(o.raw).replace(/\s*\(Inactive\)$/i, "")); if (m) areas.add(m[2]); }
    return raw.map((o) => Object.assign({ idx: o.idx, value: o.value, text: one(o.raw) }, parseOpt(o.raw)));
  }
  // who already has a row anywhere on the page (all services): Transporter ID → {name, where, svc, key}
  function takenNow(svcs) {
    const m = new Map();
    for (const s of svcs || readServices()) for (const r of s.rows) {
      if (r.sel.value) m.set(r.sel.value, { name: currentDA(r), where: `${s.short} ${r.key}`, svc: s.el, key: r.key });
    }
    return m;
  }

  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  // same first + last word, and every word of `want` appears in `have`: "Barry Hughes" ~ "Barry Len Hughes"
  function sameDriver(want, have) {
    const w = norm(want).split(" "), h = norm(have).split(" ");
    if (!w[0] || w[0] !== h[0] || w[w.length - 1] !== h[h.length - 1]) return false;
    return w.every((t) => h.includes(t));
  }

  // Opens a service with its "+" (only one is open at a time on Amazon). false when it stays shut —
  // Amazon then asks about unsaved changes elsewhere, which dispatch must answer, not us.
  async function openService(svcEl) {
    if (isOpen(svcEl)) return true;
    const ex = svcEl.querySelector(".rowHeaderMain .expandable") || svcEl.querySelector(".expandable");
    if (!ex) return false;
    ex.click();
    return !!(await waitFor(() => isOpen(svcEl), 1500));
  }
  function setSelect(sel, value) {                             // what Amazon's own code listens to
    sel.value = value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function closeChosen(row) {
    const inp = row.el.querySelector(".chosen-search input");
    if (inp) inp.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
  }
  // the way a person picks: open the Chosen box, let go of the mouse on the name (idx = option index)
  async function chosenPick(row, idx) {
    const a = row.el.querySelector(".chosen-single");
    if (!a) return false;
    a.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, view: window }));
    const li = await waitFor(() => row.el.querySelector(`.chosen-results li[data-option-array-index="${idx}"]`), 1000);
    if (!li) { closeChosen(row); return false; }
    li.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, view: window }));
    li.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, view: window }));
    return true;
  }
  // Sets a row to option `idx` (0 = empty) until `done()` holds: a plain "change" first, else the
  // Chosen box. Once the plain way fails on this page, Chosen goes first (no 1.5 s wait per row).
  let viaChosen = false;
  async function setRow(row, idx, done) {
    for (const how of viaChosen ? ["chosen", "plain"] : ["plain", "chosen"]) {
      if (how === "plain") setSelect(row.sel, row.sel.options[idx] ? row.sel.options[idx].value : "");
      else if (!(await chosenPick(row, idx))) continue;
      if (await waitFor(done, 1500)) { viaChosen = how === "chosen"; return true; }
      closeChosen(row);
      if (row.sel.selectedIndex !== 0 && idx !== 0) row.sel.selectedIndex = 0;   // undo a half-done try quietly
      await sleep(100);
    }
    return false;
  }
  // empties a row we just filled (our own pick only; never the red X)
  const emptyRow = (row) => setRow(row, 0, () => !row.sel.value && shown(row) === CAPTION);

  /* ---------- the run ---------- */
  let date = null, payload = null;

  function stopWith(html) { progress(null); clearBtns(); say(html, "bad"); }

  // Step 1: the page checks. Returns a warning line (or "") when OK, null when stopped.
  function checks() {
    if (!APP) { stopWith("This bookmark is broken — drag a fresh one from the Live board."); return null; }
    const kind = pageKind();
    if (kind === "dispatch") {
      const sa = new URLSearchParams(location.search).get("serviceAreaId"), d = urlDate();
      const link = sa && d ? ` — or <a href="${esc(location.origin + "/scheduling?serviceAreaId=" + encodeURIComponent(sa) +
        "&date=" + d + "&navMenuVariant=external")}">open the legacy page for ${esc(dayLabel(d))}</a>` : "";
      stopWith(`This bookmark fills Amazon's legacy page now. Turn on <b>Legacy view</b> at the top${link}, then click the bookmark again.`);
      return null;
    }
    if (kind !== "legacy") {
      stopWith("Open Amazon <b>Dispatch</b> with <b>Legacy view</b> on (the old Scheduling page), pick the day, then click the bookmark again.");
      return null;
    }
    const u = urlDate(), b = barDate(u);
    date = u || b;
    if (!date) { stopWith("Couldn't tell which day this page is for. Pick the day again, then click the bookmark again."); return null; }
    if (u && b && u !== b) {
      stopWith(`The address bar says ${esc(dayLabel(u))} but the page shows ${esc(dayLabel(b))}. Reload the page, then click the bookmark again.`);
      return null;
    }
    return "";
  }

  async function run() {
    const my = ++runId;
    stopped = false; payload = null;
    clearTimeout(ap.timer); Object.assign(ap, { my: 0, picks: null, res: null, note: "" });
    progress(null); clearBtns();
    const warn = checks();
    if (warn == null) return;
    ask(my, warn, true);
  }

  // Step 2: get the day from the Live board (small window, postMessage)
  function ask(my, warn, auto) {
    clearTimeout(ask.timer);
    ask.my = my; ask.warn = warn;
    const label = esc(dayLabel(date));
    // a window we opened earlier (e.g. still showing an error) is closed first, and the ?r=<time>
    // makes even a leftover "jajbRoster" window from before a page reload load fresh: the same
    // address would only change its #hash and not reload it
    const open = () => {
      ask.asked = false;
      try { if (ask.win && !ask.win.closed) ask.win.close(); } catch (e) { /* gone */ }
      ask.win = window.open(APP + "?r=" + Date.now() + "#roster=" + date, "jajbRoster", "width=440,height=560");
      return ask.win;
    };
    const waiting = () => {
      clearBtns();
      say(`${warn}<p>Getting ${label} from the Live board and checking who should have a route… (sign in there if it asks — this can take a few seconds)</p>`);
      ask.timer = setTimeout(() => {
        if (my !== runId || payload) return;
        clearBtns();
        say(`${warn}<p class="bad">Didn't hear back from the Live board. If its window is open and signed in, try again.</p>`);
        btn("Try again", () => { if (open()) waiting(); else blocked(); });
      }, 90000);
    };
    const blocked = () => {
      clearBtns();
      say(`${warn}<p>Click the button to get the drivers from the Live board.</p>`);
      btn(`Get ${dayLabel(date)} from the Live board`, () => { if (open()) waiting(); else blocked(); });
    };
    if (auto) { if (open()) waiting(); else blocked(); }
  }

  // Amazon's associate rows for the day, every service (Standard Parcel, Electric, Nursery, Hub…):
  // how many drivers on routes the Live board should have (Jose 2026-11-12). null when unreadable.
  function amazonRows() {
    const svcs = readServices();
    return svcs.length ? svcs.reduce((n, s) => n + s.rows.length, 0) : null;
  }

  function onMessage(e) {
    if (!APP_ORIGIN || e.origin !== APP_ORIGIN || !e.data || typeof e.data !== "object") return;
    const my = ask.my;
    if (e.data.type === "jajb-roster-applied") { onApplied(e); return; }
    if (my !== runId || payload || !date) return;
    if (e.data.type === "jajb-roster-ready") {
      if (ask.asked) return;                                   // once: the app is working out the plan
      ask.asked = true;
      const src = e.source;
      waitFor(() => readServices().length ? true : null, 4000).then(() => {
        try { src.postMessage({ type: "jajb-roster-request", date, rows: amazonRows() }, APP_ORIGIN); } catch (err) { /* window closed */ }
      });
      return;
    }
    if (e.data.type !== "jajb-roster") return;
    payload = e.data;
    clearTimeout(ask.timer);
    const retry = () => { payload = null; ask(my, ask.warn, true); };
    if (payload.error) {
      stopWith(esc(payload.error));
      btn("Try again", retry);
      return;
    }
    if (payload.date !== date) {
      stopWith(`The Live board sent ${esc(dayLabel(payload.date))}, but this Amazon page is ${esc(dayLabel(date))}. Nothing was filled.`);
      btn("Try again", retry);
      return;
    }
    review(my);
  }
  window.addEventListener("message", onMessage);

  /* ---------- Step 2b: the Live board vs Amazon's routes (Jose 2026-11-12) ----------
   * The app sends payload.plan = {live, rows, diff, short, pairs, changes: [{id, kind, name, wave,
   * why, checked, with?, with_wave?, with_why?}]} (engine roster_plan). kind backup: more drivers
   * on routes than Amazon has rows -> this route becomes a backup; route: fewer -> this backup gets
   * a route (backup changes with alt: next in line, unticked - pick someone else, Jose 2026-11-15);
   * six: 6 days in 7 over 54h -> a backup, `with` takes the route. Dispatch
   * ticks what to do; "Change the Live board" sends {type: "jajb-roster-apply", date, rev, picks}
   * to the app window, which answers {type: "jajb-roster-applied", date, results, payload?, error?}
   * (payload = the day again, fresh). Nothing on Amazon's page changes in this step. */
  const ap = { my: 0, picks: null, timer: null, res: null };
  const showPreview = (my) => preview(my).catch((err) => stopWith("Something went wrong: " + esc(err && err.message || err)));
  const changeLine = (c) => {
    const at = c.wave ? ` (${esc(c.wave)})` : "";
    if (c.kind === "backup") return `<b>${esc(c.name)}</b>${at} → backup <span class="muted">— ${esc(c.why)}</span>`;
    if (c.kind === "route") return `<b>${esc(c.name)}</b>${at} backup → route <span class="muted">— ${esc(c.why)}</span>`;
    const w = c.with ? ` and <b>${esc(c.with)}</b>${c.with_wave ? ` (${esc(c.with_wave)})` : ""} takes the route <span class="muted">(${esc(c.with_why || "")})</span>`
      : ' <span class="warn">— no backup left to take the route (it stays open)</span>';
    return `<b>${esc(c.name)}</b>${at} → backup${w}<br><span class="muted">${esc(c.why)}</span>`;
  };
  function review(my) {
    const pl = payload.plan;
    let note = "";
    // the checklist (rules engine) and the fill list (the Live board's saved day) must count the same
    // drivers; Jose 2026-11-14 saw "both have 27" with 28 in the fill list (one left with no row)
    const sent = (payload.drivers || []).length;
    const odd = pl && pl.live != null && pl.live !== sent;
    if (payload.planError) note = `<p class="warn">Couldn't check the Live board against Amazon's routes (${esc(payload.planError)}) — filling as it is.</p>`;
    else if (odd) note = `<p class="bad">The checklist counted ${plural(pl.live, "driver")} on routes, but the Live board sent ${sent}. It may have changed in the middle. Click <b>Start over</b> before filling.</p>`;
    else if (pl && pl.rows != null && !pl.diff) note = `<p class="muted">Amazon and the Live board both have ${plural(pl.rows, "route")}.</p>`;
    ap.note = note;
    if (!pl || !(pl.changes || []).length) {
      if (pl && pl.short) ap.note += `<p class="bad">Amazon has ${plural(pl.short, "more route")} than the Live board can fill with backups. Add someone on the Live board ("Who can work extra?") or fill by hand.</p>`;
      showPreview(my); return;
    }
    progress(null); clearBtns();
    const groups = [
      ["backup", pl.diff > 0 ? `Amazon has <b>${plural(pl.rows, "route")}</b> (all services) but the Live board has <b>${plural(pl.live, "driver")}</b> on routes. To match, these drivers go to backup:` : ""],
      ["route", pl.diff < 0 ? `Amazon has <b>${plural(pl.rows, "route")}</b> (all services) but the Live board has only <b>${plural(pl.live, "driver")}</b> on routes. To match, these backups get a route:` : ""],
      ["six", "6 days in 7 and could go over 54 hours — make them a backup? (only if you tick it)"],
    ];
    let h = ask.warn + `<p><b>${esc(dayLabel(date))}</b> — first, the Live board.</p>`;
    for (const [kind, head] of groups) {
      const cs = pl.changes.filter((c) => c.kind === kind && !c.alt);
      const alts = pl.changes.filter((c) => c.kind === kind && c.alt);
      if (!cs.length && !alts.length) continue;
      const line = (c) => `<label style="display:block;margin:3px 0;cursor:pointer"><input type="checkbox" data-id="${esc(c.id)}" data-kind="${esc(c.kind)}"${c.checked ? " checked" : ""} style="margin-right:6px">${changeLine(c)}</label>`;
      h += `<div class="wave"><p style="margin:0 0 4px">${head}</p>` + cs.map(line).join("");
      // someone else instead (Jose 2026-11-15): untick a pick above, tick one of these
      if (alts.length) h += `<p class="muted" style="margin:8px 0 4px">Or someone else instead — next in line for backup (untick one above, tick one here):</p>` + alts.map(line).join("");
      if (kind === "backup" && pl.diff > 0) h += `<p class="bk-count" style="margin:6px 0 0"></p>`;
      h += "</div>";
    }
    if (pl.short) h += `<p class="bad">Still ${plural(pl.short, "route")} short — not enough backups who can take a route. Add someone on the Live board ("Who can work extra?") or fill by hand.</p>`;
    if (pl.pairs) h += `<p class="muted">Training pairs stay as they are.</p>`;
    h += `<p>Ticked changes are made on the <b>Live board</b> (saved there, with a change-log line each). Then the rows here are filled from it. Nothing on Amazon's page changes yet.</p>`;
    say(h);
    const boxes = () => [...box.querySelectorAll('input[type="checkbox"][data-id]')];
    const go = btn("Change the Live board", () => {
      const ids = new Set(boxes().filter((b) => b.checked).map((b) => b.getAttribute("data-id")));
      const picks = pl.changes.filter((c) => ids.has(c.id))
        .map((c) => (c.kind === "six" ? { kind: c.kind, name: c.name, with: c.with || null } : { kind: c.kind, name: c.name }));
      if (!picks.length) { showPreview(my); return; }
      sendApply(my, picks);
    });
    const relabel = () => {
      const n = boxes().filter((b) => b.checked).length;
      go.textContent = n ? `Change the Live board (${n})` : "Nothing ticked — go on to fill";
      // how many are ticked for backup vs how many Amazon needs
      const cnt = box.querySelector(".bk-count");
      if (cnt) {
        const k = boxes().filter((b) => b.checked && b.getAttribute("data-kind") === "backup").length;
        const left = pl.diff - k;
        cnt.className = "bk-count " + (left ? "warn" : "muted");
        cnt.innerHTML = `Ticked for backup: <b>${k} of ${pl.diff}</b>` + (left > 0
          ? ` — tick ${plural(left, "more driver")}, or ${left === 1 ? "one driver" : "some drivers"} won't get an Amazon row`
          : left < 0 ? ` — that's ${-left} more than Amazon needs; they'll be backups and ${left === -1 ? "a row stays" : "rows stay"} empty` : "");
      }
    };
    boxes().forEach((b) => { b.onchange = relabel; });
    relabel();
    btn("Skip — fill as it is", () => {
      try { if (ask.win && !ask.win.closed) ask.win.close(); } catch (err) { /* gone */ }
      showPreview(my);
    }, true);
  }
  function sendApply(my, picks) {
    clearBtns();
    Object.assign(ap, { my, picks, res: null });
    if (!ask.win || ask.win.closed) {
      stopWith("The Live board window was closed, so nothing was changed. Click the bookmark again.");
      btn("Start over", run, true); return;
    }
    say(`<p>Changing the Live board (${plural(picks.length, "change")})…</p>`);
    try { ask.win.postMessage({ type: "jajb-roster-apply", date, rev: payload.plan.rev != null ? payload.plan.rev : payload.rev, picks }, APP_ORIGIN); } catch (err) { /* closed */ }
    clearTimeout(ap.timer);
    ap.timer = setTimeout(() => {
      if (ap.my !== runId || ap.res) return;
      stopWith("No answer from the Live board window. Check the Live board, then click the bookmark again.");
      btn("Start over", run, true);
    }, 90000);
  }
  function onApplied(e) {
    const d = e.data;
    if (!ask.win || e.source !== ask.win || ap.my !== runId || !ap.picks || ap.res || d.date !== date) return;
    clearTimeout(ap.timer);
    ap.res = d;
    const by = new Map((Array.isArray(d.results) ? d.results : []).filter((r) => r && typeof r === "object").map((r) => [r.name, r]));
    const lines = [];
    for (const pk of ap.picks) {
      const r = by.get(pk.name);
      if (r && r.ok) {
        lines.push(`<li>${esc(pk.name)} → ${pk.kind === "route" ? "route" : "backup"}</li>`);
        if (pk.with) lines.push(r.with_ok ? `<li>${esc(pk.with)} → route</li>`
          : `<li class="bad">${esc(pk.with)} NOT given the route: ${esc(r.with_why || "no answer")}</li>`);
      } else {
        lines.push(`<li class="bad">${esc(pk.name)} NOT changed: ${esc((r && r.why) || d.error || "no answer")}</li>`);
      }
    }
    ap.note = `<div class="wave"><b>Live board:</b><ul>${lines.join("")}</ul>${d.payload ? "" : '<p class="bad">Nothing was saved on the Live board — the rows are filled from it as it was.</p>'}</div>`;
    if (d.payload && typeof d.payload === "object" && d.payload.type === "jajb-roster" && d.payload.date === date && !d.payload.error) {
      payload = d.payload;                                     // the day again, after the changes
    }
    showPreview(ap.my);
  }

  // Step 3: what will happen, before picking anything
  let plan = null;
  const nameOf = (d) => esc(d.name) + (d.trainee ? ' <span class="muted">(trainee — trainer rides along)</span>' : "");
  const names = (list) => list.map(nameOf).join(", ");

  // the Standard Parcel service's rows grouped by start time, page order: [{label, key, rows}]
  function readWaves(svcEl) {
    const out = [], byKey = new Map();
    for (const r of readRows(svcEl)) {
      let w = byKey.get(r.key);
      if (!w) { w = { label: r.key, key: r.key, rows: [] }; byKey.set(r.key, w); out.push(w); }
      w.rows.push(r);
    }
    return out;
  }

  async function buildPlan() {
    const svcs = await waitFor(() => { const s = readServices(); return s.length ? s : null; }, 4000);
    if (!svcs) return { err: "Couldn't find any confirmed services on this page. Let the page finish loading, then click the bookmark again." };
    const sps = svcs.filter((s) => s.sp && s.rows.length);
    if (!sps.length) return { err: "There is no Standard Parcel service with routes on this day — nothing to fill." };
    // Amazon opens one service at a time: the open one with empty rows, else the first with empty rows
    // A re-run (Jose 2026-11-12): a row holding someone who isn't on a route on the Live board any more
    // ("stale") is a free row too - the Live board driver goes in their place, or it is emptied.
    // Stale is only known once the associate list is read, so a service counts as "has room" here when
    // it has an empty row or any filled one.
    const hasEmpty = (s) => s.rows.some(isEmpty);
    const hasRoom = (s) => hasEmpty(s) || s.rows.some((r) => r.sel.value && !r.sel.disabled);
    const target = sps.find((s) => isOpen(s.el) && hasEmpty(s)) || sps.find(hasEmpty) || sps.find((s) => isOpen(s.el) && hasRoom(s))
      || sps.find(hasRoom) || sps.find((s) => isOpen(s.el)) || sps[0];
    const opened = !isOpen(target.el);
    if (!(await openService(target.el))) {
      return { errHtml: `Amazon didn't open <b>${esc(target.short)}</b> — it may be asking about unsaved changes. Answer it (or Save / Cancel the open service), then click the bookmark again.` };
    }
    const opts = readOptions(target.rows[0].sel);
    if (!opts.length) return { err: "Amazon's associate list came up empty for this day. Nothing was changed." };
    const taken = takenNow(svcs);
    // pre-match every driver locally: Transporter ID first (Amazon's option value), then the name
    const usedBy = new Map();
    const keep = new Set();                                    // every option a Live board route driver could be
    const drivers = (payload.drivers || []).map((d) => {
      const r = { d, opt: null, status: null, why: "" };
      let cands = d.tid ? opts.filter((o) => o.value === d.tid) : [];
      if (!cands.length) cands = opts.filter((o) => sameDriver(d.name, o.name));
      for (const c of cands) keep.add(c.value);
      if (cands.length > 1) { r.status = "ambiguous"; r.why = cands.map((c) => c.name).join(" / "); return r; }
      if (!cands.length) { r.status = "notfound"; return r; }
      const c = r.opt = cands[0];
      const t = taken.get(c.value);
      if (t) { r.status = "already"; r.where = t; return r; }
      if (c.inactive) { r.status = "group"; r.why = "Inactive"; return r; }
      const prev = usedBy.get(c.value);
      if (prev) { r.status = "ambiguous"; r.why = `same Amazon name as ${prev.d.name}: ${c.name}`; return r; }
      usedBy.set(c.value, r);
      r.status = "match";
      return r;
    });
    // line schedule waves up with Amazon start times
    const waves = readWaves(target.el);
    const byKey = new Map(waves.map((w) => [w.key, w]));
    const sched = [];                                          // [{key, label, sched, drivers: [r]}] payload order
    for (const r of drivers) {
      const k = waveKey(r.d.portal);
      let s = sched.find((x) => x.key === k);
      if (!s) { s = { key: k, label: one(r.d.portal), sched: r.d.sched, drivers: [] }; sched.push(s); }
      s.drivers.push(r);
    }
    const isStale = (row) => !!row.sel.value && !row.sel.disabled && !keep.has(row.sel.value);
    const lines = [];                                          // per Amazon start time, page order
    for (const w of waves) {
      const s = sched.find((x) => x.key === w.key);
      const empty = w.rows.filter(isEmpty).length;
      // stale rows: [{value, name}] - who's there now (re-run, Jose 2026-11-12)
      const stale = w.rows.filter(isStale).map((row) => ({ value: row.sel.value, name: currentDA(row) }));
      const free = empty + stale.length;
      const ds = s ? s.drivers : [];
      const fill = ds.filter((r) => r.status === "match");
      fill.forEach((r, i) => { if (i >= free) r.status = "leftover"; });
      lines.push({ w, s, routes: w.rows.length, empty, stale, free, ds, toFill: fill.filter((r) => r.status === "match") });
    }
    const noWave = sched.filter((s) => !byKey.has(s.key));
    for (const s of noWave) for (const r of s.drivers) if (r.status === "match" || r.status === "leftover") r.status = "nowave";
    // Moved to another start time (Jose 2026-10-23): Amazon's wave split often differs from the schedule's
    // (11 drivers at 10:25, Amazon 9 rows; 14 at 10:45, Amazon 15). A driver left over — or whose start
    // time Amazon doesn't have — goes into a spare empty row at the nearest other start time (a later one
    // on a tie) and the panel says so. Once their pick is in, the Live board follows (moves window below).
    const spare = (l) => l.free - l.toFill.length;
    const loose = [];
    for (const l of lines) for (const r of l.ds) if (r.status === "leftover") loose.push({ r, from: l.w.label, mins: waveMins(l.w.key) });
    for (const s of noWave) for (const r of s.drivers) if (r.status === "nowave") loose.push({ r, from: s.label, mins: waveMins(s.key) });
    for (const x of loose) {
      const to = lines.filter((l) => spare(l) > 0 && l.w.label !== x.from)
        .sort((a, b) => Math.abs(waveMins(a.w.key) - x.mins) - Math.abs(waveMins(b.w.key) - x.mins) || waveMins(b.w.key) - waveMins(a.w.key))[0];
      if (!to) continue;
      x.r.status = "match";
      x.r.movedTo = to.w.label;
      x.r.movedFrom = x.from;
      to.toFill.push(x.r);
      (to.moved || (to.moved = [])).push(x.r);
    }
    // which stale rows get a Live board driver (the empty rows fill first) and which are emptied
    for (const l of lines) {
      const into = Math.max(0, l.toFill.length - l.empty);
      l.swapOut = l.stale.slice(0, into);                      // someone else goes in their place
      l.clear = l.stale.slice(into);                           // emptied: nobody left for that row
    }
    const total = lines.reduce((n, l) => n + l.toFill.length, 0);
    const clears = lines.reduce((n, l) => n + l.clear.length, 0);
    const others = svcs.filter((s) => s.el !== target.el)
      .map((s) => ({ short: s.short, sp: s.sp, rows: s.rows.length, empty: s.rows.filter(isEmpty).length }));
    const filtered = [...target.el.querySelectorAll(".DAFilter select")].some((x) => x.value);
    return { target, opened, lines, noWave, drivers, total, clears, others, filtered, keep,
      anyEmpty: target.rows.some(isEmpty) || lines.some((l) => l.stale.length) };
  }

  // where someone already is, when it isn't this start time of the service we fill
  const whereNote = (r, l) => r.where && (r.where.svc !== plan.target.el || r.where.key !== l.w.key) ? ` (on ${esc(r.where.where)})` : "";

  // the per-wave problem lines; `final` adds what happened during the fill
  function waveHtml(l, final) {
    // a driver moved to another start time is reported there (Jose 2026-10-23)
    const ds = [...l.ds.filter((r) => !r.movedTo), ...(l.moved || [])];
    const by = (st) => ds.filter((r) => r.status === st);
    const out = [];
    // moves read one way (Jose 2026-11-14): the sending time says "more drivers than rows - these go to X",
    // the receiving time says "more rows than drivers - these come from Y"; it's the same people, once
    const gone = l.ds.filter((r) => r.movedTo);
    for (const to of [...new Set(gone.map((r) => r.movedTo))]) {
      const g = gone.filter((r) => r.movedTo === to);
      out.push(`<li class="warn">${plural(g.length, "more driver")} than Amazon has rows here, so ${g.length === 1 ? "this driver goes" : "these drivers go"} to <b>${esc(to)}</b> instead: ${names(g.map((r) => r.d))}</li>`);
    }
    if ((l.moved || []).length) {
      const from = [...new Set(l.moved.map((r) => r.movedFrom))].join(" / ");
      out.push(`<li class="warn">Amazon has ${plural(l.moved.length, "more row")} here than drivers, so ${l.moved.length === 1 ? "this driver comes" : "these drivers come"} over from <b>${esc(from)}</b>: ${names(l.moved.map((r) => r.d))}</li>`);
    }
    const nf = by("notfound"); if (nf.length) out.push(`<li class="bad">Not in Amazon's associate list: ${names(nf.map((r) => r.d))}</li>`);
    const am = by("ambiguous"); if (am.length) out.push(`<li class="bad">More than one match in Amazon's list — not placed: ${am.map((r) => `${nameOf(r.d)} (${esc(r.why)})`).join(", ")}</li>`);
    const gr = by("group"); if (gr.length) out.push(`<li class="bad">Amazon lists them as ${esc(gr[0].why)} — not placed: ${names(gr.map((r) => r.d))}</li>`);
    const al = by("already"); if (al.length) out.push(`<li class="muted">Already on Amazon — nothing to do: ${al.map((r) => nameOf(r.d) + whereNote(r, l)).join(", ")}</li>`);
    const fa = by("failed"); if (fa.length) out.push(`<li class="bad">Couldn't place: ${fa.map((r) => `${nameOf(r.d)} — ${esc(r.why)}`).join("; ")}</li>`);
    const lo = by("leftover"); if (lo.length) out.push(`<li class="bad">Amazon has no row left for ${lo.length === 1 ? "this driver" : "these drivers"}, so they stay off Amazon but still on a route on the Live board: ${names(lo.map((r) => r.d))}. Make them a backup on the Live board, or add a row on Amazon.</li>`);
    const nm = (xs) => xs.map((x) => esc(x.name || "someone")).join(", ");
    if (final) {
      const ns = by("match"); if (ns.length) out.push(`<li class="warn">Not filled (stopped): ${names(ns.map((r) => r.d))}</li>`);
      const sw = (l.swapped || []); if (sw.length) out.push(`<li class="warn">Replaced (no longer on a route on the Live board): ${nm(sw)}</li>`);
      const cl = (l.cleared || []); if (cl.length) out.push(`<li class="warn">Taken off, row left empty (no longer on a route on the Live board): ${nm(cl)}</li>`);
      const cf = (l.clearFailed || []); if (cf.length) out.push(`<li class="bad">Couldn't take off — do it by hand: ${nm(cf)}</li>`);
      const still = l.w.rows.filter(isEmpty).length;
      if (still) out.push(`<li class="warn">${plural(still, "row")} still empty</li>`);
      const flagged = l.w.rows.filter((r) => errMark(r));
      if (flagged.length) out.push(`<li class="bad">Amazon shows a red ! on ${plural(flagged.length, "row")} at this time — check them</li>`);
    } else {
      if (l.swapOut.length) out.push(`<li class="warn">On Amazon but no longer on a route on the Live board — someone from the Live board takes their row: ${nm(l.swapOut)}</li>`);
      if (l.clear.length) out.push(`<li class="warn">On Amazon but no longer on a route on the Live board — their row will be emptied: ${nm(l.clear)}</li>`);
      const stay = l.free - l.toFill.length;
      if (stay > 0) out.push(`<li class="bad">${plural(stay, "row")} will still be empty after the fill — not enough drivers</li>`);
    }
    if (!l.s) out.push(`<li class="warn">Nobody on the Live board at this start time</li>`);
    // the header compares Amazon's rows with the Live board's drivers at this time (Jose 2026-11-14:
    // "18 empty rows" read as 18 short when it was 6) - rows already holding someone are named apart
    const had = l.routes - l.empty;
    const head = final
      ? `<b>${esc(l.w.label)}</b> — Amazon: ${plural(l.routes, "row")} · ${l.placed || 0} filled just now`
      : `<b>${esc(l.w.label)}</b> — Amazon: ${plural(l.routes, "row")}${had ? ` (${had} already ${had === 1 ? "has" : "have"} someone)` : ""} · Live board: ${plural(l.ds.length, "driver")}`;
    const who = !final && l.toFill.length
      ? `<details><summary>Who goes in (${l.toFill.length})</summary><ol>${l.toFill.map((r) => `<li>${nameOf(r.d)}</li>`).join("")}</ol></details>` : "";
    return `<div class="wave">${head}${out.length ? `<ul>${out.join("")}</ul>` : ""}${who}</div>`;
  }
  function extraHtml(p) {
    let h = "";
    for (const s of p.noWave) {
      const left = s.drivers.filter((r) => !r.movedTo);
      if (left.length) h += `<div class="wave"><span class="bad">Amazon has no <b>${esc(s.label)}</b> rows in ${esc(p.target.short)} (Live board time ${esc(s.sched)}) — not placed:${names(left.map((r) => r.d))}</span></div>`;
    }
    const sk = payload.skipped || [];
    if (sk.length) h += `<p class="muted">Backups and trainers don't get an Amazon row: ${sk.map((s) => `${esc(s.name)} (${esc(String(s.why || "").toLowerCase())})`).join(", ")}</p>`;
    for (const o of p.others.filter((x) => x.sp && x.empty)) {
      h += `<p class="warn">Also ${esc(o.short)}: ${plural(o.empty, "empty row")}. Save this one first, then open that one with its + and click the bookmark again.</p>`;
    }
    const rest = p.others.filter((x) => !x.sp);
    if (rest.length) h += `<p class="muted">Left for you (not filled): ${rest.map((o) => `${esc(o.short)} — ${plural(o.rows, "row")}, ${o.empty} empty`).join("; ")}</p>`;
    return h;
  }

  async function preview(my) {
    clearBtns(); progress(null);
    say("Reading Amazon's services and associate list…");
    const p = await buildPlan();
    if (my !== runId) return;
    if (p.err || p.errHtml) { stopWith(p.errHtml || esc(p.err)); btn("Start over", run, true); return; }
    plan = p;
    const n = (payload.drivers || []).length;
    let h = ask.warn + (ap.note || "") + `<p><b>${esc(dayLabel(date))}</b> — ${plural(n, "driver")} on routes on the Live board.</p>`;
    h += `<p>Filling <b>${esc(p.target.short)}</b>${p.opened ? " (opened it for you)" : ""}.</p>`;
    if (p.filtered) h += '<p class="warn">⚠ Set the Filter (Start Time / Associate Name) back to All so every row shows.</p>';
    if (!p.anyEmpty) h += '<p class="warn">Every row already has the right associate — there is nothing to fill.</p>';
    h += p.lines.map((l) => waveHtml(l, false)).join("") + extraHtml(p);
    h += `<p><b>Nothing has been changed on Amazon's page yet.</b> Amazon keeps nothing until you press <b>Save</b> under the rows.</p>`;
    say(h);
    const label = [p.total ? `Fill ${plural(p.total, "row")}` : "", p.clears ? `take ${p.clears} off` : ""].filter(Boolean).join(", ");
    if (p.total || p.clears) btn(label.charAt(0).toUpperCase() + label.slice(1), () => fill(my));
    btn("Start over", run, true);
  }

  // Step 4: fill, one row at a time
  // `was` (a re-run, Jose 2026-11-12): the row holds that associate now (not on a route on the Live
  // board) and the driver goes in their place; if Amazon won't take it, they're put back.
  async function placeOne(row, opt, was) {
    const { sel } = row;
    if (!sel.isConnected) return { ok: false, why: "that row is gone", rowBad: true };
    if (was ? sel.value !== was : currentDA(row)) return { ok: false, why: "that row now has " + (currentDA(row) || "someone else"), rowBad: true };
    if (sel.disabled) return { ok: false, why: "Amazon has that row locked", rowBad: true };
    const o = [...sel.options].find((x) => x.value === opt.value);
    if (!o) return { ok: false, why: "not in Amazon's list for that row" };
    const other = takenNow().get(opt.value);
    if (other) return { ok: false, why: `Amazon now shows them on ${other.where}` };
    const back = was ? [...sel.options].find((x) => x.value === was) : null;
    const undo = () => (back ? setRow(row, back.index, () => sel.value === was) : emptyRow(row));
    const want = one(o.textContent);
    if (!(await setRow(row, o.index, () => sel.value === opt.value && shown(row) === want))) {
      const clean = (was ? sel.value === was : !sel.value && shown(row) === CAPTION) || await undo();
      return { ok: false, why: "Amazon's box didn't take it" + (clean ? "" : " — please check that row") };
    }
    await sleep(150);                                          // give Amazon a moment to show its red !
    const bad = errMark(row);
    if (bad) {
      const cleared = await undo() && !!(await waitFor(() => !errMark(row), 1000));
      return { ok: false, why: `Amazon said “${bad}” — ${cleared ? (was ? "that row was put back" : "that row was emptied again") : "couldn't undo that row, please check it"}` };
    }
    return { ok: true };
  }

  const stillHere = () => !!plan && plan.target.el.isConnected && isOpen(plan.target.el) && pageDate() === date;

  async function fill(my) {
    if (my !== runId || !plan) return;
    if (!stillHere()) {
      stopWith("The page changed (another day, or the Standard Parcel rows were closed). Nothing more was filled. Click the bookmark again.");
      return;
    }
    // a driver going to another start time: the Live board window opens now, inside the click (no
    // pop-up block), and loads while Amazon is filled (Jose 2026-10-23)
    if (movedOf(plan).length) openMoves(my); else mv.my = 0;
    stopped = false;
    clearBtns();
    btn("Stop", () => { stopped = true; }, true);
    const total = plan.total, steps = plan.total + plan.clears;
    let done = 0, placed = 0;
    progress(0);
    const status = () => say(`<p>Filling ${Math.min(done + 1, steps)} of ${steps}…</p><p class="muted">Nothing is saved — you press Save at the end.</p>`);
    outer:
    for (const l of plan.lines) {
      l.placed = 0; l.swapped = []; l.cleared = []; l.clearFailed = [];
      const bad = new Set();                                   // row positions at this start time to skip
      const left = new Map(l.stale.map((x) => [x.value, x]));  // stale associates still on a row here
      const fresh = () => { const w = readWaves(plan.target.el).find((x) => x.key === l.w.key); if (w) l.w.rows = w.rows; return w; };
      for (const r of l.toFill) {
        if (stopped || my !== runId) break outer;
        if (!stillHere()) { stopped = true; plan.lost = true; break outer; }
        status();
        const w = fresh();                                     // fresh rows: the page may have re-drawn
        // an empty row first, else a row whose associate isn't on a route on the Live board (re-run)
        let idx = w ? w.rows.findIndex((row, i) => !bad.has(i) && isEmpty(row)) : -1;
        if (idx < 0 && w) idx = w.rows.findIndex((row, i) => !bad.has(i) && !row.sel.disabled && left.has(row.sel.value));
        if (idx < 0) { r.status = "leftover"; done++; progress(done / steps); continue; }
        const was = isEmpty(w.rows[idx]) ? null : w.rows[idx].sel.value;
        let res;
        try { res = await placeOne(w.rows[idx], r.opt, was); } catch (err) { res = { ok: false, why: "error: " + (err && err.message || err) }; }
        if (res.ok) {
          r.status = "placed"; placed++; l.placed++;
          if (was) { l.swapped.push(left.get(was)); left.delete(was); }
        } else { r.status = "failed"; r.why = res.why; if (res.rowBad || was) bad.add(idx); }
        done++;
        progress(done / steps);
      }
      // whoever is still on a row here but not on a route on the Live board: their row is emptied
      for (const x of [...left.values()]) {
        if (stopped || my !== runId) break outer;
        if (!stillHere()) { stopped = true; plan.lost = true; break outer; }
        status();
        const w = fresh();
        const row = w && w.rows.find((rw) => !rw.sel.disabled && rw.sel.value === x.value);
        let ok = false;
        if (row) { try { ok = await emptyRow(row); } catch (err) { ok = false; } }
        (ok ? l.cleared : l.clearFailed).push(x);
        left.delete(x.value);
        done++;
        progress(Math.min(1, done / steps));
      }
    }
    if (mv.my === my) sendMoves();                             // also when the panel was closed mid-fill
    if (my !== runId) return;
    finish(placed, total);
  }

  // Step 5: the end
  function finish(placed, total) {
    progress(null); clearBtns();
    const fresh = readWaves(plan.target.el);
    for (const l of plan.lines) { const w = fresh.find((x) => x.key === l.w.key); if (w) l.w.rows = w.rows; }
    const svcs = readServices();
    plan.others = svcs.filter((s) => s.el !== plan.target.el)
      .map((s) => ({ short: s.short, sp: s.sp, rows: s.rows.length, empty: s.rows.filter(isEmpty).length }));
    let h = (ap.note || "") + `<p><b>${stopped ? "Stopped. " : ""}Filled ${placed} of ${plural(total, "row")}.</b></p>`;
    if (plan.lost) h += '<p class="bad">The Standard Parcel rows were closed (or the day changed) during the fill.</p>';
    h += plan.lines.map((l) => waveHtml(l, true)).join("") + extraHtml(plan);
    if (mv.list && mv.list.length) h += '<div class="lvmoves"></div>';
    h += `<p style="margin-top:8px"><b>Nothing is saved yet. Check the screen, then press Save (under the ${esc(plan.target.short)} rows) yourself.</b></p>`;
    say(h);
    renderMoves();
    btn("Start over", run, true);
    btn("Close", () => box.querySelector(".x").click(), true);
  }

  /* ---------- the Live board follows Amazon's start times (Jose 2026-10-23) ----------
   * A driver put at another start time here is moved on the Live board too (wave and that day's
   * per-wave route counts). The Fill click opens the app as APP#roster-moves=<date> (window
   * "jajbRosterMoves"); it signs in and loads the week's rules engine while Amazon is filled, says
   * "jajb-roster-moves-ready" every second, and once the fill is over gets ONLY the moves whose pick
   * went in: {type: "jajb-roster-moves", date, week, rev, moves: [{name, tid, from, to}]} (schedule
   * times). It answers {type: "jajb-roster-moves-done", date, results: [{name, ok, why?}], error?}.
   * Kept apart from onMessage, so closing the panel mid-fill still sends what went in. */
  const mv = { my: 0, win: null, list: null, sent: false, res: null, timer: null, date: null, week: null, rev: null };
  const movedOf = (p) => p.lines.flatMap((l) => l.moved || []);
  const WAIT_MOVES = 90000;                                    // the engine may still be loading
  function openMoves(my) {
    clearTimeout(mv.timer);
    Object.assign(mv, { my, list: null, sent: false, res: null, date,
      week: payload.week || null, rev: payload.rev != null ? payload.rev : null });
    try { if (mv.win && !mv.win.closed) mv.win.close(); } catch (e) { /* gone */ }
    mv.win = window.open(APP + "?r=" + Date.now() + "#roster-moves=" + date, "jajbRosterMoves", "width=440,height=560");
    window.addEventListener("message", onMoves);
  }
  const noAnswer = (why) => { mv.res = { results: [], error: why }; renderMoves(); };
  function sendMoves() {
    mv.list = movedOf(plan).filter((r) => r.status === "placed")
      .map((r) => ({ name: r.d.name, tid: r.d.tid || null, from: r.d.sched, to: toSched(r.movedTo) }))
      .filter((x) => x.from && x.to && x.from !== x.to);
    clearTimeout(mv.timer);
    if (!mv.win) { if (mv.list.length) noAnswer("the Live board window didn't open (pop-ups blocked?)"); return; }
    // nothing went in: still answered, so the window closes itself
    mv.timer = setTimeout(() => { if (!mv.res) noAnswer("no answer from the Live board window"); }, WAIT_MOVES);
    renderMoves();
  }
  function onMoves(e) {
    if (!APP_ORIGIN || e.origin !== APP_ORIGIN || !mv.win || e.source !== mv.win || !e.data || typeof e.data !== "object") return;
    if (e.data.type === "jajb-roster-moves-ready") {
      if (!mv.list || mv.sent) return;                         // still filling: it says "ready" again in a second
      mv.sent = true;
      try { e.source.postMessage({ type: "jajb-roster-moves", date: mv.date, week: mv.week, rev: mv.rev, moves: mv.list }, APP_ORIGIN); } catch (err) { /* closed */ }
      clearTimeout(mv.timer);
      mv.timer = setTimeout(() => { if (!mv.res) noAnswer("no answer from the Live board window"); }, WAIT_MOVES);
      return;
    }
    if (e.data.type === "jajb-roster-moves-done" && mv.sent && e.data.date === mv.date) {
      clearTimeout(mv.timer);
      mv.res = { results: Array.isArray(e.data.results) ? e.data.results : [], error: e.data.error ? String(e.data.error) : null };
      window.removeEventListener("message", onMoves);
      renderMoves();
    }
  }
  // the panel's lines (the fill's own lines and the Save reminder stay as they are)
  function renderMoves() {
    const slot = box.querySelector(".lvmoves");
    if (!slot || !mv.list || !mv.list.length) return;
    // the Live board's time can differ from Amazon's for the same wave (Jose 2026-11-14) - say both
    const amz = (m) => ((plan ? movedOf(plan) : []).find((r) => r.d.name === m.name) || {}).movedTo;
    const to = (m) => { const a = amz(m); return `${esc(m.name)} → ${esc(m.to)}${a && a !== m.to ? ` (Amazon's ${esc(a)})` : ""}`; };
    if (!mv.res) { slot.innerHTML = `<p class="muted">Updating the Live board to match: ${mv.list.map(to).join(", ")}…</p>`; return; }
    const by = new Map(mv.res.results.filter((r) => r && typeof r === "object").map((r) => [r.name, r]));
    const good = mv.list.filter((m) => by.has(m.name) && by.get(m.name).ok === true);
    let h = good.length ? `<p><b>Live board updated:</b> ${good.map(to).join(", ")}</p>` : "";
    for (const m of mv.list.filter((x) => !good.includes(x))) {
      const why = String((by.get(m.name) || {}).why || mv.res.error || "no answer from the Live board window").replace(/\.\s*$/, "");
      h += `<p class="bad">Live board NOT updated for ${esc(m.name)}: ${esc(why)} — change it there by hand (to ${esc(m.to)} on the Live board).</p>`;
    }
    slot.innerHTML = h;
  }

  run().catch((err) => stopWith("Something went wrong: " + esc(err && err.message || err)));
})();
