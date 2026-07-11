import { CONVERT_EXTENSIONS } from './config';

export function splitExt(name: string): { base: string; ext: string } {
	const m = /\.([^.]+)$/.exec(name);
	if (!m || m.index === 0) return { base: name, ext: '' };
	return { base: name.slice(0, m.index), ext: m[0] };
}

/** Characters MediaWiki forbids in titles are replaced with '-'. */
export function sanitizeFileName(name: string): string {
	return name
		.replace(/[#<>[\]|{}:/\\]/g, '-')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Final Commons name: prefix + (custom name | original base) + original extension. */
export function buildFinalName(prefix: string, customName: string, origName: string): string {
	const { base: origBase, ext } = splitExt(origName);
	let base = customName.trim() || origBase;
	if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, base.length - ext.length);
	return sanitizeFileName(prefix + base) + ext;
}

/**
 * Names the Commons title blacklist rejects as meaningless: camera counters,
 * UUID-style photo library names, timestamp-only names.
 */
const GENERIC_NAME_PATTERNS = [
	/^img[_ -]?e?\d/i, // IMG_0001, IMG-20200101, IMG_E0001
	/^(dsc|dscf|dscn|pict|pxl|mvimg|vid|mov|gopr|fb_img|received|whatsapp image|screenshot)[_ -]?\d/i,
	/^p\d{7}\b/i, // P1010001
	/^dcim\b/i,
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
	/^\d{8}[_ -]\d{6}/, // 20230101_123456
	/^\d+$/,
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
