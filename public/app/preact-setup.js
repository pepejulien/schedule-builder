// Bind htm to Preact's hyperscript so components can use tagged-template JSX
// with no build step. Import { html, render } from here everywhere.
import { h, render } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);
export { render, h };
