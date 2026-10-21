import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initialState } from '../src/lib/state';
import { StateStore, type SecretStorage } from '../electron/state-store';
import { WorkspaceAuthority } from '../electron/workspace-authority';
import {
	applyWorkspacePatch,
	assertWorkspacePatch,
	createWorkspacePatch,
} from '../src/workspace-patch';
import { validateState } from '../electron/validation';
import type { AppState, Thread } from '../src/types';

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
const secrets: SecretStorage = {
	available: () => false,
	encrypt: () => {
		throw new Error('Unused');
	},
	decrypt: () => {
		throw new Error('Unused');
	},
};

function fixture(): AppState {
	const state = initialState();
	const chat: Thread = {
		id: 'chat',
		kind: 'chat',
		title: 'Archived versions',
		connectionId: state.activeConnectionId,
		model: 'fixture',
		createdAt: 1,
		updatedAt: 3,
		archivedAt: 4,
		messages: [
			{
				id: 'question', role: 'user', content: 'A question', createdAt: 1, parentId: null,
				replyTo: { messageId: 'earlier-version', text: 'The exact selected text before branching.' },
			},
			{
				id: 'answer-two',
				role: 'assistant',
				content: 'New answer',
				createdAt: 3,
				parentId: 'question',
			},
		],
		messageHistory: [
			{
				id: 'question-original',
				role: 'user',
				content: 'The original question',
				createdAt: 1,
				parentId: null,
				replyTo: { messageId: 'earlier-version', text: 'The original selection retained in history.' },
			},
			{
				id: 'answer-one',
				role: 'assistant',
				content: 'Original answer',
				createdAt: 2,
				parentId: 'question',
				toolCalls: [
					{
						id: 'image',
						name: 'image.view',
						arguments: '{}',
						status: 'completed',
						startedAt: 1,
						result: {
							content: [{ type: 'image', dataUrl: 'data:image/png;base64,' + 'A'.repeat(100_000) }],
							research: {
								sources: [{ id: 'web-one', title: 'Publisher', url: 'https://example.com/paper' }],
								images: [
									{
										id: 'web-one',
										title: 'Image',
										url: 'https://example.com/image.png',
										sourceUrl: 'https://example.com/paper',
										previewDataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(80_000),
									},
								],
							},
						},
					},
				],
			},
		],
		branchedFrom: { threadId: 'original', messageId: 'previous' },
	};
	state.threads = [chat];
	state.chatDrafts = {
		chat: {
			content: 'Large draft for this chat. '.repeat(5000),
			replyTo: { messageId: 'answer-two', text: 'New answer' },
			updatedAt: 5,
			attachments: [
				{
					name: 'Pasted text.txt',
					type: 'text/plain',
					dataUrl:
						'data:text/plain;base64,' +
						Buffer.from('large pasted text '.repeat(10_000)).toString('base64'),
				},
			],
		},
	};
	state.dictation = {
		enabled: false,
		connectionId: state.activeConnectionId,
		model: 'asr-fixture',
	};
	state.backgroundNotifications = false;
	return state;
}

describe('Chat feature durable storage and workspace patches', () => {
	it('validates bounded selected references in drafts, active messages and inactive history', () => {
		const selected = { messageId: 'earlier-version', text: 'x'.repeat(100_000) };
		for (const placement of ['draft', 'message', 'history'] as const) {
			const state = fixture();
			const entry = placement === 'draft'
				? state.chatDrafts!.chat
				: placement === 'message' ? state.threads[0].messages[0] : state.threads[0].messageHistory![0];
			entry.replyTo = selected;
			expect(() => validateState(state)).not.toThrow();
			for (const invalid of [null, [], {}, { messageId: '', text: 'Selected' }, { messageId: ' '.repeat(4), text: 'Selected' }, { messageId: 'x'.repeat(257), text: 'Selected' }, { messageId: 'previous', text: '' }, { messageId: 'previous', text: ' \n ' }, { messageId: 'previous', text: 'x'.repeat(100_001) }, { messageId: 'previous', text: 1 }]) {
				(entry as unknown as Record<string, unknown>).replyTo = invalid;
				expect(() => validateState(state)).toThrow('Workspace data is invalid');
			}
			delete entry.replyTo;
			expect(() => validateState(state)).not.toThrow();
		}
	});
	it('round-trips archived conversation versions, research metadata and large drafts through split disk storage', async () => {
		const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-chat-persistence-'));
		folders.push(folder);
		const filename = path.join(folder, 'workspace.json'),
			config = path.join(folder, 'config.json');
		const state = fixture();
		validateState(state);
		await new StateStore(filename, secrets, config).save(state);
		expect(await new StateStore(filename, secrets, config).load()).toEqual(state);
		const storedConfig = JSON.parse(await readFile(config, 'utf8'));
		expect(storedConfig.dictation).toEqual(state.dictation);
		expect(storedConfig.backgroundNotifications).toBe(false);
		expect(storedConfig).not.toHaveProperty('chatDrafts');
	});
	it('patches parent IDs, inactive versions, archive status and Chat settings without dropping them', () => {
		const original = initialState();
		const next = fixture();
		next.connections = original.connections;
		next.activeConnectionId = original.activeConnectionId;
		next.threads[0].connectionId = original.activeConnectionId;
		next.dictation!.connectionId = original.activeConnectionId;
		const patch = createWorkspacePatch(original, next);
		assertWorkspacePatch(patch);
		const applied = applyWorkspacePatch(original, patch);
		validateState(applied);
		expect(applied).toEqual(next);
		const restored = {
			...next,
			threads: next.threads.map(({ archivedAt: _removed, ...item }) => item),
			chatDrafts: {},
			backgroundNotifications: true,
		};
		const second = createWorkspacePatch(next, restored);
		assertWorkspacePatch(second);
		expect(applyWorkspacePatch(next, second)).toEqual(restored);
	});
	it('strips temporary history and its large draft before host authority disk writes or snapshots', async () => {
		const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-temp-authority-'));
		folders.push(folder);
		const filename = path.join(folder, 'workspace.json');
		const authority = new WorkspaceAuthority(new StateStore(filename, secrets));
		const snapshot = await authority.load();
		const state = initialState();
		state.threads = [
			{
				...fixture().threads[0],
				id: 'temporary',
				title: 'Do not persist this title',
				temporary: true,
			},
		];
		state.chatDrafts = {
			temporary: { content: 'Do not persist this draft', attachments: [], updatedAt: 1 },
		};
		await authority.save(state, snapshot.revision);
		expect((await authority.load()).state?.threads).toEqual([]);
		expect((await authority.load()).state?.chatDrafts).toEqual({});
		expect(await readFile(filename, 'utf8')).not.toContain('Do not persist');
	});
});
