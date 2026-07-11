import './style.css';
import { handleRedirect } from './oauth';
import { restoreFromDb, resume } from './queue';
import { initUi, setStartupError } from './ui/app';

async function init(): Promise<void> {
	// iOS can zoom into focused inputs even at 16px; it honors maximum-scale
	// (unlike user-scalable=no), so cap it there only — other platforms keep pinch zoom
	if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
		document
			.querySelector('meta[name="viewport"]')
			?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover');
	}
	try {
		await handleRedirect();
	} catch (e) {
		setStartupError(e instanceof Error ? e.message : String(e));
	}
	await restoreFromDb();
	initUi();
	// uploads interrupted by an app or device restart continue automatically
	resume();
	addEventListener('online', resume);
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) resume();
	});
	if (navigator.storage?.persist) void navigator.storage.persist().catch(() => undefined);
	if (import.meta.env.PROD && 'serviceWorker' in navigator) {
		navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => undefined);
	}
}

void init();
