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

self.addEventListener('fetch', (e) => {
	const req = e.request;
	if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
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
