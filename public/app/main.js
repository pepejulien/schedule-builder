import { html, render } from './preact-setup.js';
import { App } from './app.js';
import { rosterHashDate, startRosterPage } from './roster-send.js';
import { rosterMovesHashDate, startRosterMovesPage } from './roster-moves.js';
import { weekHashDate, startWeekPage } from './week-send.js';

// #roster=YYYY-MM-DD: the Roster to Amazon window (docs/roster-bookmarklet.md), not the app
// #roster-moves=YYYY-MM-DD: the same bookmark's "match the Live board to Amazon" window (Jose 2026-10-23)
// #schedweek=YYYY-MM-DD (a Sunday): the Week to Amazon window (docs/week-bookmarklet.md)
const rosterDate = rosterHashDate();
const movesDate = rosterMovesHashDate();
const weekDate = weekHashDate();
if (rosterDate) startRosterPage(document.getElementById('root'), rosterDate);
else if (movesDate) startRosterMovesPage(document.getElementById('root'), movesDate);
else if (weekDate) startWeekPage(document.getElementById('root'), weekDate);
else render(html`<${App} />`, document.getElementById('root'));
