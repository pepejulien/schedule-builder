/* roster.js — the "🧾 Roster to Amazon" bookmark (Jose 2026-10-09; legacy page 2026-10-23;
 * spec: docs/roster-bookmarklet.md, Amazon page notes: docs/amazon-roster-dom.md "Legacy view").
 *
 * Runs in Amazon's old Scheduling day page — what Dispatch shows with "Legacy view" on
 * (logistics.amazon.com/scheduling?date=…). It opens the Schedule Builder in a small window
 * (APP#roster=<date>), which reads that day off the Live board and hands the drivers back
 * (window.postMessage). Then it shows what it will do, and on "Fill" picks each driver in an
 * empty Associate box of the Standard Parcel service, wave by wave (start time), one row at a time.
 *
 * Amazon keeps nothing until the service's Save button is pressed, and this file NEVER clicks
 * Save, Cancel, SUBMIT, Auto Roster, Bulk Import or a red X. Rows that already have an associate
 * are never touched; Nursery Route, Hub Transport and other services are left alone (listed).
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
        return { el, heading, short: shortSvc(heading), sp: SP_RE.test(heading), rows: readRows(el) };
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
      try { if (ask.win && !ask.win.closed) ask.win.close(); } catch (e) { /* gone */ }
      ask.win = window.open(APP + "?r=" + Date.now() + "#roster=" + date, "jajbRoster", "width=440,height=560");
      return ask.win;
    };
    const waiting = () => {
      clearBtns();
      say(`${warn}<p>Getting ${label} from the Live board… (sign in there if it asks)</p>`);
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

  function onMessage(e) {
    if (!APP_ORIGIN || e.origin !== APP_ORIGIN || !e.data || typeof e.data !== "object") return;
    const my = ask.my;
    if (my !== runId || payload || !date) return;
    if (e.data.type === "jajb-roster-ready") {
      try { e.source.postMessage({ type: "jajb-roster-request", date }, APP_ORIGIN); } catch (err) { /* window closed */ }
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
    preview(my).catch((err) => stopWith("Something went wrong: " + esc(err && err.message || err)));
  }
  window.addEventListener("message", onMessage);

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
    const hasEmpty = (s) => s.rows.some(isEmpty);
    const target = sps.find((s) => isOpen(s.el) && hasEmpty(s)) || sps.find(hasEmpty) || sps.find((s) => isOpen(s.el)) || sps[0];
    const opened = !isOpen(target.el);
    if (!(await openService(target.el))) {
      return { errHtml: `Amazon didn't open <b>${esc(target.short)}</b> — it may be asking about unsaved changes. Answer it (or Save / Cancel the open service), then click the bookmark again.` };
    }
    const opts = readOptions(target.rows[0].sel);
    if (!opts.length) return { err: "Amazon's associate list came up empty for this day. Nothing was changed." };
    const taken = takenNow(svcs);
    // pre-match every driver locally: Transporter ID first (Amazon's option value), then the name
    const usedBy = new Map();
    const drivers = (payload.drivers || []).map((d) => {
      const r = { d, opt: null, status: null, why: "" };
      let cands = d.tid ? opts.filter((o) => o.value === d.tid) : [];
      if (!cands.length) cands = opts.filter((o) => sameDriver(d.name, o.name));
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
    const lines = [];                                          // per Amazon start time, page order
    for (const w of waves) {
      const s = sched.find((x) => x.key === w.key);
      const empty = w.rows.filter(isEmpty).length;
      const ds = s ? s.drivers : [];
      const fill = ds.filter((r) => r.status === "match");
      fill.forEach((r, i) => { if (i >= empty) r.status = "leftover"; });
      lines.push({ w, s, routes: w.rows.length, empty, ds, toFill: fill.filter((r) => r.status === "match") });
    }
    const noWave = sched.filter((s) => !byKey.has(s.key));
    for (const s of noWave) for (const r of s.drivers) if (r.status === "match" || r.status === "leftover") r.status = "nowave";
    const total = lines.reduce((n, l) => n + l.toFill.length, 0);
    const others = svcs.filter((s) => s.el !== target.el)
      .map((s) => ({ short: s.short, sp: s.sp, rows: s.rows.length, empty: s.rows.filter(isEmpty).length }));
    const filtered = [...target.el.querySelectorAll(".DAFilter select")].some((x) => x.value);
    return { target, opened, lines, noWave, drivers, total, others, filtered, anyEmpty: target.rows.some(isEmpty) };
  }

  // where someone already is, when it isn't this start time of the service we fill
  const whereNote = (r, l) => r.where && (r.where.svc !== plan.target.el || r.where.key !== l.w.key) ? ` (on ${esc(r.where.where)})` : "";

  // the per-wave problem lines; `final` adds what happened during the fill
  function waveHtml(l, final) {
    const ds = l.ds;
    const by = (st) => ds.filter((r) => r.status === st);
    const out = [];
    const nf = by("notfound"); if (nf.length) out.push(`<li class="bad">Not in Amazon's associate list: ${names(nf.map((r) => r.d))}</li>`);
    const am = by("ambiguous"); if (am.length) out.push(`<li class="bad">More than one match in Amazon's list — not placed: ${am.map((r) => `${nameOf(r.d)} (${esc(r.why)})`).join(", ")}</li>`);
    const gr = by("group"); if (gr.length) out.push(`<li class="bad">Amazon lists them as ${esc(gr[0].why)} — not placed: ${names(gr.map((r) => r.d))}</li>`);
    const al = by("already"); if (al.length) out.push(`<li class="muted">Already on a row in Amazon (skipped, that's fine): ${al.map((r) => nameOf(r.d) + whereNote(r, l)).join(", ")}</li>`);
    const fa = by("failed"); if (fa.length) out.push(`<li class="bad">Couldn't place: ${fa.map((r) => `${nameOf(r.d)} — ${esc(r.why)}`).join("; ")}</li>`);
    const lo = by("leftover"); if (lo.length) out.push(`<li class="warn">More drivers than empty rows — left over: ${names(lo.map((r) => r.d))}</li>`);
    if (final) {
      const ns = by("match"); if (ns.length) out.push(`<li class="warn">Not filled (stopped): ${names(ns.map((r) => r.d))}</li>`);
      const still = l.w.rows.filter(isEmpty).length;
      if (still) out.push(`<li class="warn">${plural(still, "empty row")} left empty</li>`);
      const flagged = l.w.rows.filter((r) => errMark(r));
      if (flagged.length) out.push(`<li class="bad">Amazon shows a red ! on ${plural(flagged.length, "row")} at this time — check them</li>`);
    } else {
      const stay = l.empty - l.toFill.length;
      if (stay > 0) out.push(`<li class="warn">${plural(stay, "empty row")} will stay empty</li>`);
    }
    if (!l.s) out.push(`<li class="warn">Nobody on the schedule for this start time</li>`);
    const head = final
      ? `<b>${esc(l.w.label)}</b> — ${plural(l.routes, "row")} · ${plural(l.ds.length, "driver")} · ${l.placed || 0} filled`
      : `<b>${esc(l.w.label)}</b> — ${plural(l.routes, "row")} · ${plural(l.ds.length, "driver")} · ${plural(l.empty, "empty row")}`;
    const who = !final && l.toFill.length
      ? `<details><summary>Who goes in (${l.toFill.length})</summary><ol>${l.toFill.map((r) => `<li>${nameOf(r.d)}</li>`).join("")}</ol></details>` : "";
    return `<div class="wave">${head}${out.length ? `<ul>${out.join("")}</ul>` : ""}${who}</div>`;
  }
  function extraHtml(p) {
    let h = "";
    for (const s of p.noWave) {
      h += `<div class="wave"><span class="bad">No <b>${esc(s.label)}</b> rows in ${esc(p.target.short)} (schedule ${esc(s.sched)}) — not placed: ${names(s.drivers.map((r) => r.d))}</span></div>`;
    }
    const sk = payload.skipped || [];
    if (sk.length) h += `<p class="muted">Not rostered: ${sk.map((s) => `${esc(s.name)} (${esc(String(s.why || "").toLowerCase())})`).join(", ")}</p>`;
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
    let h = ask.warn + `<p><b>${esc(dayLabel(date))}</b> — ${plural(n, "driver")} on routes on the Live board.</p>`;
    h += `<p>Filling <b>${esc(p.target.short)}</b>${p.opened ? " (opened it for you)" : ""}.</p>`;
    if (p.filtered) h += '<p class="warn">⚠ Set the Filter (Start Time / Associate Name) back to All so every row shows.</p>';
    if (!p.anyEmpty) h += '<p class="warn">Every row already has an associate — there is nothing to fill.</p>';
    h += p.lines.map((l) => waveHtml(l, false)).join("") + extraHtml(p);
    h += `<p><b>Nothing has been changed on Amazon's page yet.</b> Amazon keeps nothing until you press <b>Save</b> under the rows.</p>`;
    say(h);
    if (p.total) btn(`Fill ${plural(p.total, "row")}`, () => fill(my));
    btn("Start over", run, true);
  }

  // Step 4: fill, one row at a time
  async function placeOne(row, opt) {
    const { sel } = row;
    if (!sel.isConnected) return { ok: false, why: "that row is gone", rowBad: true };
    if (currentDA(row)) return { ok: false, why: "that row already has " + currentDA(row), rowBad: true };
    if (sel.disabled) return { ok: false, why: "Amazon has that row locked", rowBad: true };
    const o = [...sel.options].find((x) => x.value === opt.value);
    if (!o) return { ok: false, why: "not in Amazon's list for that row" };
    const other = takenNow().get(opt.value);
    if (other) return { ok: false, why: `Amazon now shows them on ${other.where}` };
    const want = one(o.textContent);
    if (!(await setRow(row, o.index, () => sel.value === opt.value && shown(row) === want))) {
      const clean = !sel.value && shown(row) === CAPTION || await emptyRow(row);
      return { ok: false, why: "Amazon's box didn't take it" + (clean ? "" : " — please check that row") };
    }
    await sleep(150);                                          // give Amazon a moment to show its red !
    const bad = errMark(row);
    if (bad) {
      const cleared = await emptyRow(row) && !!(await waitFor(() => !errMark(row), 1000));
      return { ok: false, why: `Amazon said “${bad}” — ${cleared ? "that row was emptied again" : "couldn't empty that row, please check it"}` };
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
    stopped = false;
    clearBtns();
    btn("Stop", () => { stopped = true; }, true);
    const total = plan.total;
    let done = 0, placed = 0;
    progress(0);
    const status = () => say(`<p>Filling ${Math.min(done + 1, total)} of ${total}…</p><p class="muted">Nothing is saved — you press Save at the end.</p>`);
    outer:
    for (const l of plan.lines) {
      l.placed = 0;
      const bad = new Set();                                   // row positions at this start time to skip
      for (const r of l.toFill) {
        if (stopped || my !== runId) break outer;
        if (!stillHere()) { stopped = true; plan.lost = true; break outer; }
        status();
        const w = readWaves(plan.target.el).find((x) => x.key === l.w.key);   // fresh rows: the page may have re-drawn
        if (w) l.w.rows = w.rows;
        const idx = w ? w.rows.findIndex((row, i) => !bad.has(i) && isEmpty(row)) : -1;
        if (idx < 0) { r.status = "leftover"; done++; progress(done / total); continue; }
        let res;
        try { res = await placeOne(w.rows[idx], r.opt); } catch (err) { res = { ok: false, why: "error: " + (err && err.message || err) }; }
        if (res.ok) { r.status = "placed"; placed++; l.placed++; } else { r.status = "failed"; r.why = res.why; if (res.rowBad) bad.add(idx); }
        done++;
        progress(done / total);
      }
    }
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
    let h = `<p><b>${stopped ? "Stopped. " : ""}Filled ${placed} of ${plural(total, "row")}.</b></p>`;
    if (plan.lost) h += '<p class="bad">The Standard Parcel rows were closed (or the day changed) during the fill.</p>';
    h += plan.lines.map((l) => waveHtml(l, true)).join("") + extraHtml(plan);
    h += `<p style="margin-top:8px"><b>Nothing is saved yet. Check the screen, then press Save (under the ${esc(plan.target.short)} rows) yourself.</b></p>`;
    say(h);
    btn("Start over", run, true);
    btn("Close", () => box.querySelector(".x").click(), true);
  }

  run().catch((err) => stopWith("Something went wrong: " + esc(err && err.message || err)));
})();
