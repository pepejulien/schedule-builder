import { html } from './preact-setup.js';
import { createContext } from 'preact';
import { useEffect, useState, useContext } from 'preact/hooks';
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
import { Today } from './live/today.js';

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
  { key: 'files', title: 'Week & files', icon: 'calendar', sub: 'Drop this week\'s availability and last week\'s schedule', comp: StepFiles },
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
    if (ok) setState({ auth: 'in', route: 'home' });
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

// Next week's build in one card — the Today page's footer (Jose 2026-10-06:
// the old Overview was only this checklist).
function BuildCard() {
  const wizard = useStore((s) => s.wizard);
  const r = readiness(wizard);
  const started = !!(wizard.availability || wizard.week?.num || wizard.build?.status === 'done');
  const cont = () => { const rr = readiness(getState().wizard); continueWizard(); setWizard({ step: rr.firstTodoIdx }); };
  const nWarn = r.warnings.length;
  return html`<div class="card buildcard">
    <div>
      <h2>Next week's build</h2>
      <p class="hint">${started
        ? html`<b>${wizard.week?.label || 'In progress'}</b> · ${r.doneCount} of ${STEPS.length} steps ready${nWarn ? ` · ${nWarn} thing${nWarn === 1 ? '' : 's'} to check` : ''}${wizard.build?.published ? ' · published' : ''}`
        : "Not started yet. Have this week's availability export ready — last week comes from the Live board."}</p>
    </div>
    <div class="row">${started
      ? html`<button class="primary" onClick=${cont}>Continue ${Icon('arrow', 16)}</button>
          <button class="ghost" onClick=${() => { if (confirm('Start over? This clears the current build from this browser.')) startFresh(); }}>Start over</button>`
      : html`<button class="accent" onClick=${startFresh}>Start a new schedule ${Icon('arrow', 16)}</button>`}</div>
  </div>`;
}

function Home() {
  if (canLive()) return html`<${Today} buildCard=${html`<${BuildCard} />`} />`;
  return html`<${BuildHome} />`;
}

