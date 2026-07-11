import './style.css';
import { handleRedirect } from './oauth';
import { restoreFromDb, resume } from './queue';
import { initUi, setStartupError } from './ui/app';

async function init(): Promise<void> {
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
