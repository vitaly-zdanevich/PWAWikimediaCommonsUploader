import { ApiError, RateLimitError, describeUploadWarnings, type WarningResult } from './apierrors';
import { COMMONS_API } from './config';
import { ensureFresh } from './oauth';
import { getAccount } from './prefs';

type Json = Record<string, unknown>;

async function authHeader(username: string, forceFresh = false): Promise<Record<string, string>> {
	const acc = getAccount(username);
	if (!acc) throw new Error(`Not signed in as ${username}`);
	const fresh = await ensureFresh(acc, forceFresh);
	return { Authorization: `Bearer ${fresh.accessToken}` };
}

async function request(url: string, init: RequestInit, username?: string): Promise<Json> {
	let headers: Record<string, string> = {};
	if (username) headers = await authHeader(username);
	let res = await fetch(url, { ...init, headers });
	if (res.status === 401 && username) {
		headers = await authHeader(username, true);
		res = await fetch(url, { ...init, headers });
	}
	const text = await res.text();
	let json: Json | undefined;
	try {
		json = JSON.parse(text) as Json;
	} catch {
		json = undefined;
	}
	const err = json?.error as { code?: string; info?: string } | undefined;
	if (res.status === 429 || err?.code === 'ratelimited') {
		const ra = Number(res.headers.get('retry-after'));
		throw new RateLimitError(Number.isFinite(ra) && ra > 0 ? ra : 300);
	}
	if (err) throw new ApiError(err.code ?? 'unknown', err.info ?? 'Unknown Wikimedia Commons error');
	if (!res.ok || !json) {
		throw new Error(`Wikimedia Commons HTTP ${res.status}${text ? ': ' + text.slice(0, 140) : ''}`);
	}
	return json;
}

// Cross-origin rules of api.php: origin=* is anonymous BY DESIGN (any session is
// dropped); authenticated CORS requires crossorigin=1 + the Authorization header.
export function apiGet(params: Record<string, string>, username?: string): Promise<Json> {
	const cors: Record<string, string> = username ? { crossorigin: '1' } : { origin: '*' };
	const q = new URLSearchParams({ format: 'json', ...cors, ...params });
	return request(`${COMMONS_API}?${q}`, { method: 'GET' }, username);
}

export function apiPost(
	fields: Record<string, string>,
	username: string,
	blob?: { name: string; data: Blob },
): Promise<Json> {
	const fd = new FormData();
	fd.set('format', 'json');
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	if (blob) fd.set(blob.name, blob.data, 'chunk.bin');
	return request(`${COMMONS_API}?crossorigin=1`, { method: 'POST', body: fd }, username);
}

const csrfCache = new Map<string, string>();

export async function getCsrfToken(username: string, forceNew = false): Promise<string> {
	if (!forceNew) {
		const hit = csrfCache.get(username);
		if (hit) return hit;
	}
	const json = await apiGet({ action: 'query', meta: 'tokens', type: 'csrf' }, username);
	const token = (json.query as { tokens?: { csrftoken?: string } } | undefined)?.tokens?.csrftoken;
	if (!token || token === '+\\') throw new Error('Could not get an edit token; please sign in again');
	csrfCache.set(username, token);
	return token;
}

export async function searchCategories(query: string): Promise<string[]> {
	const q = query.trim();
	if (!q) return [];
	const json = await apiGet({
		action: 'query',
		list: 'prefixsearch',
		pssearch: 'Category:' + q,
		psnamespace: '14',
		pslimit: '10',
	});
	const list = (json.query as { prefixsearch?: { title: string }[] } | undefined)?.prefixsearch ?? [];
	const names = list.map((p) => p.title.replace(/^Category:/, ''));
	if (names.length >= 5) return names;
	// prefix search is start-anchored; full-text finds "Beaches of Batumi" for "batumi beach"
	const json2 = await apiGet({
		action: 'query',
		list: 'search',
		srsearch: q,
		srnamespace: '14',
		srlimit: '10',
		srprop: '',
	});
	const found = (json2.query as { search?: { title: string }[] } | undefined)?.search ?? [];
	return names.concat(found.map((p) => p.title.replace(/^Category:/, '')));
}

/** Asks Commons' own title blacklist (authoritative, unlike the local patterns). */
export async function titleBlacklisted(fileName: string): Promise<string | null> {
	const json = await apiGet({ action: 'titleblacklist', tbtitle: 'File:' + fileName, tbaction: 'create' });
	const tb = json.titleblacklist as { result?: string } | undefined;
	if (tb?.result !== 'blacklisted') return null;
	return `Commons rejects the file name "${fileName}" as generic or uninformative. Add a prefix or a descriptive name, then retry.`;
}

export async function titleExists(fileName: string): Promise<boolean> {
	const json = await apiGet({ action: 'query', titles: 'File:' + fileName });
	const pages = (json.query as { pages?: Record<string, { missing?: string }> } | undefined)?.pages ?? {};
	return Object.entries(pages).some(([id, p]) => Number(id) > 0 && p.missing === undefined);
}

export interface UploadChunkResult {
	result: string;
	offset?: number;
	filekey?: string;
}

interface UploadResponse {
	result?: string;
	offset?: number;
	filekey?: string;
	warnings?: Record<string, unknown>;
	imageinfo?: { url?: string; descriptionurl?: string };
}

async function uploadPost(fields: Record<string, string>, username: string, chunk?: Blob): Promise<UploadResponse> {
	const run = async () => {
		const token = await getCsrfToken(username);
		const json = await apiPost(
			{ action: 'upload', token, ...fields },
			username,
			chunk ? { name: 'chunk', data: chunk } : undefined,
		);
		return (json.upload ?? {}) as UploadResponse;
	};
	try {
		return await run();
	} catch (e) {
		if (e instanceof ApiError && e.code === 'badtoken') {
			await getCsrfToken(username, true);
			return run();
		}
		throw e;
	}
}

export function uploadChunk(o: {
	username: string;
	fileName: string;
	fileSize: number;
	offset: number;
	chunk: Blob;
	filekey?: string;
}): Promise<UploadResponse> {
	const fields: Record<string, string> = {
		stash: '1',
		ignorewarnings: '1',
		filename: o.fileName,
		filesize: String(o.fileSize),
		offset: String(o.offset),
	};
	if (o.filekey) fields.filekey = o.filekey;
	return uploadPost(fields, o.username, o.chunk);
}

export interface PublishResult {
	ok: boolean;
	pageUrl?: string;
	fileUrl?: string;
	warning?: WarningResult;
}

/** Publishes a fully stashed file; warnings (name taken, SHA1 duplicate…) are returned, not thrown. */
export async function publishStash(o: {
	username: string;
	filekey: string;
	fileName: string;
	text: string;
	comment: string;
}): Promise<PublishResult> {
	const up = await uploadPost(
		{ filekey: o.filekey, filename: o.fileName, text: o.text, comment: o.comment },
		o.username,
	);
	if (up.result === 'Success') {
		return { ok: true, pageUrl: up.imageinfo?.descriptionurl, fileUrl: up.imageinfo?.url };
	}
	if (up.warnings) return { ok: false, warning: describeUploadWarnings(up.warnings) };
	throw new Error(`Unexpected upload result: ${up.result ?? 'none'}`);
}
