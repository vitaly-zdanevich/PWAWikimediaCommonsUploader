import { bearingArrow, fetchNearbyCategories, formatDistance, type NearbyCategory } from '../geo';
import { clear, el } from './dom';
import { categoryUrl } from './catinput';

/**
 * Lists the closest Commons categories from Wikidata (P625 + P373), around the
 * given coordinates (e.g. from photo EXIF) or the device location.
 */
export function openNearby(o: {
	has: (c: string) => boolean;
	add: (c: string) => void;
	coords?: { lat: number; lon: number };
}): void {
	let radiusKm = 1;
	let coords: { lat: number; lon: number } | null = null;

	const body = el('div', { class: 'sheet-body' });
	const wider = el('button', { type: 'button', class: 'btn', onclick: () => {
		radiusKm = Math.min(radiusKm * 5, 25);
		void search();
	} }, '');
	const overlay = el(
		'div',
		{ class: 'overlay', onclick: (ev: Event) => { if (ev.target === overlay) overlay.remove(); } },
		el(
			'div',
			{ class: 'sheet' },
			el(
				'div',
				{ class: 'sheet-head' },
				el('strong', {}, '📍 Nearby Commons categories'),
				el('button', { type: 'button', class: 'x', 'aria-label': 'Close', onclick: () => overlay.remove() }, '×'),
			),
			body,
			el('div', { class: 'sheet-foot' }, wider),
		),
	);

	function msg(text: string, isErr = false): void {
		clear(body).append(el('p', { class: isErr ? 'err' : 'muted' }, text));
	}

	function updateWider(): void {
		wider.disabled = radiusKm >= 25 || !coords;
		wider.textContent = radiusKm >= 25 ? 'Maximum radius reached' : `Search wider (${Math.min(radiusKm * 5, 25)} km)`;
	}

	function row(it: NearbyCategory): HTMLElement {
		const btn = el('button', {
			type: 'button',
			class: 'linklike' + (o.has(it.category) ? ' added' : ''),
			onclick: () => {
				o.add(it.category);
				btn.classList.add('added');
			},
		}, it.category);
		return el(
			'li',
			{ class: 'nearby-row' },
			el('span', { class: 'dir' }, bearingArrow(it.bearing)),
			btn,
			el('span', { class: 'dist muted' }, formatDistance(it.distanceM)),
			el('a', { href: categoryUrl(it.category), target: '_blank', rel: 'noopener', 'aria-label': 'Open category' }, '↗'),
		);
	}

	async function search(): Promise<void> {
		if (!coords) return;
		updateWider();
		msg(`Searching within ${radiusKm} km…`);
		try {
			const items = await fetchNearbyCategories(coords.lat, coords.lon, radiusKm);
			if (!items.length) {
				msg(`No Commons categories found within ${radiusKm} km.`);
				return;
			}
			const ul = el('ul', { class: 'nearby' });
			for (const it of items) ul.append(row(it));
			clear(body).append(ul);
		} catch (e) {
			msg(e instanceof Error ? e.message : String(e), true);
		}
	}

	document.body.append(overlay);
	updateWider();
	if (o.coords) {
		coords = { ...o.coords };
		void search();
		return;
	}
	if (!('geolocation' in navigator)) {
		msg('Geolocation is not available on this device.', true);
		return;
	}
	msg('Getting your location…');
	navigator.geolocation.getCurrentPosition(
		(pos) => {
			coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
			void search();
		},
		(err) => msg('Geolocation failed: ' + err.message, true),
		{ enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
	);
}
