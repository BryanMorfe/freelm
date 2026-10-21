import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceAuthority } from '../electron/workspace-authority';
import { StateStore } from '../electron/state-store';
import { createAgentHost } from '../electron/agent-bridge';
import { initialState } from '../src/lib/state';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { latestComposerMode } from '../src/lib/code-plan';
import { createComposerMention } from '../src/lib/composer-mention-codec';
import type { AppState, Message } from '../src/types';
import type { ToolHostRequest, ToolResult } from '../src/agent-types';

vi.mock('electron', () => ({ dialog: {}, ipcMain: { handle: vi.fn() } }));

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.restoreAllMocks();
});
const text = (result: ToolResult) =>
	result.content
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n');
const request = (name: string, args: Record<string, unknown> = {}): ToolHostRequest => ({
	workspaceId: 'local',
	runId: 'production-plan',
	threadId: 'code',
	name,
	arguments: args,
});
const input = (id: string, planning = false): Message => ({
	id,
	role: 'user',
	content: planning ? 'Inspect the files and plan the change.' : 'Implement the change.',
	createdAt: 1,
	...(planning ? { composer: { mode: 'plan' as const } } : {}),
});
async function fixture(planning = true) {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-plan-authority-'));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const state = initialState();
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: true,
		commandExecution: true,
		workspaceRoot: directory,
		approvalMode: 'full-access',
		imageGeneration: { ...defaultToolSettings().imageGeneration, enabled: false },
	};
	state.threads = [
		{
			id: 'code',
			kind: 'code',
			title: 'Production Plan test',
			connectionId: state.activeConnectionId,
			model: 'fixture',
			permissionMode: 'full-access',
			messages: [input('human', planning)],
			createdAt: 1,
			updatedAt: 1,
		},
	];
	const store = new StateStore(
		path.join(directory, 'workspace.json'),
		{
			available: () => false,
			encrypt: () => {
				throw new Error('Unused');
			},
			decrypt: () => {
				throw new Error('Unused');
			},
		},
		path.join(directory, 'config.json'),
	);
	const authority = new WorkspaceAuthority(store);
	await authority.save(state, (await authority.load()).revision);
	// This is the production constructor and lightweight loader used by main.ts.
	const bridge = createAgentHost(authority, () => null);
	cleanup.push(() => bridge.service.close());
	await bridge.service.catalog('production-plan', 'code');
	return { authority, bridge, directory, state };
}
async function update(authority: WorkspaceAuthority, mutate: (state: AppState) => void) {
	const snapshot = await authority.load();
	mutate(snapshot.state!);
	await authority.save(snapshot.state!, snapshot.revision);
}

describe('production authority planning admission', () => {
	it('retains only the committed Code planning selector without copying content, attachments, references or other history', async () => {
		const { authority, directory } = await fixture();
		const reference = createComposerMention({
			kind: 'file',
			id: 'file-id',
			label: 'read-me.txt',
			path: path.join(directory, 'read-me.txt'),
		});
		await update(authority, (state) => {
			const code = state.threads[0];
			code.messages[0].content += ' private request '.repeat(5000) + reference.token;
			code.messages[0].composer!.references = [reference];
			code.messages[0].attachments = [
				{
					name: 'attachment.txt',
					type: 'text/plain',
					dataUrl: 'data:text/plain;base64,cHJpdmF0ZQ==',
				},
			];
			code.messages.push({
				id: 'assistant',
				role: 'assistant',
				content: 'Private assistant history.',
				createdAt: 2,
			});
			code.messageHistory = [...code.messages];
			state.threads.push({
				...code,
				id: 'other-code',
				messages: [input('ordinary')],
				messageHistory: code.messageHistory,
			});
			state.threads.push({
				...code,
				id: 'chat',
				kind: 'chat',
				permissionMode: undefined,
				messages: [input('chat-request', true)],
			});
		});
		const projected = (await authority.loadToolState())!;
		expect(projected.threads[0].messages).toEqual([
			{ id: 'human', role: 'user', content: '', createdAt: 1, composer: { mode: 'plan' } },
		]);
		expect(projected.threads[0].messageHistory).toEqual([]);
		expect(projected.threads[1].messages).toEqual([]);
		expect(projected.threads[2].messages).toEqual([]);
		expect(projected.chatDrafts).toEqual({});
		expect(projected.generations).toEqual([]);
		const serialized = JSON.stringify(projected.threads[0].messages);
		expect(serialized).not.toContain('private');
		expect(serialized).not.toContain('attachment');
		expect(serialized).not.toContain(reference.token);
		projected.threads[0].messages[0].composer!.mode = 'goal';
		expect(latestComposerMode((await authority.load()).state!.threads[0])).toBe('plan');
	});
	it('blocks real patch and command writes through createAgentHost while allowing a real file read', async () => {
		const { bridge, directory } = await fixture();
		await writeFile(path.join(directory, 'read-me.txt'), 'production read contents');
		const patch = '*** Begin Patch\n*** Add File: blocked.txt\n+must not exist\n*** End Patch';
		for (const call of [
			request('apply_patch', { patch }),
			request('exec_command', { cmd: 'touch blocked.txt' }),
		]) {
			const result = await bridge.service.execute(call);
			expect(result.isError).toBe(true);
			expect(text(result)).toContain('Plan mode');
		}
		await expect(readFile(path.join(directory, 'blocked.txt'))).rejects.toThrow();
		const read = await bridge.service.execute(request('exec_command', { cmd: 'cat read-me.txt' }));
		expect(read.isError).not.toBe(true);
		expect(text(read)).toContain('production read contents');
	});
	it('does not activate a queued Plan selection until commitment, and exits on the next ordinary committed user input', async () => {
		const { authority, bridge, directory } = await fixture(false);
		await update(authority, (state) => {
			state.threads[0].queuedMessages = [
				{ id: 'queued', content: 'Plan only.', createdAt: 2, composer: { mode: 'plan' } },
			];
		});
		expect((await authority.loadToolState())!.threads[0].messages).toEqual([]);
		await update(authority, (state) => {
			state.threads[0].messages.push(input('committed-plan', true));
			state.threads[0].queuedMessages = [];
		});
		const patch =
			'*** Begin Patch\n*** Add File: implementation.txt\n+implemented after explicit mode removal\n*** End Patch';
		const blocked = await bridge.service.execute(request('apply_patch', { patch }));
		expect(blocked.isError).toBe(true);
		await expect(readFile(path.join(directory, 'implementation.txt'))).rejects.toThrow();
		await update(authority, (state) => state.threads[0].messages.push(input('implement')));
		expect((await authority.loadToolState())!.threads[0].messages).toEqual([]);
		const implemented = await bridge.service.execute(request('apply_patch', { patch }));
		expect(implemented.isError).not.toBe(true);
		expect(await readFile(path.join(directory, 'implementation.txt'), 'utf8')).toContain(
			'implemented after explicit mode removal',
		);
	});
});
