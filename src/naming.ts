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

/** Camera names like IMG_1234 are meaningless on Commons, so a prefix is required. */
export function needsPrefix(prefix: string, customName: string, origName: string): boolean {
	const effectiveBase = customName.trim() || origName;
	return /^img_/i.test(effectiveBase) && prefix.trim() === '';
}

export function requiresConversion(name: string): boolean {
	const ext = splitExt(name).ext.slice(1).toLowerCase();
	return CONVERT_EXTENSIONS.includes(ext);
}
