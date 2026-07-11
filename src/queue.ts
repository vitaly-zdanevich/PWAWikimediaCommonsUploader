import { ApiError, RateLimitError, filePageUrl } from './apierrors';
import { getCsrfToken, publishStash, titleBlacklisted, titleExists, uploadChunk } from './api';
import { CHUNK_SIZE, PWA_CATEGORY, UPLOAD_COMMENT } from './config';
import { readJpegGps } from './exif';
import { dbAll, dbDelete, dbPut } from './idb';
import { buildFinalName, requiresConversion } from './naming';
import { ensureFresh, randomId } from './oauth';
import { getAccount, getPrefs, rememberCategories, rememberPrefix } from './prefs';
import type { Entry } from './types';
import { buildWikitext, dedupeCategories } from './wikitext';

export const entries: Entry[] = [];

let onUpdate: (e?: Entry) => void = () => {};
export function setOnUpdate(cb: (e?: Entry) => void): void {
	onUpdate = cb;
}

let seq = 0;
let running = false;

export function isRunning(): boolean {
	return running;
}

export function addFiles(files: ArrayLike<File>): void {
	for (let i = 0; i < files.length; i++) {
		const f = files[i];
		const entry: Entry = {
			id: `${Date.now().toString(36)}-${randomId(4)}`,
			seq: ++seq,
			file: f,
			origName: f.name,
			size: f.size,
			lastModified: f.lastModified,
			customName: '',
			description: '',
			categories: [],
			license: '',
			username: '',
			prefix: '',
			globalCats: [],
			status: 'new',
			offset: 0,
			viaLambda: requiresConversion(f.name),
		};
		entries.push(entry);
		if (f.type === 'image/jpeg' || /\.jpe?g$/i.test(f.name)) {
			void readJpegGps(f).then((gps) => {
				if (!gps) return;
				entry.lat = gps.lat;
				entry.lon = gps.lon;
				onUpdate();
			});
		}
	}
	onUpdate();
}

export function removeEntry(id: string): void {
	const i = entries.findIndex((e) => e.id === id);
	if (i < 0) return;
	entries.splice(i, 1);
	void dbDelete(id);
	onUpdate();
}

export function clearFinished(): void {
	for (const e of entries.filter((x) => x.status === 'done')) {
		void dbDelete(e.id);
	}
	const keep = entries.filter((x) => x.status !== 'done');
	entries.length = 0;
	entries.push(...keep);
	onUpdate();
}

export function doneEntries(): Entry[] {
	return entries.filter((e) => e.status === 'done');
}

export async function restoreFromDb(): Promise<void> {
	const stored = await dbAll();
	stored.sort((a, b) => a.seq - b.seq);
	for (const e of stored) {
		if (e.status === 'uploading') e.status = 'pending';
		e.seq = ++seq;
		entries.push(e);
	}
}

function persist(e: Entry): void {
	// keep the blob only while it is still needed
	void dbPut(e.status === 'done' ? { ...e, file: null } : e);
}

/** Snapshots global settings into the selected entries and starts the queue. */
export function startUploads(username: string, prefix: string, globalCats: string[]): void {
	const defLicense = getPrefs().defaultLicense;
	for (const e of entries) {
		if (e.status !== 'new') continue;
		e.username = username;
		e.prefix = prefix;
		e.globalCats = dedupeCategories(globalCats);
		if (!e.license) e.license = defLicense;
		e.status = 'pending';
		e.error = undefined;
		e.errorLinks = undefined;
		persist(e);
	}
	if (prefix.trim()) rememberPrefix(prefix);
	onUpdate();
	void run();
}

/** Retry honors the CURRENT form values (e.g. a corrected prefix), not the old snapshot. */
export function retryEntry(id: string, snap: { prefix: string; globalCats: string[] }): void {
	const e = entries.find((x) => x.id === id);
	if (!e || e.status !== 'error') return;
	e.prefix = snap.prefix;
	e.globalCats = dedupeCategories(snap.globalCats);
	e.finalName = undefined;
	e.status = 'pending';
	e.error = undefined;
	e.errorLinks = undefined;
	persist(e);
	onUpdate(e);
	void run();
}

export function resume(): void {
	if (entries.some((e) => e.status === 'pending')) void run();
}

