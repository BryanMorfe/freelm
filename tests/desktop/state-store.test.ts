import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	mkdir,
	mkdtemp,
	open,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
	StateStore,
	splitLegacyWorkspace,
	validateSplitWorkspace,
	type SecretStorage,
} from '../../electron/state-store';
import { validateRequest, validateState } from '../../electron/validation';
import type { AppState, WireRequest } from '../../src/types';
import { recoverState } from '../../src/lib/state';

const folders: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
function workspace(): AppState {
	return {
		version: 1,
		theme: 'system',
		activeConnectionId: 'provider',
		threads: [],
		projects: [],
		generations: [],
		connections: [
			{
				id: 'provider',
				name: 'Local provider',
				baseUrl: 'http://localhost:8000/v1',
				apiKey: 'sk-test-secret',
				chatApi: 'responses',
				models: { chat: 'model', images: '', videos: '', speech: '', transcription: '' },
				discoveredModels: [],
			},
		],
	};
}
async function filename() {
	const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-store-'));
	folders.push(folder);
	return path.join(folder, 'workspace.json');
}
function secretStorage(): SecretStorage {
	const key = randomBytes(32);
	return {
		available: () => true,
		encrypt: (value) => {
			const iv = randomBytes(16);
			const cipher = createCipheriv('aes-256-cbc', key, iv);
			return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final()]);
		},
		decrypt: (value) => {
			const cipher = createDecipheriv('aes-256-cbc', key, value.subarray(0, 16));
			return Buffer.concat([cipher.update(value.subarray(16)), cipher.final()]).toString('utf8');
		},
	};
}

describe('desktop workspace persistence', () => {
	it.each([false, true])(
		'opens, saves, and reports keyless workspaces without initializing the keychain (split=%s)',
		async (split) => {
			const file = await filename();
			const configFile = split ? path.join(path.dirname(file), 'config.json') : undefined;
			const available = vi.fn(async () => {
				throw new Error('Keychain initialization must stay lazy');
			});
			const secrets: SecretStorage = {
				available,
				status: () => undefined,
				encrypt: vi.fn(() => {
					throw new Error('Unexpected encryption');
				}),
				decrypt: vi.fn(() => {
					throw new Error('Unexpected decryption');
				}),
			};
			const state = workspace();
			state.connections[0].apiKey = '';
			const store = new StateStore(file, secrets, configFile);
			expect(await store.load()).toBeNull();
			expect(await store.info()).toEqual({
				secure: false,
				checked: false,
				location: configFile ?? file,
			});
			await store.save(state);
			expect(await store.load()).toEqual(state);
			expect(await new StateStore(file, secrets, configFile).load()).toEqual(state);
			expect(available).not.toHaveBeenCalled();
			expect(secrets.encrypt).not.toHaveBeenCalled();
			expect(secrets.decrypt).not.toHaveBeenCalled();
		},
	);
	it('reports completed credential status without performing another availability check', async () => {
		const file = await filename();
		let status: boolean | undefined;
		const secrets = secretStorage();
		secrets.status = () => status;
		secrets.available = vi.fn(async () => {
			status = true;
			return true;
		});
		const store = new StateStore(file, secrets);
		expect((await store.info()).checked).toBe(false);
		await store.save(workspace());
		expect(await store.info()).toEqual({ secure: true, checked: true, location: file });
		expect(secrets.available).toHaveBeenCalledTimes(1);
	});
	it('rejects credential encryption when the actual backend check fails without writing plaintext', async () => {
		const file = await filename();
		const secrets = secretStorage();
		secrets.status = () => true; // Informational status cannot authorize encryption.
		secrets.available = vi.fn(async () => {
			throw new Error('Keychain locked');
		});
		secrets.encrypt = vi.fn(secrets.encrypt);
		const store = new StateStore(file, secrets);
		const state = workspace();
		state.connections[0].apiKey = '';
		await store.save(state);
		const before = await readFile(file, 'utf8');
		await expect(store.save(workspace())).rejects.toThrow('Keychain locked');
		expect(await readFile(file, 'utf8')).toBe(before);
		expect(secrets.available).toHaveBeenCalledTimes(1);
		expect(secrets.encrypt).not.toHaveBeenCalled();
	});
	it('round-trips encrypted keys without plaintext or temporary files on disk', async () => {
		const file = await filename();
		const secrets = secretStorage();
		const store = new StateStore(file, secrets);
		await store.save(workspace());
		const contents = await readFile(file, 'utf8');
		expect(contents).not.toContain('sk-test-secret');
		expect(JSON.parse(contents).state.connections[0].apiKey).toBe('');
		expect(await new StateStore(file, secrets).load()).toEqual(workspace());
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect(await readdir(path.dirname(file))).toEqual(['workspace.json']);
	});
	it('persists workspace prompts and custom thinking presets and protects saved data from invalid updates', async () => {
		const file = await filename();
		const secrets = secretStorage();
		const store = new StateStore(file, secrets);
		const state = workspace();
		state.systemPrompt = 'Prefer concise answers.\nUse project terminology.';
		state.thinkingPresets = [
			{
				id: 'budget',
				name: 'Careful',
				parameters: { chat: { thinking: { budget_tokens: 4096 } } },
			},
		];
		await store.save(state);
		expect(await new StateStore(file, secrets).load()).toEqual(state);
		const before = await readFile(file, 'utf8');
		state.thinkingPresets[0].parameters.chat = { model: 'cannot-override-routing' };
		expect(() => store.save(state)).toThrow('cannot override');
		expect(await readFile(file, 'utf8')).toBe(before);
	});
	it('keeps keys in memory only without a system secret backend', async () => {
		const file = await filename();
		const unavailable: SecretStorage = {
			available: () => false,
			encrypt: () => {
				throw new Error('Must not encrypt');
			},
			decrypt: () => {
				throw new Error('Must not decrypt');
			},
		};
		const store = new StateStore(file, unavailable);
		await store.save(workspace());
		expect((await store.load())?.connections[0].apiKey).toBe('sk-test-secret');
		expect((await new StateStore(file, unavailable).load())?.connections[0].apiKey).toBe('');
		expect(JSON.parse(await readFile(file, 'utf8')).encryptedKeys).toEqual({});
		expect((await store.info()).secure).toBe(false);
	});
	it('serializes overlapping snapshots in save order', async () => {
		const file = await filename();
		const store = new StateStore(file, secretStorage());
		const state = workspace();
		const first = store.save(state);
		state.theme = 'dark';
		const last = store.save(state);
		state.theme = 'light';
		await Promise.all([first, last]);
		expect((await store.load())?.theme).toBe('dark');
	});
	it('surfaces corrupt state without replacing the original file', async () => {
		const file = await filename();
		await writeFile(file, '{broken');
		await expect(new StateStore(file, secretStorage()).load()).rejects.toThrow(
			'Could not open your saved workspace',
		);
		expect(await readFile(file, 'utf8')).toBe('{broken');
	});
	it('keeps the last successful file when encryption fails', async () => {
		const file = await filename();
		const secrets = secretStorage();
		const store = new StateStore(file, secrets);
		await store.save(workspace());
		const before = await readFile(file, 'utf8');
		secrets.encrypt = () => {
			throw new Error('Keychain locked');
		};
		await expect(store.save(workspace())).rejects.toThrow('Keychain locked');
		expect(await readFile(file, 'utf8')).toBe(before);
	});
});

