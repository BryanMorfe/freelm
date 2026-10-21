import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, jsonPayloadAsync } from '../json-file';
import type { WorkflowCollectionRecord, WorkflowCollectionRequest } from '../../src/workflow-types';

interface CollectionFile {
	version: 1;
	records: Record<string, WorkflowCollectionRecord>;
	revisions: Record<string, number>;
	mutations: Record<string, { fingerprint: string; output: Record<string, unknown> }>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const badKey = (key: string) => ['__proto__', 'prototype', 'constructor'].includes(key);
const recordId = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= 200 && !badKey(value);
const getPath = (value: unknown, key: string): unknown =>
	key
		.split('.')
		.filter(Boolean)
		.reduce<unknown>(
			(current, segment) =>
				!badKey(segment) &&
				current !== null &&
				typeof current === 'object' &&
				Object.hasOwn(current, segment)
					? (current as Record<string, unknown>)[segment]
					: undefined,
			value,
		);
function safeJson(value: unknown, maximum: number): string {
	const seen = new Set<object>();
	let count = 0;
	const visit = (current: unknown, depth: number): void => {
		if (depth > 32 || ++count > 100_000)
			throw new Error('Collection data is too deeply nested or too large.');
		if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
		if (typeof current === 'number' && Number.isFinite(current)) return;
		if (typeof current !== 'object' || seen.has(current))
			throw new Error('Collections require plain JSON data.');
		if (
			!Array.isArray(current) &&
			![Object.prototype, null].includes(Object.getPrototypeOf(current))
		)
			throw new Error('Collections require plain JSON data.');
		seen.add(current);
		for (const [key, child] of Object.entries(current)) {
			if (badKey(key)) throw new Error('Unsafe collection property name.');
			visit(child, depth + 1);
		}
		seen.delete(current);
	};
	visit(value, 0);
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json, 'utf8') > maximum)
		throw new Error('Collection data exceeds its storage limit.');
	return json;
}

