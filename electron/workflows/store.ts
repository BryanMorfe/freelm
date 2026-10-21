import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, jsonPayloadAsync } from '../json-file';
import { WorkflowCollections } from './collections';
import type {
	WorkflowDefinition,
	WorkflowProjectBinding,
	WorkflowRun,
} from '../../src/workflow-types';

export interface WorkflowScheduleCursor {
	fingerprint: string;
	nextAt?: number;
	lastAt?: number;
}
interface WorkflowMetadata {
	version: 1;
	state: Record<string, Record<string, unknown>>;
	schedules: Record<string, WorkflowScheduleCursor>;
}

const safeId = (id: string): string => {
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('Invalid workflow identifier.');
	return id;
};

/** Individual atomic files keep a run update independent of the size of the workspace. */
export class WorkflowStore {
	private metadata: WorkflowMetadata = { version: 1, state: {}, schedules: {} };
	private writes = new Map<string, Promise<void>>();
	readonly collections: WorkflowCollections;
	constructor(readonly directory: string) {
		this.collections = new WorkflowCollections(path.join(directory, 'collections'));
	}
	async init(): Promise<void> {
		await Promise.all(
			['definitions', 'runs', 'bindings'].map((name) =>
				mkdir(path.join(this.directory, name), { recursive: true, mode: 0o700 }),
			),
		);
		try {
			const value = JSON.parse(
				await readFile(path.join(this.directory, 'metadata.json'), 'utf8'),
			) as WorkflowMetadata;
			if (value.version !== 1 || !value.state || !value.schedules)
				throw new Error('Unsupported workflow metadata.');
			this.metadata = value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
	private async write(filename: string, value: unknown): Promise<void> {
		// Capture before queueing so later in-memory mutations cannot change this commit.
		const copy = structuredClone(value);
		const previous = this.writes.get(filename) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(async () => atomicWrite(filename, await jsonPayloadAsync(copy)));
		this.writes.set(filename, next);
		try {
			await next;
		} finally {
			if (this.writes.get(filename) === next) this.writes.delete(filename);
		}
	}
	private async list<T>(folder: string): Promise<T[]> {
		const names = await readdir(path.join(this.directory, folder));
		const values: T[] = [];
		for (const name of names.filter((name) => name.endsWith('.json')).sort()) {
			// A corrupt durable record must be reported, never silently discarded.
			values.push(JSON.parse(await readFile(path.join(this.directory, folder, name), 'utf8')) as T);
		}
		return values;
	}
	listWorkflows(): Promise<WorkflowDefinition[]> {
		return this.list('definitions');
	}
	listBindings(): Promise<WorkflowProjectBinding[]> {
		return this.list('bindings');
	}
	saveBinding(binding: WorkflowProjectBinding): Promise<void> {
		return this.write(path.join(this.directory, 'bindings', `${safeId(binding.id)}.json`), binding);
	}
	async deleteBinding(id: string): Promise<void> {
		const filename = path.join(this.directory, 'bindings', `${safeId(id)}.json`);
		await this.writes.get(filename);
		await rm(filename, { force: true });
	}
	listRuns(): Promise<WorkflowRun[]> {
		return this.list('runs');
	}
	saveWorkflow(workflow: WorkflowDefinition): Promise<void> {
		return this.write(
			path.join(this.directory, 'definitions', `${safeId(workflow.id)}.json`),
			workflow,
		);
	}
	async deleteWorkflow(id: string): Promise<void> {
		const filename = path.join(this.directory, 'definitions', `${safeId(id)}.json`);
		await this.writes.get(filename);
		await rm(filename, { force: true });
	}
	saveRun(run: WorkflowRun): Promise<void> {
		return this.write(path.join(this.directory, 'runs', `${safeId(run.id)}.json`), run);
	}
	getState(workflowId: string, key: string): unknown {
		return structuredClone(this.metadata.state[workflowId]?.[key]);
	}
	async setState(workflowId: string, key: string, value: unknown): Promise<void> {
		if (['__proto__', 'prototype', 'constructor'].includes(key))
			throw new Error('Invalid state key.');
		const scope = this.metadata.state[workflowId] ?? (this.metadata.state[workflowId] = {});
		if (value === undefined) delete scope[key];
		else scope[key] = structuredClone(value);
		await this.write(path.join(this.directory, 'metadata.json'), this.metadata);
	}
	getSchedule(key: string): WorkflowScheduleCursor | undefined {
		return structuredClone(this.metadata.schedules[key]);
	}
	async setSchedule(key: string, cursor: WorkflowScheduleCursor): Promise<void> {
		this.metadata.schedules[key] = { ...cursor };
		await this.write(path.join(this.directory, 'metadata.json'), this.metadata);
	}
	async flush(): Promise<void> {
		await Promise.all([...this.writes.values(), this.collections.flush()]);
	}
}
