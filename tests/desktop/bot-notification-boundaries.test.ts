import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotHost } from '../../electron/bot-host';
import type { BotProfile, BotReplyRequest } from '../../src/bot-types';
import { initialState } from '../../src/lib/state';

const hosts: BotHost[] = [];
const folders: string[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) host.close();
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it('does not deliver a polled task summary after the remote bot loses history access', async () => {
	const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-bot-notification-boundaries-'));
	folders.push(folder);
	const profile: BotProfile = {
		id: 'nova',
		name: 'Nova',
		address: 'nova@freelm',
		color: '#abcdef',
		identity: 'Helpful.',
		learnedPersonality: '',
		enabled: true,
		historyAccess: true,
		personalityLearning: true,
		connectionId: 'provider',
		model: 'fixture',
		createdAt: 1,
		updatedAt: 1,
	};
	const entered = deferred<void>();
	const polled = deferred<unknown>();
	const events: BotReplyRequest[] = [];
	const host = new BotHost({
		filename: path.join(folder, 'mailbox.json'),
		identity: async () => ({ id: 'home', name: 'Home' }),
		workspace: async () => initialState(),
		watchIntervalMs: 60_000,
		remoteProfile: async () => structuredClone(profile),
		remoteRespond: async (_participant, request) => {
			if (request.notification) {
				events.push(structuredClone(request));
				return { content: 'Task completed.', reactions: [] };
			}
			return {
				content: 'I’ll let you know when it finishes.',
				reactions: [],
				taskWatches: [{ hostId: 'remote', threadId: 'code', afterCursor: 'working' }],
			};
		},
		pollTask: async () => {
			entered.resolve();
			return polled.promise;
		},
	});
	hosts.push(host);
	await host.command({
		type: 'create-conversation',
		id: 'conversation',
		participants: [{ hostId: 'remote', botId: 'nova' }],
	});
	await host.command({
		type: 'send',
		conversationId: 'conversation',
		messageId: 'request',
		content: 'Finish the Code task.',
	});
	await host.idle();
	const polling = host.pollTaskWatches();
	await entered.promise;
	profile.historyAccess = false;
	polled.resolve({
		polls: [{ id: 'code', status: 'completed', cursor: 'done', answer: 'Sensitive task summary.' }],
	});
	await polling;
	await host.idle();
	expect(events).toEqual([]);
	expect((await host.snapshot()).conversations[0].messages).toHaveLength(2);
});
