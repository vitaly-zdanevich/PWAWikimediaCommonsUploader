import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureFresh, handleRedirect, startLogin } from '../src/oauth';
import { getAccount, getActiveAccount, savePrefs, upsertAccount } from '../src/prefs';
import type { Account } from '../src/types';
import { jsonResponse, stubBrowserStorage } from './stubs';

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function account(overrides: Partial<Account> = {}): Account {
	return {
		username: 'Vitaly Zdanevich',
		accessToken: 'OLD',
		refreshToken: 'RT1',
		expiresAt: Date.now() + 3_600_000,
		...overrides,
	};
}

beforeEach(() => {
	stubBrowserStorage();
	vi.clearAllMocks();
	vi.stubGlobal('fetch', fetchMock);
	vi.stubGlobal('location', {
		search: '',
		origin: 'https://vitaly-zdanevich.github.io',
		pathname: '/PWAWikimediaCommonsUploader/',
		assign: vi.fn(),
	});
	vi.stubGlobal('history', { replaceState: vi.fn() });
	savePrefs({ clientId: 'CID' });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('ensureFresh', () => {
	it('returns the account untouched while the token is valid', async () => {
		const acc = account();
		expect(await ensureFresh(acc)).toBe(acc);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('refreshes an expired token and persists the rotated pair', async () => {
		upsertAccount(account({ expiresAt: Date.now() - 1000 }));
		fetchMock.mockResolvedValue(
			jsonResponse({ access_token: 'NEW', refresh_token: 'RT2', expires_in: 14400 }),
		);

		const fresh = await ensureFresh(account({ expiresAt: Date.now() - 1000 }));
		expect(fresh.accessToken).toBe('NEW');
		expect(fresh.refreshToken).toBe('RT2');

		const body = String(fetchMock.mock.calls[0][1]?.body);
		expect(body).toContain('grant_type=refresh_token');
		expect(body).toContain('refresh_token=RT1');
		expect(body).toContain('client_id=CID');
		expect(getAccount('Vitaly Zdanevich')?.accessToken).toBe('NEW');
	});

	it('keeps the old refresh token when the response does not rotate it', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ access_token: 'NEW', expires_in: 14400 }));
		const fresh = await ensureFresh(account({ expiresAt: 0 }));
		expect(fresh.refreshToken).toBe('RT1');
	});

	it('deduplicates concurrent refreshes for the same account', async () => {
		fetchMock.mockImplementation(async () => {
			await new Promise((r) => setTimeout(r, 10));
			return jsonResponse({ access_token: 'NEW', refresh_token: 'RT2', expires_in: 14400 });
		});
		const expired = account({ expiresAt: 0 });

		const [a, b] = await Promise.all([ensureFresh(expired), ensureFresh(expired)]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(a.accessToken).toBe('NEW');
		expect(b.accessToken).toBe('NEW');
	});

	it('surfaces the OAuth server explanation on failure', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400),
		);
		await expect(ensureFresh(account({ expiresAt: 0 }))).rejects.toThrow('Refresh token revoked');
	});
});

describe('login flow', () => {
	it('startLogin stores the PKCE verifier and sends S256 challenge', async () => {
		await startLogin();

		const assign = vi.mocked((location as unknown as { assign: (u: string) => void }).assign);
		const url = new URL(assign.mock.calls[0][0] as unknown as string);
		expect(url.pathname).toContain('/oauth2/authorize');
		expect(url.searchParams.get('response_type')).toBe('code');
		expect(url.searchParams.get('client_id')).toBe('CID');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('redirect_uri')).toBe(
			'https://vitaly-zdanevich.github.io/PWAWikimediaCommonsUploader/',
		);

		const state = url.searchParams.get('state') ?? '';
		expect(sessionStorage.getItem('cu_pkce_' + state)).toBeTruthy();
	});

	it('handleRedirect is a no-op without a code in the URL', async () => {
		expect(await handleRedirect()).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('handleRedirect exchanges the code and saves the account named by Commons', async () => {
		(location as unknown as { search: string }).search = '?code=THECODE&state=ST';
		sessionStorage.setItem('cu_pkce_ST', 'THEVERIFIER');
		fetchMock.mockImplementation(async (url, init) => {
			if (String(url).includes('/oauth2/access_token')) {
				const body = String(init?.body);
				expect(body).toContain('grant_type=authorization_code');
				expect(body).toContain('code=THECODE');
				expect(body).toContain('code_verifier=THEVERIFIER');
				return jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 14400 });
			}
			expect(String(url)).toContain('crossorigin=1');
			return jsonResponse({ query: { userinfo: { id: 808303, name: 'Vitaly Zdanevich' } } });
		});

		const acc = await handleRedirect();
		expect(acc?.username).toBe('Vitaly Zdanevich');
		expect(acc?.accessToken).toBe('AT');
		expect(getActiveAccount()?.username).toBe('Vitaly Zdanevich');
		expect(vi.mocked((history as unknown as { replaceState: () => void }).replaceState)).toHaveBeenCalled();
	});
});
