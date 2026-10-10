/* schedweek.js — the "📅 Week to Amazon" bookmark (Jose 2026-10-09; spec: docs/week-bookmarklet.md).
 *
 * Runs in Amazon's Scheduling week view (logistics.amazon.com/scheduling/calendar-view/week?date=…).
 * It opens the Schedule Builder in a small window (APP#schedweek=<Sunday>), which reads that week off
 * the Live board and hands every driver's shifts back (window.postMessage). Then it shows the plan,
 * and on "Fill" puts each shift into the driver's EMPTY day cell the way a person would: open the
 * cell's menu, click the shift ("Driver • 10:05 AM • 9h 50m", "Helper 10:25 AM", "Dispatcher • …",
 * "Meeting").
 *
 * On this page a picked shift is applied at once (unpublished) — there is no Save. The bookmark:
 *   - NEVER presses Publish, Auto-roster, Apply weekly pattern or anything else on Amazon's page;
 *   - never touches a cell that already has something (a shift, Unavailable, time off …);
 *   - only opens a cell's menu when the shift it needs is in Amazon's shift list (read from the
 *     page's Shifts panel first), and never closes a menu any other way than by picking that shift
 *     (2026-10-09: an Escape / outside click once left "Unavailable" in a cell) — if a menu is ever
 *     open when it shouldn't be, it stops and says so;
 *   - checks each cell after picking, and skips days already over.
 * Dispatch reviews the week and presses Publish themselves.
 *
 * Loaded fresh on every click (the bookmark adds ?<time>), so fixing this file fixes every computer.
 * Local testing: a copy of Amazon's page (tests/roster_mock/scheduling.html) sets
 * window.__jajbWeekTest = true, which skips only the "is this Amazon's Scheduling page" check.
 */
