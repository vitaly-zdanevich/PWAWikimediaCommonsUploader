import { fetchNearbyCategories, formatDistance, type NearbyCategory } from '../geo';
import { buildFinalName, namifyBase, needsPrefix } from '../naming';
import { rerender } from './app';
import { getActiveAccount, getPrefs } from '../prefs';
import { NAMIFY_CATEGORY } from '../config';
import {
	addFiles,
	clearFinished,
	doneEntries,
	entries,
	isRunning,
	removeEntry,
	retryEntry,
	startUploads,
} from '../queue';
import type { Entry } from '../types';
import { LICENSES } from '../wikitext';
import { createCatInput } from './catinput';
import { clear, el } from './dom';
import { openNearby } from './nearby';

let prefix = '';
let globalCats: string[] = [];

// categories near the photos' EXIF position, proposed as one-tap chips
let exifSuggestions: NearbyCategory[] = [];
let exifSuggKey = '';
let suggRow: HTMLElement | null = null;
let catInputRef: { refresh(): void } | null = null;

function firstGpsEntry(): Entry | undefined {
	return entries.find((e) => e.lat !== undefined && e.lon !== undefined);
}

function addGlobalCat(c: string): void {
	if (!globalCats.some((x) => x.toLowerCase() === c.toLowerCase())) globalCats = [...globalCats, c];
	catInputRef?.refresh();
}

function renderSuggRow(): void {
	if (!suggRow) return;
	clear(suggRow);
	const items = exifSuggestions
		.filter((s) => !globalCats.some((c) => c.toLowerCase() === s.category.toLowerCase()))
		.slice(0, 6);
	suggRow.hidden = items.length === 0;
	if (!items.length) return;
	suggRow.append(el('span', { class: 'muted' }, 'Near photo: '));
	for (const s of items) {
		suggRow.append(
			el('button', { type: 'button', class: 'sugg', title: formatDistance(s.distanceM), onclick: () => {
				addGlobalCat(s.category);
				renderSuggRow();
			} }, s.category),
		);
	}
}

async function refreshExifSuggestions(): Promise<void> {
	const e = firstGpsEntry();
	if (!e || e.lat === undefined || e.lon === undefined) {
		exifSuggestions = [];
		exifSuggKey = '';
		renderSuggRow();
		return;
	}
	const key = `${e.lat.toFixed(5)},${e.lon.toFixed(5)}`;
	if (key === exifSuggKey) {
		renderSuggRow();
		return;
	}
	exifSuggKey = key;
	try {
		exifSuggestions = await fetchNearbyCategories(e.lat, e.lon, 1);
	} catch {
		exifSuggestions = [];
	}
	renderSuggRow();
}

interface RowRefs {
	status: HTMLElement;
	name: HTMLElement;
	err: HTMLElement;
}

const rowRefs = new Map<string, RowRefs>();
const thumbUrls = new Map<string, string>();
let copyBar: HTMLElement | null = null;
let uploadBtn: HTMLButtonElement | null = null;
let validation: HTMLElement | null = null;

function statusText(e: Entry): string {
	switch (e.status) {
		case 'new': return '·';
		case 'pending': return e.progressText ? `🕓 ${e.progressText}` : '🕓';
		case 'uploading': return `⏳ ${e.progressText ?? ''}`;
		case 'done': return '✅';
		case 'error': return '❌';
	}
}

function displayName(e: Entry): string {
	// error rows preview with the live prefix — that is what Retry will upload
	if (e.status !== 'error' && e.finalName) return e.finalName;
	return buildFinalName(prefix, e.customName, e.origName);
}

function setName(refs: RowRefs, e: Entry): void {
	clear(refs.name);
	if (e.pageUrl) refs.name.append(el('a', { href: e.pageUrl, target: '_blank', rel: 'noopener' }, displayName(e)));
	else refs.name.append(displayName(e));
}

