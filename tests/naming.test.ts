import { describe, expect, it } from 'vitest';
import { buildFinalName, needsPrefix, requiresConversion, sanitizeFileName, splitExt } from '../src/naming';

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
	it('is satisfied by a prefix or a custom name', () => {
		expect(needsPrefix('Batumi ', '', 'IMG_0001.jpg')).toBe(false);
		expect(needsPrefix('', 'Nice sunset', 'IMG_0001.jpg')).toBe(false);
	});
	it('does not apply to normal names', () => {
		expect(needsPrefix('', '', 'sunset.jpg')).toBe(false);
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