// The Netlify site (no Live board): the build checklist as before.
function BuildHome() {
  const wizard = useStore((s) => s.wizard);
  const r = readiness(wizard);
  const started = !!(wizard.availability || wizard.week?.num || wizard.build?.status === 'done');

  const promo = canLive() ? html`<div class="card buildcard lv-promo">
      <div><h2>Live schedule</h2>
        <p class="hint">The published week, day by day: call-outs, extra shifts, who can still work, and every change logged.</p></div>
      <button class="primary" onClick=${() => setState({ route: 'live' })}>Open the Live board ${Icon('arrow', 16)}</button>
    </div>` : '';

  if (!started) {
    return html`${promo}<div class="card hero">
      <div class="hero-ico">${Icon('calendar', 24)}</div>
      <h2>Build next week's schedule</h2>
      <p class="hint">Five short steps. Have this week's <b>availability export</b> ready${canLive()
        ? html` — last week comes from the Live board` : html`, plus <b>last week's schedule</b> (the Week-NN-Schedule.xlsx this app made)`}. Progress saves automatically.</p>
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

function Sidebar() {
  const route = useStore((s) => s.route);
  const step = useStore((s) => s.wizard.step);
  const wizard = useStore((s) => s.wizard);
  const r = readiness(wizard);
  const nav = (on, icon, label, onClick, extra) => html`
    <a class=${'nv' + (on ? ' on' : '')} onClick=${onClick}>${Icon(icon)}<span>${label}</span>${extra || ''}</a>`;
  return html`<aside class="sidebar">
    <div class="sblogo"><img src="assets/logo.png" alt="" />
      <div><div class="sbname">Schedule Builder</div><div class="sbsub">JAJB Logistics · WWV9</div></div></div>
    <nav>
      ${nav(route === 'home', 'home', canLive() ? 'Today' : 'Overview', () => setState({ route: 'home' }))}
      ${nav(route === 'live', 'live', 'Live schedule', () => setState({ route: 'live' }))}
      <div class="sbgroup">Build a week</div>
      ${STEPS.map((s, i) => {
        const st = r.steps[i]?.status;
        return nav(route === 'wizard' && step === i, s.icon, `${i + 1}. ${s.title}`,
          () => { continueWizard(); goStep(i); },
          st === 'done' ? html`<span class="nvok">${Icon('check', 14)}</span>` : '');
      })}
      <div class="sbgroup">App</div>
      ${nav(route === 'settings', 'settings', 'Settings', () => setState({ route: 'settings' }))}
    </nav>
    <div class="sbfoot">
      ${whoAmI() ? html`<div class="sbwho">Signed in as ${whoAmI()}</div>` : ''}
      <a class="nv" onClick=${async () => { await logout(); setState({ auth: 'out' }); }}>${Icon('logout')}<span>Sign out</span></a>
    </div>
  </aside>`;
}

function TopBar() {
  const route = useStore((s) => s.route);
  const step = useStore((s) => s.wizard.step);
  const week = useStore((s) => s.wizard.week);
  let title = canLive() ? 'Today' : 'Overview';
  let sub = canLive() ? 'This week at a glance' : 'Where this week\'s schedule stands';
  if (route === 'settings') { title = 'Settings'; sub = 'Saved for every week'; }
  else if (route === 'live') { title = 'Live schedule'; sub = 'The published week, worked day by day — every change is logged'; }
  else if (route === 'wizard') { title = STEPS[step].title; sub = `Step ${step + 1} of ${STEPS.length} · ${STEPS[step].sub}`; }
  return html`<header class="topbar"><div class="tbrow">
    <div>
      <div class="tbtitle"><h1>${title}</h1>${week?.label && route !== 'live' && !(route === 'home' && canLive()) ? html`<span class="wkpill">${week.label}</span>` : ''}</div>
      <div class="tbsub">${sub}</div>
    </div>
    ${route === 'home' && !canLive() && (week?.num || step) ? html`<button class="rbtn" onClick=${() => { const rr = readiness(getState().wizard); continueWizard(); setWizard({ step: rr.firstTodoIdx }); }}>
      Continue ${Icon('arrow', 16)}</button>` : ''}
  </div></header>`;
}

// Below 1000px the sidebar hides; this pill row keeps every page reachable.
function MobileSteps() {
  const route = useStore((s) => s.route);
  const step = useStore((s) => s.wizard.step);
  return html`<div class="msteps">
    <button class=${'mstep' + (route === 'home' ? ' on' : '')} onClick=${() => setState({ route: 'home' })}>${canLive() ? 'Today' : 'Overview'}</button>
    <button class=${'mstep' + (route === 'live' ? ' on' : '')} onClick=${() => setState({ route: 'live' })}>Live schedule</button>
    ${STEPS.map((s, i) => html`
    <button class=${'mstep' + (route === 'wizard' && i === step ? ' on' : '')}
      onClick=${() => { continueWizard(); goStep(i); }}>${i + 1}. ${s.title}</button>`)}
    <button class=${'mstep' + (route === 'settings' ? ' on' : '')} onClick=${() => setState({ route: 'settings' })}>Settings</button>
    <button class="mstep" onClick=${async () => { await logout(); setState({ auth: 'out' }); }}>Sign out</button>
  </div>`;
}

export function App() {
  const auth = useStore((s) => s.auth);
  const route = useStore((s) => s.route);
  const step = useStore((s) => s.wizard.step);
  const toastVal = useStore((s) => s.toast);

  useEffect(() => {
    checkAuth().then(async (ok) => {
      if (ok === true) {
        const d = await loadDraft();
        if (d && d.wizard) hydrateWizard(d.wizard);
      }
      setState({ auth: ok === 'no-app' ? 'no-app' : ok ? 'in' : 'out' });
    });
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
  else if (route === 'wizard') { const Comp = STEPS[Math.min(step, STEPS.length - 1)].comp; body = html`<${Comp}/>`; }
  else body = html`<${Home}/>`;

  return html`
    <div class="layout">
      <${Sidebar}/>
      <div class="maincol">
        <${TopBar}/>
        <${MobileSteps}/>
        <main>${body}</main>
      </div>
      <${Toast} toast=${toastVal}/>
    </div>`;
}
