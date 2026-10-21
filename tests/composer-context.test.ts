import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../electron/state-store';
import { describe, expect, it } from 'vitest';
import {
	composerGoal,
	latestComposerMode,
	validComposerContext,
} from '../src/lib/composer-context';
import { createComposerMention } from '../src/lib/composer-mention-codec';
import {
	addQueuedCodeMessage,
	drainQueuedCodeMessages,
	editQueuedCodeMessage,
} from '../src/lib/code-queue';
import { initialState, conversationInput, recoverState } from '../src/lib/state';
import { validateState } from '../electron/validation';
import { applyWorkspacePatch, createWorkspacePatch } from '../src/workspace-patch';
import type { AppState, Message } from '../src/types';

const mention = createComposerMention({
	kind: 'skill',
	id: 'exact-skill',
	label: 'App Design',
	path: '/configured/skills/app-design/SKILL.md',
	description: 'A description is not persisted as identity.',
});
const content = `Use ${mention.token} for this task.`;
const message: Message = {
	id: 'user',
	role: 'user',
	content,
	composer: { mode: 'plan', references: [mention] },
	createdAt: 1,
};
function fixture(): AppState {
	const state = initialState();
	state.chatDrafts = {
		draft: { content, composer: message.composer, attachments: [], updatedAt: 1 },
		modeOnly: { content: '', composer: { mode: 'plan' }, attachments: [], updatedAt: 1 },
	};
	state.threads = [
		{
			id: 'code',
			kind: 'code',
			title: 'Task',
			connectionId: state.activeConnectionId,
			model: 'model',
			messages: [message],
			createdAt: 1,
			updatedAt: 1,
			queuedMessages: [{ id: 'queued', content, composer: message.composer, createdAt: 2 }],
		},
	];
	return state;
}

describe('explicit composer selections', () => {
	it('round-trips modes and exact references through the real split config/workspace store', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'freelm-composer-store-'));
		try {
			const store = new StateStore(
				path.join(root, 'workspace.json'),
				{
					available: () => false,
					encrypt: () => {
						throw new Error('No keys');
					},
					decrypt: () => {
						throw new Error('No keys');
					},
				},
				path.join(root, 'config.json'),
			);
			const state = fixture();
			await store.save(state);
			expect(await store.load()).toEqual(state);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('preserves mode and exact mention through workspace validation, recovery and remote patches', () => {
		const state = fixture();
		expect(() => validateState(state)).not.toThrow();
		expect(recoverState(structuredClone(state))).toMatchObject({
			chatDrafts: state.chatDrafts,
			threads: [{ messages: [message], queuedMessages: state.threads[0].queuedMessages }],
		});
		const previous = initialState();
		const patch = createWorkspacePatch(previous, state);
		expect(applyWorkspacePatch(previous, patch)).toEqual(state);
	});
	it('does not drop selections when a queue is copied, edited or drained', () => {
		const queued = {
			id: 'queued',
			content,
			composer: structuredClone(message.composer),
			createdAt: 1,
		};
		const added = addQueuedCodeMessage([], queued);
		queued.composer!.references![0] = { ...mention, label: 'changed outside queue' };
		expect(added[0].composer?.references?.[0].label).toBe('App Design');
		const edited = editQueuedCodeMessage(added, 'queued', {
			composer: { mode: 'goal' },
			content: 'Finish the task',
		});
		expect(drainQueuedCodeMessages(edited).drained[0]).toMatchObject({
			composer: { mode: 'goal' },
			content: 'Finish the task',
		});
		expect(
			editQueuedCodeMessage(edited, 'queued', { composer: undefined })[0].composer,
		).toBeUndefined();
	});
	it('creates a persistent goal only for an explicitly selected Goal input', () => {
		expect(composerGoal(undefined, [{ content: 'Build a thing' }])).toBeUndefined();
		const goal = composerGoal(undefined, [
			{ content, composer: { mode: 'goal', references: [mention] } },
		]);
		expect(goal).toMatchObject({ objective: 'Use App Design for this task.', status: 'active' });
		expect(() =>
			composerGoal(goal, [{ content: 'Another objective', composer: { mode: 'goal' } }]),
		).toThrow('unfinished goal');
	});
	it('uses the latest user selection, ignoring assistant text and queued input until committed', () => {
		expect(latestComposerMode([message, { role: 'assistant' }])).toBe('plan');
		expect(latestComposerMode([message, { role: 'user', composer: {} }])).toBeUndefined();
	});
	it('keeps provider prose human readable while leaving the stored identity intact', () => {
		expect(conversationInput([message])[0].content).toBe('Use App Design for this task.');
		expect(message.content).toBe(content);
		const plain: Message = { ...message, content: 'Normal prompt', composer: undefined };
		expect(conversationInput([plain])[0]).toBe(plain);
	});
	it('rejects malformed/unbounded selection metadata before persistence', () => {
		expect(validComposerContext({ mode: 'invalid' })).toBe(false);
		expect(validComposerContext({ references: [{ ...mention, path: 'bad\0path' }] })).toBe(false);
		expect(validComposerContext({ references: Array(31).fill(mention) })).toBe(false);
		const state = fixture();
		state.threads[0].queuedMessages![0].composer = { mode: 'invalid' } as any;
		expect(() => validateState(state)).toThrow();
	});
});
