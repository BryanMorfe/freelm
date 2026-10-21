import type { DesktopBridge } from '../types';
import type { WorkspaceSnapshot } from '../remote-types';
import type { BotCommandResult, BotSnapshot } from '../bot-types';
import type { WorkspaceReadOperation, WorkspaceWriteOperation } from '../desktop-workspace-types';
import {
	readWorkspaceTransfer,
	writeWorkspaceTransfer,
	type WorkspaceTransferCache,
} from '../workspace-transfer';

/** Reconstruct in the renderer, after IPC and contextBridge have both carried bounded chunks. */
export function workspaceDesktopBridge(native: DesktopBridge): DesktopBridge {
	const transport = native.workspaceTransfer;
	if (!transport) return native;
	const cache: WorkspaceTransferCache = new Map();
	const loads = new Map<string, Promise<unknown>>();
	const read = async <T>(operation: WorkspaceReadOperation, args: unknown[]): Promise<T> => {
		const descriptor = await transport.open(operation, args);
		try {
			return await readWorkspaceTransfer<T>(descriptor, transport.read, cache);
		} finally {
			if ('id' in descriptor.metadata)
				await transport.release([descriptor.metadata.id]).catch(() => {});
		}
	};
	const load = <T>(operation: WorkspaceReadOperation, args: unknown[]): Promise<T> => {
		const key = JSON.stringify([operation, args]);
		const pending = loads.get(key);
		if (pending) return pending as Promise<T>;
		const next = read<T>(operation, args).finally(() => loads.delete(key));
		loads.set(key, next);
		return next;
	};
	const save = async <T>(
		operation: WorkspaceWriteOperation,
		args: unknown[],
		value: unknown,
	): Promise<T> => {
		const created: string[] = [];
		const create = async (length: number, kind: 'string' | 'metadata' = 'string') => {
			const id = await transport.create(length, kind);
			created.push(id);
			return id;
		};
		try {
			const descriptor = await writeWorkspaceTransfer(
				value,
				{
					createString: create,
					writeChunk: transport.write,
					createMetadata: (length) => create(length, 'metadata'),
					writeMetadataChunk: transport.write,
				},
				cache,
			);
			return (await transport.commit(operation, args, descriptor)) as T;
		} finally {
			await transport.release(created).catch(() => {});
		}
	};
	return {
		...native,
		load: () => load('load', []),
		save: (state) => save('save', [], state),
		workspaceLoad: (target) => load<WorkspaceSnapshot>('workspace-load', [target]),
		workspaceSave: (target, revision, state) => save('workspace-save', [target, revision], state),
		workspacePatch: (target, revision, patch) => save('workspace-patch', [target, revision], patch),
		workspaceBackup: (state) => save('workspace-backup', [], state),
		instanceConnect: (input) => load('instance-connect', [input]),
		instanceOpen: (id) => load('instance-open', [id]),
		botsSnapshot: (target) => load<BotSnapshot>('bots-snapshot', [target]),
		botsCommand: async (target, command) => {
			const result = await save<Omit<BotCommandResult, 'snapshot'>>(
				'bots-command',
				[target],
				command,
			);
			// Mutations acknowledge with small metadata; histories cross the bounded reader.
			const snapshot = await read<BotSnapshot>('bots-snapshot', [target]);
			return { ...result, snapshot };
		},
	};
}

export function installWorkspaceDesktopBridge() {
	if (window.desktopNative) window.desktop = workspaceDesktopBridge(window.desktopNative);
}