(() => {
  "use strict";
  const SELF = (document.currentScript && document.currentScript.src) || "";
  const APP = SELF.replace(/schedweek\.js(\?.*)?$/, "");
  const APP_ORIGIN = APP ? new URL(APP).origin : "";
  if (window.__jajbWeek) { window.__jajbWeek.show(); return; }

  /* ---------- small helpers ---------- */
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
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const todayISO = () => iso(new Date());
  const short = (isoD) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoD || ""); return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}` : isoD; };
  // "10:05 AM" / "4 PM" -> minutes after midnight, or null
  function mins(s) {
    const m = /(\d{1,2})(?::(\d{2}))?\s*([AP])\.?M\b/i.exec(String(s || ""));
    if (!m) return null;
    return ((+m[1] % 12) + (m[3].toUpperCase() === "P" ? 12 : 0)) * 60 + (+(m[2] || 0));
  }
  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  // same first + last word, and every word of `want` appears in `have`: "Barry Hughes" ~ "Barry Len Hughes"
  function sameDriver(want, have) {
    const w = norm(want).split(" "), h = norm(have).split(" ");
    if (!w[0] || w[0] !== h[0] || w[w.length - 1] !== h[h.length - 1]) return false;
    return w.every((t) => h.includes(t));
  }
  const visible = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };

  /* ---------- the panel ---------- */
  const box = document.createElement("div");
  box.id = "jajb-week";
  box.innerHTML = `
    <style>
      #jajb-week{position:fixed;top:14px;right:14px;z-index:2147483647;width:380px;max-height:calc(100vh - 28px);
        overflow:auto;box-sizing:border-box;background:#fff;color:#1d2433;border:2px solid #243762;border-radius:12px;
        box-shadow:0 10px 30px rgba(0,0,0,.28);font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
        padding:12px 14px;text-align:left}
      #jajb-week *{box-sizing:border-box}
      #jajb-week b{font-weight:700}
      #jajb-week h3{margin:0 22px 6px 0;font-size:14px;color:#243762}
      #jajb-week .bar{height:8px;background:#e6e9f0;border-radius:6px;overflow:hidden;margin:8px 0}
      #jajb-week .bar i{display:block;height:100%;width:0;background:#df7332;transition:width .2s}
      #jajb-week button{font:inherit;font-weight:600;border-radius:8px;padding:7px 12px;cursor:pointer;margin:6px 6px 0 0;
        border:1px solid #243762;background:#243762;color:#fff}
      #jajb-week button.ghost{background:#fff;color:#243762}
      #jajb-week .msg p{margin:0 0 6px}
      #jajb-week ul{margin:2px 0 6px;padding-left:18px;list-style:disc}
      #jajb-week li{margin:1px 0}
      #jajb-week .bad{color:#a12a1f}
      #jajb-week .warn{color:#8a5a00}
      #jajb-week .muted{color:#6b7280}
      #jajb-week details{margin:2px 0 6px}
      #jajb-week summary{cursor:pointer;color:#243762}
      #jajb-week .x{position:absolute;top:6px;right:10px;cursor:pointer;color:#888;font-size:18px;line-height:1}
    </style>
    <span class="x" title="Close">×</span>
    <h3>📅 Week from the Schedule Builder</h3>
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
    box.remove(); delete window.__jajbWeek;
  };
  window.__jajbWeek = { show: () => { box.style.display = ""; if (!box.isConnected) document.body.appendChild(box); } };
  const say = (html, cls) => { $msg.innerHTML = html; $msg.className = "msg" + (cls ? " " + cls : ""); };
  function btn(label, fn, ghost) {
    const b = document.createElement("button");
    b.textContent = label; if (ghost) b.className = "ghost";
    b.onclick = fn; $btns.appendChild(b); return b;
  }
  const clearBtns = () => { $btns.innerHTML = ""; };
  const progress = (frac) => { if (frac == null) { $bar.style.display = "none"; return; } $bar.style.display = ""; $fill.style.width = (100 * frac) + "%"; };
  function stopWith(html) { progress(null); clearBtns(); say(html, "bad"); }

  /* ---------- reading Amazon's page (docs/week-bookmarklet.md) ---------- */
  // "Week 42: Oct 11 - Oct 17, 2026" -> the Sunday, as YYYY-MM-DD
  function pageSunday() {
    const t = one(document.body.innerText.slice(0, 4000));
    const m = /Week\s*\d+\s*:\s*([A-Z][a-z]{2})\s+(\d{1,2})\s*-\s*([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})/.exec(t);
    if (!m) return null;
    const endY = +m[5], sm = MONTHS.indexOf(m[1]), em = MONTHS.indexOf(m[3]);
    if (sm < 0 || em < 0) return null;
    const d = new Date(sm > em ? endY - 1 : endY, sm, +m[2]);
    return d.getDay() === 0 ? iso(d) : null;
  }
  function urlSunday() {
    const q = new URLSearchParams(location.search).get("date");
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(q || "");
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    d.setDate(d.getDate() - d.getDay());
    return iso(d);
  }
  // the 7 day headers in page order ("Sun, Oct 11") — must read Sun..Sat
  function headerDays() {
    const seen = [];
    for (const e of document.querySelectorAll("p, span, div, h2, h3, h4")) {
      if (e.children.length) continue;
      const m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat),\s*[A-Z][a-z]{2}\s+\d{1,2}$/.exec(one(e.textContent));
      if (m && !seen.includes(m[1])) seen.push(m[1]);
    }
    return seen;
  }
  // [{name, row, cells: [7 day cells]}] — one row per associate ("Name <email>" in the title)
  function readRows() {
    const out = [];
    for (const p of document.querySelectorAll("p[title]")) {
      const m = /^(.+?)\s*<[^<>]*@[^<>]*>\s*$/.exec(p.getAttribute("title") || "");
      if (!m || p.closest("#jajb-week")) continue;
      let r = p;
      for (let i = 0; i < 14 && r; i++) {
        r = r.parentElement;
        const inner = r && r.children.length === 2 && r.children[1].children[0];
        if (inner && inner.children.length === 7) { out.push({ name: one(m[1]), row: r, cells: [...inner.children] }); break; }
      }
    }
    return out;
  }
  const cellText = (c) => one(c && c.innerText);
  // Amazon's shift list, from the Shifts panel (no menu opened): [{title, kind, mins}]
  function shiftTypes() {
    const out = [], seen = new Set();
    for (const p of document.querySelectorAll("p[title]")) {
      if (p.closest('[role="dialog"]') || p.closest("#jajb-week")) continue;
      const t = one(p.getAttribute("title"));
      const k = kindOf(t);
      if (!k || seen.has(t)) continue;
      seen.add(t); out.push({ title: t, kind: k, mins: mins(t) });
    }
    return out;
  }
  function kindOf(title) {
    const lead = norm(String(title).split("•")[0]).replace(/\d.*$/, "").trim();
    if (lead === "driver") return "driver";
    if (lead === "helper") return "helper";
    if (lead === "dispatcher") return "dispatcher";
    if (lead === "meeting") return "meeting";
    return null;
  }
  // the Amazon shift a schedule shift becomes, or null
  function typeFor(sh, types) {
    const want = sh.time ? mins(sh.time) : null;
    const same = types.filter((t) => t.kind === sh.kind);
    if (sh.kind === "driver" || sh.kind === "helper") return same.find((t) => t.mins === want) || null;
    return same[0] || null;
  }
  const shiftLabel = (sh) => sh.kind === "driver" ? `${sh.what === "Route" ? "Driver" : sh.what} ${sh.time}`
    : sh.kind === "helper" ? `Trainer (Helper) ${sh.time}` : sh.kind === "dispatcher" ? "Dispatcher" : "Meeting";
  // does a filled cell already show this shift?
  function shows(text, sh, type) {
    if (sh.kind === "meeting") return /meeting/i.test(text);
    const m = mins(text);
    return m != null && type && m === type.mins;
  }
  // the shift menu that's open now (the one with "Apply single shift"), or null
  const openMenu = () => [...document.querySelectorAll('[role="dialog"]')]
    .find((d) => visible(d) && /Apply single shift/.test(d.textContent || "")) || null;

  /* ---------- the run ---------- */
  let sunday = null, payload = null, plan = null;

  function checks() {
    const onAmazon = /(^|\.)logistics\.amazon\.com$/.test(location.hostname) && /^\/scheduling\/calendar-view\/week/.test(location.pathname);
    if (!onAmazon && window.__jajbWeekTest !== true) {
      stopWith("Open Amazon <b>Scheduling</b> in the <b>Week</b> view (Scheduling → Week), go to the week, then click the bookmark again.");
      return false;
    }
    if (!APP) { stopWith("This bookmark is broken — drag a fresh one from the Live board."); return false; }
    const ps = pageSunday(), us = urlSunday();
    sunday = ps || us;
    if (!sunday) { stopWith("Couldn't tell which week this page shows. Pick the week again, then click the bookmark again."); return false; }
    if (ps && us && ps !== us) {
      stopWith(`The page shows the week of ${esc(short(ps))} but the address bar says ${esc(short(us))}. Reload the page, then click the bookmark again.`);
      return false;
    }
    const hd = headerDays();
    if (hd.join() !== DAYS.join()) { stopWith("Couldn't read the 7 day columns (Sun to Sat). Make sure the page is in the Week view."); return false; }
    if (openMenu()) { stopWith("A shift menu is open on the page. Close it first (click its cell again), then click the bookmark again."); return false; }
    return true;
  }

  async function run() {
    const my = ++runId;
    stopped = false; payload = null; plan = null;
    progress(null); clearBtns();
    if (!checks()) return;
    ask(my, true);
  }

  // get the week from the Live board (small window, postMessage)
  function ask(my, auto) {
    clearTimeout(ask.timer);
    ask.my = my;
    const label = `the week of ${esc(short(sunday))}`;
    const open = () => {
      try { if (ask.win && !ask.win.closed) ask.win.close(); } catch (e) { /* gone */ }
      ask.win = window.open(APP + "?r=" + Date.now() + "#schedweek=" + sunday, "jajbWeek", "width=440,height=560");
      return ask.win;
    };
    const waiting = () => {
      clearBtns();
      say(`<p>Getting ${label} from the Live board… (sign in there if it asks)</p>`);
      ask.timer = setTimeout(() => {
        if (my !== runId || payload) return;
        clearBtns();
        say(`<p class="bad">Didn't hear back from the Live board. If its window is open and signed in, try again.</p>`);
        btn("Try again", () => { if (open()) waiting(); else blocked(); });
      }, 90000);
    };
    const blocked = () => {
      clearBtns();
      say("<p>Click the button to get the week from the Live board.</p>");
      btn("Get the week from the Live board", () => { if (open()) waiting(); else blocked(); });
    };
    if (auto) { if (open()) waiting(); else blocked(); }
  }

  function onMessage(e) {
    if (!APP_ORIGIN || e.origin !== APP_ORIGIN || !e.data || typeof e.data !== "object") return;
    const my = ask.my;
    if (my !== runId || payload || !sunday) return;
    if (e.data.type === "jajb-week-ready") {
      try { e.source.postMessage({ type: "jajb-week-request", week: sunday }, APP_ORIGIN); } catch (err) { /* closed */ }
      return;
    }
    if (e.data.type !== "jajb-week") return;
    payload = e.data;
    clearTimeout(ask.timer);
    const retry = () => { payload = null; ask(my, true); };
    if (payload.error) { stopWith(esc(payload.error)); btn("Try again", retry); return; }
    if (payload.week !== sunday) {
      stopWith(`The Live board sent the week of ${esc(short(payload.week))}, but this Amazon page is the week of ${esc(short(sunday))}. Nothing was filled.`);
      btn("Try again", retry);
      return;
    }
    try { preview(my); } catch (err) { stopWith("Something went wrong: " + esc(err && err.message || err)); }
  }
  window.addEventListener("message", onMessage);

  // the plan: every (driver, day) the Live board has, against Amazon's page
  function buildPlan() {
    const rows = readRows();
    if (!rows.length) return { err: "Couldn't find any driver rows on this page. Make sure the week's drivers show (clear the search box), then click the bookmark again." };
    const types = shiftTypes();
    if (!types.length) return { err: "Couldn't read Amazon's shift list (the Shifts panel). Nothing was changed." };
    const days = payload.days || [];
    const today = todayISO();
    const used = new Map();
    const items = [], people = [];
    for (const d of payload.drivers || []) {
      let hits = rows.filter((r) => norm(r.name) === norm(d.name));
      if (!hits.length) hits = rows.filter((r) => sameDriver(d.name, r.name));
      const p = { d, row: null, status: "ok", why: "" };
      people.push(p);
      if (!hits.length) { p.status = "notfound"; continue; }
      if (hits.length > 1) { p.status = "ambiguous"; p.why = hits.map((h) => h.name).join(" / "); continue; }
      if (used.has(hits[0].name)) { p.status = "ambiguous"; p.why = `same Amazon row as ${used.get(hits[0].name)}`; continue; }
      used.set(hits[0].name, d.name);
      p.row = hits[0];
      for (let i = 0; i < 7; i++) {
        const day = days[i];
        const sh = day && d.shifts[day.day];
        if (!sh) continue;
        const it = { p, i, day: day.day, date: day.date, sh, type: typeFor(sh, types), status: "todo", why: "" };
        const text = cellText(p.row.cells[i]);
        if (day.date < today) { it.status = "past"; }
        else if (!it.type) { it.status = "notype"; }
        else if (text) { it.status = shows(text, sh, it.type) ? "already" : "busy"; it.why = text; }
        items.push(it);
      }
    }
    return { items, people, types };
  }

  function listHtml(its, fmt) {
    return `<ul>${its.slice(0, 60).map((it) => `<li>${fmt(it)}</li>`).join("")}${its.length > 60 ? `<li class="muted">…and ${its.length - 60} more</li>` : ""}</ul>`;
  }
  const who = (it) => `${esc(it.p.d.name)} — ${it.day} ${esc(short(it.date))}`;
  function reportHtml(final) {
    const by = (st) => plan.items.filter((it) => it.status === st);
    const pp = (st) => plan.people.filter((p) => p.status === st);
    let h = "";
    const nf = pp("notfound"); if (nf.length) h += `<p class="bad">Not on Amazon's page (no row): ${nf.map((p) => esc(p.d.name)).join(", ")}</p>`;
    const am = pp("ambiguous"); if (am.length) h += `<p class="bad">More than one match — not filled: ${am.map((p) => `${esc(p.d.name)} (${esc(p.why)})`).join(", ")}</p>`;
    const nt = by("notype"); if (nt.length) h += `<details open><summary class="bad">Amazon has no matching shift (${nt.length})</summary>${listHtml(nt, (it) => `${who(it)}: ${esc(shiftLabel(it.sh))}`)}</details>`;
    const bz = by("busy"); if (bz.length) h += `<details><summary class="warn">Cell already has something else — left alone (${bz.length})</summary>${listHtml(bz, (it) => `${who(it)}: Amazon has “${esc(it.why)}”, schedule says ${esc(shiftLabel(it.sh))}`)}</details>`;
    const al = by("already"); if (al.length) h += `<p class="muted">Already in Amazon (fine): ${plural(al.length, "shift")}</p>`;
    const pa = by("past"); if (pa.length) h += `<p class="muted">Days already over, skipped: ${plural(pa.length, "shift")}</p>`;
    if (final) {
      const fa = by("failed"); if (fa.length) h += `<details open><summary class="bad">Couldn't fill (${fa.length})</summary>${listHtml(fa, (it) => `${who(it)}: ${esc(it.why)}`)}</details>`;
      const ns = by("todo"); if (ns.length) h += `<p class="warn">Not filled (stopped): ${plural(ns.length, "shift")}</p>`;
    }
    return h;
  }

  function preview(my) {
    clearBtns(); progress(null);
    say("Reading Amazon's page…");
    const p = buildPlan();
    if (my !== runId) return;
    if (p.err) { stopWith(esc(p.err)); btn("Start over", run, true); return; }
    plan = p;
    const todo = p.items.filter((it) => it.status === "todo");
    const firstWho = todo.length ? todo[0].p : null;
    const firstN = firstWho ? todo.filter((it) => it.p === firstWho).length : 0;
    const byDay = DAYS.map((dn) => [dn, todo.filter((it) => it.day === dn).length]).filter(([, n]) => n);
    let h = `<p><b>${esc(payload.label || "Week of " + short(sunday))}</b> — ${plural(todo.length, "shift")} to fill for ${plural(new Set(todo.map((it) => it.p)).size, "driver")}.</p>`;
    if (byDay.length) h += `<p class="muted">${byDay.map(([dn, n]) => `${dn} ${n}`).join(" · ")}</p>`;
    h += reportHtml(false);
    h += "<p><b>Nothing has been changed on Amazon's page yet.</b> Each shift you fill goes into Amazon right away (unpublished). You press <b>Publish</b> yourself at the end.</p>";
    say(h);
    if (firstWho) btn(`Test: ${firstWho.d.name.split(" ")[0]} only (${firstN})`, () => fill(my, firstWho), true);
    if (todo.length) btn(`Fill ${plural(todo.length, "shift")}`, () => fill(my, null));
    btn("Start over", run, true);
  }

  // open one empty cell's menu: hover it (the "+" shows), click the "+", or the cell itself
  async function openCell(cell) {
    let t = cell;
    while (t.firstElementChild) t = t.firstElementChild;
    for (const type of ["pointerover", "mouseover", "pointerenter", "mouseenter", "mousemove"]) {
      t.dispatchEvent(new MouseEvent(type, { bubbles: type.endsWith("over") || type === "mousemove", relatedTarget: document.body }));
    }
    await sleep(120);
    const plus = cell.querySelector('button, [role="button"]');
    (plus || t).click();
    return waitFor(openMenu, 2500);
  }

  async function placeOne(it) {
    const cell = readRows().find((r) => r.name === it.p.row.name);
    const c = cell && cell.cells[it.i];
    if (!c) return { ok: false, why: "their row is gone from the page" };
    const now = cellText(c);
    if (now) return shows(now, it.sh, it.type) ? { ok: true, already: true } : { ok: false, why: `the cell now has “${now}”` };
    if (openMenu()) return { ok: false, why: "a shift menu was already open", halt: true };
    const menu = await openCell(c);
    if (!menu) return { ok: false, why: "the cell's menu didn't open (nothing was changed)" };
    const pick = [...menu.querySelectorAll("button")].find((b) => one((b.querySelector("p[title]") || {}).title || "") === it.type.title);
    if (!pick) return { ok: false, why: `the menu has no “${it.type.title}” — the menu is still OPEN on this cell`, halt: true };
    pick.click();
    const got = await waitFor(() => cellText(c) || null, 3000);
    await waitFor(() => !openMenu(), 2000);
    if (!got) return { ok: false, why: "Amazon didn't show the shift in the cell — please check it" };
    if (!shows(got, it.sh, it.type)) return { ok: false, why: `the cell shows “${got}” — please check it` };
    if (openMenu()) return { ok: true, halt: true, why: "a shift menu stayed open after picking" };
    return { ok: true };
  }

  async function fill(my, only) {
    if (my !== runId || !plan) return;
    if (pageSunday() && pageSunday() !== sunday) { stopWith("The page moved to another week. Nothing more was filled. Click the bookmark again."); return; }
    stopped = false;
    clearBtns();
    btn("Stop", () => { stopped = true; }, true);
    const todo = plan.items.filter((it) => it.status === "todo" && (!only || it.p === only));
    let done = 0, placed = 0, halt = "";
    progress(0);
    for (const it of todo) {
      if (stopped || my !== runId) break;
      say(`<p>Filling ${done + 1} of ${todo.length}: ${who(it)} — ${esc(shiftLabel(it.sh))}</p><p class="muted">Applied in Amazon as it goes (unpublished). It never presses Publish.</p>`);
      let res;
      try { res = await placeOne(it); } catch (err) { res = { ok: false, why: "error: " + (err && err.message || err), halt: true }; }
      if (res.ok) { it.status = res.already ? "already" : "placed"; if (!res.already) placed++; }
      else { it.status = "failed"; it.why = res.why; }
      done++;
      progress(done / todo.length);
      if (res.halt) { halt = `${who(it)}: ${res.why}`; break; }
      await sleep(200);
    }
    if (my !== runId) return;
    progress(null); clearBtns();
    let h = `<p><b>${halt ? "Stopped — " : stopped ? "Stopped. " : ""}Filled ${placed} of ${plural(todo.length, "shift")}${only ? ` (test: ${esc(only.d.name)})` : ""}.</b></p>`;
    if (halt) h += `<p class="bad"><b>${esc(halt)}</b>. Look at that cell before going on.</p>`;
    h += reportHtml(true);
    h += "<p style=\"margin-top:8px\"><b>Check the week, then press Publish yourself.</b></p>";
    say(h);
    btn("Start over", run, true);
    btn("Close", () => box.querySelector(".x").click(), true);
  }

  run().catch((err) => stopWith("Something went wrong: " + esc(err && err.message || err)));
})();
