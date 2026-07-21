import { CONVERT_EXTENSIONS } from './config';

export function splitExt(name: string): { base: string; ext: string } {
	const m = /\.([^.]+)$/.exec(name);
	if (!m || m.index === 0) return { base: name, ext: '' };
	return { base: name.slice(0, m.index), ext: m[0] };
}

export function normalizeJpegExtension(name: string): string {
	return name.replace(/\.jpeg$/i, '.jpg');
}

/** Characters MediaWiki forbids in titles are replaced with '-'. */
export function sanitizeFileName(name: string): string {
	return name
		.replace(/[#<>[\]|{}:/\\]/g, '-')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Final Commons name: prefix + (custom name | original base) + normalized original extension. */
export function buildFinalName(prefix: string, customName: string, origName: string): string {
	const { base: origBase, ext } = splitExt(normalizeJpegExtension(origName));
	let base = customName.trim() || origBase;
	const suffixes = ext.toLowerCase() === '.jpg' ? ['.jpeg', '.jpg'] : [ext.toLowerCase()];
	const includedExt = suffixes.find((suffix) => suffix && base.toLowerCase().endsWith(suffix));
	if (includedExt) base = base.slice(0, base.length - includedExt.length);
	return sanitizeFileName(prefix + base) + ext;
}

/**
 * Names the Commons title blacklist rejects, transliterated from
 * https://commons.wikimedia.org/wiki/MediaWiki:Titleblacklist ("generic file
 * names" section). Kept local to avoid a network call per file; if an edge
 * case slips through, publishing fails with the server's message and Retry
 * republishes the kept stash after a rename, so nothing is re-uploaded.
 */
const GENERIC_NAME_PATTERNS = [
	/^(mv)?i?mg[p_ -]?e?\d{3}/i, // IMG_0001, IMGP1234, IMG 0767 …, IMG_E001 (Canon, Pentax, phones)
	/^img[_ -][\da-f]{6,}$/i, // hex suffix form
	/^(dsc|dscf|dscn|dcp|pict|pxl|vid|mov|gopr|duw|cimg|sdc|pana|hpim|kimg|snv|mvc)[_ -]?\d/i,
	/^(im|ex)\d{3,}$/i, // HP Photosmart
	/^p[\da-f]\d{6}/i, // Olympus, Kodak
	/^dcim\b/i,
	/^1\d+-\d+(_img)?$/i, // Canon
	/^dc\d+[sml]$/i, // Kodak
	/^(test|scan)[\d\s]*$/i,
	/^file_\d+_/i,
	/^(whatsapp[ _-](image|video)|wechatimg|kakaotalk|picsart|inshot|robloxscreenshot)/i,
	/^(fb_img|received|screenshot)[_ -]?\d/i,
	/^win_\d{8}\b/i, // Windows camera
	/^(c360|wp)_\d/i,
	/^s-l\d+$/i, // eBay
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // UUID (iOS photo library)
	/^\d{8}[_ -]\d{6}/, // 20230101_123456
	/^\P{L}*$/u, // no letters at all — Commons' catch-all rule
];

export function isGenericName(base: string): boolean {
	return GENERIC_NAME_PATTERNS.some((re) => re.test(base.trim()));
}

/** Generic names will be rejected by Commons, so a prefix is required for them. */
export function needsPrefix(prefix: string, customName: string, origName: string): boolean {
	if (prefix.trim()) return false;
	const base = customName.trim() || splitExt(origName).base;
	return isGenericName(base);
}

export function requiresConversion(name: string): boolean {
	const ext = splitExt(name).ext.slice(1).toLowerCase();
	return CONVERT_EXTENSIONS.includes(ext);
}

const MONTHS = [
	'january', 'february', 'march', 'april', 'may', 'june',
	'july', 'august', 'september', 'october', 'november', 'december',
];

/** 46.5476 → "46_54_76" (degrees + 4 decimals in two pairs, ~11 m precision) */
function namifyCoord(v: number): string {
	const neg = v < 0 ? '-' : '';
	const a = Math.abs(v);
	let deg = Math.floor(a);
	let frac = Math.round((a - deg) * 10000);
	if (frac === 10000) {
		deg += 1;
		frac = 0;
	}
	const f = String(frac).padStart(4, '0');
	return `${neg}${deg}_${f.slice(0, 2)}_${f.slice(2)}`;
}

/** "2026july_46_54_76_to_26_55_56_iphone7plus" from EXIF position, date and model. */
export function namifyBase(lat: number, lon: number, takenAt: number, model?: string): string {
	const d = new Date(takenAt);
	const device = model ? '_' + model.toLowerCase().replace(/[^a-z0-9]+/g, '') : '';
	return `${d.getFullYear()}${MONTHS[d.getMonth()]}_${namifyCoord(lat)}_to_${namifyCoord(lon)}${device}`;
}
