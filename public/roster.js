/* roster.js — the "🧾 Roster to Amazon" bookmark (Jose 2026-10-09; spec: docs/roster-bookmarklet.md,
 * Amazon page notes: docs/amazon-roster-dom.md).
 *
 * Runs in Amazon's Dispatch page (logistics.amazon.com/dispatch?date=…) after dispatch clicks
 * "Edit route assignment". It opens the Schedule Builder in a small window (APP#roster=<date>),
 * which reads that day off the Live board and hands the drivers back (window.postMessage). Then it
 * shows what it will do, and on "Fill" puts each driver into an empty "Select DA" box of their wave,
 * one box at a time, the way a person would pick from the list.
 *
 * It NEVER saves: it never clicks Save changes, Auto-roster Vehicle, Cancel or anything else on
 * Amazon's toolbar. Rows that already have a DA are never touched. Dispatch checks the screen and
 * presses Save changes themselves.
 *
 * Loaded fresh on every click (the bookmark adds ?<time>), so fixing this file fixes every dispatch
 * computer — no re-adding the bookmark. The app it asks is wherever this file was loaded from.
 *
 * Local testing: a test page that copies Amazon's screen (tests/roster_mock/dispatch.html) sets
 * window.__jajbRosterTest = true before loading this file; that skips only the "is this
 * logistics.amazon.com/dispatch" check. Everything else runs exactly as on Amazon.
 */