/** All read/modify/write operations on a collection share one serial transaction queue. */
export class WorkflowCollections {
	private transactions = new Map<string, Promise<unknown>>();
	constructor(private readonly directory: string) {}
	async execute(input: WorkflowCollectionRequest): Promise<Record<string, unknown>> {
		// Validate and snapshot before queueing; caller mutation cannot affect a queued operation.
		const request = structuredClone(input);
		if (
			!['run', 'workflow'].includes(request.scope) ||
			!recordId(request.scopeId) ||
			!recordId(request.name) ||
			!['list', 'get', 'append', 'upsert', 'delete'].includes(request.operation)
		)
			throw new Error('Invalid collection scope, name, or operation.');
		if (request.recordId !== undefined && !recordId(request.recordId))
			throw new Error('Invalid collection record ID.');
		if (['get', 'upsert', 'delete'].includes(request.operation) && !request.recordId)
			throw new Error('This collection operation requires a record ID.');
		if (
			request.expectedRevision !== undefined &&
			(!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0)
		)
			throw new Error('Expected revision must be a nonnegative integer.');
		if (
			request.filter !== undefined &&
			(!request.filter || Array.isArray(request.filter) || typeof request.filter !== 'object')
		)
			throw new Error('Collection filters must be an object of field paths and expected values.');
		if (
			request.query !== undefined &&
			(typeof request.query !== 'string' || request.query.length > 1000)
		)
			throw new Error('Collection query is limited to 1000 characters.');
		const limit = request.limit ?? 100,
			offset = request.offset ?? 0;
		if (
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 1000 ||
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			offset > 10_000
		)
			throw new Error('Collection limit must be 1–1000 and offset 0–10000.');
		if (request.filter) safeJson(request.filter, 16 * 1024);
		if (['append', 'upsert'].includes(request.operation)) safeJson(request.value, 256 * 1024);
		if (
			typeof request.mutationId !== 'string' ||
			!request.mutationId ||
			request.mutationId.length > 1000
		)
			throw new Error('Collection operations require a stable mutation ID.');
		const key = hash(JSON.stringify([request.scope, request.scopeId, request.name]));
		const previous = this.transactions.get(key) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(() => this.transact(key, request, limit, offset));
		this.transactions.set(key, next);
		try {
			return await next;
		} finally {
			if (this.transactions.get(key) === next) this.transactions.delete(key);
		}
	}
	private async transact(
		key: string,
		request: WorkflowCollectionRequest,
		limit: number,
		offset: number,
	): Promise<Record<string, unknown>> {
		const filename = path.join(this.directory, `${key}.json`);
		let state: CollectionFile = { version: 1, records: {}, revisions: {}, mutations: {} };
		try {
			const raw = await readFile(filename, 'utf8');
			if (Buffer.byteLength(raw) > 8 * 1024 * 1024)
				throw new Error('Collection exceeds its 8 MB storage limit.');
			state = JSON.parse(raw) as CollectionFile;
			if (state.version !== 1 || !state.records || !state.revisions || !state.mutations)
				throw new Error('Invalid collection storage.');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		if (request.operation === 'list') {
			const query = request.query?.toLocaleLowerCase();
			const all = Object.values(state.records).filter(
				(record) =>
					Object.entries(request.filter ?? {}).every(
						([field, expected]) =>
							JSON.stringify(getPath(record.data, field)) === JSON.stringify(expected),
					) &&
					(!query || JSON.stringify(record.data).toLocaleLowerCase().includes(query)),
			);
			// A page has both data-only and metadata views; bound their combined serialized size.
			const records: WorkflowCollectionRecord[] = [];
			let bytes = 0;
			for (const record of all.slice(offset, offset + limit)) {
				const size =
					Buffer.byteLength(JSON.stringify(record), 'utf8') +
					2 * Buffer.byteLength(JSON.stringify(record.data), 'utf8');
				if (records.length && bytes + size > 2 * 1024 * 1024) break;
				records.push(record);
				bytes += size;
			}
			const items = records.map((record) => record.data);
			return {
				value: items,
				items,
				records,
				count: all.length,
				nextOffset: offset + records.length < all.length ? offset + records.length : null,
			};
		}
		const id = request.recordId ?? `record-${hash(request.mutationId).slice(0, 32)}`;
		const existing = state.records[id];
		if (request.operation === 'get')
			return { value: existing?.data ?? null, record: existing ?? null, found: !!existing };
		const mutationKey = hash(request.mutationId);
		const fingerprint = hash(
			JSON.stringify({
				operation: request.operation,
				id,
				value: request.value,
				expectedRevision: request.expectedRevision,
			}),
		);
		const prior = state.mutations[mutationKey];
		if (prior) {
			if (prior.fingerprint !== fingerprint)
				throw new Error('Collection retry changed an already committed operation.');
			return structuredClone(prior.output);
		}
		if (
			request.expectedRevision !== undefined &&
			request.expectedRevision !== (existing?.revision ?? 0)
		)
			throw new Error(
				`Collection revision conflict: expected ${request.expectedRevision}, found ${existing?.revision ?? 0}.`,
			);
		if (request.operation === 'append' && existing)
			throw new Error('Collection append record ID already exists.');
		if (Object.keys(state.mutations).length >= 10_000)
			throw new Error('Collection reached its 10000 mutation limit; use a new collection.');
		const revision = (state.revisions[id] ?? 0) + 1;
		let output: Record<string, unknown>;
		if (request.operation === 'delete') {
			delete state.records[id];
			output = { value: existing?.data ?? null, record: existing ?? null, deleted: !!existing };
		} else {
			if (!existing && Object.keys(state.records).length >= 10_000)
				throw new Error('Collection reached its 10000 record limit.');
			const now = Date.now();
			const record: WorkflowCollectionRecord = {
				id,
				data: request.value,
				revision,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
				provenance: { ...request.provenance },
			};
			state.records[id] = record;
			output = { value: record.data, record, revision };
		}
		state.revisions[id] = revision;
		state.mutations[mutationKey] = { fingerprint, output };
		safeJson(state, 8 * 1024 * 1024);
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await atomicWrite(filename, await jsonPayloadAsync(state));
		return structuredClone(output);
	}
	async flush(): Promise<void> {
		await Promise.allSettled([...this.transactions.values()]);
	}
}
