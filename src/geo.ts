import { WDQS_URL } from './config';

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const dLat = rad(lat2 - lat1);
	const dLon = rad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

/** Initial bearing in degrees, 0 = north, clockwise. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
	const x =
		Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
		Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
	return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

export function bearingArrow(deg: number): string {
	return ARROWS[Math.round(deg / 45) % 8];
}

export function formatDistance(m: number): string {
	return `${Math.round(m)} m`;
}

export interface NearbyCategory {
	category: string;
	label: string;
	distanceM: number;
	bearing: number;
}

export async function fetchNearbyCategories(
	lat: number,
	lon: number,
	radiusKm: number,
): Promise<NearbyCategory[]> {
	const sparql = `SELECT ?itemLabel ?cat ?lat ?lon WHERE {
	SERVICE wikibase:around {
		?item wdt:P625 ?loc .
		bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral .
		bd:serviceParam wikibase:radius "${radiusKm}" .
	}
	?item wdt:P373 ?cat .
	BIND(geof:latitude(?loc) AS ?lat)
	BIND(geof:longitude(?loc) AS ?lon)
	SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
} LIMIT 300`;
	const res = await fetch(`${WDQS_URL}?query=${encodeURIComponent(sparql)}&format=json`, {
		headers: { Accept: 'application/sparql-results+json' },
	});
	if (!res.ok) throw new Error(`Wikidata query failed (HTTP ${res.status})`);
	const json = (await res.json()) as {
		results: { bindings: Record<string, { value: string }>[] };
	};
	const byCat = new Map<string, NearbyCategory>();
	for (const b of json.results.bindings) {
		const cat = b.cat?.value;
		const bLat = Number(b.lat?.value);
		const bLon = Number(b.lon?.value);
		if (!cat || !isFinite(bLat) || !isFinite(bLon)) continue;
		const item: NearbyCategory = {
			category: cat,
			label: b.itemLabel?.value ?? cat,
			distanceM: haversineMeters(lat, lon, bLat, bLon),
			bearing: bearingDeg(lat, lon, bLat, bLon),
		};
		const prev = byCat.get(cat);
		if (!prev || item.distanceM < prev.distanceM) byCat.set(cat, item);
	}
	return [...byCat.values()].sort((a, b) => a.distanceM - b.distanceM);
}

/** Finds the nearest available categories without making sparse areas look empty. */
export async function fetchClosestCategories(lat: number, lon: number): Promise<NearbyCategory[]> {
	for (const radiusKm of [1, 5, 25]) {
		const items = await fetchNearbyCategories(lat, lon, radiusKm);
		if (items.length) return items;
	}
	return [];
}
