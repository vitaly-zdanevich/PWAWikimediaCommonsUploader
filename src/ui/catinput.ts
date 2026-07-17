import { searchCategories } from '../api';
import { COMMONS_WIKI } from '../config';
import { getPrefs } from '../prefs';
import { normalizeCategory } from '../wikitext';
import { clear, el } from './dom';

export function categoryUrl(cat: string): string {
	return COMMONS_WIKI + 'Category:' + encodeURIComponent(cat.replace(/ /g, '_'));
}

export interface CatInput {
	root: HTMLElement;
	refresh(): void;
	commit(): void;
}

/**
 * Chip list + text input with autocompletion (saved categories first, then
 * Commons prefix search). Clicking a chip opens the category page.
 */
export function createCatInput(o: {
	get: () => string[];
	set: (next: string[]) => void;
	placeholder?: string;
}): CatInput {
	const chips = el('span', { class: 'chips' });
	const input = el('input', {
		type: 'text',
		placeholder: o.placeholder ?? 'Add category…',
		autocapitalize: 'off',
		autocomplete: 'off',
		spellcheck: 'false',
	});
	const drop = el('div', { class: 'dropdown', hidden: true });
	const root = el('div', { class: 'catinput' }, chips, el('div', { class: 'dropwrap' }, input, drop));

	const has = (c: string) => o.get().some((x) => x.toLowerCase() === c.toLowerCase());

	function refresh(): void {
		clear(chips);
		for (const c of o.get()) {
			chips.append(
				el(
					'span',
					{ class: 'chip' },
					el('a', { href: categoryUrl(c), target: '_blank', rel: 'noopener' }, c),
					el('button', { type: 'button', class: 'x', 'aria-label': `Remove ${c}`, onclick: () => {
						o.set(o.get().filter((x) => x !== c));
						refresh();
					} }, '×'),
				),
			);
		}
	}

	function hide(): void {
		drop.hidden = true;
	}

	function add(raw: string): void {
		const c = normalizeCategory(raw);
		if (c && !has(c)) o.set([...o.get(), c]);
		input.value = '';
		hide();
		refresh();
	}

	function commit(): void {
		if (normalizeCategory(input.value)) add(input.value);
		else hide();
	}

	let reqSeq = 0;
	let timer = 0;

	async function suggest(): Promise<void> {
		const mySeq = ++reqSeq;
		const q = normalizeCategory(input.value).toLowerCase();
		const merged: string[] = [];
		const seen = new Set<string>();
		const push = (c: string) => {
			const k = c.toLowerCase();
			if (!k || seen.has(k) || has(c)) return;
			seen.add(k);
			merged.push(c);
		};
		let searchFailed = false;
		for (const c of getPrefs().categories) if (!q || c.toLowerCase().includes(q)) push(c);
		if (q.length >= 2) {
			try {
				for (const c of await searchCategories(input.value)) push(c);
			} catch {
				searchFailed = true; // offline or rate-limited: history suggestions only
			}
			if (mySeq !== reqSeq) return;
		}
		clear(drop);
		for (const c of merged.slice(0, 10)) {
			drop.append(
				el('button', {
					type: 'button',
					class: 'dropitem',
					onpointerdown: (ev: Event) => {
						ev.preventDefault();
						add(c);
					},
					onmousedown: (ev: Event) => ev.preventDefault(),
					onclick: () => add(c),
				}, c),
			);
		}
		if (searchFailed) drop.append(el('div', { class: 'dropnote muted' }, 'Commons search unavailable (offline or rate-limited)'));
		drop.hidden = merged.length === 0 && !searchFailed;
	}

	input.addEventListener('input', () => {
		clearTimeout(timer);
		timer = window.setTimeout(() => void suggest(), 250);
	});
	input.addEventListener('focus', () => void suggest());
	input.addEventListener('blur', commit);
	input.addEventListener('keydown', (ev) => {
		if (ev.key === 'Enter') {
			ev.preventDefault();
			commit();
		} else if (ev.key === 'Escape') {
			hide();
		}
	});

	refresh();
	return { root, refresh, commit };
}
