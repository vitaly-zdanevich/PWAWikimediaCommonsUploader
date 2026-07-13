import { vi } from 'vitest';

/** node has no Web Storage; prefs/oauth need these two. */
export function stubBrowserStorage(): void {
	const make = () => {
		const m = new Map<string, string>();
		return {
			getItem: (k: string) => m.get(k) ?? null,
			setItem: (k: string, v: string) => void m.set(k, String(v)),
			removeItem: (k: string) => void m.delete(k),
			clear: () => m.clear(),
		};
	};
	vi.stubGlobal('localStorage', make());
	vi.stubGlobal('sessionStorage', make());
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	});
}
