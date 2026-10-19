import { html } from './preact-setup.js';
import { createContext } from 'preact';
import { useEffect, useState, useContext, useRef } from 'preact/hooks';
import { getState, setState, setWizard, useStore, startFresh, continueWizard, hydrateWizard } from './store.js';
import { checkAuth, login, logout, whoAmI, canLive } from './api.js';
import { loadDraft } from './draft.js';
import { readiness } from './readiness.js';
import { Banner, Spinner, Toast, Icon } from './ui.js';

import { StepFiles } from './steps/step-files.js';
import { Step3Tiers } from './steps/step3-tiers.js';
import { Step5Demand } from './steps/step5-demand.js';
import { Step6Backups } from './steps/step6-backups.js';
import { Step7Standing } from './steps/step7-standing.js';
import { Step9Build } from './steps/step9-build.js';
import { Settings } from './settings.js';
import { LiveBoard } from './live/live-board.js';
import { Requests, useConflictCount } from './live/requests.js';
import { Drivers } from './drivers.js';

// A step rendered INSIDE another step hides its own Back/Next bar.
export const Embedded = createContext(false);

// Routes + backups are one decision ("how many people each day"), so they
// share a screen.
function StepRoutes() {
  const demand = useStore((s) => s.wizard.demand);
  const anyRoutes = Object.values(demand || {}).some((rows) => (rows || []).some((r) => (parseInt(r.count, 10) || 0) > 0));
  return html`
    <${Embedded.Provider} value=${true}>
      <${Step5Demand} />
      <${Step6Backups} />
    <//>
    <div class="card navcard"><${StepNav} canNext=${anyRoutes} /></div>`;
}

// Five steps (Jose 2026-10-03: the old nine — with the two files uploaded in
// separate steps — were confusing). Schedule Builder's JAJB accent is teal.
export const STEPS = [
  { key: 'files', title: 'Week & files', icon: 'calendar', sub: 'Next week\'s availability and the current week\'s schedule', comp: StepFiles },
  { key: 'tiers', title: 'Drivers', icon: 'users', sub: 'Tiers from the driver board and each driver\'s day target', comp: Step3Tiers },
  { key: 'routes', title: 'Routes & backups', icon: 'truck', sub: 'How many routes per wave each day, plus backups', comp: StepRoutes },
  { key: 'standing', title: 'Trainers & settings', icon: 'cap', sub: 'Trainers, training pairs, dispatch, exclusions', comp: Step7Standing },
  { key: 'build', title: 'Build', icon: 'build', sub: 'Check, build, adjust, download', comp: Step9Build },
];

export function goStep(i) {
  setWizard({ step: Math.max(0, Math.min(STEPS.length - 1, i)) });
  window.scrollTo(0, 0);
}

// A shared footer nav each step renders (hidden when embedded).
export function StepNav({ canNext = true, onNext, nextLabel = 'Next', hideNext = false, hideBack = false }) {
  const step = useStore((s) => s.wizard.step);
  const embedded = useContext(Embedded);
  if (embedded) return null;
  return html`
    <div class="stepnav">
      <div>${!hideBack && step > 0
        ? html`<button onClick=${() => goStep(step - 1)}>← Back</button>` : ''}</div>
      <div>${!hideNext
        ? html`<button class="primary" disabled=${!canNext}
            onClick=${() => { if (onNext) onNext(); else goStep(step + 1); }}>${nextLabel} →</button>` : ''}</div>
    </div>`;
}

