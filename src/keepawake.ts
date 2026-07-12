// iOS < 16.4 has no Wake Lock API; a tiny muted looping video is the reliable
// way to stop the screen from auto-locking while uploads run (NoSleep technique).
let video: HTMLVideoElement | null = null;

export function keepAwake(on: boolean): void {
	if (!on) {
		video?.pause();
		return;
	}
	if (!video) {
		video = document.createElement('video');
		video.src = import.meta.env.BASE_URL + 'keepawake.mp4';
		video.loop = true;
		video.muted = true;
		video.setAttribute('muted', '');
		video.setAttribute('playsinline', '');
	}
	// needs a user gesture on iOS; when denied the upload still works, the
	// screen just auto-locks as usual
	void video.play().catch(() => undefined);
}
