import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitError } from '../src/apierrors';
import type { Entry } from '../src/types';
import { stubBrowserStorage } from './stubs';

vi.mock('../src/config', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/config')>()),
	CHUNK_SIZE: 1024,
}));
vi.mock('../src/api', () => ({
	getCsrfToken: vi.fn(async () => 'CSRF'),
	titleExists: vi.fn(async () => false),
	uploadChunk: vi.fn(),
	publishStash: vi.fn(),
	pageLastEdit: vi.fn(),
	editPage: vi.fn(async () => undefined),
}));
vi.mock('../src/idb', () => ({
	dbPut: vi.fn(async () => undefined),
	dbDelete: vi.fn(async () => undefined),
	dbAll: vi.fn(async () => []),
}));
vi.mock('../src/keepawake', () => ({ keepAwake: vi.fn() }));

import { editPage, pageLastEdit, publishStash, titleExists, uploadChunk } from '../src/api';
import { dbAll, dbPut } from '../src/idb';
import { addFiles, doneEntries, entries, restoreFromDb, resume, retryEntry, startUploads, updateOnCommons } from '../src/queue';

const upload = vi.mocked(uploadChunk);
const publish = vi.mocked(publishStash);
const exists = vi.mocked(titleExists);

function chunkedUploadOk(): void {
	upload.mockImplementation(async ({ offset, chunk, fileSize }) => {
		const end = offset + chunk.size;
		return end >= fileSize ? { result: 'Success', filekey: 'FK' } : { result: 'Continue', offset: end, filekey: 'FK' };
	});
}

function publishOk(): void {
	publish.mockResolvedValue({
		ok: true,
		pageUrl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
		fileUrl: 'https://upload.wikimedia.org/x.jpg',
	});
}

function makeFile(name = 'Sunset over Batumi.jpg', bytes = 2500): File {
	return new File([new Uint8Array(bytes)], name, { type: 'image/png', lastModified: 1752400000000 });
}

