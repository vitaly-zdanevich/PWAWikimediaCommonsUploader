import './style.css';
import { takeSharedFiles } from './idb';
import { handleRedirect } from './oauth';
import { addFiles, entries, isRunning, restoreFromDb, resume } from './queue';
import { initUi, setStartupError } from './ui/app';

async function pickupShared(): Promise<void> {
	const files = await takeSharedFiles();
	if (files.length) addFiles(files);
}

// If input-focus zoom ever returns on iOS despite 16px fields, the fallback is
// setting maximum-scale=1 in the viewport meta for iOS only (it costs pinch zoom).
async function init(): Promise<void> {
	try {
		await handleRedirect();
	} catch (e) {
		setStartupError(e instanceof Error ? e.message : String(e));
	}
	await restoreFromDb();
	await pickupShared();
	initUi();
	// uploads interrupted by an app or device restart continue automatically
	resume();
	addEventListener('online', resume);
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) {
			resume();
			void pickupShared();
		}
	});
	// desktop convenience: Ctrl/Cmd+V with an image in the clipboard
	addEventListener('paste', (ev) => {
		const files = (ev as ClipboardEvent).clipboardData?.files;
		if (files?.length) addFiles(files);
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
		navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => undefined);
	}
}

void init();
