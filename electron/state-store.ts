import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { constants as bufferLimits } from 'node:buffer';
import type { AppState } from '../src/types';
import { validateState } from './validation';
import {
	atomicWrite,
	jsonPayload,
	joinedPayload,
	literal,
	syncDirectory,
	type JsonPayload,
} from './json-file';
import { MediaStore, type MediaReference } from './media-store';
import { normalizeJson } from '../src/json-normalize';

export interface SecretStorage {
	available(): boolean | Promise<boolean>;
	/** Last completed availability check; never initializes or unlocks the backend. */
	status?(): boolean | undefined;
	encrypt(value: string): Buffer | Promise<Buffer>;
	decrypt(value: Buffer): string | Promise<string>;
}

interface StoredWorkspace {
	format: 'freelm-workspace-v1';
	state: AppState;
	encryptedKeys: Record<string, string>;
}
export interface StoredConfig extends Omit<
	AppState,
	'threads' | 'projects' | 'generations' | 'savedMemories' | 'chatDrafts'
> {
	format: 'freelm-config-v1';
	encryptedKeys: Record<string, string>;
}
export interface StoredWorkspaceData extends Pick<
	AppState,
	'version' | 'threads' | 'projects' | 'generations' | 'savedMemories' | 'chatDrafts'
> {
	format: 'freelm-workspace-v2';
}
export interface StoredStatePair {
	config: StoredConfig;
	workspace: StoredWorkspaceData;
}
interface StoredMediaWorkspace extends Omit<StoredWorkspaceData, 'format'> {
	format: 'freelm-workspace-v3';
	blobs: MediaReference[];
}
interface PersistedStatePair {
	config: StoredConfig;
	workspace: StoredWorkspaceData | StoredMediaWorkspace;
}
interface StateTransaction extends PersistedStatePair {
	format: 'freelm-state-transaction-v1';
}
const MAX_BYTES = Math.min(512 * 1024 * 1024, bufferLimits.MAX_STRING_LENGTH);
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

function encryptedKeys(value: unknown): Record<string, string> {
	if (
		!record(value) ||
		Object.entries(value).some(
			([key, ciphertext]) =>
				key.length > 256 || typeof ciphertext !== 'string' || ciphertext.length > 65536,
		)
	)
		throw new Error('Invalid encrypted API keys.');
	// Preserve every byte of existing ciphertext without invoking the system keychain.
	return Object.assign(Object.create(null), value) as Record<string, string>;
}

function splitState(state: AppState, keys: Record<string, string>, clone = true): StoredStatePair {
	const copy = clone ? normalizeJson(state) : state;
	const config: StoredConfig = {
		format: 'freelm-config-v1',
		version: copy.version,
		connections: copy.connections.map((connection) => ({ ...connection, apiKey: '' })),
		activeConnectionId: copy.activeConnectionId,
		theme: copy.theme,
		...(copy.appearance !== undefined ? { appearance: copy.appearance } : {}),
		...(copy.debugMode !== undefined ? { debugMode: copy.debugMode } : {}),
		...(copy.systemPrompt !== undefined ? { systemPrompt: copy.systemPrompt } : {}),
		...(copy.thinkingPresets !== undefined ? { thinkingPresets: copy.thinkingPresets } : {}),
		...(copy.toolSettings !== undefined ? { toolSettings: copy.toolSettings } : {}),
		...(copy.memorySettings !== undefined ? { memorySettings: copy.memorySettings } : {}),
		...(copy.personalization !== undefined ? { personalization: copy.personalization } : {}),
		...(copy.dictation !== undefined ? { dictation: copy.dictation } : {}),
		...(copy.backgroundNotifications !== undefined
			? { backgroundNotifications: copy.backgroundNotifications }
			: {}),
		...(copy.codeCompaction !== undefined ? { codeCompaction: copy.codeCompaction } : {}),
		...(copy.moderation !== undefined ? { moderation: copy.moderation } : {}),
		encryptedKeys: encryptedKeys(keys),
	};
	return {
		config,
		workspace: {
			format: 'freelm-workspace-v2',
			version: copy.version,
			threads: copy.threads,
			projects: copy.projects,
			generations: copy.generations,
			...(copy.savedMemories !== undefined ? { savedMemories: copy.savedMemories } : {}),
			...(copy.chatDrafts !== undefined ? { chatDrafts: copy.chatDrafts } : {}),
		},
	};
}

/** Convert an intact legacy payload without reading, decrypting, or re-encrypting its keys. */
export function splitLegacyWorkspace(raw: unknown): StoredStatePair {
	const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
	if (!record(value) || value.format !== 'freelm-workspace-v1')
		throw new Error('Unsupported workspace format.');
	validateState(value.state);
	return splitState(value.state, encryptedKeys(value.encryptedKeys));
}

