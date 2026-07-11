import './style.css';
import { handleRedirect } from './oauth';
import { entries, isRunning, restoreFromDb, resume } from './queue';
import { initUi, setStartupError } from './ui/app';

// If input-focus zoom ever returns on iOS despite 16px fields, the fallback is
// setting maximum-scale=1 in the viewport meta for iOS only (it costs pinch zoom).
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
		// reload once when an update takes over, but never mid-work
		let hadController = Boolean(navigator.serviceWorker.controller);
		navigator.serviceWorker.addEventListener('controllerchange', () => {
			const busy = isRunning() || entries.some((e) => e.status !== 'done' && e.status !== 'error');
			if (hadController && !busy) location.reload();
			hadController = true;
		});
		navigator.serviceWorker
			.register(import.meta.env.BASE_URL + 'sw.js', { updateViaCache: 'none' })
			.then((reg) => {
				document.addEventListener('visibilitychange', () => {
					if (!document.hidden) void reg.update().catch(() => undefined);
				});
			})
			.catch(() => undefined);
	}
}

void init();
