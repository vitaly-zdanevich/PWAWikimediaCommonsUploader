import { describe, expect, it } from 'vitest';
import { readJpegGps, readJpegMeta } from '../src/exif';

/** Minimal JPEG: SOI + APP1(Exif, little-endian TIFF, GPS IFD with DMS rationals). */
function buildJpeg(latRef = 'N', lonRef = 'E'): Blob {
	const tiff = new DataView(new ArrayBuffer(128));
	tiff.setUint8(0, 0x49);
	tiff.setUint8(1, 0x49);
	tiff.setUint16(2, 42, true);
	tiff.setUint32(4, 8, true);
	tiff.setUint16(8, 1, true); // IFD0: one entry, the GPS IFD pointer
	const entry = (o: number, tag: number, type: number, count: number, val: number) => {
		tiff.setUint16(o, tag, true);
		tiff.setUint16(o + 2, type, true);
		tiff.setUint32(o + 4, count, true);
		tiff.setUint32(o + 8, val, true);
	};
	entry(10, 0x8825, 4, 1, 26);
	tiff.setUint32(22, 0, true);
	tiff.setUint16(26, 4, true); // GPS IFD: 4 entries
	entry(28, 0x0001, 2, 2, 0);
	tiff.setUint8(36, latRef.charCodeAt(0));
	entry(40, 0x0002, 5, 3, 80);
	entry(52, 0x0003, 2, 2, 0);
	tiff.setUint8(60, lonRef.charCodeAt(0));
	entry(64, 0x0004, 5, 3, 104);
	tiff.setUint32(76, 0, true);
	const rat = (o: number, n: number, d: number) => {
		tiff.setUint32(o, n, true);
		tiff.setUint32(o + 4, d, true);
	};
	rat(80, 41, 1); // 41° 39' 0" = 41.65
	rat(88, 39, 1);
	rat(96, 0, 1);
	rat(104, 41, 1); // 41° 37' 48" = 41.63
	rat(112, 37, 1);
	rat(120, 48, 1);
	const head = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 136, 0x45, 0x78, 0x69, 0x66, 0, 0]);
	return new Blob([head, new Uint8Array(tiff.buffer)]);
}

describe('readJpegGps', () => {
	it('reads DMS coordinates from EXIF', async () => {
		const gps = await readJpegGps(buildJpeg());
		expect(gps).not.toBeNull();
		expect(gps?.lat).toBeCloseTo(41.65, 4);
		expect(gps?.lon).toBeCloseTo(41.63, 4);
	});

	it('applies S/W as negative', async () => {
		const gps = await readJpegGps(buildJpeg('S', 'W'));
		expect(gps?.lat).toBeCloseTo(-41.65, 4);
		expect(gps?.lon).toBeCloseTo(-41.63, 4);
	});

	it('returns null for non-JPEG data', async () => {
		expect(await readJpegGps(new Blob(['not a jpeg at all']))).toBeNull();
	});

	it('returns null for a JPEG without EXIF', async () => {
		expect(await readJpegGps(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]))).toBeNull();
	});
});

/** Like buildJpeg, plus IFD0 Model and an Exif IFD with DateTimeOriginal. */
function buildJpegWithMetadata(): Blob {
	const tiff = new DataView(new ArrayBuffer(208));
	const ascii = (off: number, s: string) => {
		for (let i = 0; i < s.length; i++) tiff.setUint8(off + i, s.charCodeAt(i));
	};
	const entry = (o: number, tag: number, type: number, count: number, val: number) => {
		tiff.setUint16(o, tag, true);
		tiff.setUint16(o + 2, type, true);
		tiff.setUint32(o + 4, count, true);
		tiff.setUint32(o + 8, val, true);
	};
	const rat = (o: number, n: number, d: number) => {
		tiff.setUint32(o, n, true);
		tiff.setUint32(o + 4, d, true);
	};
	ascii(0, 'II');
	tiff.setUint16(2, 42, true);
	tiff.setUint32(4, 8, true);
	tiff.setUint16(8, 3, true); // IFD0: Model, Exif IFD, GPS IFD
	entry(10, 0x0110, 2, 14, 50);
	entry(22, 0x8769, 4, 1, 64);
	entry(34, 0x8825, 4, 1, 104);
	tiff.setUint32(46, 0, true);
	ascii(50, 'iPhone 7 Plus\0');
	tiff.setUint16(64, 1, true); // Exif IFD
	entry(66, 0x9003, 2, 20, 82);
	tiff.setUint32(78, 0, true);
	ascii(82, '2026:07:11 15:04:05\0');
	tiff.setUint16(104, 4, true); // GPS IFD
	entry(106, 0x0001, 2, 2, 0);
	tiff.setUint8(114, 'N'.charCodeAt(0));
	entry(118, 0x0002, 5, 3, 158);
	entry(130, 0x0003, 2, 2, 0);
	tiff.setUint8(138, 'E'.charCodeAt(0));
	entry(142, 0x0004, 5, 3, 182);
	tiff.setUint32(154, 0, true);
	rat(158, 41, 1);
	rat(166, 39, 1);
	rat(174, 0, 1);
	rat(182, 41, 1);
	rat(190, 37, 1);
	rat(198, 48, 1);
	const head = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 216, 0x45, 0x78, 0x69, 0x66, 0, 0]);
	return new Blob([head, new Uint8Array(tiff.buffer)]);
}

describe('readJpegMeta', () => {
	it('reads GPS, camera model and capture time together', async () => {
		const meta = await readJpegMeta(buildJpegWithMetadata());
		expect(meta?.gps?.lat).toBeCloseTo(41.65, 4);
		expect(meta?.gps?.lon).toBeCloseTo(41.63, 4);
		expect(meta?.model).toBe('iPhone 7 Plus');
		expect(meta?.takenAt).toBe(new Date(2026, 6, 11, 15, 4, 5).getTime());
	});

	it('tolerates files with GPS only', async () => {
		const meta = await readJpegMeta(buildJpeg());
		expect(meta?.gps).not.toBeNull();
		expect(meta?.model).toBeNull();
		expect(meta?.takenAt).toBeNull();
	});
});
