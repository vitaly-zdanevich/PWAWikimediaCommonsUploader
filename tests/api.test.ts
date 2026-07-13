import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, RateLimitError } from '../src/apierrors';
import { jsonResponse, stubBrowserStorage } from './stubs';

vi.mock('../src/oauth', () => ({
	ensureFresh: vi.fn(),
}));

import { getCsrfToken, searchCategories } from '../src/api';
import { ensureFresh } from '../src/oauth';
import { upsertAccount } from '../src/prefs';
import type { Account } from '../src/types';

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function account(username: string, token = 'AT'): Account {
	return { username, accessToken: token, refreshToken: 'RT', expiresAt: Date.now() + 3_600_000 };
}

beforeEach(() => {
	stubBrowserStorage();
	vi.clearAllMocks();
	vi.stubGlobal('fetch', fetchMock);
	vi.mocked(ensureFresh).mockImplementation(async (acc) => acc);
});

describe('anonymous requests', () => {
	it('use origin=* and no Authorization header', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				query: {
					prefixsearch: ['A', 'B', 'C', 'D', 'E'].map((x) => ({ title: `Category:Batumi ${x}` })),
				},
			}),
		);
		const cats = await searchCategories('Batumi');

		expect(cats).toEqual(['Batumi A', 'Batumi B', 'Batumi C', 'Batumi D', 'Batumi E']);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toContain('origin=*');
		expect(url).not.toContain('crossorigin');
		expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
	});

	it('fall back to full-text search when prefix search is scarce', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ query: { prefixsearch: [] } }))
			.mockResolvedValueOnce(jsonResponse({ query: { search: [{ title: 'Category:Beaches of Batumi' }] } }));
		const cats = await searchCategories('batumi beach');

		expect(cats).toEqual(['Beaches of Batumi']);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1][0]).toContain('list=search');
	});
});

describe('authenticated requests', () => {
	it('use crossorigin=1 with a Bearer token', async () => {
		upsertAccount(account('U1'));
		fetchMock.mockResolvedValue(jsonResponse({ query: { tokens: { csrftoken: 'abc123+\\' } } }));

		const token = await getCsrfToken('U1');
		expect(token).toBe('abc123+\\');
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toContain('crossorigin=1');
		expect(url).not.toContain('origin=*');
		expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer AT');
	});

	it('retries once with a forced token refresh on 401', async () => {
		upsertAccount(account('U2'));
		vi.mocked(ensureFresh).mockImplementation(async (acc, force) =>
			force ? { ...acc, accessToken: 'AT2' } : acc,
		);
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ httpCode: 401 }, 401))
			.mockResolvedValueOnce(jsonResponse({ query: { tokens: { csrftoken: 'tok+\\' } } }));

		const token = await getCsrfToken('U2');
		expect(token).toBe('tok+\\');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const retryHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
		expect(retryHeaders.Authorization).toBe('Bearer AT2');
		expect(vi.mocked(ensureFresh).mock.calls[1][1]).toBe(true);
	});
});

describe('error mapping', () => {
	it('HTTP 429 becomes RateLimitError with the Retry-After value', async () => {
		upsertAccount(account('U3'));
		fetchMock.mockResolvedValue(jsonResponse({}, 429, { 'Retry-After': '123' }));

		const err = await getCsrfToken('U3').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RateLimitError);
		expect((err as RateLimitError).retryAfterSec).toBe(123);
	});

	it('MediaWiki error JSON becomes ApiError with code and info', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'badvalue', info: 'Unrecognized value.' } }));

		const err = await searchCategories('x y').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).code).toBe('badvalue');
		expect((err as ApiError).message).toContain('Unrecognized value.');
	});

	it('non-JSON server failures surface the HTTP status and body snippet', async () => {
		fetchMock.mockResolvedValue(new Response('<html>Service Unavailable</html>', { status: 503 }));

		const err = await searchCategories('xx').catch((e: unknown) => e);
		expect(String(err)).toContain('HTTP 503');
		expect(String(err)).toContain('Service Unavailable');
	});
});