/** Validate both halves together and return an independent state with blank plaintext key fields. */
export function validateSplitWorkspace(
	config: unknown,
	workspace: unknown,
): {
	state: AppState;
	encryptedKeys: Record<string, string>;
} {
	return validatedSplitWorkspace(config, workspace, true);
}

function validatedSplitWorkspace(
	config: unknown,
	workspace: unknown,
	clone: boolean,
): {
	state: AppState;
	encryptedKeys: Record<string, string>;
} {
	if (
		!record(config) ||
		config.format !== 'freelm-config-v1' ||
		config.version !== 1 ||
		!record(workspace) ||
		workspace.format !== 'freelm-workspace-v2' ||
		workspace.version !== 1
	)
		throw new Error('Unsupported configuration or workspace format.');
	if (
		['threads', 'projects', 'generations', 'savedMemories', 'chatDrafts'].some((key) =>
			Object.hasOwn(config, key),
		) ||
		[
			'connections',
			'activeConnectionId',
			'theme',
			'appearance',
			'debugMode',
			'systemPrompt',
			'thinkingPresets',
			'toolSettings',
			'memorySettings',
			'personalization',
			'dictation',
			'backgroundNotifications',
			'codeCompaction',
			'moderation',
			'encryptedKeys',
		].some((key) => Object.hasOwn(workspace, key))
	)
		throw new Error(
			'Configuration belongs in config.json; chats, projects, and generations belong in workspace.json.',
		);
	const state = {
		version: config.version,
		connections: config.connections,
		activeConnectionId: config.activeConnectionId,
		theme: config.theme,
		...(config.appearance !== undefined ? { appearance: config.appearance } : {}),
		...(config.debugMode !== undefined ? { debugMode: config.debugMode } : {}),
		...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
		...(config.thinkingPresets !== undefined ? { thinkingPresets: config.thinkingPresets } : {}),
		...(config.toolSettings !== undefined ? { toolSettings: config.toolSettings } : {}),
		...(config.memorySettings !== undefined ? { memorySettings: config.memorySettings } : {}),
		...(config.personalization !== undefined ? { personalization: config.personalization } : {}),
		...(config.dictation !== undefined ? { dictation: config.dictation } : {}),
		...(config.backgroundNotifications !== undefined
			? { backgroundNotifications: config.backgroundNotifications }
			: {}),
		...(config.codeCompaction !== undefined ? { codeCompaction: config.codeCompaction } : {}),
		...(config.moderation !== undefined ? { moderation: config.moderation } : {}),
		threads: workspace.threads,
		projects: workspace.projects,
		generations: workspace.generations,
		...(workspace.savedMemories !== undefined ? { savedMemories: workspace.savedMemories } : {}),
		...(workspace.chatDrafts !== undefined ? { chatDrafts: workspace.chatDrafts } : {}),
	};
	validateState(state);
	const cloned = clone ? normalizeJson(state) : state;
	cloned.connections = cloned.connections.map((connection) => ({ ...connection, apiKey: '' }));
	return { state: cloned, encryptedKeys: encryptedKeys(config.encryptedKeys) };
}

