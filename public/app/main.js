import { html, render } from './preact-setup.js';
import { App } from './app.js';
import { rosterHashDate, startRosterPage } from './roster-send.js';
import { weekHashDate, startWeekPage } from './week-send.js';

// #roster=YYYY-MM-DD: the Roster to Amazon window (docs/roster-bookmarklet.md), not the app
// #schedweek=YYYY-MM-DD (a Sunday): the Week to Amazon window (docs/week-bookmarklet.md)
const rosterDate = rosterHashDate();
const weekDate = weekHashDate();
if (rosterDate) startRosterPage(document.getElementById('root'), rosterDate);
else if (weekDate) startWeekPage(document.getElementById('root'), weekDate);
else render(html`<${App} />`, document.getElementById('root'));
