import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { resolveBotMentions } from '../../src/lib/bot-mentions';
import type { BotCommand, BotConversation, BotProfile, BotSnapshot } from '../../src/bot-types';

// Browser plugin not available. This is the real renderer with a disposable in-memory
// host facade; no provider, remote host, or user profile is accessed.
test.setTimeout(120_000);
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
	const entries: string[] = [];
	errors.set(page, entries);
	page.on('pageerror', (error) => entries.push(error.message));
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));

async function fixture(page: Page, busy = false) {
	const state = initialState();
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	const now = Date.now();
	const profile = (id: string, name: string): BotProfile => ({
		id,
		name,
		address: `${id}@freelm`,
		color: '#799fdf',
		identity: '',
		learnedPersonality: '',
		enabled: true,
		historyAccess: true,
		personalityLearning: true,
		connectionId: '',
		model: '',
		createdAt: now,
		updatedAt: now,
	});
	const localBots = [profile('nova', 'Nova'), profile('alex-local', 'Alex Morgan')];
	const remoteBots = [profile('alex-remote', 'Alex Morgan')];
	const roster = [
		...localBots.map((bot) => ({
			hostId: 'local',
			botId: bot.id,
			name: bot.name,
			address: bot.address,
		})),
		...remoteBots.map((bot) => ({
			hostId: 'remote',
			botId: bot.id,
			name: bot.name,
			address: bot.address,
		})),
	];
	const content = '@Nova can review. Keep `@Nova` and [@Nova](https://example.com) as examples.';
	const thread: BotConversation = {
		id: 'group',
		title: 'Design team',
		participants: roster.map(({ hostId, botId }) => ({ hostId, botId })),
		draft: '',
		createdAt: now,
		updatedAt: now,
		readAt: now,
		groupReplyLimit: 12,
		messages: [
			{
				id: 'reply',
				role: 'bot',
				author: { hostId: 'local', botId: 'alex-local' },
				content,
				mentions: resolveBotMentions(content, roster),
				createdAt: now,
				updatedAt: now,
				status: 'completed',
				reactions: [],
			},
		],
	};
	if (busy)
		thread.messages.push({
			id: 'pending',
			role: 'bot',
			author: { hostId: 'local', botId: 'nova' },
			content: '',
			createdAt: now,
			updatedAt: now,
			status: 'pending',
			activity: 'thinking',
			reactions: [],
		});
	const snapshots: Record<string, BotSnapshot> = {
		local: {
			host: { id: 'local', name: 'This computer' },
			revision: 0,
			bots: localBots,
			conversations: [thread],
			connections: [],
		},
		remote: {
			host: { id: 'remote', name: 'Studio Linux' },
			revision: 0,
			bots: remoteBots,
			conversations: [],
			connections: [],
		},
	};
	const calls: BotCommand[] = [];
	await page.exposeFunction('__groupSnapshot', (id: string) => structuredClone(snapshots[id]));
	await page.exposeFunction('__groupCommand', (target: string, command: BotCommand) => {
		calls.push(structuredClone(command));
		const snapshot = snapshots[target];
		if (command.type === 'update-conversation') {
			for (const key of ['draft', 'draftMentions', 'readAt', 'groupReplyLimit'] as const)
				if (command[key] !== undefined) Object.assign(thread, { [key]: command[key] });
		} else if (command.type === 'send') {
			thread.messages.push({
				id: command.messageId,
				role: 'user',
				content: command.content,
				mentions: command.mentions,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				status: 'completed',
				reactions: [],
			});
			thread.draft = '';
			thread.draftMentions = [];
			thread.groupReplyState = undefined;
		} else if (command.type === 'edit') {
			Object.assign(
				thread.messages.find((message) => message.id === command.messageId)!,
				{
					content: command.content,
					mentions: command.mentions,
					editedAt: Date.now(),
					updatedAt: Date.now(),
				},
			);
		} else if (command.type === 'stop') {
			thread.messages = thread.messages.filter((message) => message.status !== 'pending');
			thread.groupReplyState = { rootMessageId: 'request', automaticReplies: 3, paused: 'stopped' };
		}
		snapshot.revision++;
		return { snapshot: structuredClone(snapshot) };
	});
	await page.addInitScript(
		({ serialized }) => {
			const state = JSON.parse(serialized);
			const bridge = window as any;
			bridge.desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({ state: structuredClone(state), revision: '0' }),
				workspaceSave: async () => ({ revision: '1' }),
				storageInfo: async () => ({ secure: false, location: 'Isolated group fixture' }),
				instanceStatus: async () => ({
					host: { running: true, name: 'This computer', instanceId: 'local', port: 4319 },
					instances: [
						{
							id: 'remote',
							instanceId: 'remote',
							name: 'Studio Linux',
							transport: 'direct',
							connected: true,
							hasToken: true,
							url: 'http://fixture.invalid',
						},
					],
				}),
				botsSnapshot: bridge.__groupSnapshot,
				botsCommand: bridge.__groupCommand,
				onToolApproval: () => () => {},
				onOpenThread: () => () => {},
				onPrepareClose: () => () => {},
			};
		},
		{ serialized: JSON.stringify(state) },
	);
	await page.route('**/*', async (route) => {
		const url = new URL(route.request().url());
		if (
			!['127.0.0.1', 'localhost'].includes(url.hostname) &&
			!['data:', 'blob:'].includes(url.protocol)
		)
			return route.abort();
		return route.continue();
	});
	await page.goto('/');
	await openGroup(page);
	return { thread, calls };
}
async function openGroup(page: Page) {
	await expect(page).toHaveTitle('FreeLM');
	await page.getByRole('button', { name: 'Bots', exact: true }).click();
	await page.locator('.bots-sidebar button').filter({ hasText: 'Design team' }).click();
	await expect(page.getByLabel('Message your bot', { exact: true })).toBeVisible();
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
}

