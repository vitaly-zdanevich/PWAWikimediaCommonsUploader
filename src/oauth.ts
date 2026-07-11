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

async function fetchUsername(accessToken: string): Promise<string> {
	const res = await fetch(`${OAUTH_BASE}/resource/profile`, {
		headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
	});
	const body = await res.text();
	if (res.ok) {
		try {
			const name = (JSON.parse(body) as { username?: string }).username;
			if (name) return name;
		} catch {
			// fall through to the detailed error
		}
	}
	throw new Error(`Could not read the user name for this login (HTTP ${res.status}: ${body.slice(0, 160)})`);
}

/** Uploads go to Commons, so the token must be accepted there too — fail early if not. */
async function assertCommonsAuth(accessToken: string, username: string): Promise<void> {
	let detail = '';
	try {
		const res = await fetch(`${COMMONS_API}?action=query&meta=userinfo&format=json&origin=*`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		const body = await res.text();
		if (res.ok) {
			const info = (JSON.parse(body) as { query?: { userinfo?: { name?: string; anon?: string } } })
				.query?.userinfo;
			if (info?.name && info.anon === undefined) return;
		}
		detail = `HTTP ${res.status}: ${body.slice(0, 160)}`;
	} catch (e) {
		detail = e instanceof Error ? e.message : String(e);
	}
	throw new Error(
		`Signed in as ${username}, but commons.wikimedia.org did not accept the token (${detail}). ` +
			'Check that the OAuth consumer applies to all projects, not a single wiki.',
	);
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
	const username = await fetchUsername(tokens.access_token ?? '');
	await assertCommonsAuth(tokens.access_token ?? '', username);
	const acc = toAccount(username, tokens);
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
