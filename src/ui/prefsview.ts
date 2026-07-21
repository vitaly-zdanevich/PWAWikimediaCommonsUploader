import { APP_VERSION, COMMONS_WIKI, GITHUB_OWNER, GITHUB_REPO, GITHUB_URL, PWA_CATEGORY } from '../config';
import { redirectUri, startLogin } from '../oauth';
import { getAccountsState, getActiveAccount, getPrefs, removeAccount, savePrefs, setActiveAccount } from '../prefs';
import type { LicenseId } from '../types';
import { LICENSES } from '../wikitext';
import { rerender } from './app';
import { clear, el } from './dom';

function section(title: string, ...kids: (Node | string | null)[]): HTMLElement {
	const s = el('div', { class: 'pref-sec' }, el('h2', {}, title));
	for (const k of kids) if (k != null) s.append(k);
	return s;
}

function historyChips(list: string[], save: (next: string[]) => void): HTMLElement {
	if (!list.length) return el('p', { class: 'muted' }, 'Nothing saved yet.');
	const wrap = el('div', { class: 'chips' });
	for (const item of list) {
		const chip = el(
			'span',
			{ class: 'chip' },
			item,
			el('button', { type: 'button', class: 'x', 'aria-label': `Remove ${item}`, onclick: () => {
				save(list.filter((x) => x !== item));
				chip.remove();
			} }, '×'),
		);
		wrap.append(chip);
	}
	return wrap;
}

interface GhCommit {
	sha: string;
	html_url: string;
	commit: { message: string; committer?: { date?: string }; author?: { date?: string } };
}

/** package.json version at a given commit; raw.githubusercontent is CORS-open and not API-rate-limited. */
async function versionAt(sha: string): Promise<string> {
	try {
		const res = await fetch(`https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${sha}/package.json`);
		if (!res.ok) return '';
		const v = (JSON.parse(await res.text()) as { version?: string }).version;
		return v ? `v${v}` : '';
	} catch {
		return '';
	}
}

