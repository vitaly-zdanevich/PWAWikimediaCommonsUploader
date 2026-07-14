export interface GpsCoords {
	lat: number;
	lon: number;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

interface TagRef {
	type: number;
	count: number;
	valOff: number;
}

function findTag(view: DataView, tiffBase: number, ifdOff: number, tag: number, le: boolean): TagRef | null {
	const abs = tiffBase + ifdOff;
	if (abs + 2 > view.byteLength) return null;
	const n = view.getUint16(abs, le);
	for (let i = 0; i < n; i++) {
		const e = abs + 2 + i * 12;
		if (e + 12 > view.byteLength) return null;
		if (view.getUint16(e, le) !== tag) continue;
		const type = view.getUint16(e + 2, le);
		const count = view.getUint32(e + 4, le);
		const size = (TYPE_SIZE[type] ?? 1) * count;
		const valOff = size <= 4 ? e + 8 : tiffBase + view.getUint32(e + 8, le);
		return { type, count, valOff };
	}
	return null;
}

function rational(view: DataView, off: number, le: boolean): number {
	const den = view.getUint32(off + 4, le);
	return den ? view.getUint32(off, le) / den : 0;
}

/** degrees + minutes + seconds, stored as three rationals */
function dms(view: DataView, off: number, le: boolean): number {
	return rational(view, off, le) + rational(view, off + 8, le) / 60 + rational(view, off + 16, le) / 3600;
}

export interface JpegMeta {
	gps: GpsCoords | null;
	/** camera model, e.g. "iPhone 7 Plus" */
	model: string | null;
	/** DateTimeOriginal as epoch ms (camera local time), when present */
	takenAt: number | null;
}

function readAscii(view: DataView, off: number, count: number): string {
	let s = '';
	for (let i = 0; i < count && off + i < view.byteLength; i++) {
		const c = view.getUint8(off + i);
		if (c === 0) break;
		s += String.fromCharCode(c);
	}
	return s.trim();
}

function parseGps(view: DataView, base: number, gpsIfd: number, le: boolean): GpsCoords | null {
	const lat = findTag(view, base, gpsIfd, 0x0002, le);
	const lon = findTag(view, base, gpsIfd, 0x0004, le);
	if (!lat || !lon || lat.count < 3 || lon.count < 3) return null;
	let la = dms(view, lat.valOff, le);
	let lo = dms(view, lon.valOff, le);
	const latRef = findTag(view, base, gpsIfd, 0x0001, le);
	const lonRef = findTag(view, base, gpsIfd, 0x0003, le);
	if (latRef && view.getUint8(latRef.valOff) === 0x53) la = -la; // 'S'
	if (lonRef && view.getUint8(lonRef.valOff) === 0x57) lo = -lo; // 'W'
	if (!isFinite(la) || !isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180 || (la === 0 && lo === 0)) {
		return null;
	}
	return { lat: la, lon: lo };
}

/** "YYYY:MM:DD HH:MM:SS" in camera local time */
function parseExifDate(s: string): number | null {
	const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
	if (!m) return null;
	const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
	return isFinite(t) ? t : null;
}

function parseTiff(view: DataView, base: number): JpegMeta | null {
	if (base + 8 > view.byteLength) return null;
	const bo = view.getUint16(base);
	const le = bo === 0x4949;
	if (!le && bo !== 0x4d4d) return null;
	if (view.getUint16(base + 2, le) !== 42) return null;
	const ifd0 = view.getUint32(base + 4, le);

	const meta: JpegMeta = { gps: null, model: null, takenAt: null };

	const modelTag = findTag(view, base, ifd0, 0x0110, le);
	if (modelTag && modelTag.type === 2) meta.model = readAscii(view, modelTag.valOff, modelTag.count) || null;

	const exifPtr = findTag(view, base, ifd0, 0x8769, le);
	if (exifPtr) {
		const dateTag = findTag(view, base, view.getUint32(exifPtr.valOff, le), 0x9003, le);
		if (dateTag && dateTag.type === 2) meta.takenAt = parseExifDate(readAscii(view, dateTag.valOff, dateTag.count));
	}

	const gpsPtr = findTag(view, base, ifd0, 0x8825, le);
	if (gpsPtr) meta.gps = parseGps(view, base, view.getUint32(gpsPtr.valOff, le), le);

	return meta;
}

/** GPS/model/date from a JPEG's EXIF APP1 segment. Reads only the file head. */
export async function readJpegMeta(file: Blob): Promise<JpegMeta | null> {
	try {
		const view = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
		if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
		let off = 2;
		while (off + 4 <= view.byteLength) {
			const marker = view.getUint16(off);
			if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break; // corrupt or image data
			const size = view.getUint16(off + 2);
			if (size < 2) break;
			if (
				marker === 0xffe1 &&
				off + 10 <= view.byteLength &&
				view.getUint32(off + 4) === 0x45786966 && // 'Exif'
				view.getUint16(off + 8) === 0
			) {
				return parseTiff(view, off + 10);
			}
			off += 2 + size;
		}
	} catch {
		// unreadable or truncated file
	}
	return null;
}

export async function readJpegGps(file: Blob): Promise<GpsCoords | null> {
	return (await readJpegMeta(file))?.gps ?? null;
}