function Login() {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    const ok = await login(pw);
    setBusy(false);
    if (ok) setState({ auth: 'in', route: 'home', ...(takeHash() || {}) });
    else setErr('That password was not accepted.');
  };
  return html`
    <div class="login card">
      <img src="assets/logo.png" alt="" class="login-logo" />
      <h2>Schedule Builder</h2>
      <p class="hint">JAJB Logistics · WWV9. Sign in to build this week's driver schedule.</p>
      <form onSubmit=${submit}>
        <label class="fld"><span>Password</span>
          <input type="password" value=${pw} onInput=${(e) => setPw(e.target.value)}
            autofocus style="width:100%" /></label>
        ${err ? html`<${Banner} kind="err">${err}<//>` : ''}
        <button class="primary" style="width:100%" disabled=${busy || !pw}>
          ${busy ? html`<${Spinner}/> Signing in…` : 'Sign in'}</button>
      </form>
    </div>`;
}

const STATUS_CHIP = { done: ['open', 'Ready'], warn: ['lock', 'Check'], todo: ['todo', 'To do'] };

// #requests or #requests/YYYY-MM-DD (the HR notification's link, 2026-10-19): the Requests page, that day
// picked. -> {route, requestsDay} | null. takeHash() also clears the hash once it's used.
function hashRoute() {
  const m = String(location.hash || '').match(/^#requests(?:\/(\d{4}-\d{2}-\d{2}))?$/);
  return m ? { route: 'requests', requestsDay: m[1] || null } : null;
}
function takeHash() {
  const h = hashRoute();
  if (h) { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* old browser */ } }
  return h;
}

// The route as the screens use it (Jose 2026-10-19): with the Live board, "home" IS the Live
// schedule — the Today page is gone, the app opens on the Live schedule.
function useRoute() {
  const route = useStore((s) => s.route);
  return route === 'home' && canLive() ? 'live' : route;
}

function Home() {
  return html`<${BuildHome} />`;
}

// The Netlify site (no Live board): the build checklist as before.
function BuildHome() {
  const wizard = useStore((s) => s.wizard);
  const r = readiness(wizard);
  const started = !!(wizard.availability || wizard.priorWeek?.source || wizard.build?.status === 'done');

  const promo = canLive() ? html`<div class="card buildcard lv-promo">
      <div><h2>Live schedule</h2>
        <p class="hint">The published week, day by day: call-outs, extra shifts, who can still work, and every change logged.</p></div>
      <button class="primary" onClick=${() => setState({ route: 'live' })}>Open the Live board ${Icon('arrow', 16)}</button>
    </div>` : '';

  if (!started) {
    return html`${promo}<div class="card hero">
      <div class="hero-ico">${Icon('calendar', 24)}</div>
      <h2>Build next week's schedule</h2>
      <p class="hint">Five short steps. Have next week's <b>availability export</b> ready${canLive()
        ? html` — the current week comes from the Live board` : html`, plus <b>the current week's schedule</b> (the Week-NN-Schedule.xlsx this app made)`}. Progress saves automatically.</p>
      <button class="accent" onClick=${startFresh}>Start a new schedule ${Icon('arrow', 16)}</button>
    </div>`;
  }

  return html`
    ${promo}
    <div class="stats">
      <div class="stat"><div class="big">${r.numbers.drivers}</div><div class="muted">drivers</div></div>
      <div class="stat"><div class="big">${r.numbers.operatingDays}</div><div class="muted">operating days</div></div>
      <div class="stat"><div class="big">${r.numbers.routeTotal}</div><div class="muted">routes</div></div>
      <div class="stat"><div class="big">${r.doneCount}/${STEPS.length}</div><div class="muted">steps ready</div></div>
    </div>
    ${r.warnings.map((wn) => html`<${Banner} kind="warn">${wn}<//>`)}
    <div class="steps-grid">
      ${r.steps.map((s) => {
        const [cls, lab] = STATUS_CHIP[s.status];
        return html`<button class="steptile" onClick=${() => { continueWizard(); setWizard({ step: s.idx }); }}>
          <span class="tico">${Icon(STEPS[s.idx].icon, 20)}</span>
          <span class="tname">${s.idx + 1}. ${s.title}</span>
          <span class="tdesc">${s.detail}</span>
          <span class=${'chip ' + cls}>${lab}</span>
        </button>`;
      })}
    </div>
    <div class="row" style="margin-top:18px">
      <button class="ghost" onClick=${() => { if (confirm('Start over? This clears the current build from this browser.')) startFresh(); }}>
        Start over with a new week</button>
    </div>`;
}

// The pages both navs list: the sidebar, and the Live schedule's top nav (Jose 2026-10-11).
function useNavItems() {
  const route = useRoute();
  const step = useStore((s) => s.wizard.step);
  const wizard = useStore((s) => s.wizard);
  const r = readiness(wizard);
  const conflicts = useConflictCount();   // drivers who asked off but are still on the schedule
  return {
    // with the Live board: Live schedule · Requests · Driver preferences (Jose 2026-10-19: Today is gone)
    pages: canLive() ? [
      { on: route === 'live', icon: 'live', label: 'Live schedule', onClick: () => setState({ route: 'live' }) },
      { on: route === 'requests', icon: 'inbox', label: 'Requests', badge: conflicts, onClick: () => setState({ route: 'requests' }) },
      { on: route === 'drivers', icon: 'users', label: 'Driver preferences', onClick: () => setState({ route: 'drivers' }) },
    ] : [
      { on: route === 'home', icon: 'home', label: 'Overview', onClick: () => setState({ route: 'home' }) },
      { on: route === 'live', icon: 'live', label: 'Live schedule', onClick: () => setState({ route: 'live' }) },
      { on: route === 'drivers', icon: 'users', label: 'Driver preferences', onClick: () => setState({ route: 'drivers' }) },
    ],
    steps: STEPS.map((s, i) => ({ on: route === 'wizard' && step === i, icon: s.icon, label: `${i + 1}. ${s.title}`,
      onClick: () => { continueWizard(); goStep(i); }, done: r.steps[i]?.status === 'done' })),
    settings: { on: route === 'settings', icon: 'settings', label: 'Settings', onClick: () => setState({ route: 'settings' }) },
  };
}
const signOut = async () => { await logout(); setState({ auth: 'out' }); };
const doneMark = (it) => (it.done ? html`<span class="nvok">${Icon('check', 14)}</span>` : '');
// the red count on Requests (nothing at 0)
const badge = (it) => (it.badge ? html`<span class="nvbadge" aria-label=${`${it.badge} to check`}>${it.badge}</span>` : '');

function Sidebar() {
  const { pages, steps, settings } = useNavItems();
  const nav = (it) => html`
    <a class=${'nv' + (it.on ? ' on' : '')} onClick=${it.onClick}>${Icon(it.icon)}<span>${it.label}</span>${badge(it)}${doneMark(it)}</a>`;
  return html`<aside class="sidebar">
    <div class="sblogo"><img src="assets/logo.png" alt="" />
      <div><div class="sbname">Schedule Builder</div><div class="sbsub">JAJB Logistics · WWV9</div></div></div>
    <nav>
      ${pages.map((it) => nav(it))}
      <div class="sbgroup">Build a week</div>
      ${steps.map((it) => nav(it))}
      <div class="sbgroup">App</div>
      ${nav(settings)}
    </nav>
    <div class="sbfoot">
      ${whoAmI() ? html`<div class="sbwho">Signed in as ${whoAmI()}</div>` : ''}
      <a class="nv" onClick=${signOut}>${Icon('logout')}<span>Sign out</span></a>
    </div>
  </aside>`;
}

// The Live schedule takes the whole screen on a computer (Jose 2026-10-11): this slim bar stands
// in for the sidebar + top bar there. Hidden below 1000px (the phone layout stays as it was).
function TopNav() {
  const { pages, steps, settings } = useNavItems();
  const [open, setOpen] = useState(false);   // the "Build a week" list
  const dropRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (dropRef.current && !dropRef.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const item = (it) => html`
    <a class=${'tn' + (it.on ? ' on' : '')} onClick=${it.onClick}>${Icon(it.icon, 16)}<span>${it.label}</span>${badge(it)}</a>`;
  return html`<header class="topnav">
    <div class="tnlogo"><img src="assets/logo.png" alt="" /><span>Schedule Builder</span></div>
    <nav class="tnnav">
      ${pages.map((it) => item(it))}
      <div class="tndrop" ref=${dropRef}>
        <a class=${'tn' + (open ? ' open' : '')} aria-haspopup="menu" aria-expanded=${open ? 'true' : 'false'}
          onClick=${() => setOpen((o) => !o)}><span>Build a week ▾</span></a>
        ${open ? html`<div class="tnmenu" role="menu">${steps.map((it) => html`
          <a class=${'nv' + (it.on ? ' on' : '')} role="menuitem" onClick=${() => { setOpen(false); it.onClick(); }}>${Icon(it.icon)}<span>${it.label}</span>${doneMark(it)}</a>`)}
        </div>` : ''}
      </div>
      ${item(settings)}
    </nav>
    <div class="tnright">
      ${whoAmI() ? html`<span class="tnwho">Signed in as ${whoAmI()}</span>` : ''}
      <a class="tn" onClick=${signOut}>${Icon('logout', 16)}<span>Sign out</span></a>
    </div>
  </header>`;
}

function TopBar() {
  const route = useRoute();
  const step = useStore((s) => s.wizard.step);
  const week = useStore((s) => s.wizard.week);
  const begun = useStore((s) => !!(s.wizard.availability || s.wizard.priorWeek?.source));
  let title = 'Overview';
  let sub = 'Where this week\'s schedule stands';
  if (route === 'settings') { title = 'Settings'; sub = 'Saved for every week'; }
  else if (route === 'drivers') { title = 'Driver preferences'; sub = 'Days each driver can work, and their limits'; }
  else if (route === 'requests') { title = 'Requests'; sub = 'Days off drivers asked for, and VET / VTO offers'; }
  else if (route === 'live') { title = 'Live schedule'; sub = 'The published week, worked day by day — every change is logged'; }
  else if (route === 'wizard') { title = STEPS[step].title; sub = `Step ${step + 1} of ${STEPS.length} · ${STEPS[step].sub}`; }
  return html`<header class="topbar"><div class="tbrow">
    <div>
      <div class="tbtitle"><h1>${title}</h1>${week?.label && route !== 'live' && route !== 'drivers' && route !== 'requests' ? html`<span class="wkpill">${week.label}</span>` : ''}</div>
      <div class="tbsub">${sub}</div>
    </div>
    ${route === 'home' && !canLive() && (begun || step) ? html`<button class="rbtn" onClick=${() => { const rr = readiness(getState().wizard); continueWizard(); setWizard({ step: rr.firstTodoIdx }); }}>
      Continue ${Icon('arrow', 16)}</button>` : ''}
  </div></header>`;
}

// Below 1000px the sidebar hides; this pill row keeps every page reachable.
function MobileSteps() {
  const { pages } = useNavItems();
  const route = useRoute();
  const step = useStore((s) => s.wizard.step);
  return html`<div class="msteps">
    ${pages.map((it) => html`<button class=${'mstep' + (it.on ? ' on' : '')} onClick=${it.onClick}>${it.label}${badge(it)}</button>`)}
    ${STEPS.map((s, i) => html`
    <button class=${'mstep' + (route === 'wizard' && i === step ? ' on' : '')}
      onClick=${() => { continueWizard(); goStep(i); }}>${i + 1}. ${s.title}</button>`)}
    <button class=${'mstep' + (route === 'settings' ? ' on' : '')} onClick=${() => setState({ route: 'settings' })}>Settings</button>
    <button class="mstep" onClick=${signOut}>Sign out</button>
  </div>`;
}

export function App() {
  const auth = useStore((s) => s.auth);
  const route = useRoute();
  const step = useStore((s) => s.wizard.step);
  const toastVal = useStore((s) => s.toast);

  useEffect(() => {
    checkAuth().then(async (ok) => {
      if (ok === true) {
        const d = await loadDraft();
        if (d && d.wizard) hydrateWizard(d.wizard);
      }
      setState({ auth: ok === 'no-app' ? 'no-app' : ok ? 'in' : 'out', ...(ok === true ? takeHash() || {} : {}) });
    });
    // a #requests link opened while the app is already up
    const onHash = () => { if (getState().auth === 'in' && hashRoute()) setState(takeHash()); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (auth === 'unknown') {
    return html`<div class="center" style="margin-top:20vh"><${Spinner}/> Loading…</div>`;
  }
  if (auth === 'out') return html`<${Login}/><${Toast} toast=${toastVal}/>`;
  // Firebase: signed in, but this login doesn't include the Schedule Builder
  if (auth === 'no-app') {
    return html`<div class="login card">
      <img src="assets/logo.png" alt="" class="login-logo" />
      <h2>Schedule Builder</h2>
      <p class="hint">Your login doesn't include the Schedule Builder. Ask Jose if you need it.</p>
      <a href="/">⌂ All JAJB apps</a>
    </div>`;
  }

  let body;
  if (route === 'settings') body = html`<${Settings}/>`;
  else if (route === 'live') body = html`<${LiveBoard}/>`;
  else if (route === 'requests' && canLive()) body = html`<${Requests}/>`;
  else if (route === 'drivers') body = html`<${Drivers}/>`;
  else if (route === 'wizard') { const Comp = STEPS[Math.min(step, STEPS.length - 1)].comp; body = html`<${Comp}/>`; }
  else body = html`<${Home}/>`;

  // Live schedule (Jose 2026-10-11): on a computer the top nav replaces the sidebar + top bar
  // (the top bar stays in the page for the phone layout; CSS hides it from 1001px up)
  const wide = route === 'live';
  return html`
    <div class=${'layout' + (wide ? ' lv-wide' : '')}>
      ${wide ? '' : html`<${Sidebar}/>`}
      <div class="maincol">
        ${wide ? html`<${TopNav}/>` : ''}
        <${TopBar}/>
        <${MobileSteps}/>
        <main>${body}</main>
      </div>
      <${Toast} toast=${toastVal}/>
    </div>`;
}
