import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppState, Message, Project, Thread } from '../src/types';
import { initialState, recoverState } from '../src/lib/state';
import { migrateConversationKinds, projectKind, threadKind } from '../src/lib/conversation-kind';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { AgentHost } from '../electron/agent-host';
import { ToolRuntime } from '../electron/tools/runtime';
import { StateStore } from '../electron/state-store';
import { WorkspaceAuthority } from '../electron/workspace-authority';
import { validateState } from '../electron/validation';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.restoreAllMocks();
});
const project = (overrides: Partial<Project> = {}): Project => ({
	id: 'project',
	name: 'Project',
	instructions: '',
	createdAt: 1,
	...overrides,
});
const thread = (overrides: Partial<Thread> = {}): Thread => ({
	id: 'thread',
	title: 'Conversation',
	connectionId: 'connection',
	model: 'model',
	createdAt: 1,
	updatedAt: 1,
	messages: [],
	...overrides,
});
const message = (overrides: Partial<Message> = {}): Message => ({
	id: 'message',
	role: 'assistant',
	content: 'Done',
	createdAt: 1,
	...overrides,
});
function stateFor(conversation: Partial<Thread> = {}): AppState {
	const state = initialState();
	state.threads = [thread({ connectionId: state.activeConnectionId, ...conversation })];
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: true,
		commandExecution: true,
		allowRemote: true,
		workspaceRoot: tmpdir(),
	};
	return state;
}
async function authorityFor(state: AppState) {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-kinds-'));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const store = new StateStore(path.join(directory, 'workspace.json'), {
		available: () => false,
		encrypt: () => {
			throw new Error('Not available');
		},
		decrypt: () => {
			throw new Error('Not available');
		},
	});
	await store.save(state);
	return new WorkspaceAuthority(store);
}
function hostFor(state: AppState, approve = async () => true) {
	const host = new AgentHost(async () => structuredClone(state), approve);
	cleanup.push(() => host.close());
	return host;
}
const execute = (host: AgentHost) =>
	host.execute({
		workspaceId: 'local',
		runId: 'run',
		threadId: 'thread',
		name: 'exec_command',
		arguments: { cmd: 'echo should-not-run' },
	});

describe('Chat and Code classification', () => {
	it('keeps ordinary legacy chats and unbound projects in Chat', () => {
		expect(projectKind(project())).toBe('chat');
		expect(projectKind(project({ directories: [] }))).toBe('chat');
		expect(threadKind(thread())).toBe('chat');
		expect(threadKind(thread({ projectId: 'project' }), [project()])).toBe('chat');
	});

	it('classifies bound projects and legacy tool or transcript conversations as Code', () => {
		const bound = project({ directories: ['/project'] });
		expect(projectKind(bound)).toBe('code');
		expect(threadKind(thread({ projectId: bound.id }), [bound])).toBe('code');
		expect(
			threadKind(
				thread({
					messages: [
						message({
							toolCalls: [
								{
									id: 'call',
									name: 'exec_command',
									arguments: '{}',
									status: 'completed',
									startedAt: 1,
								},
							],
						}),
					],
				}),
			),
		).toBe('code');
		expect(
			threadKind(
				thread({ messages: [message({ agentTranscript: { api: 'responses', items: [] } })] }),
			),
		).toBe('code');
		expect(threadKind(thread({ messages: [message({ toolCalls: [] })] }))).toBe('chat');
	});

	it('gives explicit kinds precedence over legacy evidence', () => {
		expect(projectKind(project({ kind: 'chat', directories: ['/legacy'] }))).toBe('chat');
		expect(projectKind(project({ kind: 'code' }))).toBe('code');
		expect(
			threadKind(
				thread({
					kind: 'chat',
					projectId: 'project',
					messages: [
						message({
							agentTranscript: { api: 'chat', items: [{ role: 'assistant', content: 'Legacy' }] },
						}),
					],
				}),
				[project({ directories: ['/legacy'] })],
			),
		).toBe('chat');
		expect(threadKind(thread({ kind: 'code' }))).toBe('code');
	});

	it('materializes kinds immutably and idempotently, preserving mixed legacy projects', () => {
		const state = stateFor({
			projectId: 'project',
			messages: [
				message({
					agentTranscript: { api: 'responses', items: [] },
				}),
			],
		});
		state.projects = [project()];
		const migrated = migrateConversationKinds(state);
		expect(state.projects[0].kind).toBeUndefined();
		expect(state.threads[0].kind).toBeUndefined();
		expect(migrated.projects[0].kind).toBe('chat');
		expect(migrated.threads[0]).toMatchObject({ kind: 'code', projectId: 'project' });
		expect(migrated.threads[0].messages).toBe(state.threads[0].messages);
		expect(migrateConversationKinds(migrated)).toBe(migrated);
		expect(() => validateState(migrated)).not.toThrow();
		expect(recoverState(state).threads[0].kind).toBe('code');
	});

	it('validates optional kind values and rejects filesystem bindings on explicit Chat projects', () => {
		const state = stateFor();
		state.projects = [project({ directories: ['/legacy'] })];
		expect(() => validateState(state)).not.toThrow();
		state.projects[0].kind = 'chat';
		expect(() => validateState(state)).toThrow('Workspace data is invalid');
		state.projects[0].directories = [];
		expect(() => validateState(state)).not.toThrow();
		(state.threads[0] as unknown as { kind: string }).kind = 'images';
		expect(() => validateState(state)).toThrow('Workspace data is invalid');
	});
});