(() => {
  "use strict";
  const SELF = (document.currentScript && document.currentScript.src) || "";
  const APP = SELF.replace(/roster\.js(\?.*)?$/, "");          // the app's own folder
  const APP_ORIGIN = APP ? new URL(APP).origin : "";
  if (window.__jajbRoster) { window.__jajbRoster.show(); return; }

  /* ---------- small helpers ---------- */
  const DA_INPUT = 'input[role="combobox"][aria-label="Select DA"]';
  const AVAILABLE = "Available";
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
  function dayLabel(iso) {                                     // "Saturday Oct 10"
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return String(iso || "");
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }
  const waveKey = (s) => one(s).toUpperCase().replace(/^0/, "");   // "10:45 AM"

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

  /* ---------- reading Amazon's page (docs/amazon-roster-dom.md) ---------- */
  function isEditing() {
    return !!document.querySelector(DA_INPUT) &&
      [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Save changes");
  }
  // the "Legacy view" switch in the header, when it is on
  function legacyOn() {
    for (const s of document.querySelectorAll('input[role="switch"]')) {
      const names = [s.getAttribute("aria-label")];
      const lb = s.getAttribute("aria-labelledby");
      if (lb) for (const id of lb.split(/\s+/)) names.push(document.getElementById(id) && document.getElementById(id).textContent);
      if (s.labels) for (const l of s.labels) names.push(l.textContent);
      for (let p = s.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) {
        const t = one(p.textContent);
        if (t && t.length < 60) names.push(t);
      }
      if (names.some((n) => /legacy view/i.test(n || "")) && (s.checked || s.getAttribute("aria-checked") === "true")) return true;
    }
    return false;
  }
  function urlDate() {
    const q = new URLSearchParams(location.search).get("date");
    return /^\d{4}-\d{2}-\d{2}$/.test(q || "") ? q : null;
  }
  function pickerDate() {                                      // "Saturday, October 10, 2026" between the arrows
    const prev = document.querySelector('button[aria-label="Previous day"]');
    const p = prev && prev.parentElement && prev.parentElement.querySelector("p");
    const d = p ? new Date(p.textContent.replace(/^[A-Za-z]+,\s*/, "")) : null;
    if (!d || isNaN(d)) return null;
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  const searchBox = () => document.querySelector('input[placeholder^="Search associates"]');

  // [{label, key, rows: [tr, …]}] in page order; a wave time on several cycles is merged (dup: true)
  function readWaves() {
    const out = [], byKey = new Map();
    for (const h of document.querySelectorAll('div[role="button"][aria-controls]')) {
      const body = document.getElementById(h.getAttribute("aria-controls"));
      const table = body && body.querySelector('table[aria-label="Dispatch routes"]');
      if (!table) continue;
      const label = one((h.querySelector("[mdn-expander-title] p") || {}).textContent);
      const rows = [...table.querySelectorAll("tbody tr")].filter((tr) => tr.querySelector(DA_INPUT));
      const key = waveKey(label);
      if (byKey.has(key)) { const w = byKey.get(key); w.rows.push(...rows); w.dup = true; continue; }
      const w = { label, key, rows, dup: false };
      byKey.set(key, w); out.push(w);
    }
    return out;
  }
  function currentDA(tr) {
    const v = one((tr.querySelector("[mdn-select-value]") || {}).textContent);
    const hasClear = !!tr.querySelector('button[aria-label="Clear DA assignment"]');
    return hasClear || (v && v !== "Select DA") ? v : null;
  }
  const alertText = (tr) => one((tr.querySelector('[role="alert"]') || {}).textContent) || null;

  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  // same first + last word, and every word of `want` appears in `have`: "Barry Hughes" ~ "Barry Len Hughes"
  function sameDriver(want, have) {
    const w = norm(want).split(" "), h = norm(have).split(" ");
    if (!w[0] || w[0] !== h[0] || w[w.length - 1] !== h[h.length - 1]) return false;
    return w.every((t) => h.includes(t));
  }
  // Optional, React internals (unstable): [{transporterId, name, …}] or null
  function daPool(inp) {
    try {
      const k = Object.keys(inp).find((x) => x.startsWith("__reactFiber$"));
      for (let f = k && inp[k], i = 0; f && i < 40; f = f.return, i++) {
        const p = f.memoizedProps;
        if (p && Array.isArray(p.daPool)) return p.daPool;
      }
    } catch (e) { /* not React, or changed */ }
    return null;
  }
  function setVal(inp, v) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(inp, v);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function closeList(inp) {
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
  }
  const listOf = (inp) => document.getElementById(inp.getAttribute("aria-controls") || "");
  // Types q into the box ("" = everyone) and returns [{el, group, name, hours}] once the list is stable.
  async function openList(inp, q) {
    inp.focus();
    if (inp.value === q) setVal(inp, q + " ");                // React only re-searches on a real change
    setVal(inp, q);
    let last = -1, stable = 0;
    for (let t = 0; t < 40; t++) {
      await sleep(50);
      const lb = listOf(inp);
      const n = lb ? lb.querySelectorAll('[role="option"]').length : 0;
      stable = n === last ? stable + 1 : 0;
      last = n;
      if (stable >= 3 && (n > 0 || t >= 12)) break;            // an empty list: wait a bit longer first
    }
    const lb = listOf(inp);
    if (!lb) return [];                                        // no match: Amazon renders no listbox at all
    return [...lb.querySelectorAll('[role="group"]')].flatMap((g) => {
      const group = one((g.querySelector('[role="presentation"]') || {}).textContent);
      return [...g.querySelectorAll('[role="option"]')].map((el) => ({
        el, group,
        name: el.getAttribute("aria-label") || "",                       // raw; may contain double spaces
        hours: one((el.querySelectorAll("p")[1] || {}).textContent),     // "29.1h/60h"
      }));
    });
  }
  async function closeAndWait(inp) {
    closeList(inp);
    await waitFor(() => inp.getAttribute("aria-expanded") !== "true", 1000);
  }

  /* ---------- the run ---------- */
  let date = null, payload = null;

  function stopWith(html) { progress(null); clearBtns(); say(html, "bad"); }

  // Step 1: the page checks. Returns a warning line (or "") when OK, null when stopped.
  function checks() {
    const onAmazon = /(^|\.)logistics\.amazon\.com$/.test(location.hostname) && /^\/dispatch/.test(location.pathname);
    if (!onAmazon && window.__jajbRosterTest !== true) {
      stopWith("Open Amazon <b>Dispatch</b>, pick the day, and click <b>Edit route assignment</b> first.");
      return null;
    }
    if (!APP) { stopWith("This bookmark is broken — drag a fresh one from the Live board."); return null; }
    if (legacyOn()) { stopWith("Turn off <b>Legacy view</b>, then click the bookmark again."); return null; }
    if (!isEditing()) { stopWith("Click <b>Edit route assignment</b> first, then click the bookmark again."); return null; }
    const u = urlDate(), p = pickerDate();
    date = u || p;
    if (!date) { stopWith("Couldn't tell which day this page is for. Pick the day again, then click the bookmark again."); return null; }
    if (u && p && u !== p) {
      stopWith(`The address bar says ${esc(dayLabel(u))} but the page shows ${esc(dayLabel(p))}. Reload the page, then click the bookmark again.`);
      return null;
    }
    const sb = searchBox();
    return sb && sb.value.trim() ? '<p class="warn">⚠ Clear the search box so every route shows.</p>' : "";
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

  // Step 3: what will happen, before touching anything
  let plan = null;
  const nameOf = (d) => esc(d.name) + (d.trainee ? ' <span class="muted">(trainee — trainer rides along)</span>' : "");
  const names = (list) => list.map(nameOf).join(", ");

  async function buildPlan() {
    const waves = readWaves();
    if (!waves.length) return { err: "Couldn't find any routes on this page. Make sure the day's routes show, then click the bookmark again." };
    const firstEmpty = waves.flatMap((w) => w.rows).find((tr) => !currentDA(tr));
    // who is already on a route in Amazon: exact (spaces collapsed) name → wave label
    const taken = new Map();
    for (const w of waves) for (const tr of w.rows) { const v = currentDA(tr); if (v) taken.set(v, w.label); }
    let opts = [], pool = null;
    if (firstEmpty) {
      const inp = firstEmpty.querySelector(DA_INPUT);
      pool = daPool(inp);
      opts = await openList(inp, "");
      await closeAndWait(inp);
      if (!opts.length) return { err: "Amazon's driver list came up empty for this day. Nothing was changed." };
    }
    // groups other than the two known ones (e.g. a limit) are named in the panel
    const otherGroups = [...new Set(opts.map((o) => o.group).filter((g) => g !== AVAILABLE && !/overlapping/i.test(g)))];
    // pre-match every driver locally
    const usedBy = new Map();
    const drivers = (payload.drivers || []).map((d) => {
      const r = { d, exact: null, status: null, why: "" };
      let cands = [];
      if (d.tid && pool) {
        const hit = pool.find((p) => p && p.transporterId === d.tid);
        if (hit) cands = opts.filter((o) => one(o.name) === one(hit.name));
        if (hit && !cands.length && taken.has(one(hit.name))) { r.exact = hit.name; r.status = "already"; r.where = taken.get(one(hit.name)); return r; }
      }
      if (!cands.length) cands = opts.filter((o) => sameDriver(d.name, o.name));
      if (cands.length > 1) { r.status = "ambiguous"; r.why = cands.map((c) => one(c.name)).join(" / "); return r; }
      // someone already in a DA box (not in the list we read, or listed as overlapping)
      const takenNames = [...taken.keys()].filter((t) => (cands.length ? one(cands[0].name) === t : sameDriver(d.name, t)));
      if (takenNames.length > 1) { r.status = "ambiguous"; r.why = takenNames.join(" / "); return r; }
      const takenName = takenNames[0];
      if (takenName) { r.exact = takenName; r.status = "already"; r.where = taken.get(takenName); return r; }
      if (!firstEmpty) { r.status = "nobox"; return r; }
      if (!cands.length) { r.status = "notfound"; return r; }
      const c = cands[0];
      r.exact = c.name;
      if (c.group !== AVAILABLE) {
        r.status = /overlapping/i.test(c.group) ? "already" : "group";
        r.why = c.group; return r;
      }
      const prev = usedBy.get(one(c.name));
      if (prev) { r.status = "ambiguous"; r.why = `same Amazon name as ${prev.d.name}: ${one(c.name)}`; return r; }
      usedBy.set(one(c.name), r);
      r.status = "match";
      return r;
    });
    // line schedule waves up with Amazon waves by label
    const byKey = new Map(waves.map((w) => [w.key, w]));
    const sched = [];                                          // [{key, label, sched, drivers: [r]}] payload order
    for (const r of drivers) {
      const k = waveKey(r.d.portal);
      let s = sched.find((x) => x.key === k);
      if (!s) { s = { key: k, label: one(r.d.portal), sched: r.d.sched, drivers: [] }; sched.push(s); }
      s.drivers.push(r);
    }
    const lines = [];                                          // per Amazon wave, page order
    for (const w of waves) {
      const s = sched.find((x) => x.key === w.key);
      const empty = w.rows.filter((tr) => !currentDA(tr)).length;
      const ds = s ? s.drivers : [];
      const fill = ds.filter((r) => r.status === "match");
      fill.forEach((r, i) => { if (i >= empty) r.status = "leftover"; });
      lines.push({ w, s, routes: w.rows.length, empty, ds, toFill: fill.filter((r) => r.status === "match") });
    }
    const noWave = sched.filter((s) => !byKey.has(s.key));
    for (const s of noWave) for (const r of s.drivers) if (r.status === "match" || r.status === "leftover") r.status = "nowave";
    const total = lines.reduce((n, l) => n + l.toFill.length, 0);
    return { waves, lines, noWave, drivers, total, otherGroups, anyEmpty: !!firstEmpty };
  }

  // the per-wave problem lines; `final` adds what happened during the fill
  function waveHtml(l, final) {
    const ds = l.ds;
    const by = (st) => ds.filter((r) => r.status === st);
    const out = [];
    const nf = by("notfound"); if (nf.length) out.push(`<li class="bad">Not in Amazon's list (likely not available that day): ${names(nf.map((r) => r.d))}</li>`);
    const am = by("ambiguous"); if (am.length) out.push(`<li class="bad">More than one match in Amazon's list — not placed: ${am.map((r) => `${nameOf(r.d)} (${esc(r.why)})`).join(", ")}</li>`);
    const gr = by("group"); if (gr.length) out.push(`<li class="bad">Amazon lists them as not available — not placed: ${gr.map((r) => `${nameOf(r.d)} (${esc(r.why)})`).join(", ")}</li>`);
    const al = by("already"); if (al.length) out.push(`<li class="muted">Already on a route in Amazon (skipped, that's fine): ${al.map((r) => nameOf(r.d) + (r.where && waveKey(r.where) !== l.w.key ? ` (on a ${esc(r.where)} route)` : "")).join(", ")}</li>`);
    const nb = by("nobox"); if (nb.length) out.push(`<li class="warn">No empty box to put them in: ${names(nb.map((r) => r.d))}</li>`);
    const fa = by("failed"); if (fa.length) out.push(`<li class="bad">Couldn't place: ${fa.map((r) => `${nameOf(r.d)} — ${esc(r.why)}`).join("; ")}</li>`);
    const lo = by("leftover"); if (lo.length) out.push(`<li class="warn">More drivers than empty boxes — left over: ${names(lo.map((r) => r.d))}</li>`);
    if (final) {
      const ns = by("match"); if (ns.length) out.push(`<li class="warn">Not filled (stopped): ${names(ns.map((r) => r.d))}</li>`);
      const still = l.w.rows.filter((tr) => !currentDA(tr)).length;
      if (still) out.push(`<li class="warn">${plural(still, "empty box", "empty boxes")} left empty</li>`);
      const flagged = l.w.rows.filter((tr) => alertText(tr));
      if (flagged.length) out.push(`<li class="bad">Amazon shows a warning on ${plural(flagged.length, "route")} in this wave — check them</li>`);
    } else {
      const stay = l.empty - l.toFill.length;
      if (stay > 0) out.push(`<li class="warn">${plural(stay, "empty box", "empty boxes")} will stay empty</li>`);
    }
    if (!l.s) out.push(`<li class="warn">Nobody on the schedule for this wave</li>`);
    if (l.w.dup) out.push(`<li class="warn">This wave time shows up in more than one cycle — filled in page order</li>`);
    const head = final
      ? `<b>${esc(l.w.label)}</b> — ${plural(l.routes, "route")} · ${plural(l.ds.length, "driver")} · ${l.placed || 0} filled`
      : `<b>${esc(l.w.label)}</b> — ${plural(l.routes, "route")} · ${plural(l.ds.length, "driver")} · ${plural(l.empty, "empty box", "empty boxes")}`;
    const who = !final && l.toFill.length
      ? `<details><summary>Who goes in (${l.toFill.length})</summary><ol>${l.toFill.map((r) => `<li>${nameOf(r.d)}</li>`).join("")}</ol></details>` : "";
    return `<div class="wave">${head}${out.length ? `<ul>${out.join("")}</ul>` : ""}${who}</div>`;
  }
  function extraHtml(p, final) {
    let h = "";
    for (const s of p.noWave) {
      h += `<div class="wave"><span class="bad">Amazon has no <b>${esc(s.label)}</b> wave (schedule ${esc(s.sched)}) — not placed: ${names(s.drivers.map((r) => r.d))}</span></div>`;
    }
    if (p.otherGroups.length) h += `<p class="muted">Amazon's list also has: ${p.otherGroups.map(esc).join(", ")} — those drivers are never picked.</p>`;
    const sk = payload.skipped || [];
    if (sk.length) h += `<p class="muted">Not rostered: ${sk.map((s) => `${esc(s.name)} (${esc(String(s.why || "").toLowerCase())})`).join(", ")}</p>`;
    return h;
  }

  async function preview(my) {
    clearBtns(); progress(null);
    say("Reading Amazon's routes and driver list…");
    const p = await buildPlan();
    if (my !== runId) return;
    if (p.err) { stopWith(esc(p.err)); btn("Start over", run, true); return; }
    plan = p;
    const n = (payload.drivers || []).length;
    let h = ask.warn + `<p><b>${esc(dayLabel(date))}</b> — ${plural(n, "driver")} on routes on the Live board.</p>`;
    if (!p.anyEmpty) h += '<p class="warn">Every route already has a DA — there is nothing to fill.</p>';
    h += p.lines.map((l) => waveHtml(l, false)).join("") + extraHtml(p, false);
    h += `<p><b>Nothing has been changed on Amazon's page yet.</b></p>`;
    say(h);
    if (p.total) btn(`Fill ${plural(p.total, "DA box", "DA boxes")}`, () => fill(my));
    btn("Start over", run, true);
  }

  // Step 4: fill, one box at a time
  async function placeOne(tr, exact) {
    const inp = tr.querySelector(DA_INPUT);
    if (!inp) return { ok: false, why: "that route has no DA box", rowBad: true };
    if (currentDA(tr)) return { ok: false, why: "that route already has " + currentDA(tr), rowBad: true };
    const target = one(exact);
    const opts = await openList(inp, "");
    if (!opts.length) { await closeAndWait(inp); return { ok: false, why: "Amazon's list for that route was empty", rowBad: true }; }
    const hits = opts.filter((o) => one(o.name) === target);
    if (!hits.length) { await closeAndWait(inp); return { ok: false, why: "not in Amazon's list for that route" }; }
    const pick = hits.find((o) => o.group === AVAILABLE);
    if (!pick) { await closeAndWait(inp); return { ok: false, why: "Amazon now lists them as: " + hits[0].group }; }
    pick.el.click();                                           // closes the list and sets the value
    await waitFor(() => currentDA(tr) === target, 1500);
    await sleep(150);                                          // give Amazon a moment to show a warning
    const al = alertText(tr);
    if (al) {
      const clear = tr.querySelector('button[aria-label="Clear DA assignment"]');
      if (clear) clear.click();
      const cleared = await waitFor(() => !currentDA(tr), 1500);
      return { ok: false, why: `Amazon said “${al}” — ${cleared ? "that box was cleared" : "couldn't clear that box, please check it"}` };
    }
    const got = currentDA(tr);
    if (got !== target) {
      if (inp.getAttribute("aria-expanded") === "true") await closeAndWait(inp);
      return { ok: false, why: got ? `the box shows ${got} instead — please check it` : "Amazon didn't take it" };
    }
    return { ok: true };
  }

  async function fill(my) {
    if (my !== runId || !plan) return;
    if (!isEditing() || (urlDate() || pickerDate()) !== date) {
      stopWith("The page changed (edit mode closed or another day). Nothing more was filled. Click the bookmark again.");
      return;
    }
    stopped = false;
    clearBtns();
    btn("Stop", () => { stopped = true; }, true);
    const total = plan.total;
    let done = 0, placed = 0;
    progress(0);
    const status = () => say(`<p>Filling ${Math.min(done + 1, total)} of ${total}…</p><p class="muted">Nothing is saved — you press Save changes at the end.</p>`);
    outer:
    for (const l of plan.lines) {
      l.placed = 0;
      const bad = new Set();                                   // row positions in this wave to skip
      for (const r of l.toFill) {
        if (stopped || my !== runId) break outer;
        if (!isEditing()) { stopped = true; plan.lost = true; break outer; }
        status();
        const w = readWaves().find((x) => x.key === l.w.key);  // fresh rows: the page may have re-drawn
        if (w) l.w = Object.assign(l.w, { rows: w.rows });
        const idx = w ? w.rows.findIndex((tr, i) => !bad.has(i) && !currentDA(tr)) : -1;
        if (idx < 0) { r.status = "leftover"; done++; progress(done / total); continue; }
        let res;
        try { res = await placeOne(w.rows[idx], r.exact); } catch (err) { res = { ok: false, why: "error: " + (err && err.message || err) }; }
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
    const fresh = readWaves();
    for (const l of plan.lines) { const w = fresh.find((x) => x.key === l.w.key); if (w) l.w.rows = w.rows; }
    let h = `<p><b>${stopped ? "Stopped. " : ""}Filled ${placed} of ${plural(total, "DA box", "DA boxes")}.</b></p>`;
    if (plan.lost) h += '<p class="bad">Edit mode closed during the fill.</p>';
    h += plan.lines.map((l) => waveHtml(l, true)).join("") + extraHtml(plan, true);
    h += '<p style="margin-top:8px"><b>Nothing is saved yet. Check the screen, then press Save changes yourself.</b></p>';
    say(h);
    btn("Start over", run, true);
    btn("Close", () => box.querySelector(".x").click(), true);
  }

  run().catch((err) => stopWith("Something went wrong: " + esc(err && err.message || err)));
})();
