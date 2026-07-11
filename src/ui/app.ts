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
	let errNode: HTMLElement | null = null;
	if (startupError) {
		errNode = el('div', { class: 'err' }, startupError);
		const dbgToken = sessionStorage.getItem('cu_debug_token');
		if (dbgToken) {
			const cmd =
				`curl -s 'https://commons.wikimedia.org/w/api.php?action=query&meta=userinfo&format=json&crossorigin=1' -H 'Authorization: Bearer ${dbgToken}'; echo; ` +
				`curl -s 'https://commons.wikimedia.org/w/api.php?action=query&meta=userinfo&format=json' -H 'Authorization: Bearer ${dbgToken}'`;
			const btn = el('button', { type: 'button', class: 'btn small', onclick: () => {
				void navigator.clipboard.writeText(cmd).then(() => (btn.textContent = '✓ Copied'));
			} }, 'Copy diagnostic command');
			errNode.append(' ', btn);
		}
	}
	clear(app).append(header, errNode ?? '', main);
	startupError = '';
}

export function initUi(): void {
	setOnUpdate((e) => (e ? patchEntry(e) : rerender()));
	rerender();
}
