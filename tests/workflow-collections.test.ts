import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkflowCollections } from '../electron/workflows/collections';
import type { WorkflowCollectionRequest } from '../src/workflow-types';
const roots: string[] = [];
async function create() {
	const root = await mkdtemp(path.join(os.tmpdir(), 'freelm-collections-'));
	roots.push(root);
	return new WorkflowCollections(root);
}
const request = (
	overrides: Partial<WorkflowCollectionRequest> = {},
): WorkflowCollectionRequest => ({
	scope: 'run',
	scopeId: 'root',
	name: 'records',
	operation: 'list',
	mutationId: 'read',
	provenance: { runId: 'child', nodeId: 'node', workflowId: 'graph' },
	...overrides,
});
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});
describe('transactional workflow collections', () => {
	it('serializes concurrent appends, persists them, and paginates/filter queries without lost writes', async () => {
		const store = await create();
		await Promise.all(
			Array.from({ length: 30 }, (_, index) =>
				store.execute(
					request({
						operation: 'append',
						value: { index, group: index % 2, title: `Record ${index}` },
						mutationId: `append-${index}`,
					}),
				),
			),
		);
		const result = await store.execute(request({ filter: { group: 1 }, limit: 4, offset: 4 }));
		expect(result.count).toBe(15);
		expect(result.nextOffset).toBe(8);
		expect(result.items).toEqual(
			[9, 11, 13, 15].map((index) => ({ index, group: 1, title: `Record ${index}` })),
		);
		const restored = new WorkflowCollections(roots[0]);
		expect((await restored.execute(request({ query: 'Record 29' }))).items).toEqual([
			{ index: 29, group: 1, title: 'Record 29' },
		]);
	});
	it('enforces revision guards atomically and makes committed retries idempotent', async () => {
		const store = await create();
		const first = await store.execute(
			request({
				operation: 'upsert',
				recordId: 'fact',
				value: 1,
				expectedRevision: 0,
				mutationId: 'create',
			}),
		);
		expect(first.revision).toBe(1);
		const results = await Promise.allSettled(
			[2, 3].map((value) =>
				store.execute(
					request({
						operation: 'upsert',
						recordId: 'fact',
						value,
						expectedRevision: 1,
						mutationId: `update-${value}`,
					}),
				),
			),
		);
		expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
		expect(String((results[1] as PromiseRejectedResult).reason)).toContain('revision conflict');
		expect(
			(
				await store.execute(
					request({
						operation: 'upsert',
						recordId: 'fact',
						value: 2,
						expectedRevision: 1,
						mutationId: 'update-2',
					}),
				)
			).revision,
		).toBe(2);
		await expect(
			store.execute(
				request({ operation: 'upsert', recordId: 'fact', value: 7, mutationId: 'update-2' }),
			),
		).rejects.toThrow('retry changed');
		expect((await store.execute(request({ operation: 'get', recordId: 'fact' }))).value).toBe(2);
	});
	it('preserves null data, provenance, deletes and monotonic revision through recreation', async () => {
		const store = await create();
		await store.execute(
			request({ operation: 'upsert', recordId: 'x', value: null, mutationId: 'create' }),
		);
		expect(await store.execute(request({ operation: 'get', recordId: 'x' }))).toMatchObject({
			found: true,
			value: null,
			record: { provenance: { runId: 'child', nodeId: 'node', workflowId: 'graph' } },
		});
		await store.execute(
			request({ operation: 'delete', recordId: 'x', expectedRevision: 1, mutationId: 'delete' }),
		);
		expect(await store.execute(request({ operation: 'get', recordId: 'x' }))).toMatchObject({
			found: false,
		});
		expect(
			await store.execute(
				request({
					operation: 'upsert',
					recordId: 'x',
					value: 2,
					expectedRevision: 0,
					mutationId: 'again',
				}),
			),
		).toMatchObject({ revision: 3 });
	});
	it('isolates root-run and workflow namespaces and rejects malformed/unbounded data', async () => {
		const store = await create();
		await store.execute(request({ operation: 'append', value: 3, mutationId: 'a' }));
		for (const changes of [{ scopeId: 'other' }, { scope: 'workflow' as const }, { name: 'other' }])
			expect((await store.execute(request(changes))).items).toEqual([]);
		for (const changes of [
			{ limit: 1001 },
			{ recordId: '__proto__', operation: 'get' as const },
			{ operation: 'append' as const, value: 'x'.repeat(300000) },
			{ operation: 'append' as const, value: Infinity },
			{ query: 'x'.repeat(1001) },
		])
			await expect(store.execute(request(changes))).rejects.toThrow();
	});
});
