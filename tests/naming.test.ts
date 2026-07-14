import { describe, expect, it } from 'vitest';
import { buildFinalName, namifyBase, needsPrefix, requiresConversion, sanitizeFileName, splitExt } from '../src/naming';

describe('splitExt', () => {
	it('splits a normal extension', () => {
		expect(splitExt('IMG_0001.jpg')).toEqual({ base: 'IMG_0001', ext: '.jpg' });
	});
	it('handles no extension and dotfiles', () => {
		expect(splitExt('README')).toEqual({ base: 'README', ext: '' });
		expect(splitExt('.hidden')).toEqual({ base: '.hidden', ext: '' });
	});
});

describe('buildFinalName', () => {
	it('joins prefix, base and extension', () => {
		expect(buildFinalName('Batumi beach ', '', 'IMG_1.jpg')).toBe('Batumi beach IMG_1.jpg');
	});
	it('uses the custom name and keeps the original extension', () => {
		expect(buildFinalName('', 'Sunset over sea', 'IMG_1.jpg')).toBe('Sunset over sea.jpg');
	});
	it('does not double the extension when the custom name includes it', () => {
		expect(buildFinalName('', 'Sunset.JPG', 'a.jpg')).toBe('Sunset.jpg');
	});
	it('replaces characters MediaWiki forbids', () => {
		expect(buildFinalName('', 'a:b/c#d', 'x.png')).toBe('a-b-c-d.png');
	});
});

describe('needsPrefix', () => {
	it('requires a prefix for IMG_ files', () => {
		expect(needsPrefix('', '', 'IMG_0001.jpg')).toBe(true);
		expect(needsPrefix('', '', 'img_0001.jpg')).toBe(true);
	});
	it('requires a prefix for other generic names Commons rejects', () => {
		expect(needsPrefix('', '', '05998DD7-852F-40BF-BCE9-EB6BB9AD7D1B.jpeg')).toBe(true);
		expect(needsPrefix('', '', 'DSC_0042.JPG')).toBe(true);
		expect(needsPrefix('', '', 'PXL_20230101_123456789.jpg')).toBe(true);
		expect(needsPrefix('', '', 'P1010001.jpg')).toBe(true);
		expect(needsPrefix('', '', '20230101_123456.jpg')).toBe(true);
		expect(needsPrefix('', '', '12345678.jpg')).toBe(true);
		expect(needsPrefix('', '', 'Screenshot 2023-01-01.png')).toBe(true);
	});
	it('is satisfied by a prefix or a descriptive custom name', () => {
		expect(needsPrefix('Batumi ', '', 'IMG_0001.jpg')).toBe(false);
		expect(needsPrefix('', 'Nice sunset', 'IMG_0001.jpg')).toBe(false);
		expect(needsPrefix('Batumi ', '', '05998DD7-852F-40BF-BCE9-EB6BB9AD7D1B.jpeg')).toBe(false);
	});
	it('still applies when the custom name itself is generic', () => {
		expect(needsPrefix('', 'IMG_9999', 'photo.jpg')).toBe(true);
	});
	it('does not apply to descriptive names', () => {
		expect(needsPrefix('', '', 'sunset.jpg')).toBe(false);
		expect(needsPrefix('', '', 'Batumi boulevard at night.jpg')).toBe(false);
		expect(needsPrefix('', '', '2023 Batumi flowers.jpg')).toBe(false);
	});
});

describe('requiresConversion', () => {
	it('routes HEIC and H.264/H.265 containers to the conversion endpoint', () => {
		expect(requiresConversion('a.heic')).toBe(true);
		expect(requiresConversion('a.MOV')).toBe(true);
		expect(requiresConversion('a.mp4')).toBe(true);
	});
	it('keeps Commons-supported formats direct', () => {
		expect(requiresConversion('a.jpg')).toBe(false);
		expect(requiresConversion('a.webm')).toBe(false);
		expect(requiresConversion('a.png')).toBe(false);
	});
});

describe('sanitizeFileName', () => {
	it('collapses whitespace', () => {
		expect(sanitizeFileName('  a   b  ')).toBe('a b');
	});
});

describe('namifyBase', () => {
	const july = new Date(2026, 6, 11, 15, 0, 0).getTime();

	it('builds year+month, paired coordinate digits and the device', () => {
		expect(namifyBase(46.5476, 26.5556, july, 'iPhone 7 Plus')).toBe(
			'2026july_46_54_76_to_26_55_56_iphone7plus',
		);
	});

	it('pads short fractions and works without a device', () => {
		expect(namifyBase(41.65, 41.6301, july)).toBe('2026july_41_65_00_to_41_63_01');
	});

	it('carries over when the fraction rounds to the next degree', () => {
		expect(namifyBase(41.99999, 41.5, july)).toBe('2026july_42_00_00_to_41_50_00');
	});

	it('keeps the sign for southern/western coordinates', () => {
		expect(namifyBase(-33.8688, -70.6693, july)).toBe('2026july_-33_86_88_to_-70_66_93');
	});

	it('produces names that do not trigger the generic-name prefix rule', () => {
		expect(needsPrefix('', namifyBase(46.5476, 26.5556, july, 'iPhone 7 Plus'), 'IMG_1.jpg')).toBe(false);
	});
});