test('group mentions preserve host identity through emoji edits, saved drafts and sent messages', async ({
	page,
}) => {
	const { thread, calls } = await fixture(page);
	const log = page.getByRole('log', { name: 'Bot messages' });
	await expect(log.locator('strong').filter({ hasText: '@Nova' })).toHaveCount(1);
	await expect(log.locator('code')).toHaveText('@Nova');
	await expect(log.locator('a')).toHaveText('@Nova');
	await expect(log.locator('code strong, a strong')).toHaveCount(0);
	const input = page.getByLabel('Message your bot', { exact: true });
	await input.fill('🎉 @Alex');
	await expect(page.getByRole('listbox', { name: 'Mention a bot' })).toBeVisible();
	await expect(page.getByRole('option')).toHaveCount(2);
	await input.press('ArrowDown');
	await input.press('Enter');
	await expect(input).toHaveValue('🎉 @Alex Morgan · Studio Linux ');
	await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
	await input.pressSequentially('Hello ');
	await expect.poll(() => thread.draftMentions?.[0]?.start).toBe(9);
	await expect.poll(() => thread.draftMentions?.[0]?.hostId).toBe('remote');
	await page.reload();
	await openGroup(page);
	await expect(input).toHaveValue('Hello 🎉 @Alex Morgan · Studio Linux ');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	const sent = () => thread.messages.filter((message) => message.role === 'user').at(-1)!;
	await expect.poll(() => sent()?.mentions?.[0]?.hostId).toBe('remote');
	await expect(
		log.locator('strong').filter({ hasText: '@Alex Morgan · Studio Linux' }),
	).toHaveCount(1);
	const bubble = page.locator('.bot-message-row.own').last();
	await bubble.locator('.bot-message-bubble-wrap').click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
	const edit = page.getByLabel('Edit message', { exact: true });
	await edit.evaluate((element: HTMLTextAreaElement) =>
		element.setSelectionRange(element.value.length, element.value.length),
	);
	await edit.pressSequentially(' and @Nova');
	await edit.press('Enter');
	await page.getByRole('button', { name: 'Save edit', exact: true }).click();
	await expect
		.poll(() => sent().mentions?.map((mention) => mention.botId))
		.toEqual(['alex-remote', 'nova']);
	await expect(bubble.locator('strong').filter({ hasText: '@Nova' })).toHaveCount(1);
	expect(calls.some((command) => command.type === 'edit' && command.mentions?.length === 2)).toBe(
		true,
	);
});

test('running groups offer stop while preserving a typed draft and configurable follow-up limits', async ({
	page,
}) => {
	const { thread, calls } = await fixture(page, true);
	await expect(page.getByRole('button', { name: 'Stop reply', exact: true })).toBeVisible();
	const input = page.getByLabel('Message your bot', { exact: true });
	await input.fill('Keep this draft while I stop.');
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Stop reply', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Stop group replies', exact: true }).click();
	await expect(input).toHaveValue('Keep this draft while I stop.');
	await expect(
		page.getByText('Group replies stopped. Send a message to continue.', { exact: true }),
	).toBeVisible();
	expect(calls.filter((command) => command.type === 'stop')).toHaveLength(1);
	await page.getByRole('button', { name: 'Show conversation details', exact: true }).click();
	await page.getByLabel('Automatic replies', { exact: true }).fill('5');
	await page.getByLabel('Automatic replies', { exact: true }).press('Enter');
	await expect.poll(() => thread.groupReplyLimit).toBe(5);
	await page.getByRole('button', { name: 'Close conversation details', exact: true }).click();
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(
		page.getByText('Group replies stopped. Send a message to continue.', { exact: true }),
	).toHaveCount(0);
	await expect(input).toHaveValue('');
});
