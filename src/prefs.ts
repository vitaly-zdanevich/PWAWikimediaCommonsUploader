import { DEFAULT_OAUTH_CLIENT_ID } from './config';
import type { Account, LicenseId } from './types';

export interface Prefs {
	defaultLicense: LicenseId;
	showThumbs: boolean;
	lambdaUrl: string;
	clientId: string;
	prefixes: string[];
	categories: string[];
}

const PREFS_KEY = 'cu_prefs';
const ACCOUNTS_KEY = 'cu_accounts';
const HISTORY_CAP = 30;

const defaults: Prefs = {
	defaultLicense: 'cc-by-4.0',
	showThumbs: false,
	lambdaUrl: '',
	clientId: DEFAULT_OAUTH_CLIENT_ID,
	prefixes: [],
	categories: [],
};

function readJson<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
	} catch {
		return fallback;
	}
}

export function getPrefs(): Prefs {
	const p = readJson(PREFS_KEY, defaults);
	// an empty saved value must not mask the built-in client ID
	if (!p.clientId) p.clientId = DEFAULT_OAUTH_CLIENT_ID;
	return p;
}

export function savePrefs(patch: Partial<Prefs>): Prefs {
	const next = { ...getPrefs(), ...patch };
	localStorage.setItem(PREFS_KEY, JSON.stringify(next));
	return next;
}

function pushHistory(list: string[], value: string): string[] {
	const v = value.trim();
	if (!v) return list;
	return [v, ...list.filter((x) => x !== v)].slice(0, HISTORY_CAP);
}

export function rememberPrefix(prefix: string): void {
	savePrefs({ prefixes: pushHistory(getPrefs().prefixes, prefix) });
}

export function rememberCategories(cats: string[]): void {
	let list = getPrefs().categories;
	for (const c of cats) list = pushHistory(list, c);
	savePrefs({ categories: list });
}

interface AccountsState {
	list: Account[];
	active: string;
}

export function getAccountsState(): AccountsState {
	return readJson(ACCOUNTS_KEY, { list: [], active: '' });
}

function saveAccountsState(s: AccountsState): void {
	localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(s));
}

export function getAccount(username: string): Account | null {
	return getAccountsState().list.find((a) => a.username === username) ?? null;
}

export function getActiveAccount(): Account | null {
	const s = getAccountsState();
	return s.list.find((a) => a.username === s.active) ?? s.list[0] ?? null;
}

export function setActiveAccount(username: string): void {
	const s = getAccountsState();
	s.active = username;
	saveAccountsState(s);
}

export function upsertAccount(acc: Account): void {
	const s = getAccountsState();
	const i = s.list.findIndex((a) => a.username === acc.username);
	if (i >= 0) s.list[i] = acc;
	else s.list.push(acc);
	s.active = acc.username;
	saveAccountsState(s);
}

export function removeAccount(username: string): void {
	const s = getAccountsState();
	s.list = s.list.filter((a) => a.username !== username);
	if (s.active === username) s.active = s.list[0]?.username ?? '';
	saveAccountsState(s);
}
