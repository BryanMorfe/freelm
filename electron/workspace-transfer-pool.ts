import { randomUUID } from 'node:crypto';
import { constants } from 'node:buffer';
import {
	assertWorkspaceTransferDescriptor,
	describeWorkspaceTransfer,
	encodeWorkspaceTransfer,
	hydrateWorkspaceTransfer,
	parseWorkspaceTransferManifest,
	workspaceTransferChunk,
	WORKSPACE_TRANSFER_CHUNK_SIZE,
	type WorkspaceTransferDescriptor,
} from '../src/workspace-transfer';

interface PendingString {
	kind: 'string' | 'metadata';
	length: number;
	received: number;
	parts: string[];
	expires: number;
}
interface OwnerPool {
	strings: Map<string, string>;
	identities: Map<string, string>;
	pending: Map<string, PendingString>;
	metadata: Map<string, { value: string; expires: number }>;
}
const UPLOAD_LIFETIME = 5 * 60 * 1000;

/** Immutable strings are shared by manifests instead of serializing every occurrence. */
export class WorkspaceTransferPool {
	private owners = new Map<number, OwnerPool>();
	constructor(private readonly now = Date.now) {}

	private pool(owner: number) {
		let pool = this.owners.get(owner);
		if (!pool) {
			pool = { strings: new Map(), identities: new Map(), pending: new Map(), metadata: new Map() };
			this.owners.set(owner, pool);
		}
		for (const [id, pending] of pool.pending)
			if (pending.expires < this.now()) pool.pending.delete(id);
		for (const [id, metadata] of pool.metadata)
			if (metadata.expires < this.now()) pool.metadata.delete(id);
		return pool;
	}

	private put(owner: number, value: string) {
		const pool = this.pool(owner);
		const known = pool.identities.get(value);
		if (known) return known;
		if (pool.strings.size >= 100_000)
			throw new Error('Too many workspace media references. Reload FreeLM.');
		const id = randomUUID();
		pool.strings.set(id, value);
		pool.identities.set(value, id);
		return id;
	}

	encode(owner: number, value: unknown): WorkspaceTransferDescriptor {
		return describeWorkspaceTransfer(
			encodeWorkspaceTransfer(value, (text) => this.put(owner, text)),
			(text) => {
				const id = randomUUID();
				this.pool(owner).metadata.set(id, { value: text, expires: this.now() + UPLOAD_LIFETIME });
				return id;
			},
		);
	}

	private get(owner: number, id: unknown): string {
		if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
			throw new Error('Invalid workspace transfer identifier.');
		const pool = this.pool(owner);
		const value = pool.strings.get(id) ?? pool.metadata.get(id)?.value;
		if (value === undefined)
			throw new Error(
				'Workspace transfer is incomplete or no longer available. Reload the workspace.',
			);
		return value;
	}

	decode<T>(owner: number, raw: unknown): T {
		assertWorkspaceTransferDescriptor(raw);
		const metadata = raw.metadata;
		const text = 'json' in metadata ? metadata.json : this.get(owner, metadata.id);
		if ('length' in metadata && metadata.length !== text.length)
			throw new Error('Workspace transfer metadata length does not match.');
		return hydrateWorkspaceTransfer<T>(parseWorkspaceTransferManifest(text), (id) =>
			this.get(owner, id),
		);
	}

	read(owner: number, id: unknown, offset: number, length: number) {
		return workspaceTransferChunk(this.get(owner, id), offset, length);
	}

	create(owner: number, length: unknown, kind: unknown = 'string'): string {
		if (kind !== 'string' && kind !== 'metadata')
			throw new Error('Invalid workspace transfer string kind.');
		if (
			typeof length !== 'number' ||
			!Number.isSafeInteger(length) ||
			length < 0 ||
			length > constants.MAX_STRING_LENGTH
		)
			throw new Error('Invalid workspace transfer string length.');
		const pool = this.pool(owner);
		if (pool.pending.size >= 4)
			throw new Error('Too many workspace uploads are pending. Retry shortly.');
		if (length === 0) return this.put(owner, '');
		const id = randomUUID();
		pool.pending.set(id, {
			kind,
			length,
			received: 0,
			parts: [],
			expires: this.now() + UPLOAD_LIFETIME,
		});
		return id;
	}

	write(owner: number, id: unknown, offset: unknown, chunk: unknown) {
		if (
			typeof id !== 'string' ||
			typeof offset !== 'number' ||
			!Number.isSafeInteger(offset) ||
			typeof chunk !== 'string' ||
			!chunk.length ||
			chunk.length > WORKSPACE_TRANSFER_CHUNK_SIZE
		)
			throw new Error('Invalid workspace transfer chunk.');
		const pool = this.pool(owner);
		const pending = pool.pending.get(id);
		if (!pending) throw new Error('This workspace upload is no longer available.');
		if (offset !== pending.received || offset + chunk.length > pending.length)
			throw new Error(
				'Workspace upload chunks arrived out of order or exceeded their declared length.',
			);
		pending.parts.push(chunk);
		pending.received += chunk.length;
		pending.expires = this.now() + UPLOAD_LIFETIME;
		if (pending.received === pending.length) {
			const value = pending.parts.join('');
			if (pending.kind === 'metadata')
				pool.metadata.set(id, { value, expires: this.now() + UPLOAD_LIFETIME });
			else {
				const known = pool.identities.get(value);
				pool.strings.set(id, known ? pool.strings.get(known)! : value);
				if (!known) pool.identities.set(value, id);
			}
			pool.pending.delete(id);
		}
	}

	release(owner: number, raw: unknown) {
		if (
			!Array.isArray(raw) ||
			raw.length > 1000 ||
			raw.some((id) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
		)
			throw new Error('Invalid workspace upload cancellation.');
		const pool = this.pool(owner);
		for (const id of raw) {
			pool.pending.delete(id);
			pool.metadata.delete(id);
		}
	}

	clear(owner: number) {
		this.owners.delete(owner);
	}
}
