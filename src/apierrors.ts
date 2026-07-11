import type { EntryLink } from './types';

export class ApiError extends Error {
	constructor(
		public code: string,
		public info: string,
	) {
		super(`${code}: ${info}`);
	}
}

export class RateLimitError extends Error {
	constructor(public retryAfterSec: number) {
		super('Rate limited by Wikimedia Commons (HTTP 429)');
	}
}

export function filePageUrl(fileName: string): string {
	return 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(fileName.replace(/ /g, '_'));
}

export interface WarningResult {
	message: string;
	links: EntryLink[];
}

/** Turns action=upload `warnings` into a readable message plus links to the conflicting files. */
export function describeUploadWarnings(warnings: Record<string, unknown>): WarningResult {
	const parts: string[] = [];
	const links: EntryLink[] = [];
	const addFile = (name: unknown) => {
		if (typeof name === 'string' && name) links.push({ text: name, href: filePageUrl(name) });
	};

	for (const [key, value] of Object.entries(warnings)) {
		switch (key) {
			case 'exists':
			case 'exists-normalized':
				parts.push('A file with this name already exists. Please rename your file and retry.');
				addFile(value);
				break;
			case 'page-exists':
				parts.push('A page with this name already exists. Please rename your file and retry.');
				addFile(value);
				break;
			case 'was-deleted':
				parts.push('A file with this name was previously deleted.');
				addFile(value);
				break;
			case 'badfilename':
				parts.push(`The file name is not allowed; suggested: ${String(value)}.`);
				break;
			case 'duplicate': {
				parts.push('An identical file (same SHA1) already exists.');
				for (const name of Array.isArray(value) ? value : [value]) addFile(name);
				break;
			}
			case 'duplicate-archive':
				parts.push('An identical file (same SHA1) was previously deleted.');
				addFile(value);
				break;
			case 'duplicateversions':
				parts.push('This file is identical to an old version of an existing file.');
				break;
			case 'nochange':
				parts.push('The file is identical to the current version.');
				break;
			default:
				parts.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
		}
	}
	return { message: parts.join(' ') || 'Upload warning', links };
}
