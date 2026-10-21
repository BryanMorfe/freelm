import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState, Message, Thread } from '../src/types';
import type { CodeTaskStatus } from '../src/lib/code-task-tools';
import { initialState } from '../src/lib/state';
import {
	botTaskTools,
	assertBotTaskRemoteExecution,
	executeBotTaskTool,
	isBotTaskTool,
	type BotTaskToolContext,
} from '../src/lib/bot-task-tools';

const message = (id: string, role: Message['role'], content = id): Message => ({
	id,
	role,
	content,
	createdAt: 1,
	...(role === 'assistant' ? { completedAt: 2 } : {}),
});
function fixture() {
	let state: AppState = initialState();
	const connection = state.connections[0];
	connection.id = 'provider';
	connection.name = 'Private provider';
	connection.apiKey = 'sk-secret-fixture';
	connection.baseUrl = 'https://private.example/v1';
	connection.models.chat = 'text-model';
	state.activeConnectionId = connection.id;
	connection.catalog = [
		{
			id: 'text-model',
			name: 'Text model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'high', name: 'High', parameters: { responses: { reasoning: { effort: 'high' } } } },
			],
		},
	];
	state.projects = [
		{
			id: 'chat-project',
			name: 'Conversations',
			kind: 'chat',
			instructions: 'Private Chat instructions',
			createdAt: 1,
		},
		{
			id: 'code-project',
			name: 'Coding',
			kind: 'code',
			instructions: 'Private Code instructions',
			directories: ['/project'],
			createdAt: 1,
		},
	];
	const thread = (id: string, changes: Partial<Thread> = {}): Thread => ({
		id,
		title: id,
		kind: 'chat',
		connectionId: connection.id,
		model: 'text-model',
		thinkingMode: 'high',
		messages: [message(`${id}-user`, 'user'), message(`${id}-reply`, 'assistant')],
		createdAt: 1,
		updatedAt: 2,
		...changes,
	});
	state.threads = [
		thread('chat'),
		thread('code', { kind: 'code', projectId: 'code-project', permissionMode: 'auto-review' }),
		thread('archived', { archivedAt: 3 }),
		thread('temporary', { temporary: true, updatedAt: 10 }),
	];
	const statuses: Record<string, CodeTaskStatus> = {
		chat: 'completed',
		code: 'working',
		archived: 'completed',
	};
	const dispatched: string[] = [],
		cancelled: string[][] = [];
	let sequence = 0,
		mutations = 0;
	const context: BotTaskToolContext = {
		hostId: 'host-a',
		loadState: async () => state,
		mutate: async <T>(update: (current: AppState) => { state: AppState; value: T }) => {
			mutations++;
			const result = update(state);
			state = result.state;
			return result.value;
		},
		dispatch: async (id) => {
			expect(state.threads.find((item) => item.id === id)?.queuedMessages?.length).toBeGreaterThan(
				0,
			);
			dispatched.push(id);
			return { status: statuses[id] === 'working' ? 'queued' : 'started' };
		},
		statuses: async (ids) => Object.fromEntries(ids.map((id) => [id, statuses[id] ?? 'idle'])),
		cancel: async (ids) => {
			cancelled.push([...ids]);
		},
		id: () => `operation-${++sequence}`,
		now: () => 100,
	};
	return {
		context,
		thread,
		statuses,
		dispatched,
		cancelled,
		get state() {
			return state;
		},
		get mutations() {
			return mutations;
		},
	};
}
// Tool payloads deliberately have varying shapes, like their JSON consumer.
const run = (
	name: string,
	args: Record<string, unknown>,
	context: BotTaskToolContext,
): Promise<any> => executeBotTaskTool(name, args, context);
afterEach(() => vi.useRealTimers());

