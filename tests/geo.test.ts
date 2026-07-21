import { afterEach, describe, expect, it, vi } from 'vitest';
import { bearingArrow, bearingDeg, fetchClosestCategories, formatDistance, haversineMeters } from '../src/geo';

afterEach(() => vi.unstubAllGlobals());

describe('haversineMeters', () => {
	it('is zero for the same point', () => {
		expect(haversineMeters(41.65, 41.63, 41.65, 41.63)).toBe(0);
	});
	it('Paris to London is about 344 km', () => {
		const d = haversineMeters(48.8566, 2.3522, 51.5074, -0.1278);
		expect(d).toBeGreaterThan(330000);
		expect(d).toBeLessThan(355000);
	});
});

describe('bearingDeg', () => {
	it('north is 0', () => {
		expect(bearingDeg(0, 0, 1, 0)).toBeCloseTo(0);
	});
	it('east is 90', () => {
		expect(bearingDeg(0, 0, 0, 1)).toBeCloseTo(90);
	});
	it('south is 180', () => {
		expect(bearingDeg(1, 0, 0, 0)).toBeCloseTo(180);
	});
});

describe('bearingArrow', () => {
	it('maps bearings to the 8 arrows', () => {
		expect(bearingArrow(0)).toBe('↑');
		expect(bearingArrow(45)).toBe('↗');
		expect(bearingArrow(90)).toBe('→');
		expect(bearingArrow(180)).toBe('↓');
		expect(bearingArrow(270)).toBe('←');
		expect(bearingArrow(350)).toBe('↑');
	});
});

describe('formatDistance', () => {
	it('shows meters only', () => {
		expect(formatDistance(537)).toBe('537 m');
		expect(formatDistance(12345)).toBe('12345 m');
	});
});

describe('fetchClosestCategories', () => {
	it('searches wider until it finds the closest available categories', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ results: { bindings: [] } })))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				results: {
					bindings: [{
						itemLabel: { value: 'Central square' },
						cat: { value: 'Central squares in Georgia' },
						lat: { value: '41.66' },
						lon: { value: '41.64' },
					}],
				},
			})));
		vi.stubGlobal('fetch', fetchMock);

		const items = await fetchClosestCategories(41.65, 41.63);

		expect(items.map((item) => item.category)).toEqual(['Central squares in Georgia']);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const firstQuery = new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('query');
		const secondQuery = new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('query');
		expect(firstQuery).toContain('wikibase:radius "1"');
		expect(secondQuery).toContain('wikibase:radius "5"');
	});
});
