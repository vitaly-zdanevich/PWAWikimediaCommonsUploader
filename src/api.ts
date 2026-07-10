import { ApiError, describeUploadWarnings, type WarningResult } from './apierrors';
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
  if (!res.ok && res.status !== 400) throw new Error(`Wikimedia Commons HTTP ${res.status}`);
  const json = (await res.json()) as Json;
  const err = json.error as { code?: string; info?: string } | undefined;
  if (err) throw new ApiError(err.code ?? 'unknown', err.info ?? 'Unknown Wikimedia Commons error');
  return json;
}

export function apiGet(params: Record<string, string>, username?: string): Promise<Json> {
  const q = new URLSearchParams({ format: 'json', origin: '*', ...params });
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
  return request(`${COMMONS_API}?origin=*`, { method: 'POST', body: fd }, username);
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
  return list.map((p) => p.title.replace(/^Category:/, ''));
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
