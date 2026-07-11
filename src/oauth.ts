import { COMMONS_API, OAUTH_BASE } from './config';
import { getPrefs, upsertAccount } from './prefs';
import type { Account } from './types';

function b64url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomId(len = 16): string {
	return b64url(crypto.getRandomValues(new Uint8Array(len)));
}

export function redirectUri(): string {
	return location.origin + location.pathname;
}

export function clientId(): string {
	return getPrefs().clientId.trim();
}

export async function startLogin(): Promise<void> {
	const id = clientId();
	if (!id) throw new Error('OAuth client ID is not set (Preferences)');
	const verifier = randomId(48);
	const state = randomId(12);
	sessionStorage.setItem('cu_pkce_' + state, verifier);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: id,
		redirect_uri: redirectUri(),
		state,
		code_challenge: b64url(new Uint8Array(digest)),
		code_challenge_method: 'S256',
	});
	location.assign(`${OAUTH_BASE}/authorize?${params}`);
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	message?: string;
	error_description?: string;
}

async function tokenRequest(fields: Record<string, string>): Promise<TokenResponse> {
	const res = await fetch(`${OAUTH_BASE}/access_token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(fields).toString(),
	});
	const json = (await res.json().catch(() => ({}))) as TokenResponse;
	if (!res.ok || !json.access_token) {
		throw new Error(json.error_description || json.message || json.error || `Login failed (HTTP ${res.status})`);
	}
	return json;
}

/** Username as Commons sees it, or null (failure detail pushed to `details`). */
async function commonsUsername(accessToken: string, details: string[]): Promise<string | null> {
	try {
		// crossorigin=1, not origin=* — the latter is anonymous by design
		const res = await fetch(`${COMMONS_API}?action=query&meta=userinfo&format=json&crossorigin=1`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		const body = await res.text();
		if (res.ok) {
			const info = (JSON.parse(body) as { query?: { userinfo?: { name?: string; anon?: string } } })
				.query?.userinfo;
			if (info?.name && info.anon === undefined) return info.name;
		}
		details.push(`Commons HTTP ${res.status}: ${body.slice(0, 160)}`);
	} catch (e) {
		details.push('Commons: ' + (e instanceof Error ? e.message : String(e)));
	}
	return null;
}

async function metaUsername(accessToken: string, details: string[]): Promise<string | null> {
	try {
		const res = await fetch(`${OAUTH_BASE}/resource/profile`, {
			headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
		});
		const body = await res.text();
		if (res.ok) {
			const name = (JSON.parse(body) as { username?: string }).username;
			if (name) return name;
		}
		details.push(`Meta profile HTTP ${res.status}: ${body.slice(0, 160)}`);
	} catch (e) {
		details.push('Meta profile: ' + (e instanceof Error ? e.message : String(e)));
	}
	return null;
}

/**
 * Uploads go to Commons, so Commons must recognize the token — this also keeps
 * consumers that are restricted to Commons working. Meta's profile endpoint is
 * only a fallback to name the user in the error message.
 */
async function fetchUsername(accessToken: string): Promise<string> {
	const details: string[] = [];
	const name = await commonsUsername(accessToken, details);
	if (name) return name;
	// keep the token available for the "Copy diagnostic command" button
	sessionStorage.setItem('cu_debug_token', accessToken);
	const metaName = await metaUsername(accessToken, details);
	if (metaName) {
		throw new Error(
			`Signed in as ${metaName}, but commons.wikimedia.org did not accept the token (${details.join('; ')})`,
		);
	}
	throw new Error(`Could not read the user name for this login. ${details.join('; ')}`);
}

function toAccount(username: string, t: TokenResponse): Account {
	return {
		username,
		accessToken: t.access_token ?? '',
		refreshToken: t.refresh_token ?? '',
		expiresAt: Date.now() + ((t.expires_in ?? 3600) - 60) * 1000,
	};
}

/** Completes the OAuth redirect if the URL carries ?code=…&state=… Returns the new account, if any. */
export async function handleRedirect(): Promise<Account | null> {
	const q = new URLSearchParams(location.search);
	const code = q.get('code');
	const state = q.get('state');
	if (!code || !state) return null;
	history.replaceState(null, '', redirectUri());
	const verifier = sessionStorage.getItem('cu_pkce_' + state);
	sessionStorage.removeItem('cu_pkce_' + state);
	if (!verifier) throw new Error('Login state mismatch, please try again');
	const tokens = await tokenRequest({
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri(),
		client_id: clientId(),
		code_verifier: verifier,
	});
	const acc = toAccount(await fetchUsername(tokens.access_token ?? ''), tokens);
	upsertAccount(acc);
	return acc;
}

const refreshing = new Map<string, Promise<Account>>();

async function refresh(acc: Account): Promise<Account> {
	const tokens = await tokenRequest({
		grant_type: 'refresh_token',
		refresh_token: acc.refreshToken,
		client_id: clientId(),
	});
	const next = toAccount(acc.username, tokens);
	if (!next.refreshToken) next.refreshToken = acc.refreshToken;
	upsertAccount(next);
	return next;
}

/** Returns the account with a valid access token, refreshing it when close to expiry. */
export function ensureFresh(acc: Account, force = false): Promise<Account> {
	if (!force && Date.now() < acc.expiresAt) return Promise.resolve(acc);
	if (!acc.refreshToken) return Promise.reject(new Error(`Session for ${acc.username} expired, please sign in again`));
	let p = refreshing.get(acc.username);
	if (!p) {
		p = refresh(acc).finally(() => refreshing.delete(acc.username));
		refreshing.set(acc.username, p);
	}
	return p;
}
