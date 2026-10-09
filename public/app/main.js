import { html, render } from './preact-setup.js';
import { App } from './app.js';
import { rosterHashDate, startRosterPage } from './roster-send.js';

// #roster=YYYY-MM-DD: the Roster to Amazon window (docs/roster-bookmarklet.md), not the app
const rosterDate = rosterHashDate();
if (rosterDate) startRosterPage(document.getElementById('root'), rosterDate);
else render(html`<${App} />`, document.getElementById('root'));
