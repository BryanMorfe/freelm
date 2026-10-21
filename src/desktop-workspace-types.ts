import type { WorkspaceTransferDescriptor } from './workspace-transfer';

export type WorkspaceReadOperation =
	'load' | 'workspace-load' | 'instance-connect' | 'instance-open' | 'bots-snapshot';
export type WorkspaceWriteOperation =
	'save' | 'workspace-save' | 'workspace-patch' | 'workspace-backup' | 'bots-command';

/** Only bounded descriptors and string chunks cross the isolated desktop bridge. */
export interface WorkspaceTransferBridge {
	open(operation: WorkspaceReadOperation, args: unknown[]): Promise<WorkspaceTransferDescriptor>;
	read(id: string, offset: number, length: number): Promise<string>;
	create(length: number, kind?: 'string' | 'metadata'): Promise<string>;
	write(id: string, offset: number, chunk: string): Promise<void>;
	commit(
		operation: WorkspaceWriteOperation,
		args: unknown[],
		descriptor: WorkspaceTransferDescriptor,
	): Promise<unknown>;
	release(ids: string[]): Promise<void>;
}
