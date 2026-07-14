// Prefer the Wake Lock API (Android, iOS 16.4+). Older iOS falls back to a
// hidden video with a SILENT AUDIO TRACK, unmuted: iOS 15 does not count
// muted/audio-less playback as media, optimizes away short looped videos, and
// may ignore detached elements — hence the 30 s clip, the manual rewind
// instead of `loop`, and the in-DOM 2px element (the NoSleep.js lessons).

interface WakeLockSentinelLike {
	release(): Promise<void>;
}

let wanted = false;
let sentinel: WakeLockSentinelLike | null = null;
let video: HTMLVideoElement | null = null;

async function tryWakeLock(): Promise<boolean> {
	const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } })
		.wakeLock;
	if (!wl) return false;
	try {
		sentinel = await wl.request('screen');
		return true;
	} catch {
		return false;
	}
}

function playVideo(): void {
	if (!video) {
		video = document.createElement('video');
		video.src = import.meta.env.BASE_URL + 'keepawake.mp4';
		video.setAttribute('playsinline', '');
		video.setAttribute('title', 'Uploading to Wikimedia Commons');
		video.style.cssText = 'position:fixed;bottom:0;right:0;width:2px;height:2px;opacity:0.01;pointer-events:none;';
		video.addEventListener('timeupdate', () => {
			if (video && video.duration > 0 && video.currentTime > video.duration - 2) video.currentTime = 0.1;
		});
		// iOS pauses it on its own sometimes; keep it going while needed
		video.addEventListener('pause', () => {
			if (wanted) void video?.play().catch(() => undefined);
		});
		document.body.append(video);
	}
	// plays only when triggered from a user gesture (the Upload/Retry tap)
	void video.play().catch(() => undefined);
}

export function keepAwake(on: boolean): void {
	wanted = on;
	if (!on) {
		if (sentinel) {
			void sentinel.release().catch(() => undefined);
			sentinel = null;
		}
		video?.pause();
		return;
	}
	void (async () => {
		if (await tryWakeLock()) return;
		playVideo();
	})();
}

// wake locks auto-release and iOS drops playback when the app is hidden;
// re-arm whenever it comes back while uploads still run
document.addEventListener('visibilitychange', () => {
	if (!document.hidden && wanted) keepAwake(true);
});