describe('desktop payload validation', () => {
	it('accepts the complete initial state and rejects malformed nested state', () => {
		expect(() => validateState(workspace())).not.toThrow();
		const invalid = workspace();
		(invalid.connections[0].models as unknown) = null;
		expect(() => validateState(invalid)).toThrow('Workspace data is invalid');
	});
	it('accepts valid multipart uploads and rejects contradictory fields', () => {
		const request: WireRequest = {
			id: 'a',
			baseUrl: 'http://localhost:8000/v1',
			path: '/audio/transcriptions',
			method: 'POST',
			apiKey: '',
			form: [{ name: 'file', file: { name: 'audio.wav', type: 'audio/wav', base64: 'YQ==' } }],
		};
		expect(() => validateRequest(request)).not.toThrow();
		expect(() => validateRequest({ ...request, body: {} })).toThrow('Send JSON or form data');
		expect(() =>
			validateRequest({
				...request,
				form: [{ name: 'file', value: 'x', file: request.form![0].file }],
			}),
		).toThrow('Invalid API request');
	});
});

describe('split configuration and workspace persistence', () => {
	it('persists global Code policy in config.json across edits and reload without changing history', async () => {
		const file = await filename(),
			configFile = path.join(path.dirname(file), 'config.json');
		const secrets = secretStorage(),
			state = workspace();
		const store = new StateStore(file, secrets, configFile);
		await store.save(state);
		const history = await readFile(file, 'utf8');
		for (const codeCompaction of [
			{ thresholdPercent: 90, reserveTokens: 32_000 },
			{ thresholdPercent: 85, reserveTokens: 40_000 },
			{ thresholdPercent: 80, reserveTokens: 0 },
		]) {
			await store.save({ ...state, codeCompaction });
			expect(JSON.parse(await readFile(configFile, 'utf8')).codeCompaction).toEqual(codeCompaction);
			expect(await readFile(file, 'utf8')).toBe(history);
			expect(await new StateStore(file, secrets, configFile).load()).toMatchObject({
				codeCompaction,
			});
		}
		const before = await readFile(configFile, 'utf8');
		expect(() =>
			store.save({ ...state, codeCompaction: { thresholdPercent: 100, reserveTokens: 0 } }),
		).toThrow('compaction percentage');
		expect(await readFile(configFile, 'utf8')).toBe(before);
	});

	it('recovers and saves a legacy per-model policy while preserving capacity and encrypted credentials', async () => {
		const file = await filename(),
			configFile = path.join(path.dirname(file), 'config.json');
		const secrets = secretStorage(),
			state = workspace();
		state.connections[0].catalog = [
			{
				id: 'model',
				name: 'Reasoner',
				enabled: true,
				tasks: ['chat'],
				inputModalities: ['text'],
				outputModalities: ['text'],
				thinkingModes: [],
				contextWindow: 262_144,
				...{ compactionThresholdPercent: 85, compactionReserveTokens: 40_000 },
			},
		];
		const store = new StateStore(file, secrets, configFile);
		await store.save(state);
		const history = await readFile(file, 'utf8');
		const loaded = await store.load();
		const migrated = recoverState(loaded!);
		await store.save(migrated);
		const reloaded = await new StateStore(file, secrets, configFile).load();
		expect(reloaded?.codeCompaction).toEqual({ thresholdPercent: 85, reserveTokens: 40_000 });
		expect(reloaded?.connections[0].catalog?.[0]).toHaveProperty('contextWindow', 262_144);
		expect(reloaded?.connections[0].catalog?.[0]).not.toHaveProperty('compactionThresholdPercent');
		expect(reloaded?.connections[0].catalog?.[0]).not.toHaveProperty('compactionReserveTokens');
		expect(reloaded?.connections[0].apiKey).toBe('sk-test-secret');
		expect(JSON.parse(await readFile(configFile, 'utf8')).encryptedKeys.provider).toBeTruthy();
		expect(await readFile(configFile, 'utf8')).not.toContain('sk-test-secret');
		expect(await readFile(file, 'utf8')).toBe(history);
	});

	it('round-trips global policy in legacy backups and split imports and rejects misplaced preference data', () => {
		const state = workspace();
		state.codeCompaction = { thresholdPercent: 85, reserveTokens: 40_000 };
		const pair = splitLegacyWorkspace({ format: 'freelm-workspace-v1', state, encryptedKeys: {} });
		expect(pair.config.codeCompaction).toEqual(state.codeCompaction);
		expect(pair.workspace).not.toHaveProperty('codeCompaction');
		expect(validateSplitWorkspace(pair.config, pair.workspace).state.codeCompaction).toEqual(
			state.codeCompaction,
		);
		expect(() =>
			validateSplitWorkspace(pair.config, {
				...pair.workspace,
				codeCompaction: state.codeCompaction,
			}),
		).toThrow('Configuration belongs');
	});

	it('writes readable configuration separately from chat data and round-trips encrypted credentials', async () => {
		const file = await filename(),
			configFile = path.join(path.dirname(file), 'config.json');
		const secrets = secretStorage(),
			state = workspace();
		state.systemPrompt = 'Follow the project conventions.';
		state.thinkingPresets = [
			{ id: 'careful', name: 'Careful', parameters: { chat: { reasoning_effort: 'high' } } },
		];
		state.projects = [
			{ id: 'project', name: 'Project', instructions: 'Instructions', createdAt: 1 },
		];
		state.threads = [
			{
				id: 'thread',
				title: 'Chat',
				connectionId: 'provider',
				projectId: 'project',
				model: 'model',
				messages: [{ id: 'message', role: 'user', content: 'Saved conversation', createdAt: 1 }],
				createdAt: 1,
				updatedAt: 1,
			},
		];
		const store = new StateStore(file, secrets, configFile);
		await store.save(state);
		const configSource = await readFile(configFile, 'utf8'),
			workspaceSource = await readFile(file, 'utf8');
		const config = JSON.parse(configSource),
			data = JSON.parse(workspaceSource);
		expect(config).toMatchObject({
			format: 'freelm-config-v1',
			version: 1,
			systemPrompt: state.systemPrompt,
			thinkingPresets: state.thinkingPresets,
			connections: [{ apiKey: '' }],
		});
		expect(config).not.toHaveProperty('threads');
		expect(config).not.toHaveProperty('projects');
		expect(config).not.toHaveProperty('generations');
		expect(config).not.toHaveProperty('toolSettings');
		expect(configSource).toContain('\n  "connections":');
		expect(data).toEqual({
			format: 'freelm-workspace-v2',
			version: 1,
			threads: state.threads,
			projects: state.projects,
			generations: [],
		});
		expect(configSource + workspaceSource).not.toContain('sk-test-secret');
		expect(await new StateStore(file, secrets, configFile).load()).toEqual(state);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect((await stat(configFile)).mode & 0o777).toBe(0o600);
		expect(await readdir(path.dirname(file))).toEqual(['config.json', 'workspace.json']);
		expect((await store.info()).location).toBe(configFile);
	});

	it('migrates raw legacy JSON without changing ciphertext or adding absent configuration', async () => {
		const original = {
			format: 'freelm-workspace-v1',
			state: workspace(),
			encryptedKeys: { provider: 'AAECAwQF/v8=' },
		};
		const raw = JSON.stringify(original);
		const pair = splitLegacyWorkspace(raw);
		expect(pair.config.encryptedKeys.provider).toBe(original.encryptedKeys.provider);
		expect(pair.config.connections[0].apiKey).toBe('');
		expect(pair.config).not.toHaveProperty('systemPrompt');
		expect(pair.config).not.toHaveProperty('thinkingPresets');
		expect(pair.config).not.toHaveProperty('toolSettings');
		expect(JSON.stringify(original)).toBe(raw);
		const validated = validateSplitWorkspace(pair.config, pair.workspace);
		expect(validated.encryptedKeys).toEqual(original.encryptedKeys);
		expect(validated.state).toEqual({
			...workspace(),
			connections: [{ ...workspace().connections[0], apiKey: '' }],
		});
		validated.state.connections[0].name = 'Changed return value';
		expect(pair.config.connections[0].name).toBe('Local provider');
		expect(() => splitLegacyWorkspace({ ...original, encryptedKeys: [] })).toThrow(
			'encrypted API keys',
		);
	});

	it('rejects misplaced configuration, invalid versions and mismatched connection catalogs', () => {
		const pair = splitLegacyWorkspace({
			format: 'freelm-workspace-v1',
			state: workspace(),
			encryptedKeys: {},
		});
		expect(() => validateSplitWorkspace({ ...pair.config, threads: [] }, pair.workspace)).toThrow(
			'Configuration belongs',
		);
		expect(() =>
			validateSplitWorkspace(pair.config, { ...pair.workspace, toolSettings: {} }),
		).toThrow('Configuration belongs');
		expect(() =>
			validateSplitWorkspace(pair.config, { ...pair.workspace, debugMode: true }),
		).toThrow('Configuration belongs');
		expect(() => validateSplitWorkspace({ ...pair.config, version: 2 }, pair.workspace)).toThrow(
			'Unsupported',
		);
		expect(() =>
			validateSplitWorkspace({ ...pair.config, activeConnectionId: 'missing' }, pair.workspace),
		).toThrow('valid active connection');
	});

	it('persists debug mode in configuration across enabling and disabling without changing history', async () => {
		const file = await filename(),
			configFile = path.join(path.dirname(file), 'config.json');
		const secrets = secretStorage();
		const state = workspace();
		const store = new StateStore(file, secrets, configFile);
		await store.save(state);
		expect(JSON.parse(await readFile(configFile, 'utf8'))).not.toHaveProperty('debugMode');
		const history = await readFile(file, 'utf8');
		for (const debugMode of [true, false]) {
			await store.save({ ...state, debugMode });
			expect(JSON.parse(await readFile(configFile, 'utf8')).debugMode).toBe(debugMode);
			expect(await readFile(file, 'utf8')).toBe(history);
			expect(await new StateStore(file, secrets, configFile).load()).toMatchObject({ debugMode });
		}
		const before = await readFile(configFile, 'utf8');
		expect(() => store.save({ ...state, debugMode: 'yes' } as unknown as AppState)).toThrow(
			'Workspace data is invalid',
		);
		expect(await readFile(configFile, 'utf8')).toBe(before);
	});

	it('distinguishes first launch from a missing half and leaves corrupt configuration untouched', async () => {
		const file = await filename(),
			configFile = path.join(path.dirname(file), 'config.json');
		const store = new StateStore(file, secretStorage(), configFile);
		expect(await store.load()).toBeNull();
		await store.save(workspace());
		const config = await readFile(configFile, 'utf8'),
			data = await readFile(file, 'utf8');
		await rm(configFile);
		await expect(store.load()).rejects.toThrow('Both config.json and workspace.json');
		expect(await readFile(file, 'utf8')).toBe(data);
		await writeFile(configFile, config);
		await rm(file);
		await expect(store.load()).rejects.toThrow('Both config.json and workspace.json');
		expect(await readFile(configFile, 'utf8')).toBe(config);
		await writeFile(file, data);
		await writeFile(configFile, '{broken');
		await expect(store.load()).rejects.toThrow('Could not open your saved workspace');
		expect(await readFile(configFile, 'utf8')).toBe('{broken');
		expect(await readFile(file, 'utf8')).toBe(data);
	});

	it('loads manual configuration edits at the next startup without moving chat data', async () => {
		const file = await filename(),
			configFile = path.join(path.dirname(file), 'config.json');
		const secrets = secretStorage();
		await new StateStore(file, secrets, configFile).save(workspace());
		const config = JSON.parse(await readFile(configFile, 'utf8'));
		config.theme = 'light';
		config.systemPrompt = 'A manually edited prompt';
		config.connections[0].models.chat = 'another-model';
		config.connections[0].apiKey = 'ignored-plaintext-key';
		await writeFile(configFile, JSON.stringify(config));
		const result = await new StateStore(file, secrets, configFile).load();
		expect(result).toMatchObject({
			theme: 'light',
			systemPrompt: 'A manually edited prompt',
			connections: [{ models: { chat: 'another-model' }, apiKey: 'sk-test-secret' }],
		});
	});

	it('serializes a load between saves so it never reads halves from different snapshots', async () => {
		const file = await filename(),
			configFile = path.join(path.dirname(file), 'config.json');
		const secrets = secretStorage();
		const encrypt = secrets.encrypt;
		let release!: () => void,
			calls = 0;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		secrets.encrypt = async (value) => {
			if (++calls === 1) await blocked;
			return await encrypt(value);
		};
		const store = new StateStore(file, secrets, configFile),
			first = workspace();
		first.theme = 'dark';
		first.projects = [{ id: 'dark', name: 'Dark snapshot', instructions: '', createdAt: 1 }];
		const savedFirst = store.save(first);
		const between = store.load();
		const second = structuredClone(first);
		second.theme = 'light';
		second.projects[0].name = 'Light snapshot';
		const savedSecond = store.save(second);
		release();
		await savedFirst;
		expect(await between).toMatchObject({ theme: 'dark', projects: [{ name: 'Dark snapshot' }] });
		await savedSecond;
		expect(await store.load()).toMatchObject({
			theme: 'light',
			projects: [{ name: 'Light snapshot' }],
		});
	});

	it('leaves both existing files unchanged if encryption fails before the journal commit', async () => {
		const file = await filename(),
			configFile = path.join(path.dirname(file), 'config.json');
		const secrets = secretStorage(),
			store = new StateStore(file, secrets, configFile);
		await store.save(workspace());
		const before = [await readFile(configFile, 'utf8'), await readFile(file, 'utf8')];
		secrets.encrypt = () => {
			throw new Error('Keychain locked');
		};
		await expect(store.save({ ...workspace(), theme: 'dark' })).rejects.toThrow('Keychain locked');
		expect([await readFile(configFile, 'utf8'), await readFile(file, 'utf8')]).toEqual(before);
		expect(await readdir(path.dirname(file))).toEqual(['config.json', 'workspace.json']);
	});

	it('recovers a committed transaction even if neither destination existed when the app stopped', async () => {
		const legacy = await filename(),
			secrets = secretStorage();
		await new StateStore(legacy, secrets).save(workspace());
		const pair = splitLegacyWorkspace(await readFile(legacy, 'utf8'));
		const folder = path.join(path.dirname(legacy), 'new-home');
		await mkdir(folder);
		const file = path.join(folder, 'workspace.json'),
			configFile = path.join(folder, 'config.json');
		await writeFile(
			`${file}.pending`,
			JSON.stringify({ format: 'freelm-state-transaction-v1', ...pair }),
		);
		const encrypt = vi.fn(secrets.encrypt);
		secrets.encrypt = encrypt;
		expect(await new StateStore(file, secrets, configFile).load()).toEqual(workspace());
		expect(JSON.parse(await readFile(configFile, 'utf8')).encryptedKeys).toEqual(
			pair.config.encryptedKeys,
		);
		expect(encrypt).not.toHaveBeenCalled();
		expect(await readdir(folder)).toEqual(['config.json', 'workspace.json']);
	});

	it('retains a redo journal after a real second-file replacement failure and recovers the complete pair', async () => {
		const file = await filename(),
			configFile = path.join(path.dirname(file), 'config.json');
		const secrets = secretStorage(),
			store = new StateStore(file, secrets, configFile);
		await store.save(workspace());
		await rename(file, `${file}.old`);
		await mkdir(file);
		const newer = workspace();
		newer.theme = 'dark';
		newer.projects = [{ id: 'new', name: 'New snapshot', instructions: '', createdAt: 1 }];
		await expect(store.save(newer)).rejects.toThrow('Could not save your workspace');
		const transaction = JSON.parse(await readFile(`${file}.pending`, 'utf8'));
		expect(transaction).toMatchObject({
			format: 'freelm-state-transaction-v1',
			config: { theme: 'dark' },
			workspace: { projects: [{ name: 'New snapshot' }] },
		});
		expect(JSON.stringify(transaction)).not.toContain('sk-test-secret');
		expect(JSON.parse(await readFile(configFile, 'utf8')).theme).toBe('dark');
		await rm(file, { recursive: true });
		await rename(`${file}.old`, file);
		expect(JSON.parse(await readFile(file, 'utf8')).projects).toEqual([]);
		expect(await new StateStore(file, secrets, configFile).load()).toEqual(newer);
		expect(JSON.parse(await readFile(configFile, 'utf8')).encryptedKeys).toEqual(
			transaction.config.encryptedKeys,
		);
		expect(await readdir(path.dirname(file))).toEqual(['config.json', 'workspace.json']);
	});

	it('protects existing files and an invalid journal rather than guessing a recovery state', async () => {
		const file = await filename(),
			configFile = path.join(path.dirname(file), 'config.json');
		const store = new StateStore(file, secretStorage(), configFile);
		await store.save(workspace());
		const before = [await readFile(configFile, 'utf8'), await readFile(file, 'utf8')];
		await writeFile(`${file}.pending`, '{broken');
		await expect(store.load()).rejects.toThrow('pending workspace transaction is invalid');
		await expect(store.save(workspace())).rejects.toThrow(
			'pending workspace transaction is invalid',
		);
		expect([await readFile(configFile, 'utf8'), await readFile(file, 'utf8')]).toEqual(before);
		expect(await readFile(`${file}.pending`, 'utf8')).toBe('{broken');
	});

	it.each([false, true])(
		'preserves ciphertext through unrelated saves while secrets are unavailable (split=%s)',
		async (split) => {
			const file = await filename(),
				configFile = split ? path.join(path.dirname(file), 'config.json') : undefined;
			const secrets = secretStorage();
			await new StateStore(file, secrets, configFile).save(workspace());
			const before = JSON.parse(await readFile(configFile ?? file, 'utf8')).encryptedKeys;
			let available = false;
			secrets.available = () => available;
			const encrypt = vi.fn(secrets.encrypt);
			secrets.encrypt = encrypt;
			const store = new StateStore(file, secrets, configFile);
			const state = (await store.load())!;
			expect(state.connections[0].apiKey).toBe('');
			state.theme = 'dark';
			await store.save(state);
			expect(encrypt).not.toHaveBeenCalled();
			expect(JSON.parse(await readFile(configFile ?? file, 'utf8')).encryptedKeys).toEqual(before);
			available = true;
			expect((await store.load())!.connections[0].apiKey).toBe('sk-test-secret');
			expect((await new StateStore(file, secrets, configFile).load())!.connections[0].apiKey).toBe(
				'sk-test-secret',
			);
		},
	);
	it.each([false, true])(
		'preserves locked ciphertext on keyless saves without probing again, then unlocks it on reopen (split=%s)',
		async (split) => {
			const file = await filename();
			const configFile = split ? path.join(path.dirname(file), 'config.json') : undefined;
			const secrets = secretStorage();
			await new StateStore(file, secrets, configFile).save(workspace());
			const before = JSON.parse(await readFile(configFile ?? file, 'utf8')).encryptedKeys;
			const available = vi.fn(async () => false);
			secrets.available = available;
			const store = new StateStore(file, secrets, configFile);
			const state = (await store.load())!;
			available.mockImplementation(async () => {
				throw new Error('Must not probe on a keyless save');
			});
			state.theme = 'light';
			await store.save(state);
			expect(available).toHaveBeenCalledTimes(1);
			expect(JSON.parse(await readFile(configFile ?? file, 'utf8')).encryptedKeys).toEqual(before);
			secrets.available = () => true;
			expect((await new StateStore(file, secrets, configFile).load())!.connections[0].apiKey).toBe(
				'sk-test-secret',
			);
		},
	);
	it.each([false, true])(
		'allows explicitly clearing unlocked credentials without a keychain probe (split=%s)',
		async (split) => {
			const file = await filename();
			const configFile = split ? path.join(path.dirname(file), 'config.json') : undefined;
			const secrets = secretStorage();
			await new StateStore(file, secrets, configFile).save(workspace());
			const store = new StateStore(file, secrets, configFile);
			const state = (await store.load())!;
			secrets.available = vi.fn(() => {
				throw new Error('No credential to encrypt');
			});
			state.connections[0].apiKey = '';
			await store.save(state);
			expect(secrets.available).not.toHaveBeenCalled();
			expect(JSON.parse(await readFile(configFile ?? file, 'utf8')).encryptedKeys).toEqual({});
			expect((await new StateStore(file, secrets, configFile).load())!.connections[0].apiKey).toBe(
				'',
			);
		},
	);

	it('keeps a newly entered replacement key in memory while preserving encrypted disk credentials without a keychain', async () => {
		const file = await filename(),
			configFile = path.join(path.dirname(file), 'config.json'),
			secrets = secretStorage();
		await new StateStore(file, secrets, configFile).save(workspace());
		const before = JSON.parse(await readFile(configFile, 'utf8')).encryptedKeys;
		secrets.available = () => false;
		const store = new StateStore(file, secrets, configFile);
		const state = (await store.load())!;
		state.connections[0].apiKey = 'session-only-replacement';
		await store.save(state);
		expect((await store.load())!.connections[0].apiKey).toBe('session-only-replacement');
		expect(JSON.parse(await readFile(configFile, 'utf8')).encryptedKeys).toEqual(before);
		expect(await readFile(configFile, 'utf8')).not.toContain('session-only-replacement');
		secrets.available = () => true;
		expect((await new StateStore(file, secrets, configFile).load())!.connections[0].apiKey).toBe(
			'sk-test-secret',
		);
	});

	it('preserves locked keys across direct saves when the keychain becomes available before a reload', async () => {
		const file = await filename(),
			configFile = path.join(path.dirname(file), 'config.json'),
			secrets = secretStorage();
		await new StateStore(file, secrets, configFile).save(workspace());
		const before = JSON.parse(await readFile(configFile, 'utf8')).encryptedKeys;
		let available = false;
		secrets.available = () => available;
		const store = new StateStore(file, secrets, configFile);
		const state = workspace();
		state.connections[0].apiKey = '';
		await store.save(state);
		available = true;
		state.theme = 'dark';
		await store.save(state);
		expect(JSON.parse(await readFile(configFile, 'utf8')).encryptedKeys).toEqual(before);
		expect((await store.load())!.connections[0].apiKey).toBe('sk-test-secret');
	});
});

