import { describe, expect, it } from 'vitest';
import { ApiError, describeUploadWarnings, filePageUrl } from '../src/apierrors';

describe('filePageUrl', () => {
	it('links to the file page with underscores', () => {
		expect(filePageUrl('My photo.jpg')).toBe('https://commons.wikimedia.org/wiki/File:My_photo.jpg');
	});
});

describe('describeUploadWarnings', () => {
	it('describes a taken file name and links to it', () => {
		const w = describeUploadWarnings({ exists: 'Taken.jpg' });
		expect(w.message).toContain('already exists');
		expect(w.message).toContain('rename');
		expect(w.links).toEqual([{ text: 'Taken.jpg', href: filePageUrl('Taken.jpg') }]);
	});

	it('describes SHA1 duplicates with links to each file', () => {
		const w = describeUploadWarnings({ duplicate: ['A.jpg', 'B.jpg'] });
		expect(w.message).toContain('SHA1');
		expect(w.links.map((l) => l.text)).toEqual(['A.jpg', 'B.jpg']);
	});

	it('stringifies unknown warnings', () => {
		const w = describeUploadWarnings({ 'something-new': { x: 1 } });
		expect(w.message).toContain('something-new');
		expect(w.message).toContain('{"x":1}');
	});
});

describe('ApiError', () => {
	it('keeps code and info', () => {
		const e = new ApiError('badtoken', 'Invalid CSRF token.');
		expect(e.code).toBe('badtoken');
		expect(e.message).toBe('badtoken: Invalid CSRF token.');
	});
});