function setError(refs: RowRefs, e: Entry): void {
	clear(refs.err);
	refs.err.hidden = !e.error;
	if (!e.error) return;
	refs.err.append(e.error);
	for (const l of e.errorLinks ?? []) refs.err.append(' ', el('a', { href: l.href, target: '_blank', rel: 'noopener' }, l.text));
	refs.err.append(' ', el('button', { type: 'button', class: 'btn small', onclick: () => {
		if (needsPrefix(prefix, e.customName, e.origName)) {
			if (validation) {
				validation.textContent = `A file name prefix is required for: ${e.origName}`;
				validation.hidden = false;
			}
			return;
		}
		if (validation) validation.hidden = true;
		retryEntry(e.id, { prefix, globalCats });
	} }, 'Retry'));
}

function fmtSize(bytes: number): string {
	return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function refreshCopyBar(): void {
	if (copyBar) copyBar.hidden = doneEntries().length === 0;
}

let runningNote: HTMLElement | null = null;

function refreshUploadBtn(): void {
	if (!uploadBtn) return;
	const n = entries.filter((e) => e.status === 'new').length;
	uploadBtn.disabled = n === 0;
	uploadBtn.textContent = isRunning() && n === 0 ? 'Uploading…' : `⬆️ Upload ${n} file${n === 1 ? '' : 's'}`;
	if (runningNote) runningNote.hidden = !isRunning();
}

/** Patches one row in place (status/name/error), so typing elsewhere is not disturbed. */
export function patchEntry(e: Entry): void {
	const refs = rowRefs.get(e.id);
	if (!refs) return;
	refs.status.textContent = statusText(e);
	setName(refs, e);
	setError(refs, e);
	refreshCopyBar();
	refreshUploadBtn();
}

function copyButton(label: string, getText: () => string): HTMLButtonElement {
	const b = el('button', { type: 'button', class: 'btn' }, label);
	b.addEventListener('click', () => {
		void navigator.clipboard.writeText(getText()).then(() => {
			b.textContent = '✓ Copied';
			setTimeout(() => (b.textContent = label), 1500);
		});
	});
	return b;
}

function renderRow(e: Entry): HTMLElement {
	const prefs = getPrefs();
	const status = el('span', { class: 'st' }, statusText(e));
	const name = el('span', { class: 'fname' });
	const err = el('div', { class: 'err', hidden: true });
	const refs: RowRefs = { status, name, err };
	rowRefs.set(e.id, refs);
	setName(refs, e);
	setError(refs, e);

	const details = el('div', { class: 'details', hidden: true });
	const licSel = el('select', { onchange: () => (e.license = licSel.value as Entry['license']) });
	licSel.append(el('option', { value: '' }, `Default license (${LICENSES.find((l) => l.id === prefs.defaultLicense)?.label})`));
	for (const l of LICENSES) licSel.append(el('option', { value: l.id, selected: l.id === e.license }, l.label));
	const perFileCats = createCatInput({
		get: () => e.categories,
		set: (n) => (e.categories = n),
		placeholder: 'Extra category for this file…',
	});
	details.append(
		el('input', {
			type: 'text',
			value: e.customName,
			placeholder: 'File name (extension is kept)',
			oninput: (ev: Event) => {
				e.customName = (ev.target as HTMLInputElement).value;
				setName(refs, e);
			},
		}),
		el('textarea', {
			rows: '3',
			placeholder: 'Description…',
			oninput: (ev: Event) => (e.description = (ev.target as HTMLTextAreaElement).value),
		}, e.description),
		licSel,
		perFileCats.root,
	);

	let thumb: HTMLElement | null = null;
	if (prefs.showThumbs && e.file && e.file.type.startsWith('image/')) {
		let u = thumbUrls.get(e.id);
		if (!u) {
			u = URL.createObjectURL(e.file);
			thumbUrls.set(e.id, u);
		}
		thumb = el('img', { class: 'thumb', src: u, alt: '', loading: 'lazy' });
	}

	return el(
		'li',
		{ class: 'file-row' },
		thumb,
		el(
			'div',
			{ class: 'rowline' },
			status,
			name,
			el('span', { class: 'muted size' }, fmtSize(e.size)),
			e.viaLambda ? el('span', { class: 'badge', title: 'Not supported by Commons; sent via conversion endpoint' }, 'convert') : null,
			el('button', { type: 'button', class: 'btn small', 'aria-label': 'Edit details', onclick: () => (details.hidden = !details.hidden) }, '✎'),
			e.status === 'uploading'
				? null
				: el('button', { type: 'button', class: 'btn small', 'aria-label': 'Remove', onclick: () => {
						const u = thumbUrls.get(e.id);
						if (u) {
							URL.revokeObjectURL(u);
							thumbUrls.delete(e.id);
						}
						removeEntry(e.id);
					} }, '×'),
		),
		err,
		details,
	);
}

export function renderFiles(): HTMLElement {
	rowRefs.clear();
	const prefs = getPrefs();

	const onPick = (ev: Event) => {
		const t = ev.target as HTMLInputElement;
		if (t.files?.length) addFiles(t.files);
		t.value = '';
	};
	const filesInput = el('input', { type: 'file', multiple: true, accept: 'image/*,video/*', hidden: true, onchange: onPick });
	const photoInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: onPick });
	const videoInput = el('input', { type: 'file', accept: 'video/*', capture: 'environment', hidden: true, onchange: onPick });

	const prefixInput = el('input', {
		type: 'text',
		value: prefix,
		list: 'cu-prefixes',
		placeholder: 'File name prefix (required for IMG_*)…',
		autocapitalize: 'off',
		oninput: () => {
			prefix = prefixInput.value;
			for (const e of entries) {
				const refs = rowRefs.get(e.id);
				if (refs && (e.status === 'new' || e.status === 'pending' || e.status === 'error')) setName(refs, e);
			}
		},
	});

	const catInput = createCatInput({
		get: () => globalCats,
		set: (n) => {
			globalCats = n;
			renderSuggRow();
		},
		placeholder: 'Category for all files…',
	});
	catInputRef = catInput;
	suggRow = el('div', { class: 'suggrow', hidden: true });
	renderSuggRow();
	void refreshExifSuggestions();

	validation = el('p', { class: 'err', hidden: true });

	// iOS PWAs cannot be share-sheet targets, so Photos → Copy → Paste is the route there
	const pasteFromClipboard = async () => {
		try {
			const items = await navigator.clipboard.read();
			const files: File[] = [];
			for (const it of items) {
				const type = it.types.find((t) => t.startsWith('image/') || t.startsWith('video/'));
				if (!type) continue;
				const blob = await it.getType(type);
				const ext = type.split('/')[1].replace('jpeg', 'jpg').replace('quicktime', 'mov');
				const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-');
				files.push(new File([blob], `Pasted ${stamp}.${ext}`, { type }));
			}
			if (files.length) {
				addFiles(files);
			} else if (validation) {
				validation.textContent = 'No image or video in the clipboard.';
				validation.hidden = false;
			}
		} catch {
			if (validation) {
				validation.textContent = 'Clipboard access was not allowed.';
				validation.hidden = false;
			}
		}
	};

	// name every GPS-tagged file as <year><month>_<lat>_to_<lon>_<device>
	const NAMIFY_NOTE = 'Feel free to rename to something more descriptive.';
	const namify = () => {
		const withGps = entries.filter((e) => e.status === 'new' && e.lat !== undefined && e.lon !== undefined);
		if (!withGps.length) {
			if (validation) {
				validation.textContent = 'No files with GPS coordinates to rename.';
				validation.hidden = false;
			}
			return;
		}
		const used = new Map<string, number>();
		for (const e of withGps) {
			let base = namifyBase(e.lat ?? 0, e.lon ?? 0, e.exifTakenAt ?? e.lastModified, e.exifModel);
			const n = (used.get(base) ?? 0) + 1;
			used.set(base, n);
			if (n > 1) base = `${base}_${n}`;
			e.customName = base;
			if (!e.description.includes(NAMIFY_NOTE)) {
				e.description = e.description ? `${e.description}\n${NAMIFY_NOTE}` : NAMIFY_NOTE;
			}
			if (!e.categories.some((c) => c.toLowerCase() === NAMIFY_CATEGORY.toLowerCase())) {
				e.categories = [...e.categories, NAMIFY_CATEGORY];
			}
		}
		rerender(); // rebuild rows so the per-file name/description fields show the new values
		const skipped = entries.filter((e) => e.status === 'new' && e.lat === undefined).length;
		if (validation && skipped) {
			validation.textContent = `${skipped} file${skipped === 1 ? ' has' : 's have'} no GPS coordinates and kept the original name.`;
			validation.hidden = false;
		}
	};

	const onUpload = () => {
		if (!validation) return;
		const fresh = entries.filter((e) => e.status === 'new');
		const missing = fresh.filter((e) => needsPrefix(prefix, e.customName, e.origName));
		if (missing.length) {
			validation.textContent = `A file name prefix is required for: ${missing.map((m) => m.origName).join(', ')}`;
			validation.hidden = false;
			return;
		}
		const acc = getActiveAccount();
		if (!acc) {
			validation.textContent = 'Please sign in first.';
			validation.hidden = false;
			return;
		}
		validation.hidden = true;
		startUploads(acc.username, prefix, globalCats);
	};

	uploadBtn = el('button', { type: 'button', class: 'btn primary wide' }, '');
	uploadBtn.addEventListener('click', onUpload);
	runningNote = el('p', { class: 'muted', hidden: true },
		'The screen is kept awake while uploading. If iOS still pauses it (lock button, app switch), reopen the app — it continues from the same place.');

	copyBar = el(
		'div',
		{ class: 'copybar' },
		copyButton('Copy direct URLs', () => doneEntries().map((e) => e.fileUrl).filter(Boolean).join('\n')),
		copyButton('Copy page URLs', () => doneEntries().map((e) => e.pageUrl).filter(Boolean).join('\n')),
		el('button', { type: 'button', class: 'btn', onclick: clearFinished }, 'Clear finished'),
	);
	refreshCopyBar();
	refreshUploadBtn();

	return el(
		'section',
		{},
		el(
			'div',
			{ class: 'pickers' },
			el('button', { type: 'button', class: 'btn', onclick: () => filesInput.click() }, '📁 Select files'),
			el('button', { type: 'button', class: 'btn', onclick: () => photoInput.click() }, '📷 Photo'),
			el('button', { type: 'button', class: 'btn', onclick: () => videoInput.click() }, '🎥 Video'),
			el('button', { type: 'button', class: 'btn', onclick: () => void pasteFromClipboard() }, '📋 Paste'),
			el('button', { type: 'button', class: 'btn', title: 'Name GPS-tagged files by date, coordinates and camera', onclick: namify }, '✨ Namify'),
			filesInput,
			photoInput,
			videoInput,
		),
		el('label', { class: 'field' }, 'Prefix', prefixInput),
		el('datalist', { id: 'cu-prefixes' }, ...prefs.prefixes.map((p) => el('option', { value: p }))),
		el(
			'label',
			{ class: 'field' },
			'Categories',
			catInput.root,
			el('button', { type: 'button', class: 'btn small', onclick: () => {
				const gps = firstGpsEntry();
				openNearby({
					has: (c) => globalCats.some((x) => x.toLowerCase() === c.toLowerCase()),
					add: (c) => {
						addGlobalCat(c);
						renderSuggRow();
					},
					remove: (c) => {
						globalCats = globalCats.filter((x) => x.toLowerCase() !== c.toLowerCase());
						catInputRef?.refresh();
						renderSuggRow();
					},
					coords: gps && gps.lat !== undefined && gps.lon !== undefined ? { lat: gps.lat, lon: gps.lon } : undefined,
				});
			} }, '📍 Nearby'),
		),
		suggRow,
		validation,
		el('ul', { class: 'filelist' }, ...entries.map(renderRow)),
		uploadBtn,
		runningNote,
		copyBar,
	);
}
