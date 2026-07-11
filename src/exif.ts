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

function parseTiffGps(view: DataView, base: number): GpsCoords | null {
	if (base + 8 > view.byteLength) return null;
	const bo = view.getUint16(base);
	const le = bo === 0x4949;
	if (!le && bo !== 0x4d4d) return null;
	if (view.getUint16(base + 2, le) !== 42) return null;
	const gpsPtr = findTag(view, base, view.getUint32(base + 4, le), 0x8825, le);
	if (!gpsPtr) return null;
	const gpsIfd = view.getUint32(gpsPtr.valOff, le);
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

/** GPS position from a JPEG's EXIF APP1 segment, or null. Reads only the file head. */
export async function readJpegGps(file: Blob): Promise<GpsCoords | null> {
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
				return parseTiffGps(view, off + 10);
			}
			off += 2 + size;
		}
	} catch {
		// unreadable or truncated file
	}
	return null;
}
