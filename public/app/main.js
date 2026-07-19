import { html, render } from './preact-setup.js';
import { App } from './app.js';

render(html`<${App} />`, document.getElementById('root'));
