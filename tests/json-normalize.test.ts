import { describe, expect, it } from 'vitest';
import { jsonLengthAtMost, normalizeJson } from '../src/json-normalize';

describe('bounded JSON normalization', () => {
	it('preserves JSON omission, null, numeric, Unicode and toJSON semantics without stringify', () => {
		const value = {
			absent: undefined,
			list: [undefined, NaN, Infinity, -0, '\uD800', '🙂', '\n\u0000'],
			date: new Date(0),
			custom: { toJSON: () => ({ allowed: true, missing: undefined }) },
		};
		expect(normalizeJson(value)).toEqual(JSON.parse(JSON.stringify(value)));
		expect(Object.is(normalizeJson(value).list[3], -0)).toBe(false);
		for (const candidate of [
			new Date(0),
			new Number(2),
			{ toJSON: () => new String('test') },
			value,
			{ quote: '\\"\n' },
			[1, false, null, '🙂\uD800'],
			{ n: 1e200 },
		]) {
			const length = JSON.stringify(candidate).length;
			expect(jsonLengthAtMost(candidate, length)).toBe(true);
			expect(jsonLengthAtMost(candidate, length - 1)).toBe(false);
		}
	});
	it('protects snapshots, rejects cycles, and treats prototype-looking keys as ordinary data', () => {
		const input = JSON.parse('{"__proto__":{"injected":true},"nested":{"value":1}}');
		const snapshot = normalizeJson(input);
		input.nested.value = 2;
		expect(snapshot.nested.value).toBe(1);
		expect(Object.hasOwn(snapshot, '__proto__')).toBe(true);
		expect(({} as { injected?: boolean }).injected).toBeUndefined();
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(() => normalizeJson(cycle)).toThrow('circular');
		expect(jsonLengthAtMost(cycle, 1000)).toBe(false);
	});
	it('copies a gallery larger than the V8 string limit without combining immutable strings', () => {
		const image = 'data:image/png;base64,' + 'A'.repeat(90_000_000);
		const value = Array.from({ length: 7 }, () => ({ image }));
		const snapshot = normalizeJson(value);
		expect(snapshot).not.toBe(value);
		expect(snapshot[0]).not.toBe(value[0]);
		expect(snapshot[6].image.length).toBe(90_000_022);
		expect(snapshot[6].image).toBe(image);
		expect(jsonLengthAtMost(snapshot, 500_000_000)).toBe(false);
	});
});
