import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONVERSION_URL } from '../src/config';
import { getPrefs, savePrefs } from '../src/prefs';
import { stubBrowserStorage } from './stubs';

beforeEach(() => stubBrowserStorage());

describe('conversion preferences', () => {
	it('uses the Toolforge service for a new install', () => {
		expect(getPrefs().conversionUrl).toBe(DEFAULT_CONVERSION_URL);
	});

	it('migrates the old lambdaUrl setting', () => {
		localStorage.setItem('cu_prefs', JSON.stringify({ lambdaUrl: 'https://old.example/convert' }));
		expect(getPrefs().conversionUrl).toBe('https://old.example/convert');
	});

	it('stores the renamed conversionUrl setting', () => {
		savePrefs({ conversionUrl: 'https://new.example/convert' });
		expect(getPrefs().conversionUrl).toBe('https://new.example/convert');
	});
});
