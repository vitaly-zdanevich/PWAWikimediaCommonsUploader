import { startLogin } from '../oauth';
import { getAccountsState, getActiveAccount, getPrefs } from '../prefs';
import { setOnUpdate } from '../queue';
import { clear, el } from './dom';
import { patchEntry, renderFiles } from './filesview';
import { renderPrefs } from './prefsview';

let view: 'files' | 'prefs' = 'files';
let startupError = '';

export function setStartupError(msg: string): void {
  startupError = msg;
}

export function showView(v: 'files' | 'prefs'): void {
  view = v;
  rerender();
}

function renderLogin(): HTMLElement {
  const err = el('p', { class: 'err', hidden: true });
  const hasClient = Boolean(getPrefs().clientId.trim());
  return el(
    'section',
    { class: 'login' },
    el('p', {}, 'Upload your own photos and videos to Wikimedia Commons.'),
    el('button', { type: 'button', class: 'btn primary', disabled: !hasClient, onclick: () => {
      startLogin().catch((e: Error) => {
        err.textContent = e.message;
        err.hidden = false;
      });
    } }, 'Sign in with Wikimedia'),
    hasClient ? null : el('p', { class: 'muted' }, 'First set your OAuth client ID in Preferences (⚙).'),
    err,
  );
}

export function rerender(): void {
  const app = document.getElementById('app');
  if (!app) return;
  const acc = getActiveAccount();
  const header = el(
    'header',
    {},
    el('h1', {}, 'Commons Uploader'),
    acc && view === 'files' ? el('span', { class: 'muted user' }, acc.username) : null,
    el('button', { type: 'button', class: 'btn small', 'aria-label': 'Preferences', onclick: () =>
      showView(view === 'prefs' ? 'files' : 'prefs') }, view === 'prefs' ? '← Back' : '⚙'),
  );
  let main: HTMLElement;
  if (view === 'prefs') main = renderPrefs();
  else if (!getAccountsState().list.length) main = renderLogin();
  else main = renderFiles();
  clear(app).append(header, startupError ? el('p', { class: 'err' }, startupError) : '', main);
  startupError = '';
}

export function initUi(): void {
  setOnUpdate((e) => (e ? patchEntry(e) : rerender()));
  rerender();
}