describe('host conversation boundary', () => {
	it.each([undefined, 'chat'] as const)(
		'keeps %s Chat machine-independent despite enabled Code tools',
		async (kind) => {
			const state = stateFor({ kind });
			const approve = vi.fn(async () => true);
			const catalog = vi.spyOn(ToolRuntime.prototype, 'catalog');
			const run = vi.spyOn(ToolRuntime.prototype, 'execute');
			const host = hostFor(state, approve);
			const offered = await host.catalog('run', 'thread');
			expect(offered.tools).toEqual([]);
			expect(offered.context ?? []).toEqual([]);
			expect(offered.codeCapabilities).toBeUndefined();
			await expect(execute(host)).rejects.toThrow('available only in Code');
			expect(approve).not.toHaveBeenCalled();
			expect(catalog).not.toHaveBeenCalled();
			expect(run).not.toHaveBeenCalled();
		},
	);

	it('keeps explicit Chat isolated even when its saved history and project contain Code evidence', async () => {
		const state = stateFor({
			kind: 'chat',
			projectId: 'project',
			messages: [
				message({
					agentTranscript: { api: 'responses', items: [] },
				}),
			],
		});
		state.projects = [project({ directories: [tmpdir()] })];
		const approve = vi.fn(async () => true);
		const catalog = vi.spyOn(ToolRuntime.prototype, 'catalog');
		const run = vi.spyOn(ToolRuntime.prototype, 'execute');
		const host = hostFor(state, approve);
		const offered = await host.catalog('run', 'thread', true);
		expect(offered.tools).toEqual([]);
		expect(offered.context ?? []).toEqual([]);
		expect(offered.codeCapabilities).toBeUndefined();
		await expect(execute(host)).rejects.toThrow('available only in Code');
		expect(approve).not.toHaveBeenCalled();
		expect(catalog).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});

	it('rechecks saved kind before executing an existing run', async () => {
		const state = stateFor({ kind: 'code' });
		const approve = vi.fn(async () => true);
		const run = vi.spyOn(ToolRuntime.prototype, 'execute');
		const host = hostFor(state, approve);
		await host.catalog('run', 'thread');
		state.threads[0].kind = 'chat';
		await expect(execute(host)).rejects.toThrow('only in Code');
		expect(approve).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});

	it('rechecks saved kind after approval, cancelling instead of executing', async () => {
		const state = stateFor({ kind: 'code' });
		let approve!: (value: boolean) => void;
		const consent = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					approve = resolve;
				}),
		);
		const run = vi.spyOn(ToolRuntime.prototype, 'execute');
		const host = hostFor(state, consent);
		await host.catalog('run', 'thread');
		const pending = execute(host);
		const rejected = expect(pending).rejects.toThrow('only in Code');
		await vi.waitFor(() => expect(consent).toHaveBeenCalledTimes(1));
		state.threads[0].kind = 'chat';
		approve(true);
		await rejected;
		expect(run).not.toHaveBeenCalled();
	});

	it('classifies legacy tool history before the lightweight host snapshot drops messages', async () => {
		const state = stateFor({
			messages: [message({ agentTranscript: { api: 'responses', items: [] } })],
		});
		const authority = await authorityFor(state);
		const snapshot = (await authority.loadToolState())!;
		expect(snapshot.threads[0]).toMatchObject({ kind: 'code', messages: [] });
		const host = new AgentHost(
			() => authority.loadToolState(),
			async () => true,
		);
		cleanup.push(() => host.close());
		expect(
			(await host.catalog('run', 'thread')).tools.some((tool) => tool.name === 'exec_command'),
		).toBe(true);
	});

	it('allows remote migration-only kind writes but rejects conversion of existing conversations or projects', async () => {
		const state = stateFor();
		state.projects = [project(), project({ id: 'code-project', directories: [tmpdir()] })];
		const authority = await authorityFor(state);
		const snapshot = await authority.load(true);
		await authority.save(migrateConversationKinds(snapshot.state!), snapshot.revision, true);
		const converted = await authority.load(true);
		converted.state!.threads[0].kind = 'code';
		await expect(authority.save(converted.state!, converted.revision, true)).rejects.toThrow(
			'Conversation kinds',
		);
		const projectConversion = await authority.load(true);
		projectConversion.state!.projects[0].kind = 'code';
		await expect(
			authority.save(projectConversion.state!, projectConversion.revision, true),
		).rejects.toThrow('Project kinds');
		const newCode = await authority.load(true);
		newCode.state!.threads.push(
			thread({ id: 'new-code', kind: 'code', projectId: 'code-project' }),
		);
		await expect(authority.save(newCode.state!, newCode.revision, true)).resolves.toHaveProperty(
			'revision',
		);
	});
});
