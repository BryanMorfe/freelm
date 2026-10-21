import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState, recoverState } from '../../src/lib/state';
import { StateStore } from '../../electron/state-store';
import { validateState } from '../../electron/validation';
import {
	applyWorkspacePatch,
	assertWorkspacePatch,
	createWorkspacePatch,
} from '../../src/workspace-patch';
import type { QueuedCodeMessage } from '../../src/types';

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
const secrets = {
	available: () => false,
	encrypt: () => {
		throw new Error('No keys');
	},
	decrypt: () => {
		throw new Error('No keys');
	},
};
const pending: QueuedCodeMessage = {
	id: 'pending-input',
	content: 'Please inspect the attached reference next.\nUse the same workspace.',
	createdAt: 3,
	attachments: [
		{
			name: 'reference.png',
			type: 'image/png',
			dataUrl: `data:image/png;base64,${'A'.repeat(140000)}`,
		},
	],
	replyTo: { messageId: 'answer', text: 'The selected passage' },
};
function fixture() {
	const state = initialState();
	state.threads = [
		{
			id: 'code-task',
			kind: 'code',
			title: 'Queue test',
			connectionId: state.activeConnectionId,
			model: 'fixture',
			createdAt: 1,
			updatedAt: 3,
			messages: [{ id: 'answer', role: 'assistant', content: 'Original reply.', createdAt: 2 }],
			queuedMessages: [pending],
		},
	];
	return state;
}

describe('persisted Code message queue', () => {
	it('round-trips queued input with media, reply selection and stable identity through actual storage', async () => {
		const state = fixture();
		const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-code-queue-'));
		folders.push(folder);
		const store = new StateStore(
			path.join(folder, 'workspace.json'),
			secrets,
			path.join(folder, 'config.json'),
		);
		await store.save(state);
		const restored = await store.load();
		expect(restored).toEqual(state);
		expect(recoverState(restored!).threads[0].queuedMessages).toEqual([pending]);
	});
	it('preserves edits and deletions through incremental and remote workspace patches', () => {
		const before = fixture();
		const edited = structuredClone(before);
		edited.threads[0].queuedMessages![0].content = 'Updated pending request.';
		const patch = createWorkspacePatch(before, edited);
		assertWorkspacePatch(patch);
		expect(applyWorkspacePatch(before, patch)).toEqual(edited);
		const removed = { ...edited, threads: [{ ...edited.threads[0], queuedMessages: [] }] };
		expect(applyWorkspacePatch(edited, createWorkspacePatch(edited, removed))).toEqual(removed);
		expect(before.threads[0].queuedMessages![0].content).toBe(pending.content);
	});
	it('accepts legacy thread kinds and rejects malformed or duplicated pending entries', () => {
		const state = fixture();
		delete state.threads[0].kind;
		expect(() => validateState(state)).not.toThrow();
		for (const patch of [
			{ id: '' },
			{ id: null },
			{ content: 2 },
			{ content: 'A'.repeat(2_000_001) },
			{ content: ' ', attachments: [] },
			{ createdAt: -1 },
			{ createdAt: NaN },
			{ attachments: Array(7).fill(pending.attachments![0]) },
			{ attachments: [{ name: 'x', type: 'image/png', dataUrl: 42 }] },
			{ replyTo: { messageId: 'answer', text: '' } },
		]) {
			const invalid = structuredClone(state);
			Object.assign(invalid.threads[0].queuedMessages![0], patch);
			expect(() => validateState(invalid)).toThrow('Workspace data is invalid');
		}
		const duplicate = structuredClone(state);
		duplicate.threads[0].queuedMessages!.push({ ...pending });
		expect(() => validateState(duplicate)).toThrow('Workspace data is invalid');
	});
});