async function loadCommits(container: HTMLElement): Promise<void> {
	try {
		let commits: GhCommit[] | null = null;
		let versions: string[] | null = null;
		const cached = sessionStorage.getItem('cu_commits2');
		if (cached) {
			const parsed = JSON.parse(cached) as { ts: number; data: GhCommit[]; versions: string[] };
			if (Date.now() - parsed.ts < 10 * 60 * 1000) {
				commits = parsed.data;
				versions = parsed.versions;
			}
		}
		if (!commits || !versions) {
			const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits?per_page=10`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			commits = (await res.json()) as GhCommit[];
			versions = await Promise.all(commits.map((c) => versionAt(c.sha)));
			sessionStorage.setItem('cu_commits2', JSON.stringify({ ts: Date.now(), data: commits, versions }));
		}
		const ul = el('ul', { class: 'commits' });
		commits.forEach((c, i) => {
			const date = (c.commit.committer?.date ?? c.commit.author?.date ?? '').slice(0, 10);
			const ver = versions?.[i] ? ` ${versions[i]}` : '';
			ul.append(
				el(
					'li',
					{},
					el('a', { href: c.html_url, target: '_blank', rel: 'noopener' }, c.sha.slice(0, 7)),
					`${ver} ${date} ${c.commit.message.split('\n')[0]}`,
				),
			);
		});
		clear(container).append(ul);
	} catch {
		clear(container).append(el('p', { class: 'muted' }, 'Could not load commits.'));
	}
}

export function renderPrefs(): HTMLElement {
	const prefs = getPrefs();
	const accState = getAccountsState();
	const root = el('section', { class: 'prefs' });

	const accErr = el('p', { class: 'err', hidden: true });
	const accList = el('div');
	for (const a of accState.list) {
		accList.append(
			el(
				'label',
				{ class: 'account-row' },
				el('input', { type: 'radio', name: 'active-account', checked: a.username === accState.active, onchange: () => {
					setActiveAccount(a.username);
					rerender();
				} }),
				el('span', { class: 'grow' }, a.username),
				el('button', { type: 'button', class: 'btn small', onclick: () => {
					removeAccount(a.username);
					rerender();
				} }, 'Sign out'),
			),
		);
	}
	root.append(
		section(
			'Accounts',
			accList,
			el('button', { type: 'button', class: 'btn', onclick: () => {
				startLogin().catch((e: Error) => {
					accErr.textContent = e.message;
					accErr.hidden = false;
				});
			} }, accState.list.length ? 'Add account' : 'Sign in with Wikimedia'),
			accErr,
		),
	);

	root.append(
		section(
			'OAuth client ID',
			el('input', { type: 'text', value: prefs.clientId, placeholder: 'Client ID', autocapitalize: 'off', onchange: (ev: Event) =>
				savePrefs({ clientId: (ev.target as HTMLInputElement).value.trim() }) }),
			el(
				'p',
				{ class: 'muted' },
				'Register an OAuth 2.0 client (non-confidential, PKCE) at ',
				el('a', { href: 'https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/propose/oauth2', target: '_blank', rel: 'noopener' }, 'Meta-Wiki'),
				' with callback URL ',
				el('code', {}, redirectUri()),
			),
		),
	);

	const licSel = el('select', {});
	for (const l of LICENSES) licSel.append(el('option', { value: l.id, selected: l.id === prefs.defaultLicense }, l.label));
	licSel.addEventListener('change', () => savePrefs({ defaultLicense: licSel.value as LicenseId }));
	root.append(section('Default license', licSel));

	root.append(
		section(
			'Display',
			el(
				'label',
				{ class: 'toggle' },
				el('input', { type: 'checkbox', checked: prefs.showThumbs, onchange: (ev: Event) =>
					savePrefs({ showThumbs: (ev.target as HTMLInputElement).checked }) }),
				' Show thumbnails (one per line)',
			),
		),
	);

	root.append(
		section(
			'Conversion endpoint',
			el('input', { type: 'url', value: prefs.conversionUrl, placeholder: 'https://tool-name.toolforge.org/convert', autocapitalize: 'off', onchange: (ev: Event) =>
				savePrefs({ conversionUrl: (ev.target as HTMLInputElement).value.trim() }) }),
			el('p', { class: 'muted' }, 'Formats Commons rejects (HEIC, AVIF, camera RAW, H.264/H.265…) are sent here for conversion and upload.'),
		),
	);

	root.append(section('Saved prefixes', historyChips(prefs.prefixes, (next) => savePrefs({ prefixes: next }))));
	root.append(section('Saved categories', historyChips(prefs.categories, (next) => savePrefs({ categories: next }))));

	const user = getActiveAccount()?.username;
	const links = el('ul', { class: 'links' });
	if (user) {
		links.append(
			el('li', {}, el('a', { href: `${COMMONS_WIKI}Special:ListFiles/${encodeURIComponent(user)}`, target: '_blank', rel: 'noopener' }, `All files uploaded by ${user}`)),
		);
		const q = new URLSearchParams({
			title: 'Special:Search',
			profile: 'images',
			search: `incategory:"${PWA_CATEGORY}" insource:"User:${user}"`,
		});
		links.append(
			el('li', {}, el('a', { href: `https://commons.wikimedia.org/w/index.php?${q}`, target: '_blank', rel: 'noopener' }, `Files uploaded by ${user} from this PWA`)),
		);
	}
	links.append(el('li', {}, el('a', { href: GITHUB_URL, target: '_blank', rel: 'noopener' }, 'GitHub repository')));
	root.append(section('Links', links));

	const commits = el('div', {}, el('p', { class: 'muted' }, 'Loading…'));
	void loadCommits(commits);
	root.append(section('Last 10 commits', commits));

	root.append(el('p', { class: 'muted' }, `Version ${APP_VERSION}`));
	root.append(el('p', { class: 'muted' }, 'Thanks for preserving the history'));
	return root;
}
