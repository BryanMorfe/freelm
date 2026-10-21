/**
 * Copy JSON-shaped data with JSON's omission/null rules without ever combining its
 * strings. Large inline media remains an immutable string, rather than being
 * flattened into a second workspace-sized string by stringify/parse.
 *
 * The optional cache is for immutable renderer state only. Its weak keys allow
 * removed chats/media to be collected and preserve unchanged nested records.
 */
export function normalizeJson<T>(value: T, cache?: WeakMap<object, unknown>): T {
	const stack = new Set<object>();
	const omit = Symbol('omitted JSON value');
	function visit(raw: unknown, key: string, depth: number): unknown {
		if (depth > 1000) throw new Error('Workspace data is nested too deeply.');
		let item = raw;
		if (item && typeof item === 'object') {
			const candidate = item as { toJSON?: (key: string) => unknown };
			if (typeof candidate.toJSON === 'function') item = candidate.toJSON(key);
		}
		if (item instanceof Number || item instanceof String || item instanceof Boolean)
			item = item.valueOf();
		if (
			item &&
			typeof item === 'object' &&
			Object.prototype.toString.call(item) === '[object BigInt]'
		)
			throw new TypeError('Cannot save BigInt workspace data.');
		if (item === undefined || typeof item === 'function' || typeof item === 'symbol') return omit;
		if (typeof item === 'bigint') throw new TypeError('Cannot save BigInt workspace data.');
		if (typeof item === 'number') return Number.isFinite(item) ? (item === 0 ? 0 : item) : null;
		if (item === null || typeof item !== 'object') return item;
		if (stack.has(item)) throw new Error('Cannot save circular workspace data.');
		if (cache?.has(item)) return cache.get(item);
		stack.add(item);
		const copy: unknown[] | Record<string, unknown> = Array.isArray(item) ? [] : {};
		if (Array.isArray(item)) {
			for (let index = 0; index < item.length; index++) {
				const normalized = visit(item[index], String(index), depth + 1);
				(copy as unknown[]).push(normalized === omit ? null : normalized);
			}
		} else {
			for (const name of Object.keys(item)) {
				const normalized = visit((item as Record<string, unknown>)[name], name, depth + 1);
				if (normalized === omit) continue;
				// __proto__ is ordinary data in JSON, never a prototype assignment.
				Object.defineProperty(copy, name, {
					value: normalized,
					writable: true,
					enumerable: true,
					configurable: true,
				});
			}
		}
		stack.delete(item);
		cache?.set(item, copy);
		return copy;
	}
	const result = visit(value, '', 0);
	return (result === omit ? undefined : result) as T;
}

/** Exact stringify character bound, without allocating the serialized string. */
export function jsonLengthAtMost(value: unknown, maximum: number): boolean {
	let length = 0;
	const stack = new Set<object>();
	const add = (amount: number) => (length += amount) <= maximum;
	function quoted(text: string): boolean {
		if (!add(text.length + 2)) return false;
		const escapes = /["\\\u0000-\u001f\ud800-\udfff]/g;
		let match: RegExpExecArray | null;
		while ((match = escapes.exec(text))) {
			const code = text.charCodeAt(match.index);
			if (code >= 0xd800 && code <= 0xdbff) {
				const next = text.charCodeAt(match.index + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					escapes.lastIndex++;
					continue;
				}
			}
			if (!add(code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code) ? 1 : 5))
				return false;
		}
		return true;
	}
	function visit(item: unknown, depth: number, key = '', converted = false): boolean {
		if (depth > 1000) return false;
		if (
			!converted &&
			item &&
			typeof item === 'object' &&
			typeof (item as { toJSON?: unknown }).toJSON === 'function'
		) {
			try {
				item = (item as { toJSON(key: string): unknown }).toJSON(key);
			} catch {
				return false;
			}
		}
		if (item instanceof Number || item instanceof String || item instanceof Boolean)
			item = item.valueOf();
		if (
			item &&
			typeof item === 'object' &&
			Object.prototype.toString.call(item) === '[object BigInt]'
		)
			return false;
		if (typeof item === 'string') return quoted(item);
		if (!item || typeof item !== 'object') {
			try {
				return add((JSON.stringify(item) ?? 'null').length);
			} catch {
				return false;
			}
		}
		if (stack.has(item)) return false;
		stack.add(item);
		if (!add(2)) return false;
		let count = 0;
		for (const key of Array.isArray(item)
			? Array.from({ length: item.length }, (_, index) => String(index))
			: Object.keys(item)) {
			let field = (item as Record<string, unknown>)[key];
			if (
				field &&
				typeof field === 'object' &&
				typeof (field as { toJSON?: unknown }).toJSON === 'function'
			) {
				try {
					field = (field as { toJSON(key: string): unknown }).toJSON(key);
				} catch {
					return false;
				}
			}
			const omitted =
				field === undefined || typeof field === 'function' || typeof field === 'symbol';
			if (!Array.isArray(item) && omitted) continue;
			if (
				(count++ && !add(1)) ||
				(!Array.isArray(item) && (!quoted(key) || !add(1))) ||
				!visit(omitted ? null : field, depth + 1, key, true)
			)
				return false;
		}
		stack.delete(item);
		return true;
	}
	return visit(value, 0);
}
