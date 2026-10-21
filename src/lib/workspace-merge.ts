import type { AppState } from '../types';

const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const omitted = (value: unknown) =>
	value === undefined || typeof value === 'function' || typeof value === 'symbol';

/** Compare JSON-shaped state without flattening inline media into a workspace-sized string. */
function equality() {
	const compared = new WeakMap<object, WeakMap<object, boolean>>();
	function same(a: unknown, b: unknown, depth = 0): boolean {
		if (Object.is(a, b) || a === b) return true;
		if (depth > 1000) throw new Error('Workspace data is nested too deeply.');
		if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
		const cached = compared.get(a)?.get(b);
		if (cached !== undefined) return cached;
		let result: boolean;
		if (Array.isArray(a) || Array.isArray(b)) {
			result = Array.isArray(a) && Array.isArray(b) && a.length === b.length;
			if (result) {
				const left = a as unknown[];
				const right = b as unknown[];
				for (let index = 0; index < left.length; index++) {
					if (
						!same(
							omitted(left[index]) ? null : left[index],
							omitted(right[index]) ? null : right[index],
							depth + 1,
						)
					) {
						result = false;
						break;
					}
				}
			}
		} else {
			const left = a as Record<string, unknown>;
			const right = b as Record<string, unknown>;
			// Renderer objects can still contain optional undefined fields before normalization.
			const keys = Object.keys(left).filter((key) => !omitted(left[key]));
			result =
				keys.length === Object.keys(right).filter((key) => !omitted(right[key])).length &&
				keys.every((key) => Object.hasOwn(right, key) && same(left[key], right[key], depth + 1));
		}
		let matches = compared.get(a);
		if (!matches) compared.set(a, (matches = new WeakMap()));
		matches.set(b, result);
		return result;
	}
	return same;
}
const identified = (value: unknown[]): value is ({ id: string } & Record<string, unknown>)[] =>
	value.every((item) => object(item) && typeof item.id === 'string') &&
	new Set(value.map((item) => (item as { id: string }).id)).size === value.length;

/** Three-way merge of independent renderer edits and host task checkpoints; overlapping edits fail. */
export function mergeWorkspaceState(base: AppState, local: AppState, remote: AppState): AppState {
	const same = equality();
	function merge(before: unknown, ours: unknown, theirs: unknown, path: string): unknown {
		if (same(ours, before)) return theirs;
		if (same(theirs, before) || same(ours, theirs)) return ours;
		// Optional collections may be introduced concurrently by both writers.
		if (before === undefined && Array.isArray(ours) && Array.isArray(theirs)) before = [];
		if (before === undefined && object(ours) && object(theirs)) before = {};
		if (path.endsWith('.updatedAt') && typeof ours === 'number' && typeof theirs === 'number')
			return Math.max(ours, theirs);
		if (
			Array.isArray(before) &&
			Array.isArray(ours) &&
			Array.isArray(theirs) &&
			identified(before) &&
			identified(ours) &&
			identified(theirs)
		) {
			const old = new Map(before.map((item) => [item.id, item]));
			const a = new Map(ours.map((item) => [item.id, item]));
			const b = new Map(theirs.map((item) => [item.id, item]));
			// Keep local ordering; insert only genuinely new host records. No positional media merging.
			const ids = [
				...ours.map((item) => item.id),
				...theirs.filter((item) => !a.has(item.id)).map((item) => item.id),
			];
			return ids.flatMap((id) => {
				const value = merge(old.get(id), a.get(id), b.get(id), `${path}[${id}]`);
				return value === undefined ? [] : [value];
			});
		}
		if (object(before) && object(ours) && object(theirs)) {
			const result: Record<string, unknown> = {};
			for (const key of new Set([
				...Object.keys(before),
				...Object.keys(ours),
				...Object.keys(theirs),
			])) {
				const value = merge(before[key], ours[key], theirs[key], `${path}.${key}`);
				if (value !== undefined) result[key] = value;
			}
			return result;
		}
		throw new Error(
			`WORKSPACE_CONFLICT: Both this window and the host changed ${path}. Reload before editing it again.`,
		);
	}
	return merge(base, local, remote, 'workspace') as AppState;
}
