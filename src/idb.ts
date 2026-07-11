import type { Entry } from './types';

const DB_NAME = 'commons-uploader';
const STORE = 'queue';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}
	return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return openDb().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const req = run(db.transaction(STORE, mode).objectStore(STORE));
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			}),
	);
}

export function dbPut(entry: Entry): Promise<unknown> {
	return tx('readwrite', (s) => s.put(entry)).catch(() => undefined);
}

export function dbDelete(id: string): Promise<unknown> {
	return tx('readwrite', (s) => s.delete(id)).catch(() => undefined);
}

export function dbAll(): Promise<Entry[]> {
	return tx('readonly', (s) => s.getAll() as IDBRequest<Entry[]>).catch(() => [] as Entry[]);
}
