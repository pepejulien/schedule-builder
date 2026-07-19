import { html } from './preact-setup.js';
import { useEffect, useState } from 'preact/hooks';
import { setState, setWizard, useStore, startFresh, continueWizard, hydrateWizard } from './store.js';
import { checkAuth, login, logout } from './api.js';
import { loadDraft } from './draft.js';
import { readiness } from './readiness.js';
import { Banner, Spinner, Toast } from './ui.js';

import { Step1Week } from './steps/step1-week.js';
import { Step2Availability } from './steps/step2-availability.js';
import { Step3Tiers } from './steps/step3-tiers.js';
import { Step4PriorWeek } from './steps/step4-priorweek.js';
import { Step5Demand } from './steps/step5-demand.js';
import { Step6Backups } from './steps/step6-backups.js';
import { Step7Standing } from './steps/step7-standing.js';
import { Step8Review } from './steps/step8-review.js';
import { Step9Build } from './steps/step9-build.js';
import { Settings } from './settings.js';

export const STEPS = [
  { key: 'week', title: 'Week', comp: Step1Week },
  { key: 'avail', title: 'Availability', comp: Step2Availability },
  { key: 'tiers', title: 'Tiers & names', comp: Step3Tiers },
  { key: 'prev', title: 'Prior week', comp: Step4PriorWeek },
  { key: 'demand', title: 'Route demand', comp: Step5Demand },
  { key: 'backups', title: 'Backups', comp: Step6Backups },
  { key: 'standing', title: 'Standing config', comp: Step7Standing },
  { key: 'review', title: 'Review', comp: Step8Review },
  { key: 'build', title: 'Build', comp: Step9Build },
];

export function goStep(i) {
  setWizard({ step: Math.max(0, Math.min(STEPS.length - 1, i)) });
  window.scrollTo(0, 0);
}

// A shared footer nav each step renders.
export function StepNav({ canNext = true, onNext, nextLabel = 'Next', hideNext = false, hideBack = false }) {
  const step = useStore((s) => s.wizard.step);
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
      <h2>JAJB Schedule Builder</h2>
      <p class="hint">Sign in to build this week's driver schedule.</p>
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

const STATUS_ICON = { done: '✅', warn: '⚠️', todo: '○' };

function Home() {
  const wizard = useStore((s) => s.wizard);
  const r = readiness(wizard);
  const started = !!(wizard.availability || wizard.week?.num || wizard.build?.status === 'done');

  return html`
    <div class="wrap">
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div>
            <h2>${started ? wizard.week?.label || 'This week\'s build' : 'Build a weekly schedule'}</h2>
            <p class="hint">${started
              ? `${r.doneCount} of 9 steps ready.`
              : 'Walk through the steps, then download the finished workbook. Your progress is saved automatically.'}</p>
          </div>
          <div class="row">
            ${started
              ? html`<button class="accent" onClick=${() => { continueWizard(); setWizard({ step: r.firstTodoIdx }); }}>Continue →</button>
                     <button class="ghost" onClick=${startFresh}>Start over</button>`
              : html`<button class="accent" onClick=${startFresh}>Start a new schedule</button>`}
          </div>
        </div>

        ${started ? html`
          <div class="row" style="gap:18px; margin:12px 0">
            <div><div class="big">${r.numbers.drivers}</div><div class="muted">drivers</div></div>
            <div><div class="big">${r.numbers.operatingDays}</div><div class="muted">days</div></div>
            <div><div class="big">${r.numbers.routeTotal}</div><div class="muted">routes</div></div>
            ${r.numbers.tiersAsOf ? html`<div><div class="big" style="font-size:15px">${r.numbers.tiersAsOf}</div><div class="muted">board as of</div></div>` : ''}
          </div>

          ${r.warnings.map((wn) => html`<${Banner} kind="warn">${wn}<//>`)}

          <div class="scroll-x"><table>
            <thead><tr><th></th><th>Step</th><th>Status</th><th></th></tr></thead>
            <tbody>${r.steps.map((s) => html`
              <tr>
                <td>${STATUS_ICON[s.status]}</td>
                <td>${s.title}</td>
                <td class="muted">${s.detail}</td>
                <td class="right"><button class="ghost small"
                  onClick=${() => { continueWizard(); setWizard({ step: s.idx }); }}>open</button></td>
              </tr>`)}</tbody>
          </table></div>
        ` : ''}
      </div>
    </div>`;
}

function Rail() {
  const step = useStore((s) => s.wizard.step);
  return html`
    <div class="rail">
      ${STEPS.map((s, i) => html`
        <div class=${'step ' + (i === step ? 'active' : i < step ? 'done' : '')}
             onClick=${() => (i <= step ? goStep(i) : null)}>
          <div class="num">${i < step ? '✓' : i + 1}</div>
          <div>${s.title}</div>
        </div>`)}
    </div>`;
}

function WizardShell() {
  const step = useStore((s) => s.wizard.step);
  const Comp = STEPS[step].comp;
  return html`
    <div class="wrap">
      <div class="wizard">
        <${Rail} />
        <div><${Comp} /></div>
      </div>
    </div>`;
}

function AppBar() {
  const route = useStore((s) => s.route);
  return html`
    <div class="appbar">
      <h1>JAJB Schedule Builder</h1>
      <span class="sub">WWV9 · JAJB Logistics</span>
      <div class="spacer"></div>
      <button class="small" onClick=${() => setState({ route: 'home' })}>Home</button>
      <button class="small" onClick=${() => setState({ route: 'settings' })}>Settings</button>
      <button class="small" onClick=${async () => { await logout(); setState({ auth: 'out' }); }}>Sign out</button>
    </div>`;
}

export function App() {
  const auth = useStore((s) => s.auth);
  const route = useStore((s) => s.route);
  const toastVal = useStore((s) => s.toast);

  useEffect(() => {
    checkAuth().then(async (ok) => {
      if (ok) {
        const d = await loadDraft();
        if (d && d.wizard) hydrateWizard(d.wizard);
      }
      setState({ auth: ok ? 'in' : 'out' });
    });
  }, []);

  if (auth === 'unknown') {
    return html`<div class="wrap center" style="margin-top:20vh"><${Spinner}/> Loading…</div>`;
  }
  if (auth === 'out') return html`<${Login}/><${Toast} toast=${toastVal}/>`;

  let body;
  if (route === 'settings') body = html`<div class="wrap"><${Settings}/></div>`;
  else if (route === 'wizard') body = html`<${WizardShell}/>`;
  else body = html`<${Home}/>`;

  return html`
    <div>
      <${AppBar}/>
      ${body}
      <${Toast} toast=${toastVal}/>
    </div>`;
}