async function optionalRead(filename: string): Promise<string | undefined> {
	try {
		if ((await stat(filename)).size > MAX_BYTES)
			throw new Error('Workspace metadata exceeds the 512 MB storage limit.');
		return await readFile(filename, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}
/** Serializes reads and saves; split files are committed through a durable redo journal. */
export class StateStore {
	private pending: Promise<void> = Promise.resolve();
	private sessionKeys = new Map<string, string>();
	private unavailableKeys = new Set<string>();
	private unlockedKeys = new Set<string>();
	// Weak keys let deleted/replaced records go away; values retain no serialized media copies.
	private encodedRecords = new WeakMap<object, JsonPayload>();
	private readonly media: MediaStore;

	constructor(
		readonly filename: string,
		private readonly secrets: SecretStorage,
		readonly configFilename?: string,
	) {
		this.media = new MediaStore(path.join(path.dirname(filename), 'media'));
		if (configFilename && path.resolve(configFilename) === path.resolve(filename))
			throw new Error('Configuration and workspace must use different files.');
		if (configFilename && path.resolve(configFilename) === path.resolve(`${filename}.pending`))
			throw new Error('Configuration cannot use the workspace transaction journal path.');
	}

	async info() {
		const status = this.secrets.status ? this.secrets.status() : await this.secrets.available();
		return {
			secure: status === true,
			checked: status !== undefined,
			location: this.configFilename ?? this.filename,
		};
	}
	flush() {
		return this.pending;
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.pending.then(operation);
		this.pending = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	load(): Promise<AppState | null> {
		return this.serialize(() => this.read());
	}
	private async read(): Promise<AppState | null> {
		let saved: { state: AppState; encryptedKeys: Record<string, string> };
		try {
			if (this.configFilename) {
				await this.recoverTransaction();
				const [config, workspace] = await Promise.all([
					optionalRead(this.configFilename),
					optionalRead(this.filename),
				]);
				if (config === undefined && workspace === undefined) return null;
				if (config === undefined || workspace === undefined)
					throw new Error(
						'The split workspace is incomplete. Both config.json and workspace.json are required.',
					);
				saved = validatedSplitWorkspace(
					JSON.parse(config),
					await this.media.hydrate(JSON.parse(workspace)),
					false,
				);
			} else {
				const source = await optionalRead(this.filename);
				if (source === undefined) return null;
				const value: unknown = JSON.parse(source);
				if (!record(value) || value.format !== 'freelm-workspace-v1')
					throw new Error('Unsupported workspace format.');
				validateState(value.state);
				saved = { state: value.state, encryptedKeys: encryptedKeys(value.encryptedKeys) };
			}
		} catch (error) {
			throw new Error(
				`Could not open your saved workspace. Keep a copy of ${this.filename}${this.configFilename ? ` and ${this.configFilename}` : ''} before making changes. ${(error as Error).message}`,
			);
		}
		const needsDecryption = saved.state.connections.some(
			(connection) =>
				!this.sessionKeys.has(connection.id) &&
				Object.hasOwn(saved.encryptedKeys, connection.id) &&
				Boolean(saved.encryptedKeys[connection.id]),
		);
		const secure = needsDecryption && (await this.secrets.available());
		this.unavailableKeys.clear();
		for (const connection of saved.state.connections) {
			// Plaintext credentials in manually edited files are never accepted.
			connection.apiKey = this.sessionKeys.get(connection.id) ?? '';
			const encrypted = Object.hasOwn(saved.encryptedKeys, connection.id)
				? saved.encryptedKeys[connection.id]
				: undefined;
			if (!this.sessionKeys.has(connection.id) && !secure && encrypted)
				this.unavailableKeys.add(connection.id);
			if (!this.sessionKeys.has(connection.id) && secure && encrypted) {
				try {
					connection.apiKey = await this.secrets.decrypt(Buffer.from(encrypted, 'base64'));
					this.unlockedKeys.add(connection.id);
				} catch {
					throw new Error(
						'Could not unlock saved API keys. Unlock your system keychain and reopen FreeLM. Your workspace file has not been changed.',
					);
				}
			}
		}
		return saved.state;
	}

	save(state: AppState): Promise<void> {
		validateState(state);
		const snapshot = normalizeJson(state);
		return this.serialize(() => this.write(snapshot));
	}

	/** Internal authority handoff: the caller owns and never mutates this snapshot. */
	saveSnapshot(state: AppState, previous?: AppState): Promise<void> {
		validateState(state, previous);
		return this.serialize(() => this.write(state));
	}

	private async write(state: AppState): Promise<void> {
		if (this.configFilename) await this.recoverTransaction();
		const needsEncryption = state.connections.some((connection) => Boolean(connection.apiKey));
		const secure = needsEncryption && (await this.secrets.available());
		const previous = !secure || this.unavailableKeys.size ? await this.previousEncryptedKeys() : {};
		const keys = new Map<string, string>();
		const unavailableKeys = new Set<string>();
		const unlockedKeys = new Set<string>();
		const encrypted: Record<string, string> = Object.create(null);
		for (const connection of state.connections) {
			const preserved = Object.hasOwn(previous, connection.id)
				? previous[connection.id]
				: undefined;
			const retain = Boolean(
				preserved &&
				(this.unavailableKeys.has(connection.id) ||
					(needsEncryption ? !secure : !this.unlockedKeys.has(connection.id))),
			);
			// A temporarily unavailable keychain must not turn an unrelated autosave into
			// credential deletion. Newly entered keys still live only in this process.
			if (connection.apiKey || !retain) keys.set(connection.id, connection.apiKey);
			else unavailableKeys.add(connection.id);
			if (this.unlockedKeys.has(connection.id)) unlockedKeys.add(connection.id);
			if (secure && connection.apiKey) {
				encrypted[connection.id] = (await this.secrets.encrypt(connection.apiKey)).toString(
					'base64',
				);
				unlockedKeys.add(connection.id);
			} else if (retain) encrypted[connection.id] = preserved!;
		}
		try {
			if (this.configFilename) {
				const split = splitState(state, encrypted, false);
				const pair: PersistedStatePair = {
					config: split.config,
					workspace: await this.media.encodeWorkspace(split.workspace),
				};
				const encoded = this.encodeTransaction(pair);
				// This write is the commit point. Any interrupted replacements are rolled forward
				// from the complete journal before the next read or save, including after restart.
				await atomicWrite(`${this.filename}.pending`, encoded.journal);
				this.sessionKeys = keys;
				this.unavailableKeys = unavailableKeys;
				this.unlockedKeys = unlockedKeys;
				await this.applyTransaction(pair, encoded);
			} else {
				await atomicWrite(
					this.filename,
					jsonPayload({
						format: 'freelm-workspace-v1',
						state: {
							...state,
							connections: state.connections.map((connection) => ({ ...connection, apiKey: '' })),
						},
						encryptedKeys: encrypted,
					} satisfies StoredWorkspace),
				);
				this.sessionKeys = keys;
				this.unavailableKeys = unavailableKeys;
				this.unlockedKeys = unlockedKeys;
			}
		} catch (error) {
			throw new Error(`Could not save your workspace: ${(error as Error).message}`);
		}
	}

	private async previousEncryptedKeys(): Promise<Record<string, string>> {
		const source = await optionalRead(this.configFilename ?? this.filename);
		if (source === undefined) return {};
		const saved: unknown = JSON.parse(source);
		if (
			!record(saved) ||
			saved.format !== (this.configFilename ? 'freelm-config-v1' : 'freelm-workspace-v1')
		)
			throw new Error('Could not preserve saved API keys: unsupported storage format.');
		return encryptedKeys(saved.encryptedKeys);
	}

	private async recoverTransaction(): Promise<void> {
		if (!this.configFilename) return;
		let pair: StoredStatePair;
		try {
			const source = await optionalRead(`${this.filename}.pending`);
			if (source === undefined) return;
			const transaction: unknown = JSON.parse(source);
			if (!record(transaction) || transaction.format !== 'freelm-state-transaction-v1')
				throw new Error('Unsupported transaction format.');
			// Parsed data is already private. Avoid multiple full media clones and a second
			// giant stringify just to validate a journal that must be replayed after a crash.
			const validated = validatedSplitWorkspace(
				transaction.config,
				await this.media.hydrate(transaction.workspace),
				false,
			);
			pair = splitState(validated.state, validated.encryptedKeys, false);
		} catch (error) {
			throw new Error(
				`The pending workspace transaction is invalid. Keep ${this.filename}.pending for recovery. ${(error as Error).message}`,
			);
		}
		await this.applyTransaction({
			config: pair.config,
			workspace: await this.media.encodeWorkspace(pair.workspace),
		});
	}

	private encodeRecords(records: object[]): JsonPayload {
		const parts = [literal('[')];
		for (const [index, value] of records.entries()) {
			if (index) parts.push(literal(','));
			let encoded = this.encodedRecords.get(value);
			if (!encoded) {
				encoded = jsonPayload(value);
				this.encodedRecords.set(value, encoded);
			}
			parts.push(encoded);
		}
		parts.push(literal(']'));
		return joinedPayload(parts);
	}

	private encodeTransaction(pair: PersistedStatePair) {
		const config = jsonPayload(pair.config, true);
		const workspace = joinedPayload([
			literal(
				`{"format":"${pair.workspace.format}","version":${pair.workspace.version},"threads":`,
			),
			this.encodeRecords(pair.workspace.threads),
			literal(',"projects":'),
			this.encodeRecords(pair.workspace.projects),
			literal(',"generations":'),
			this.encodeRecords(pair.workspace.generations),
			...(pair.workspace.savedMemories !== undefined
				? [literal(',"savedMemories":'), this.encodeRecords(pair.workspace.savedMemories)]
				: []),
			...(pair.workspace.chatDrafts !== undefined
				? [literal(',"chatDrafts":'), jsonPayload(pair.workspace.chatDrafts)]
				: []),
			...(pair.workspace.format === 'freelm-workspace-v3'
				? [literal(',"blobs":'), jsonPayload(pair.workspace.blobs)]
				: []),
			literal('}'),
		]);
		const journal = joinedPayload([
			literal('{"format":"freelm-state-transaction-v1","config":'),
			config,
			literal(',"workspace":'),
			workspace,
			literal('}'),
		]);
		return { config, workspace, journal };
	}

	private async applyTransaction(
		pair: PersistedStatePair,
		encoded = this.encodeTransaction(pair),
	): Promise<void> {
		await atomicWrite(this.configFilename!, encoded.config);
		await atomicWrite(this.filename, encoded.workspace);
		await rm(`${this.filename}.pending`);
		await syncDirectory(path.dirname(this.filename));
		// Orphaned media is removed only after the new files and journal commit are complete.
		// Cleanup failure must never turn an already durable save into a conflict.
		await this.media.prune(pair.workspace).catch(() => undefined);
	}
}