beforeEach(() => {
	stubBrowserStorage();
	vi.clearAllMocks();
	entries.length = 0;
	exists.mockResolvedValue(false);
	chunkedUploadOk();
	publishOk();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('queue happy path', () => {
	it('chunks, publishes with prefix and categories, frees the blob', async () => {
		addFiles([makeFile()]);
		expect(entries[0].status).toBe('new');

		startUploads('Vitaly Zdanevich', 'Batumi ', ['Cats']);
		await vi.waitFor(() => expect(entries[0].status).toBe('done'));

		// 2500 bytes at 1024-byte chunks = offsets 0, 1024, 2048
		expect(upload.mock.calls.map((c) => c[0].offset)).toEqual([0, 1024, 2048]);
		expect(upload.mock.calls[0][0].fileName).toBe('Batumi Sunset over Batumi.jpg');

		const pub = publish.mock.calls[0][0];
		expect(pub.filekey).toBe('FK');
		expect(pub.text).toContain('[[Category:Cats]]');
		expect(pub.text.trim().endsWith('[[Category:Uploaded by PWA from Vitaly Zdanevich]]')).toBe(true);
		expect(pub.text).toContain('|author=[[User:Vitaly Zdanevich|Vitaly Zdanevich]]');

		expect(entries[0].pageUrl).toContain('File:X.jpg');
		expect(entries[0].file).toBeNull();
		expect(doneEntries()).toHaveLength(1);
		// the persisted done record must not carry the blob
		const putCalls = vi.mocked(dbPut).mock.calls;
		const lastPut = putCalls[putCalls.length - 1][0] as Entry;
		expect(lastPut.status).toBe('done');
		expect(lastPut.file).toBeNull();
	});
});

describe('name conflicts', () => {
	it('fails early with a link when the title is taken, without uploading', async () => {
		exists.mockResolvedValue(true);
		addFiles([makeFile()]);
		startUploads('U', '', []);
		await vi.waitFor(() => expect(entries[0].status).toBe('error'));

		expect(entries[0].error).toContain('already exists');
		expect(entries[0].errorLinks?.[0].href).toContain('File:');
		expect(upload).not.toHaveBeenCalled();
	});

	it('publish warning keeps the stash; rename + retry republishes without re-uploading', async () => {
		publish.mockResolvedValueOnce({
			ok: false,
			warning: { message: 'A file with this name already exists.', links: [] },
		});
		addFiles([makeFile()]);
		startUploads('U', '', []);
		await vi.waitFor(() => expect(entries[0].status).toBe('error'));

		const chunkCalls = upload.mock.calls.length;
		expect(entries[0].filekey).toBe('FK'); // stash survived the warning

		entries[0].customName = 'Fishing boats in Batumi harbor';
		retryEntry(entries[0].id, { prefix: 'New ', globalCats: ['Harbors'] });
		await vi.waitFor(() => expect(entries[0].status).toBe('done'));

		expect(upload.mock.calls.length).toBe(chunkCalls); // no chunk re-uploaded
		const pub = publish.mock.calls[publish.mock.calls.length - 1][0];
		expect(pub.fileName).toBe('New Fishing boats in Batumi harbor.jpg');
		expect(pub.text).toContain('[[Category:Harbors]]');
	});
});

describe('updateOnCommons', () => {
	async function uploadedEntry(): Promise<string> {
		addFiles([makeFile()]);
		startUploads('Vitaly Zdanevich', '', ['Cats']);
		await vi.waitFor(() => expect(entries[0].status).toBe('done'));
		return entries[0].id;
	}

	it('refuses when someone else edited the page since upload', async () => {
		const id = await uploadedEntry();
		vi.mocked(pageLastEdit).mockResolvedValue({ user: 'SomeBot', timestamp: '2026-07-15T10:00:00Z' });

		await expect(updateOnCommons(id)).rejects.toThrow('edited on Commons by SomeBot');
		expect(editPage).not.toHaveBeenCalled();
	});

	it('regenerates the wikitext and saves with basetimestamp when untouched', async () => {
		const id = await uploadedEntry();
		entries[0].description = 'Fixed description';
		vi.mocked(pageLastEdit).mockResolvedValue({ user: 'Vitaly Zdanevich', timestamp: '2026-07-15T10:00:00Z' });

		await updateOnCommons(id);
		const call = vi.mocked(editPage).mock.calls[0][0];
		expect(call.title).toBe('File:' + entries[0].finalName);
		expect(call.text).toContain('Fixed description');
		expect(call.text).toContain('[[Category:Cats]]');
		expect(call.baseTimestamp).toBe('2026-07-15T10:00:00Z');
	});

	it('rejects for files that are not uploaded yet', async () => {
		addFiles([makeFile()]);
		await expect(updateOnCommons(entries[0].id)).rejects.toThrow('not uploaded yet');
	});
});

describe('interruptions', () => {
	it('network drop returns the entry to pending and resume() finishes it', async () => {
		upload.mockRejectedValueOnce(new TypeError('Failed to fetch'));
		addFiles([makeFile()]);
		startUploads('U', '', []);
		await vi.waitFor(() => expect(entries[0].status).toBe('pending'));
		expect(entries[0].progressText).toContain('waiting for network');

		resume();
		await vi.waitFor(() => expect(entries[0].status).toBe('done'));
	});

	it('rate limit waits and retries the same entry', async () => {
		vi.useFakeTimers();
		upload.mockRejectedValueOnce(new RateLimitError(1));
		addFiles([makeFile()]);
		startUploads('U', '', []);

		await vi.advanceTimersByTimeAsync(0);
		expect(entries[0].status).toBe('pending');
		expect(entries[0].progressText).toContain('rate-limited');

		await vi.advanceTimersByTimeAsync(60_000);
		expect(entries[0].status).toBe('done');
	});

	it('restoreFromDb continues an interrupted upload from the saved offset', async () => {
		const file = makeFile('Boulevard.jpg', 3000);
		vi.mocked(dbAll).mockResolvedValueOnce([
			{
				id: 'x1',
				seq: 1,
				file,
				origName: 'Boulevard.jpg',
				size: 3000,
				lastModified: 1752400000000,
				customName: '',
				description: '',
				categories: [],
				license: 'cc-by-4.0',
				username: 'U',
				prefix: '',
				globalCats: [],
				status: 'uploading', // killed mid-flight
				offset: 1024,
				filekey: 'FK',
				viaLambda: false,
			} as Entry,
		]);

		await restoreFromDb();
		expect(entries[0].status).toBe('pending');

		resume();
		await vi.waitFor(() => expect(entries[0].status).toBe('done'));
		// continued from byte 1024 with the old filekey, not from scratch
		expect(upload.mock.calls[0][0].offset).toBe(1024);
		expect(upload.mock.calls[0][0].filekey).toBe('FK');
		expect(exists).not.toHaveBeenCalled(); // pre-check skipped when a stash exists
	});
});