async function run(): Promise<void> {
	if (running) return;
	running = true;
	try {
		for (;;) {
			const e = entries.find((x) => x.status === 'pending');
			if (!e) break;
			await processEntry(e);
		}
	} finally {
		running = false;
		onUpdate();
	}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rateLimitWaits = new Map<string, number>();

function fail(e: Entry, message: string, links?: Entry['errorLinks']): void {
	e.status = 'error';
	e.error = message;
	e.errorLinks = links;
	rateLimitWaits.delete(e.id);
	persist(e);
	onUpdate(e);
}

async function processEntry(e: Entry): Promise<void> {
	e.status = 'uploading';
	e.progressText = e.viaLambda ? 'converting…' : '0%';
	onUpdate(e);
	try {
		if (e.viaLambda) {
			await lambdaUpload(e);
		} else {
			await commonsUpload(e);
		}
		e.status = 'done';
		e.progressText = undefined;
		rateLimitWaits.delete(e.id);
		persist(e);
		rememberCategories([...e.globalCats, ...e.categories]);
		onUpdate(e);
	} catch (err) {
		if (err instanceof SkipError) return; // entry already marked failed with a rich message
		if (err instanceof RateLimitError) {
			// quota window is long (380 upload hits / 72 min): wait, then the run loop retries
			const waits = (rateLimitWaits.get(e.id) ?? 0) + 1;
			rateLimitWaits.set(e.id, waits);
			if (waits <= 6) {
				const waitSec = Math.min(Math.max(err.retryAfterSec, 60), 600);
				e.status = 'pending';
				e.progressText = `rate-limited, retry in ~${Math.ceil(waitSec / 60)} min`;
				persist(e);
				onUpdate(e);
				await sleep(waitSec * 1000);
				return;
			}
			fail(e, 'Wikimedia Commons rate limit reached (regular users: 380 upload requests per 72 minutes). Retry later.');
			return;
		}
		if (err instanceof ApiError && ['stashfailed', 'invalidsessiondata', 'stasherror'].includes(err.code)) {
			// the stashed chunks are gone (e.g. expired after a long pause): restart this file
			e.offset = 0;
			e.filekey = undefined;
		}
		fail(e, err instanceof Error ? err.message : String(err));
	}
}

function entryWikitext(e: Entry): string {
	return buildWikitext({
		description: e.description,
		dateIso: new Date(e.lastModified || Date.now()).toISOString().slice(0, 10),
		username: e.username,
		licenseId: e.license || getPrefs().defaultLicense,
		categories: [...e.globalCats, ...e.categories],
		pwaCategory: PWA_CATEGORY,
	});
}

async function commonsUpload(e: Entry): Promise<void> {
	e.finalName = buildFinalName(e.prefix, e.customName, e.origName);
	const stashed = e.filekey !== undefined && e.offset >= e.size;

	if (!stashed) {
		if (!e.file) throw new Error('The file data is no longer available; remove and select it again');
		if (!e.filekey) {
			// server-side checks before spending upload quota; on network failure
			// the publish step still enforces both
			const blocked = await titleBlacklisted(e.finalName).catch(() => null);
			if (blocked) {
				fail(e, blocked);
				throw new SkipError();
			}
			if (await titleExists(e.finalName)) {
				fail(e, 'A file with this name already exists. Please rename your file and retry.', [
					{ text: e.finalName, href: filePageUrl(e.finalName) },
				]);
				throw new SkipError();
			}
		}
		await getCsrfToken(e.username);
		while (e.offset < e.size) {
			const chunk = e.file.slice(e.offset, e.offset + CHUNK_SIZE);
			const up = await uploadChunk({
				username: e.username,
				fileName: e.finalName,
				fileSize: e.size,
				offset: e.offset,
				chunk,
				filekey: e.filekey,
			});
			if (up.filekey) e.filekey = up.filekey;
			if (up.result === 'Continue' && typeof up.offset === 'number') {
				e.offset = up.offset;
			} else if (up.result === 'Success' || up.result === 'Warning') {
				e.offset = e.size;
			} else {
				throw new Error(`Chunk upload returned "${up.result ?? 'nothing'}"`);
			}
			e.progressText = `${Math.floor((e.offset / e.size) * 100)}%`;
			persist(e);
			onUpdate(e);
		}
		if (!e.filekey) throw new Error('Upload finished without a file key');
	}

	const res = await publishStash({
		username: e.username,
		filekey: e.filekey as string,
		fileName: e.finalName,
		text: entryWikitext(e),
		comment: UPLOAD_COMMENT,
	});
	if (!res.ok) {
		// keep filekey + offset: after a rename, retry republishes without re-uploading
		fail(e, res.warning?.message ?? 'Upload warning', res.warning?.links);
		throw new SkipError();
	}
	e.pageUrl = res.pageUrl;
	e.fileUrl = res.fileUrl;
	e.file = null;
}

/** Thrown after fail() already recorded a detailed error, so processEntry keeps it. */
class SkipError extends Error {}

async function lambdaUpload(e: Entry): Promise<void> {
	const url = getPrefs().lambdaUrl.trim();
	if (!url) {
		throw new Error(
			'This format is not supported by Wikimedia Commons and needs conversion; set the conversion endpoint URL in Preferences',
		);
	}
	if (!e.file) throw new Error('The file data is no longer available; remove and select it again');
	const acc = getAccount(e.username);
	if (!acc) throw new Error(`Not signed in as ${e.username}`);
	const fresh = await ensureFresh(acc);
	e.finalName = buildFinalName(e.prefix, e.customName, e.origName);
	const fd = new FormData();
	fd.set('file', e.file, e.origName);
	fd.set('filename', e.finalName);
	fd.set('text', entryWikitext(e));
	fd.set('comment', UPLOAD_COMMENT);
	fd.set('token', fresh.accessToken);
	const res = await fetch(url, { method: 'POST', body: fd });
	const json = (await res.json().catch(() => ({}))) as {
		error?: string;
		pageUrl?: string;
		fileUrl?: string;
	};
	if (!res.ok || json.error) throw new Error(json.error || `Conversion endpoint failed (HTTP ${res.status})`);
	e.pageUrl = json.pageUrl;
	e.fileUrl = json.fileUrl;
	e.file = null;
}