describe('bot thread coordination tools', () => {
	it('requires remote tool permission for remote Code creation and messages, including legacy Code projects', () => {
		const f = fixture();
		for (const [name, args] of [
			['threads_create', { kind: 'code', prompt: 'Work' }],
			['threads_send', { threadId: 'code', prompt: 'Continue' }],
		] as const)
			expect(() => assertBotTaskRemoteExecution(name, args, f.state)).toThrow('Settings → Tools');
		delete f.state.threads[1].kind;
		expect(() =>
			assertBotTaskRemoteExecution(
				'threads_send',
				{ threadId: 'code', prompt: 'Continue' },
				f.state,
			),
		).toThrow('Remote Code execution is disabled');
		expect(() => assertBotTaskRemoteExecution('threads_create', { kind: 'code' }, null)).toThrow(
			'Settings → Tools',
		);
	});
	it('honors current remote tool opt-in and revocation without granting task permissions', () => {
		const f = fixture();
		f.state.toolSettings = {
			enabled: true,
			workspaceRoot: '',
			commandExecution: true,
			approvalMode: 'ask',
			allowRemote: true,
			imageGeneration: { enabled: false, connectionId: '', model: '', size: '', quality: '' },
			mcpServers: [],
			skillDirectories: [],
		};
		for (const [name, args] of [
			['threads_create', { kind: 'code', prompt: 'Work' }],
			['threads_send', { threadId: 'code', prompt: 'Continue' }],
		] as const)
			expect(() => assertBotTaskRemoteExecution(name, args, f.state)).not.toThrow();
		expect(f.state.threads[1].permissionMode).toBe('auto-review');
		f.state.toolSettings.allowRemote = false;
		expect(() =>
			assertBotTaskRemoteExecution(
				'threads_send',
				{ threadId: 'code', prompt: 'Continue' },
				f.state,
			),
		).toThrow('Settings → Tools');
	});
	it('leaves remote Chat, read and management operations unaffected by the Code opt-in', () => {
		const f = fixture();
		for (const [name, args] of [
			['threads_create', { kind: 'chat', prompt: 'Hello' }],
			['threads_send', { threadId: 'chat', prompt: 'Hello' }],
			['threads_read', { threadId: 'code' }],
			['threads_list', {}],
			['threads_search', { query: 'code' }],
			['threads_wait', { targets: [{ threadId: 'code' }] }],
			['threads_rename', { threadId: 'code', title: 'New title' }],
			['threads_archive', { threadId: 'code', archived: true }],
			['threads_stop', { threadId: 'code' }],
		] as const)
			expect(() => assertBotTaskRemoteExecution(name, args, f.state)).not.toThrow();
	});
	it('exposes the complete host-routed catalog without permission or credential arguments', () => {
		expect(botTaskTools.map((tool) => tool.name)).toEqual([
			'projects_list',
			'models_list',
			'threads_list',
			'threads_search',
			'threads_read',
			'threads_create',
			'threads_send',
			'threads_wait',
			'threads_rename',
			'threads_archive',
			'threads_stop',
		]);
		expect(isBotTaskTool('threads_send')).toBe(true);
		expect(isBotTaskTool('threads_delete')).toBe(false);
		for (const tool of botTaskTools) {
			expect(tool.parameters.additionalProperties).toBe(false);
			expect(tool.parameters.properties).toHaveProperty('hostId');
			for (const field of ['apiKey', 'baseUrl', 'permissionMode', 'temporary', 'workspaceRoot'])
				expect(tool.parameters.properties).not.toHaveProperty(field);
		}
	});
	it('lists and paginates both conversation modes while excluding temporary and archived by default', async () => {
		const f = fixture();
		const first = await run('threads_list', { limit: 1 }, f.context);
		expect(first.threads.map((item: Thread) => item.id)).toEqual(['chat']);
		expect(first.nextCursor).toBe('chat');
		expect(
			(await run('threads_list', { limit: 1, cursor: first.nextCursor }, f.context)).threads[0].id,
		).toBe('code');
		expect(
			(
				await run('threads_list', { kind: 'code', projectId: 'code-project' }, f.context)
			).threads.map((item: Thread) => item.id),
		).toEqual(['code']);
		expect(
			(await run('threads_list', { archived: true }, f.context)).threads.map(
				(item: Thread) => item.id,
			),
		).toEqual(['archived']);
		await expect(run('threads_list', { cursor: 'temporary' }, f.context)).rejects.toThrow('cursor');
	});
	it('searches titles and text with bounded snippets and active/archive filters', async () => {
		const f = fixture();
		for (const item of f.state.threads)
			item.messages[0].content = `prefix ${'a'.repeat(1000)} climate plan sk-secret-fixture ${'b'.repeat(1000)}`;
		const result = await run('threads_search', { query: 'CLIMATE', limit: 1 }, f.context);
		expect(result.threads).toHaveLength(1);
		expect(result.threads[0].matches[0].snippet.length).toBeLessThanOrEqual(800);
		expect(JSON.stringify(result)).not.toContain('sk-secret-fixture');
		expect(result.nextCursor).toBe('chat');
		expect(
			(await run('threads_search', { query: 'climate', cursor: result.nextCursor }, f.context))
				.threads[0].id,
		).toBe('code');
		expect(
			(await run('threads_search', { query: 'climate', archived: true }, f.context)).threads[0].id,
		).toBe('archived');
		expect((await run('threads_search', { query: 'missing' }, f.context)).threads).toEqual([]);
	});
	it('returns project/model choices without provider endpoints, secrets, parameters or project instructions', async () => {
		const f = fixture();
		const projects = await run('projects_list', { kind: 'code' }, f.context);
		expect(projects.projects).toEqual([
			{ id: 'code-project', name: 'Coding', kind: 'code', directories: ['/project'] },
		]);
		const models = await run('models_list', {}, f.context);
		expect(models.models).toEqual([
			{
				connectionId: 'provider',
				connectionName: 'Private provider',
				model: 'text-model',
				name: 'Text model',
				default: true,
				ready: true,
				thinkingModes: [{ id: 'high', name: 'High' }],
			},
		]);
		const serialized = JSON.stringify({ projects, models });
		for (const hidden of [
			'sk-secret-fixture',
			'private.example',
			'Private Code instructions',
			'reasoning',
			'parameters',
		])
			expect(serialized).not.toContain(hidden);
	});
	it('pages history without attachments, credentials, replay or tool arguments', async () => {
		const f = fixture();
		f.state.threads[0].messages.push(message('new-user', 'user', 'Question'), {
			...message('new-reply', 'assistant', 'sk-secret-fixture data:image/png;base64,aGVsbG8='),
			attachments: [{ name: 'photo', type: 'image/png', dataUrl: 'private pixels' }],
			agentTranscript: { api: 'responses', items: [{ privateReplay: 'private replay' }] },
			toolCalls: [
				{
					id: 'tool',
					name: 'web.run',
					arguments: 'private arguments',
					status: 'completed',
					startedAt: 1,
					result: {
						content: [
							{ type: 'text', text: 'Bearer secret-token sk-secret-fixture' },
							{ type: 'image', dataUrl: 'private pixels' },
						],
					},
				},
			],
		});
		const result = await run(
			'threads_read',
			{ threadId: 'chat', turnLimit: 1, includeOutputs: true },
			f.context,
		);
		expect(result.turns[0].id).toBe('new-user');
		expect(result.page.nextCursor).toBe('new-user');
		expect(
			(await run('threads_read', { threadId: 'chat', cursor: result.page.nextCursor }, f.context))
				.turns[0].id,
		).toBe('chat-user');
		const serialized = JSON.stringify(result);
		for (const hidden of [
			'sk-secret-fixture',
			'data:image',
			'secret-token',
			'private pixels',
			'private replay',
			'private arguments',
		])
			expect(serialized).not.toContain(hidden);
		expect(serialized).toContain('credential redacted');
		expect(
			(await run('threads_read', { threadId: 'chat' }, f.context)).turns[0].messages[1],
		).not.toHaveProperty('tools');
	});
	it('discovers older stored images and queues them as real inputs while preserving task permissions', async () => {
		const f = fixture();
		f.state.connections[0].catalog![0].inputModalities.push('image');
		const portrait = {
			name: 'yellow-top.png',
			type: 'image/png',
			dataUrl: 'data:image/png;base64,eWVsbG93',
		};
		f.state.threads[0].messages[0].attachments = [portrait];
		f.state.threads[0].messages.push(
			message('latest-user', 'user', 'Later tests'),
			message('latest-reply', 'assistant'),
		);
		const page = await run(
			'threads_read',
			{ threadId: 'chat', turnLimit: 1, cursor: 'latest-user' },
			f.context,
		);
		const asset = page.turns[0].messages[0].attachments[0];
		expect(asset).toMatchObject({
			name: 'yellow-top.png',
			type: 'image/png',
			source: 'attachment',
			forwardable: true,
		});
		expect(JSON.stringify(page)).not.toContain(portrait.dataUrl);
		const sent = await run(
			'threads_send',
			{ threadId: 'code', prompt: 'Use this original reference.', attachmentRefs: [asset.ref] },
			f.context,
		);
		const target = f.state.threads.find((item) => item.id === 'code')!;
		expect(target.queuedMessages![0]).toMatchObject({
			id: sent.messageId,
			attachments: [portrait],
		});
		expect(target.permissionMode).toBe('auto-review');
		expect(target.queuedMessages![0].attachments![0]).not.toBe(portrait);
		expect(sent.delivery.status).toBe('queued');
		expect(JSON.stringify(sent)).not.toContain(portrait.dataUrl);
	});
	it('forwards generated image and text document outputs into new threads without exposing their bytes', async () => {
		const f = fixture();
		f.state.connections[0].catalog![0].inputModalities.push('image');
		const image = 'data:image/png;base64,aW1hZ2U=';
		f.state.threads[0].messages[1].toolCalls = [
			{
				id: 'generation',
				name: 'image_gen',
				arguments: '{}',
				status: 'completed',
				startedAt: 1,
				result: {
					content: [
						{ type: 'image', name: 'result.png', dataUrl: image },
						{
							type: 'file',
							name: 'report.json',
							mimeType: 'application/json',
							dataUrl: 'data:application/json,%7B%22done%22%3Atrue%7D',
						},
						{ type: 'image', name: 'screen.png', purpose: 'computer', dataUrl: image },
					],
				},
			},
		];
		const page = await run('threads_read', { threadId: 'chat' }, f.context);
		const assets = page.turns[0].messages[1].attachments;
		expect(assets).toHaveLength(2);
		expect(
			assets.every(
				(item: { source: string; forwardable: boolean }) =>
					item.source === 'tool' && item.forwardable,
			),
		).toBe(true);
		expect(JSON.stringify(page)).not.toMatch(/base64|%7B%22done/);
		const created = await run(
			'threads_create',
			{
				kind: 'code',
				prompt: 'Review these.',
				attachmentRefs: assets.map((item: { ref: string }) => item.ref),
			},
			f.context,
		);
		const target = f.state.threads.find((item) => item.id === created.threadId)!;
		expect(target.queuedMessages![0].attachments).toEqual([
			{ name: 'result.png', type: 'image/png', dataUrl: image },
			{
				name: 'report.json',
				type: 'text/plain',
				dataUrl: 'data:text/plain;charset=utf-8,%7B%22done%22%3Atrue%7D',
			},
		]);
		expect(target.permissionMode).toBe('ask');
	});
	it('rejects cross-host, malformed, temporary, removed, duplicate, and unsupported attachment refs', async () => {
		const f = fixture();
		f.state.connections[0].catalog![0].inputModalities.push('image');
		f.state.threads[0].messages[0].attachments = [
			{ name: 'original.png', type: 'image/png', dataUrl: 'data:image/png;base64,aGk=' },
		];
		const page = await run('threads_read', { threadId: 'chat' }, f.context);
		const ref = page.turns[0].messages[0].attachments[0].ref;
		const send = (attachmentRefs: unknown) =>
			run('threads_send', { threadId: 'code', prompt: 'Use it', attachmentRefs }, f.context);
		for (const refs of [
			['/tmp/picture.png'],
			['https://example.org/picture.png'],
			['thread-asset:%'],
			[ref, ref],
			[],
			'invalid',
		])
			await expect(send(refs)).rejects.toThrow();
		f.context.hostId = 'host-b';
		await expect(send([ref])).rejects.toThrow('same computer');
		f.context.hostId = 'host-a';
		f.state.threads[0].temporary = true;
		await expect(send([ref])).rejects.toThrow('no longer available');
		f.state.threads[0].temporary = false;
		f.state.threads[0].messages[0].attachments![0].dataUrl = 'file:///etc/passwd';
		await expect(send([ref])).rejects.toThrow('Only stored image and text');
		f.state.threads[0].messages[0].attachments = [];
		await expect(send([ref])).rejects.toThrow('no longer available');
		expect(f.state.threads[1].queuedMessages).toBeUndefined();
		expect(f.dispatched).toEqual([]);
	});
	it('requires an image-capable destination and includes attachment contents in retry identity checks', async () => {
		const f = fixture();
		f.context.operationId = 'image-send';
		f.state.threads[0].messages[0].attachments = [
			{ name: 'reference.png', type: 'image/png', dataUrl: 'data:image/png;base64,aGk=' },
		];
		const ref = (await run('threads_read', { threadId: 'chat' }, f.context)).turns[0].messages[0]
			.attachments[0].ref;
		const args = { threadId: 'code', prompt: 'Use this', attachmentRefs: [ref] };
		await expect(run('threads_send', args, f.context)).rejects.toThrow(/image/i);
		expect(f.state.threads[1].queuedMessages).toBeUndefined();
		f.state.connections[0].catalog![0].inputModalities.push('image');
		await run('threads_send', args, f.context);
		await run('threads_send', args, f.context);
		expect(f.state.threads[1].queuedMessages).toHaveLength(1);
		await expect(
			run('threads_send', { threadId: 'code', prompt: 'Use this' }, f.context),
		).rejects.toThrow('different input');
		f.state.threads[0].messages[0].attachments![0].dataUrl = 'data:image/png;base64,bmV3';
		await expect(run('threads_send', args, f.context)).rejects.toThrow('different input');
	});
	it('bounds attachment metadata even when a thread has many large assets', async () => {
		const f = fixture();
		for (let index = 0; index < 20; index++) {
			f.state.threads[0].messages.push({
				...message(`image-message-${index}`, 'user'),
				attachments: Array.from({ length: 40 }, (_, image) => ({
					name: `image-${image}.png`,
					type: 'image/png',
					dataUrl: 'data:image/png;base64,aGk=',
				})),
			});
		}
		const page = await run('threads_read', { threadId: 'chat', turnLimit: 20 }, f.context);
		const messages = page.turns.flatMap((turn: { messages: any[] }) => turn.messages);
		expect(
			messages.flatMap((item: { attachments?: unknown[] }) => item.attachments ?? []).length,
		).toBeLessThanOrEqual(24);
		expect(
			messages.some(
				(item: { omittedAttachmentCount?: number }) => (item.omittedAttachmentCount ?? 0) > 0,
			),
		).toBe(true);
		expect(JSON.stringify(page).length).toBeLessThan(64_000);
	});
	it('bounds a large history across turns, messages, tools and text', async () => {
		const f = fixture(),
			target = f.state.threads[0];
		target.messages = [];
		for (let turn = 0; turn < 20; turn++) {
			target.messages.push(message(`u-${turn}`, 'user', 'x'.repeat(20_000)));
			for (let index = 0; index < 50; index++)
				target.messages.push({
					...message(`a-${turn}-${index}`, 'assistant', 'y'.repeat(20_000)),
					toolCalls: Array.from({ length: 25 }, (_, tool) => ({
						id: `${tool}`,
						name: 'exec_command',
						arguments: '{}',
						startedAt: 1,
						status: 'completed' as const,
						result: { content: [{ type: 'text' as const, text: 'z'.repeat(20_000) }] },
					})),
				});
		}
		const result = await run(
			'threads_read',
			{ threadId: 'chat', turnLimit: 20, includeOutputs: true, maxOutputCharsPerItem: 10_000 },
			f.context,
		);
		expect(JSON.stringify(result).length).toBeLessThan(64_000);
		expect(result.turns.flatMap((turn: { messages: unknown[] }) => turn.messages)).toHaveLength(50);
		expect(
			result.turns.some((turn: { omittedMessageCount: number }) => turn.omittedMessageCount > 0),
		).toBe(true);
	});
	it.each(['threads_read', 'threads_send', 'threads_rename', 'threads_archive', 'threads_stop'])(
		'rejects temporary threads for %s',
		async (name) => {
			const f = fixture();
			await expect(
				run(
					name,
					{
						threadId: 'temporary',
						...(name === 'threads_send' ? { prompt: 'Continue' } : {}),
						...(name === 'threads_rename' ? { title: 'Title' } : {}),
						...(name === 'threads_archive' ? { archived: true } : {}),
					},
					f.context,
				),
			).rejects.toThrow('unavailable');
			expect(f.mutations).toBe(0);
			expect(f.cancelled).toEqual([]);
		},
	);
	it.each(['chat', 'code'] as const)(
		'creates %s with saved queued input, explicit thinking and no UI caller dependency',
		async (kind) => {
			const f = fixture();
			const result = await run(
				'threads_create',
				{ kind, prompt: 'Do focused work', projectId: `${kind}-project` },
				f.context,
			);
			const target = f.state.threads.find((item) => item.id === result.threadId)!;
			expect(target).toMatchObject({
				kind,
				projectId: `${kind}-project`,
				connectionId: 'provider',
				model: 'text-model',
				thinkingMode: 'high',
				messages: [],
			});
			expect(target.queuedMessages?.[0]).toMatchObject({
				id: result.messageId,
				content: 'Do focused work',
			});
			expect(target.permissionMode).toBe(kind === 'code' ? 'ask' : undefined);
			expect(result.delivery.status).toBe('started');
			expect(f.dispatched).toEqual([target.id]);
		},
	);
	it('rejects invalid creation projects, models, thinking modes and escalation fields before changing data', async () => {
		const f = fixture();
		for (const args of [
			{ projectId: 'chat-project' },
			{ projectId: 'missing' },
			{ model: 'not-configured' },
			{ connectionId: 'missing' },
			{ thinkingMode: 'missing' },
			{ permissionMode: 'full-access' },
			{ apiKey: 'secret' },
		]) {
			await expect(
				run('threads_create', { kind: 'code', prompt: 'Work', ...args }, f.context),
			).rejects.toThrow();
		}
		expect(f.state.threads).toHaveLength(4);
		expect(f.dispatched).toEqual([]);
	});
	it('requires a real thinking value even for the default model', async () => {
		const f = fixture();
		f.state.connections[0].catalog![0].thinkingModes = [];
		await expect(
			run('threads_create', { kind: 'chat', prompt: 'Hello' }, f.context),
		).rejects.toThrow('thinking value');
		expect(f.state.threads).toHaveLength(4);
	});
	it('makes create retries idempotent before and after input is delivered', async () => {
		const f = fixture();
		f.context.operationId = 'stable-create';
		const first = await run('threads_create', { kind: 'code', prompt: 'Work' }, f.context);
		await run('threads_create', { kind: 'code', prompt: 'Work' }, f.context);
		expect(f.state.threads.filter((item) => item.id === first.threadId)).toHaveLength(1);
		expect(f.dispatched).toEqual([first.threadId, first.threadId]);
		const target = f.state.threads.find((item) => item.id === first.threadId)!;
		target.messages = [{ ...target.queuedMessages![0], role: 'user' }];
		target.queuedMessages = [];
		const dispatch = vi.fn(async () => ({
			status: 'unavailable' as const,
			error: 'No queued input remains.',
		}));
		f.context.dispatch = dispatch;
		const repeated = await run('threads_create', { kind: 'code', prompt: 'Work' }, f.context);
		expect(repeated.delivery).toEqual({ status: 'started', alreadyAdmitted: true });
		expect(dispatch).not.toHaveBeenCalled();
		expect(target.messages).toHaveLength(1);
		await expect(
			run('threads_create', { kind: 'code', prompt: 'Different' }, f.context),
		).rejects.toThrow('different input');
	});
	it.each(['chat', 'code'])(
		'queues a follow-up to %s and preserves its execution settings',
		async (id) => {
			const f = fixture(),
				before = structuredClone(f.state.threads.find((item) => item.id === id)!);
			f.context.operationId = 'stable-send';
			const result = await run(
				'threads_send',
				{ threadId: id, prompt: 'Focus on tests' },
				f.context,
			);
			await run('threads_send', { threadId: id, prompt: 'Focus on tests' }, f.context);
			expect(f.dispatched).toEqual([id, id]);
			const target = f.state.threads.find((item) => item.id === id)!;
			expect(target.queuedMessages).toHaveLength(1);
			expect(target.queuedMessages![0].id).toBe(result.messageId);
			for (const field of [
				'projectId',
				'model',
				'thinkingMode',
				'connectionId',
				'permissionMode',
			] as const)
				expect(target[field]).toEqual(before[field]);
			expect(f.cancelled).toEqual([]);
			expect(result.delivery.status).toBe(id === 'code' ? 'queued' : 'started');
		},
	);
	it('rejects archived sends and reused identities with changed target/content', async () => {
		const f = fixture();
		f.context.operationId = 'same';
		await expect(
			run('threads_send', { threadId: 'archived', prompt: 'Hello' }, f.context),
		).rejects.toThrow('Restore');
		await run('threads_send', { threadId: 'chat', prompt: 'Hello' }, f.context);
		await expect(
			run('threads_send', { threadId: 'code', prompt: 'Hello' }, f.context),
		).rejects.toThrow('another thread');
		await expect(
			run('threads_send', { threadId: 'chat', prompt: 'Different' }, f.context),
		).rejects.toThrow('different input');
	});
	it('does not duplicate already-delivered sends, including messages on an inactive branch', async () => {
		const f = fixture();
		f.context.operationId = 'delivered-send';
		const result = await run('threads_send', { threadId: 'chat', prompt: 'Hello' }, f.context);
		const target = f.state.threads[0];
		target.messageHistory = [{ ...target.queuedMessages![0], role: 'user', parentId: null }];
		target.queuedMessages = [];
		const dispatch = vi.fn(async () => ({
			status: 'unavailable' as const,
			error: 'No queued input remains.',
		}));
		f.context.dispatch = dispatch;
		const repeated = await run('threads_send', { threadId: 'chat', prompt: 'Hello' }, f.context);
		expect(repeated.messageId).toBe(result.messageId);
		expect(repeated.delivery).toEqual({ status: 'started', alreadyAdmitted: true });
		expect(dispatch).not.toHaveBeenCalled();
		expect(target.queuedMessages).toEqual([]);
		expect(target.messageHistory).toHaveLength(1);
	});
	it('byte-bounds large result pages while preserving exact continuation', async () => {
		const f = fixture();
		f.state.projects = Array.from({ length: 12 }, (_, index) => ({
			id: `project-${index}`,
			name: `Project ${index.toString().padStart(2, '0')}`,
			kind: 'code',
			instructions: '',
			createdAt: 1,
			directories: Array.from({ length: 20 }, (_, row) => `/root/${row}/${'x'.repeat(990)}`),
		}));
		let cursor: string | null = null;
		const collected: string[] = [];
		do {
			const result = await run(
				'projects_list',
				{ limit: 100, ...(cursor ? { cursor } : {}) },
				f.context,
			);
			expect(JSON.stringify(result).length).toBeLessThan(64_000);
			collected.push(...result.projects.map((project: { id: string }) => project.id));
			cursor = result.nextCursor;
		} while (cursor);
		expect(collected).toEqual(f.state.projects.map((project) => project.id));
	});
	it('keeps saved prompts after unavailable dispatch while redacting error credentials', async () => {
		const f = fixture();
		f.context.dispatch = async () => {
			throw new Error('Provider rejected sk-secret-fixture Bearer other-secret');
		};
		const result = await run('threads_send', { threadId: 'chat', prompt: 'Continue' }, f.context);
		expect(result.promptSaved).toBe(true);
		expect(result.delivery.status).toBe('unavailable');
		expect(result.delivery.error).not.toMatch(/sk-secret-fixture|other-secret/);
		expect(f.state.threads[0].queuedMessages?.[0].content).toBe('Continue');
	});
	it('uses latest mutation state and cannot enqueue a thread made temporary meanwhile', async () => {
		const f = fixture(),
			original = f.context.mutate;
		f.context.mutate = async (update) => {
			f.state.threads[0].temporary = true;
			return original(update);
		};
		await expect(
			run('threads_send', { threadId: 'chat', prompt: 'No' }, f.context),
		).rejects.toThrow('unavailable');
		expect(f.dispatched).toEqual([]);
	});
	it('renames, archives/restores, and stops without deleting saved history or queued input', async () => {
		const f = fixture();
		await run('threads_rename', { threadId: 'code', title: 'Focused task' }, f.context);
		await run('threads_send', { threadId: 'code', prompt: 'Later' }, f.context);
		await run('threads_archive', { threadId: 'code', archived: true }, f.context);
		expect(f.state.threads[1]).toMatchObject({
			title: 'Focused task',
			titleSource: 'manual',
			archivedAt: 100,
		});
		expect(f.state.threads[1].messages).toHaveLength(2);
		expect(f.state.threads[1].queuedMessages).toHaveLength(1);
		expect(f.cancelled).toEqual([['code']]);
		await run('threads_archive', { threadId: 'code', archived: false }, f.context);
		expect(f.state.threads[1].archivedAt).toBeUndefined();
		await run('threads_stop', { threadId: 'code' }, f.context);
		expect(f.cancelled).toEqual([['code'], ['code']]);
		expect(f.state.threads[1].queuedMessages).toHaveLength(1);
	});
	it('does not falsely report stopping when no task runtime is attached', async () => {
		const f = fixture();
		delete f.context.cancel;
		await expect(run('threads_stop', { threadId: 'code' }, f.context)).rejects.toThrow(
			'runtime is unavailable',
		);
		await expect(
			run('threads_archive', { threadId: 'code', archived: true }, f.context),
		).rejects.toThrow('runtime is unavailable');
		expect(f.mutations).toBe(0);
	});
	it('pauses active goals when stopping, without resuming on restore', async () => {
		const f = fixture();
		f.state.threads[1].goal = {
			id: 'goal',
			objective: 'Build it',
			status: 'active',
			createdAt: 1,
			updatedAt: 1,
			usedTokens: 0,
			elapsedMs: 0,
			turns: 0,
		};
		await run('threads_archive', { threadId: 'code', archived: true }, f.context);
		expect(f.state.threads[1].goal?.status).toBe('paused');
		await run('threads_archive', { threadId: 'code', archived: false }, f.context);
		expect(f.state.threads[1].goal?.status).toBe('paused');
	});
	it('waits with runtime approval status and suppresses answers using cursors', async () => {
		const f = fixture();
		const first = await run(
			'threads_wait',
			{ targets: [{ threadId: 'chat' }], timeoutMs: 0 },
			f.context,
		);
		expect(first.wake).toBe('chat');
		expect(first.polls[0].answer).toBe('chat-reply');
		const next = await run(
			'threads_wait',
			{ targets: [{ threadId: 'chat', afterCursor: first.polls[0].cursor }], timeoutMs: 0 },
			f.context,
		);
		expect(next.wake).toBeNull();
		expect(next.polls[0]).not.toHaveProperty('answer');
		f.statuses.code = 'waiting_for_approval';
		expect(
			(await run('threads_wait', { targets: [{ threadId: 'code' }], timeoutMs: 0 }, f.context))
				.polls[0].status,
		).toBe('waiting_for_approval');
	});
	it('wakes on questions, respects its deadline and can be cancelled', async () => {
		vi.useFakeTimers();
		const f = fixture();
		const pending = run(
			'threads_wait',
			{ targets: [{ threadId: 'code' }], timeoutMs: 1000 },
			f.context,
		);
		await vi.advanceTimersByTimeAsync(250);
		f.statuses.code = 'waiting_for_input';
		await vi.advanceTimersByTimeAsync(250);
		expect((await pending).wake).toBe('code');
		f.statuses.code = 'working';
		const deadline = run(
			'threads_wait',
			{ targets: [{ threadId: 'code' }], timeoutMs: 500 },
			f.context,
		);
		await vi.advanceTimersByTimeAsync(500);
		expect((await deadline).timedOut).toBe(true);
		const controller = new AbortController();
		f.context.signal = controller.signal;
		const cancelled = run('threads_wait', { targets: [{ threadId: 'code' }] }, f.context);
		const assertion = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
		await vi.advanceTimersByTimeAsync(1);
		controller.abort();
		await assertion;
	});
	it('bounds wait targets/time and never leaks temporary history through waiting', async () => {
		const f = fixture();
		await expect(
			run('threads_wait', { targets: [{ threadId: 'code' }, { threadId: 'code' }] }, f.context),
		).rejects.toThrow('unique');
		await expect(
			run('threads_wait', { targets: [{ threadId: 'code' }], timeoutMs: 60_001 }, f.context),
		).rejects.toThrow('60000');
		const result = await run(
			'threads_wait',
			{ targets: [{ threadId: 'temporary' }], timeoutMs: 0 },
			f.context,
		);
		expect(result.polls[0].error).toContain('unavailable');
		expect(JSON.stringify(result)).not.toContain('temporary-reply');
	});
	it('validates unknown fields and types instead of relying only on the tool schema', async () => {
		const f = fixture();
		for (const [name, args] of [
			['threads_list', { limit: -1 }],
			['threads_list', { limit: null }],
			['threads_list', { kind: 'images' }],
			['threads_list', { kind: ['chat'] }],
			['threads_list', { archived: 'false' }],
			['threads_search', { query: '' }],
			['threads_create', { prompt: 'missing kind' }],
			['threads_send', { threadId: 'code', prompt: 'x', model: 'text-model' }],
			['threads_wait', { targets: [{ threadId: 'code', hostId: 'other' }] }],
		] as const)
			await expect(run(name, args, f.context)).rejects.toThrow();
		expect(f.mutations).toBe(0);
	});
});