describe('bounded media persistence', () => {
	async function watchWrites(shortWrites = false) {
		const probe = await filename();
		const handle = await open(probe, 'w');
		const prototype = Object.getPrototypeOf(handle);
		const original = prototype.write;
		await handle.close();
		let calls = 0,
			largest = 0;
		const spy = vi.spyOn(prototype, 'write').mockImplementation(async function (
			this: typeof handle,
			...args: unknown[]
		) {
			const [buffer, offset, length, position] = args as [Buffer, number, number, number | null];
			expect(Buffer.isBuffer(buffer)).toBe(true);
			calls++;
			largest = Math.max(largest, buffer.length, length);
			// Avoid retaining every media chunk in Vitest's mock call history.
			spy.mockClear();
			return await original.call(
				this,
				buffer,
				offset,
				shortWrites ? Math.min(length, 8191) : length,
				position,
			);
		});
		return { spy, metrics: () => ({ calls, largest }) };
	}
	function mediaState(megabytes: number): AppState {
		const state = workspace();
		const url = 'data:image/png;base64,' + 'A'.repeat(megabytes * 1024 * 1024);
		state.generations = [
			{
				id: 'large-image',
				kind: 'images',
				prompt: 'A generated image',
				model: 'image-model',
				connectionId: 'provider',
				createdAt: 1,
				status: 'completed',
				assets: [{ url, mimeType: 'image/png', name: 'image.png' }],
			},
		];
		return state;
	}

	it.each([false, true])(
		'matches JSON escaping and UTF-8 through partial buffer writes (split=%s)',
		async (split) => {
			const file = await filename(),
				secrets = secretStorage();
			const config = split ? path.join(path.dirname(file), 'config.json') : undefined;
			const state = mediaState(2);
			const special =
				'a'.repeat(16383) +
				'🚀日本語é' +
				'\ud800' +
				'\udc00' +
				'\ud800x\udc00' +
				'\n\t\r\b\f\u0000"\\';
			state.systemPrompt = special;
			state.generations[0].prompt = special;
			const writes = await watchWrites(true);
			await new StateStore(file, secrets, config).save(state);
			expect(writes.metrics().calls).toBeGreaterThan(200);
			expect(writes.metrics().largest).toBeLessThanOrEqual(256 * 1024);
			expect(await new StateStore(file, secrets, config).load()).toEqual(state);
			const raw = await readFile(file, 'utf8');
			const parsed = JSON.parse(raw);
			expect(raw).toBe(JSON.stringify(parsed));
			if (config) {
				const source = await readFile(config, 'utf8');
				expect(source).toBe(JSON.stringify(JSON.parse(source), null, 2) + '\n');
			}
		},
	);

	it('saves repeated large images and recovers an interrupted media save without large writes', async () => {
		const file = await filename(),
			config = path.join(path.dirname(file), 'config.json');
		const secrets = secretStorage(),
			store = new StateStore(file, secrets, config);
		const first = mediaState(12);
		first.generations = Array.from({ length: 4 }, (_, index) => ({
			...first.generations[0],
			id: `image-${index}`,
		}));
		const writes = await watchWrites();
		await store.saveSnapshot(first);
		expect((await stat(file)).size).toBeLessThan(10_000);
		const mediaDirectory = path.join(path.dirname(file), 'media');
		const mediaFiles = await readdir(mediaDirectory);
		expect(mediaFiles).toHaveLength(1);
		expect((await stat(path.join(mediaDirectory, mediaFiles[0]))).size).toBeGreaterThan(
			12 * 1024 * 1024,
		);
		const newer = {
			...first,
			theme: 'dark' as const,
			generations: [...first.generations, { ...first.generations[0], id: 'image-next' }],
		};
		await rename(file, `${file}.old`);
		await mkdir(file);
		await expect(store.saveSnapshot(newer)).rejects.toThrow('Could not save your workspace');
		expect((await stat(`${file}.pending`)).size).toBeLessThan(10_000);
		await rm(file, { recursive: true });
		await rename(`${file}.old`, file);
		const recovered = await new StateStore(file, secrets, config).load();
		expect(recovered?.theme).toBe('dark');
		expect(recovered?.generations.map((item) => item.id)).toEqual(
			newer.generations.map((item) => item.id),
		);
		expect(
			recovered?.generations.every(
				(item) => item.assets[0].url === first.generations[0].assets[0].url,
			),
		).toBe(true);
		expect(writes.metrics().calls).toBeGreaterThan(45);
		expect(writes.metrics().largest).toBeLessThanOrEqual(256 * 1024);
		expect(await readdir(path.dirname(file))).toEqual(['config.json', 'media', 'workspace.json']);
	}, 30_000);

	it('persists a logical gallery above 512 MB without duplicating large immutable strings', async () => {
		const file = await filename(),
			config = path.join(path.dirname(file), 'config.json');
		const secrets = secretStorage();
		const store = new StateStore(file, secrets, config);
		await store.save(workspace());
		const oversized = mediaState(8);
		// Shared immutable records let this exercise a >512 MB file without a >512 MB fixture allocation.
		oversized.generations = Array(65).fill(oversized.generations[0]);
		await store.saveSnapshot(oversized);
		expect((await stat(file)).size).toBeLessThan(32_000);
		const media = await readdir(path.join(path.dirname(file), 'media'));
		expect(media).toHaveLength(1);
		const restored = (await new StateStore(file, secrets, config).load())!;
		expect(restored.generations).toHaveLength(65);
		expect(
			restored.generations.every(
				(generation) => generation.assets[0].url === oversized.generations[0].assets[0].url,
			),
		).toBe(true);
		expect(await readdir(path.dirname(file))).toEqual(['config.json', 'media', 'workspace.json']);
	});

	it('preserves both files when a zero-progress write fails and can save again afterward', async () => {
		const file = await filename(),
			config = path.join(path.dirname(file), 'config.json');
		const store = new StateStore(file, secretStorage(), config);
		await store.save(workspace());
		const before = [await readFile(file, 'utf8'), await readFile(config, 'utf8')];
		const writes = await watchWrites();
		writes.spy.mockImplementationOnce(async () => ({ bytesWritten: 0 }));
		await expect(store.save({ ...workspace(), theme: 'dark' })).rejects.toThrow('made no progress');
		expect([await readFile(file, 'utf8'), await readFile(config, 'utf8')]).toEqual(before);
		expect(await readdir(path.dirname(file))).toEqual(['config.json', 'workspace.json']);
		await store.save({ ...workspace(), theme: 'light' });
		expect((await store.load())?.theme).toBe('light');
	});
	it('checks media checksums and preserves a damaged profile for recovery', async () => {
		const file = await filename(),
			config = path.join(path.dirname(file), 'config.json');
		const secrets = secretStorage(),
			store = new StateStore(file, secrets, config);
		await store.save(mediaState(1));
		const before = await readFile(file, 'utf8');
		const directory = path.join(path.dirname(file), 'media');
		const [blob] = await readdir(directory);
		await writeFile(path.join(directory, blob), '"damaged"');
		await expect(new StateStore(file, secrets, config).load()).rejects.toThrow(
			'media file is damaged',
		);
		expect(await readFile(file, 'utf8')).toBe(before);
		expect(await readFile(path.join(directory, blob), 'utf8')).toBe('"damaged"');
	});
	it('rejects media path traversal before reading any referenced content', async () => {
		const file = await filename(),
			config = path.join(path.dirname(file), 'config.json');
		const secrets = secretStorage();
		await new StateStore(file, secrets, config).save(mediaState(1));
		const source = JSON.parse(await readFile(file, 'utf8'));
		source.blobs[0].hash = '../config';
		await writeFile(file, JSON.stringify(source));
		const before = await readFile(file, 'utf8');
		await expect(new StateStore(file, secrets, config).load()).rejects.toThrow(
			'Invalid workspace media reference',
		);
		expect(await readFile(file, 'utf8')).toBe(before);
	});
	it('rejects oversized metadata before replacing the existing pair', async () => {
		const file = await filename(),
			config = path.join(path.dirname(file), 'config.json');
		const secrets = secretStorage(),
			store = new StateStore(file, secrets, config);
		await store.save(workspace());
		const before = [await readFile(file, 'utf8'), await readFile(config, 'utf8')];
		const next = workspace();
		const project = {
			id: 'project',
			name: 'Project',
			instructions: 'X'.repeat(6000),
			createdAt: 1,
		};
		next.projects = Array(100_000).fill(project);
		await expect(store.saveSnapshot(next)).rejects.toThrow('512 MB');
		expect([await readFile(file, 'utf8'), await readFile(config, 'utf8')]).toEqual(before);
		expect(await readdir(path.dirname(file))).toEqual(['config.json', 'workspace.json']);
	});
	it('writes only small metadata when changing a chat beside a large gallery and prunes media after commit', async () => {
		const file = await filename(),
			config = path.join(path.dirname(file), 'config.json');
		const secrets = secretStorage(),
			store = new StateStore(file, secrets, config);
		const first = mediaState(12);
		await store.saveSnapshot(first);
		const writes = await watchWrites();
		const next = {
			...first,
			threads: [
				{
					id: 'chat',
					title: 'Chat',
					connectionId: 'provider',
					model: 'model',
					createdAt: 1,
					updatedAt: 1,
					messages: [{ id: 'message', role: 'user' as const, content: 'Hello', createdAt: 1 }],
				},
			],
		};
		await store.saveSnapshot(next, first);
		expect(writes.metrics().largest).toBeLessThan(10_000);
		expect((await store.load())?.generations).toEqual(first.generations);
		await store.saveSnapshot({ ...next, generations: [] }, next);
		expect(await readdir(path.join(path.dirname(file), 'media'))).toEqual([]);
	});
});

describe('generated video persistence', () => {
	it('round trips a video above the old generic-file limit through external media storage', async () => {
		const file = await filename();
		const config = path.join(path.dirname(file), 'config.json');
		const dataUrl = `data:video/mp4;base64,${'A'.repeat(13_000_000)}`;
		const state = workspace();
		state.threads = [
			{
				id: 'video-chat',
				title: 'Video',
				kind: 'chat',
				connectionId: 'provider',
				model: 'model',
				createdAt: 1,
				updatedAt: 2,
				messages: [
					{
						id: 'reply',
						role: 'assistant',
						content: 'Ready',
						createdAt: 2,
						toolCalls: [
							{
								id: 'video-call',
								name: 'video_gen.videogen',
								arguments: '{"prompt":"waves"}',
								status: 'completed',
								startedAt: 1,
								result: {
									content: [{ type: 'file', dataUrl, name: 'waves.mp4', mimeType: 'video/mp4' }],
								},
							},
						],
					},
				],
			},
		];
		const secrets = secretStorage();
		const store = new StateStore(file, secrets, config);
		await store.saveSnapshot(state);
		expect((await stat(file)).size).toBeLessThan(10000);
		expect(await new StateStore(file, secrets, config).load()).toEqual(state);
	});
});
