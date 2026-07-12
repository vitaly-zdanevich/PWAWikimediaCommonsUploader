// Generated at build time by scripts/postbuild.mjs (placeholders injected).
const CACHE = 'cu-__VERSION__';
const ASSETS = __PRECACHE__;

// GitHub Pages serves with max-age=600; revalidate so precache/navigations
// never store a stale deploy (falls back gracefully where unsupported)
let REVALIDATE;
try {
	if (new Request('./', { cache: 'no-cache' }).cache === 'no-cache') REVALIDATE = { cache: 'no-cache' };
} catch {
	REVALIDATE = undefined;
}

self.addEventListener('install', (e) => {
	e.waitUntil(
		caches
			.open(CACHE)
			.then((c) =>
				Promise.all(
					ASSETS.map((u) =>
						fetch(u, REVALIDATE).then((r) => {
							if (!r.ok) throw new Error('precache failed: ' + u);
							return c.put(u, r);
						}),
					),
				),
			)
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener('activate', (e) => {
	e.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

// Android share sheet target: stash the shared files, the page picks them up
function stashShared(files) {
	return new Promise((resolve, reject) => {
		const open = indexedDB.open('commons-uploader-shared', 1);
		open.onupgradeneeded = () => open.result.createObjectStore('files', { autoIncrement: true });
		open.onsuccess = () => {
			const tx = open.result.transaction('files', 'readwrite');
			const store = tx.objectStore('files');
			for (const f of files) store.add(f);
			tx.oncomplete = resolve;
			tx.onerror = () => reject(tx.error);
		};
		open.onerror = () => reject(open.error);
	});
}

self.addEventListener('fetch', (e) => {
	const req = e.request;
	const url = new URL(req.url);
	if (req.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share-target/')) {
		e.respondWith(
			(async () => {
				const fd = await req.formData();
				const files = fd.getAll('media').filter((f) => typeof f !== 'string');
				if (files.length) await stashShared(files).catch(() => undefined);
				return new Response(null, { status: 303, headers: { Location: './' } });
			})(),
		);
		return;
	}
	if (req.method !== 'GET' || url.origin !== location.origin) return;
	if (req.mode === 'navigate') {
		e.respondWith(fetch(req, REVALIDATE).catch(() => caches.match('./')));
		return;
	}
	e.respondWith(
		caches.match(req).then(
			(hit) =>
				hit ||
				fetch(req).then((res) => {
					if (res.ok) {
						const copy = res.clone();
						caches.open(CACHE).then((c) => c.put(req, copy));
					}
					return res;
				}),
		),
	);
});
