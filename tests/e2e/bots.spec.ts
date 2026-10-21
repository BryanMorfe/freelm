import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { chooseOption } from './ui-controls';
import type {
	BotCommand,
	BotCommandResult,
	BotConversation,
	BotProfile,
	BotSnapshot,
} from '../../src/bot-types';

// Browser plugin not available. These checks exercise the real App with an
// isolated host facade. Native storage/provider execution is covered separately;
// no request reaches the user's profile, API connections, or remote computers.
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
	const entries: string[] = [];
	errors.set(page, entries);
	page.on('pageerror', (error) => entries.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') entries.push(entry.text());
	});
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));
test.setTimeout(120_000);
test.use({ actionTimeout: 30_000 });

function bot(id: string, name: string): BotProfile {
	return {
		id,
		name,
		address: `${name.toLowerCase()}@freelm`,
		color: '#799fdf',
		identity: 'A thoughtful assistant.',
		learnedPersonality: '',
		enabled: true,
		historyAccess: true,
		personalityLearning: true,
		connectionId: 'provider',
		model: 'fixture-chat',
		thinkingMode: 'low',
		createdAt: 1_790_000_000_000,
		updatedAt: 1_790_000_000_000,
	};
}
function conversation(hostId: string, botId: string, content: string): BotConversation {
	const now = Date.now() - 60_000;
	return {
		id: 'shared-conversation',
		title: '',
		participants: [{ hostId, botId }],
		draft: '',
		createdAt: now,
		updatedAt: now,
		readAt: now,
		messages: [
			{
				id: `${hostId}-welcome`,
				role: 'bot',
				author: { hostId, botId },
				content,
				createdAt: now,
				updatedAt: now,
				status: 'completed',
				reactions: [],
			},
		],
	};
}
async function fixture(page: Page, empty = false) {
	const state = initialState();
	const connection = state.connections[0];
	connection.id = 'provider';
	connection.name = 'Test provider';
	connection.models.chat = 'fixture-chat';
	connection.catalog = [
		{
			id: 'fixture-chat',
			name: 'Fixture chat',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{
					id: 'low',
					name: 'Low',
					parameters: {
						responses: { reasoning: { effort: 'low' } },
						chat: { reasoning_effort: 'low' },
					},
				},
			],
		},
	];
	state.activeConnectionId = connection.id;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	const snapshots: Record<string, BotSnapshot> = {
		local: {
			host: { id: 'local-instance', name: 'This computer' },
			revision: 0,
			bots: empty ? [] : [bot('fred-local', 'Fred'), bot('ada-local', 'Ada')],
			conversations: empty
				? []
				: [conversation('local-instance', 'fred-local', 'Hello from this computer.')],
			connections: [connection],
		},
		remote: {
			host: { id: 'remote-instance', name: 'Studio Mac' },
			revision: 0,
			bots: [bot('fred-remote', 'Fred')],
			conversations: [conversation('remote-instance', 'fred-remote', 'Hello from Studio Mac.')],
			connections: [connection],
		},
	};
	const calls: { targetId: string; command: BotCommand }[] = [];
	const control = { failSend: false, failMemory: false };
	let nextId = 0;
	await page.exposeFunction('__botsSnapshot', (targetId: string) => {
		if (!snapshots[targetId]) throw new Error(`Unknown fixture host ${targetId}`);
		return structuredClone(snapshots[targetId]);
	});
	await page.exposeFunction(
		'__botsCommand',
		(targetId: string, command: BotCommand): BotCommandResult => {
			calls.push({ targetId, command: structuredClone(command) });
			if (control.failSend && command.type === 'send')
				throw new Error('The selected host is temporarily unavailable.');
			if (control.failMemory && command.type === 'update-memory')
				throw new Error('Memory could not be saved.');
			const snapshot = snapshots[targetId];
			if (!snapshot) throw new Error(`Unknown fixture host ${targetId}`);
			const now = Date.now();
			let botId: string | undefined,
				conversationId: string | undefined,
				messageId: string | undefined;
			if (command.type === 'create-bot') {
				botId = command.id ?? `created-bot-${++nextId}`;
				snapshot.bots.push({
					...bot(botId, command.profile.name),
					...command.profile,
					address: command.profile.address ?? `${command.profile.name.toLowerCase()}@freelm`,
				});
			} else if (command.type === 'update-bot') {
				const profile = snapshot.bots.find((entry) => entry.id === command.botId)!;
				Object.assign(profile, command.changes, { updatedAt: now });
			} else if (command.type === 'update-memory' || command.type === 'delete-memory') {
				const profile = snapshot.bots.find((entry) => entry.id === command.botId)!;
				if (command.type === 'update-memory') {
					const memory = profile.memories?.find((item) => item.id === command.memoryId);
					if (!memory) throw new Error('Memory not found.');
					Object.assign(memory, { content: command.content, updatedAt: now });
				} else profile.memories = profile.memories?.filter((item) => item.id !== command.memoryId);
			} else if (command.type === 'create-conversation') {
				conversationId = command.id ?? `created-conversation-${++nextId}`;
				snapshot.conversations.push({
					id: conversationId,
					title: command.title ?? '',
					participants: command.participants,
					messages: [],
					draft: '',
					createdAt: now,
					updatedAt: now,
					readAt: now,
				});
			} else if ('conversationId' in command) {
				conversationId = command.conversationId;
				const thread = snapshot.conversations.find((entry) => entry.id === conversationId)!;
				if (!thread) throw new Error(`Unknown fixture conversation ${conversationId}`);
				if (
					command.type === 'job-approve' ||
					command.type === 'job-deny' ||
					command.type === 'job-cancel'
				) {
					const job = snapshot.jobs?.find((item) => item.id === command.jobId)!;
					job.status = command.type === 'job-approve' ? 'running' : 'cancelled';
				} else if (command.type === 'update-conversation') {
					for (const key of ['title', 'draft', 'readAt'] as const)
						if (command[key] !== undefined) Object.assign(thread, { [key]: command[key] });
				} else if (command.type === 'send') {
					messageId = command.messageId;
					thread.messages.push({
						id: messageId,
						role: 'user',
						content: command.content,
						createdAt: now,
						updatedAt: now,
						status: 'completed',
						reactions: [],
					});
					thread.draft = '';
					for (const author of thread.participants)
						thread.messages.push({
							id: `reply-${++nextId}`,
							role: 'bot',
							author,
							content: `Reply to ${command.content}`,
							createdAt: now + 1,
							updatedAt: now + 1,
							status: 'completed',
							reactions: [],
							replyTo: messageId,
						});
				} else if ('messageId' in command) {
					messageId = command.messageId;
					const message = thread.messages.find((entry) => entry.id === messageId)!;
					if (command.type === 'edit')
						Object.assign(message, { content: command.content, editedAt: now, updatedAt: now });
					if (command.type === 'unsend')
						Object.assign(message, {
							content: '',
							status: 'unsent',
							unsentAt: now,
							updatedAt: now,
							reactions: [],
						});
					if (command.type === 'react')
						message.reactions = command.emoji
							? [{ actorId: 'user', emoji: command.emoji, createdAt: now }]
							: [];
				}
				thread.updatedAt = now;
			}
			snapshot.revision++;
			return { snapshot: structuredClone(snapshot), botId, conversationId, messageId };
		},
	);
	await page.addInitScript(
		({ serialized }) => {
			let current = JSON.parse(serialized),
				revision = 0;
			const bridge = window as any;
			bridge.desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({
					state: structuredClone(current),
					revision: String(revision),
				}),
				workspaceSave: async (_target: string, _revision: string, next: unknown) => {
					current = structuredClone(next);
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: 'Isolated Bots fixture' }),
				instanceStatus: async () => ({
					host: { running: true, name: 'This computer', instanceId: 'local-instance', port: 4319 },
					instances: [
						{
							id: 'remote',
							name: 'Studio Mac',
							instanceId: 'remote-instance',
							transport: 'direct',
							url: 'http://studio.invalid:4319',
							connected: true,
							hasToken: true,
						},
					],
				}),
				botsSnapshot: bridge.__botsSnapshot,
				botsCommand: bridge.__botsCommand,
				onToolApproval: () => () => {},
				onOpenThread: () => () => {},
				onPrepareClose: () => () => {},
			};
		},
		{ serialized: JSON.stringify(state) },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	return { snapshots, calls, control };
}

async function openBots(page: Page) {
	await page.getByRole('button', { name: 'Bots', exact: true }).click();
	await expect(page.locator('.bots-sidebar')).toBeVisible();
}
async function openFred(page: Page) {
	await page.locator('.bots-sidebar .bot-inbox-row').filter({ hasText: 'Fred' }).first().click();
	await expect(page.getByLabel('Message your bot', { exact: true })).toBeVisible();
}

test('saved bot memories expose source, survive edits, report errors, and can be deleted independently of personality', async ({
	page,
}) => {
	const { snapshots, calls, control } = await fixture(page);
	const profile = snapshots.local.bots[0];
	profile.personalityLearning = false;
	profile.historyAccess = false;
	profile.memories = [
		{
			id: 'research-decision',
			key: 'benchmark-choice',
			kind: 'decision',
			content: 'The group chose the small benchmark.',
			source: {
				hostId: 'local-instance',
				conversationId: 'research',
				title: 'Research team',
				messageIds: ['source-message'],
				group: true,
			},
			createdAt: 1,
			updatedAt: 2,
		},
	];
	await openBots(page);
	await openFred(page);
	await page.getByRole('button', { name: 'Bot details', exact: true }).click();
	await expect(page.getByText('On · 1 saved memories', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Customize bot', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Customize bot' });
	await expect(dialog.getByRole('switch', { name: 'Persistent memory' })).toBeChecked();
	await expect(dialog.getByRole('switch', { name: 'Personality learning' })).not.toBeChecked();
	const row = dialog.getByRole('group', { name: 'Saved memory: benchmark-choice', exact: true });
	await expect(row.getByText('Research team', { exact: true })).toBeVisible();
	await row.getByRole('button', { name: 'Edit', exact: true }).click();
	await row
		.getByLabel('Edit memory: benchmark-choice')
		.fill('The group chose the revised benchmark.');
	control.failMemory = true;
	await row.getByRole('button', { name: 'Save memory', exact: true }).click();
	await expect(row.getByRole('alert')).toHaveText('Memory could not be saved.');
	expect(profile.memories[0].content).toBe('The group chose the small benchmark.');
	control.failMemory = false;
	await row.getByRole('button', { name: 'Save memory', exact: true }).click();
	await expect(
		row.getByText('The group chose the revised benchmark.', { exact: true }),
	).toBeVisible();
	await expect
		.poll(() => profile.memories?.[0].content)
		.toBe('The group chose the revised benchmark.');
	await dialog.getByRole('switch', { name: 'Persistent memory' }).click();
	await dialog.getByRole('button', { name: 'Save bot', exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(profile.memoryEnabled).toBe(false);
	expect(profile.personalityLearning).toBe(false);
	expect(profile.historyAccess).toBe(false);
	await page.getByRole('button', { name: 'Customize bot', exact: true }).click();
	await expect(dialog.getByRole('switch', { name: 'Persistent memory' })).not.toBeChecked();
	await expect(
		row.getByText('The group chose the revised benchmark.', { exact: true }),
	).toBeVisible();
	await row.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(row).toHaveCount(0);
	await expect.poll(() => profile.memories).toEqual([]);
	expect(
		calls
			.filter(
				(call) => call.command.type === 'update-memory' || call.command.type === 'delete-memory',
			)
			.map((call) => call.targetId),
	).toEqual(['local', 'local', 'local']);
	await page.screenshot({ path: '/tmp/freelm-bot-memory-settings.png' });
});

test('legacy bot hosts explain unsupported memory without saving a misleading enabled state', async ({
	page,
}) => {
	const { snapshots, calls } = await fixture(page);
	snapshots.remote.memorySupported = false;
	snapshots.remote.bots[0].memoryEnabled = false;
	await openBots(page);
	await page.locator('.bots-sidebar .bot-inbox-row').filter({ hasText: 'Studio Mac' }).click();
	await page.getByRole('button', { name: 'Bot details', exact: true }).click();
	await page.getByRole('button', { name: 'Customize bot', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Customize bot' });
	await expect(dialog.getByRole('switch', { name: 'Persistent memory' })).toBeDisabled();
	await expect(dialog.getByRole('switch', { name: 'Persistent memory' })).not.toBeChecked();
	await expect(
		dialog.getByText('Update FreeLM on this bot’s home computer to enable persistent memory.', {
			exact: true,
		}),
	).toBeVisible();
	await expect(dialog.getByRole('heading', { name: 'Saved memories' })).toHaveCount(0);
	await dialog.getByLabel('Name', { exact: true }).fill('Remote Fred');
	await dialog.getByRole('button', { name: 'Save bot', exact: true }).click();
	await expect(dialog).toBeHidden();
	const saved = calls.find(
		(call) => call.targetId === 'remote' && call.command.type === 'update-bot',
	);
	expect(saved?.command).toMatchObject({ type: 'update-bot', changes: { name: 'Remote Fred' } });
	if (saved?.command.type === 'update-bot')
		expect(saved.command.changes).not.toHaveProperty('memoryEnabled');
});

test('creates a named bot with an address, sends a message, and restores the host conversation', async ({
	page,
}) => {
	const { snapshots, calls } = await fixture(page, true);
	await openBots(page);
	await page.getByRole('button', { name: 'Create bot', exact: true }).first().click();
	const dialog = page.getByRole('dialog', { name: 'Create a bot' });
	await dialog.getByLabel('Name', { exact: true }).fill('Fred');
	await dialog
		.getByLabel('Identity', { exact: true })
		.fill('Help me develop creative projects, with concise replies.');
	await dialog.getByRole('button', { name: 'Create bot', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect.poll(() => snapshots.local.bots.length).toBe(1);
	expect(snapshots.local.bots[0]).toMatchObject({ name: 'Fred', address: 'fred@freelm' });
	await openFred(page);
	await page.getByLabel('Message your bot', { exact: true }).fill('Let us plan the next project.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.getByLabel('Message your bot', { exact: true })).toHaveValue('');
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('Reply to Let us plan the next project.', { exact: true }),
	).toBeVisible();
	expect(calls.filter((call) => call.command.type === 'send').map((call) => call.targetId)).toEqual(
		['local'],
	);
	await page.getByLabel('Message your bot', { exact: true }).fill('An unfinished thought.');
	await expect.poll(() => snapshots.local.conversations[0].draft).toBe('An unfinished thought.');
	await page.reload();
	await openBots(page);
	await openFred(page);
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('Reply to Let us plan the next project.', { exact: true }),
	).toBeVisible();
	await expect(page.getByLabel('Message your bot', { exact: true })).toHaveValue(
		'An unfinished thought.',
	);
	await page.screenshot({ path: '/tmp/freelm-bots-conversation.png' });
});

test('message actions edit, react, and unsend without leaving stale content after reload', async ({
	page,
}) => {
	const { snapshots } = await fixture(page);
	await openBots(page);
	await openFred(page);
	await page.getByLabel('Message your bot', { exact: true }).fill('Original message for Fred.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	const sent = () =>
		snapshots.local.conversations[0].messages.find((message) => message.role === 'user')!;
	await expect.poll(() => sent()?.content).toBe('Original message for Fred.');
	await page
		.getByRole('log', { name: 'Bot messages' })
		.getByText('Original message for Fred.', { exact: true })
		.hover();
	await page.getByRole('button', { name: /^Message actions: Original message for Fred/ }).click();
	await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await page.getByLabel('Edit message', { exact: true }).fill('Updated message for Fred.');
	await page.getByRole('button', { name: 'Save edit', exact: true }).click();
	await expect.poll(() => sent().content).toBe('Updated message for Fred.');
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('Updated message for Fred.', { exact: true }),
	).toBeVisible();
	await page
		.getByRole('log', { name: 'Bot messages' })
		.getByText('Updated message for Fred.', { exact: true })
		.hover();
	await page.getByRole('button', { name: /^Message actions: Updated message for Fred/ }).click();
	await page.getByRole('menuitem', { name: 'React ❤️', exact: true }).click();
	await expect.poll(() => sent().reactions.map((reaction) => reaction.emoji)).toEqual(['❤️']);
	await page.reload();
	await openBots(page);
	await openFred(page);
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('Updated message for Fred.', { exact: true }),
	).toBeVisible();
	await page
		.getByRole('log', { name: 'Bot messages' })
		.getByText('Updated message for Fred.', { exact: true })
		.hover();
	await page.getByRole('button', { name: /^Message actions: Updated message for Fred/ }).click();
	await page.getByRole('menuitem', { name: 'Unsend', exact: true }).click();
	await expect.poll(() => sent().status).toBe('unsent');
	expect(sent().content).toBe('');
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('Updated message for Fred.', { exact: true }),
	).toBeHidden();
	await page.reload();
	await openBots(page);
	await openFred(page);
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('Updated message for Fred.', { exact: true }),
	).toBeHidden();
});

test('matching bot addresses and conversation IDs on two hosts keep messages on the selected host', async ({
	page,
}) => {
	await observeBubbleAnimations(page);
	const { snapshots, calls } = await fixture(page);
	await openBots(page);
	await openFred(page);
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('Hello from this computer.', { exact: true }),
	).toBeVisible();
	// Direct inbox navigation keeps the same conversation ID but changes its host.
	expect(await animationIds(page)).toEqual([]);
	await page
		.locator('.bots-sidebar .bot-inbox-row')
		.filter({ hasText: 'Hello from Studio Mac.' })
		.click();
	await expect(page.getByRole('log', { name: 'Bot messages' })).toContainText(
		'Hello from Studio Mac.',
	);
	expect(await animationIds(page)).toEqual([]);
	await page
		.locator('.bots-sidebar .bot-inbox-row')
		.filter({ hasText: 'Hello from this computer.' })
		.click();
	await expect(page.getByRole('log', { name: 'Bot messages' })).toContainText(
		'Hello from this computer.',
	);
	expect(await animationIds(page)).toEqual([]);
	await chooseOption(page, page.getByLabel('Create bots on', { exact: true }), 'remote');
	await page
		.locator('.bots-sidebar .bot-inbox-row')
		.filter({ hasText: 'Hello from Studio Mac.' })
		.click();
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('Hello from Studio Mac.', { exact: true }),
	).toBeVisible();
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('Hello from this computer.', { exact: true }),
	).toBeHidden();
	await page.getByLabel('Message your bot', { exact: true }).fill('Remote-only message.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('Reply to Remote-only message.', { exact: true }),
	).toBeVisible();
	expect(calls.filter((call) => call.command.type === 'send').map((call) => call.targetId)).toEqual(
		['remote'],
	);
	expect(
		snapshots.local.conversations
			.flatMap((entry) => entry.messages)
			.some((entry) => entry.content.includes('Remote-only')),
	).toBe(false);
	await chooseOption(page, page.getByLabel('Create bots on', { exact: true }), 'local');
	await openFred(page);
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('Hello from this computer.', { exact: true }),
	).toBeVisible();
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('Reply to Remote-only message.', { exact: true }),
	).toBeHidden();
});

test('a group selects named bot addresses and shows a separate reply from each participant', async ({
	page,
}) => {
	const { snapshots, calls } = await fixture(page);
	await openBots(page);
	await page.getByRole('button', { name: 'New bot group', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'New group' });
	await dialog.getByLabel('Group name', { exact: true }).fill('Project council');
	await dialog.getByRole('button', { name: /Fred.*fred@freelm.*This computer/ }).click();
	await dialog.getByRole('button', { name: /Ada.*ada@freelm.*This computer/ }).click();
	await dialog.getByRole('button', { name: /Fred.*fred@freelm.*Studio Mac/ }).click();
	await dialog.getByRole('button', { name: 'Create group', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect
		.poll(
			() =>
				snapshots.local.conversations.find((entry) => entry.title === 'Project council')
					?.participants,
		)
		.toEqual([
			{ hostId: 'local-instance', botId: 'fred-local' },
			{ hostId: 'local-instance', botId: 'ada-local' },
			{ hostId: 'remote-instance', botId: 'fred-remote' },
		]);
	await page.getByLabel('Message your bot', { exact: true }).fill('What should we build next?');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('Reply to What should we build next?', { exact: true }),
	).toHaveCount(3);
	await expect(page.locator('.bot-message-name')).toHaveText([
		'Fred · This computer',
		'Ada',
		'Fred · Studio Mac',
	]);
	expect(calls.find((call) => call.command.type === 'create-conversation')?.targetId).toBe('local');
	await page.setViewportSize({ width: 760, height: 900 });
	await expect(page.getByLabel('Message your bot', { exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true,
	);
	await page.screenshot({ path: '/tmp/freelm-bots-group-narrow.png' });
});

test('a failed send preserves the composer text and can be retried without a duplicate message', async ({
	page,
}) => {
	const { snapshots, control } = await fixture(page);
	await openBots(page);
	await openFred(page);
	control.failSend = true;
	await page.getByLabel('Message your bot', { exact: true }).fill('Keep this unsent draft.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(
		page.getByRole('alert').filter({ hasText: 'temporarily unavailable' }).first(),
	).toBeVisible();
	await expect(page.getByLabel('Message your bot', { exact: true })).toHaveValue(
		'Keep this unsent draft.',
	);
	expect(
		snapshots.local.conversations[0].messages.filter((message) => message.role === 'user'),
	).toHaveLength(0);
	control.failSend = false;
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('Reply to Keep this unsent draft.', { exact: true }),
	).toBeVisible();
	await expect(page.getByLabel('Message your bot', { exact: true })).toHaveValue('');
	expect(
		snapshots.local.conversations[0].messages.filter((message) => message.role === 'user'),
	).toHaveLength(1);
});

test('delivery has no timestamp and becomes a timed read receipt when the bot reads the message', async ({
	page,
}) => {
	const { snapshots } = await fixture(page);
	await openBots(page);
	await openFred(page);
	await page.getByLabel('Message your bot', { exact: true }).fill('Please take a look at Mosaic.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	const ownMeta = page.locator('.bot-message-row.own .bot-message-meta');
	await expect(ownMeta).toHaveText('Delivered');
	await expect(ownMeta.locator('time')).toHaveCount(0);
	await expect(page.locator('.bot-message-row:not(.own) .bot-message-meta time')).toHaveCount(2);
	const sent = snapshots.local.conversations[0].messages.find(
		(message) => message.role === 'user',
	)!;
	const readAt = sent.createdAt + 120_000;
	sent.readBy = [{ hostId: 'local-instance', botId: 'fred-local', readAt }];
	snapshots.local.revision++;
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(ownMeta).toHaveText(/^Read \d{1,2}:\d{2} [AP]M$/);
	await expect(ownMeta.locator('time')).toHaveAttribute('datetime', new Date(readAt).toISOString());
	await page.screenshot({ path: '/tmp/freelm-bot-read-receipt-dark.png' });
	// Edits remain visible without reintroducing a sent timestamp or a stale read receipt.
	sent.editedAt = readAt + 1_000;
	sent.readBy = [];
	snapshots.local.revision++;
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(ownMeta).toHaveText('EditedDelivered');
	await expect(ownMeta.locator('time')).toHaveCount(0);
});

test('groups wait for every host-qualified participant and use the latest relevant read time', async ({
	page,
}) => {
	const { snapshots } = await fixture(page);
	const thread = snapshots.local.conversations[0];
	thread.title = 'Cross-host council';
	// Bot IDs alone are not enough to identify a participant across computers.
	snapshots.remote.bots[0].id = 'fred-local';
	thread.participants.push({ hostId: 'remote-instance', botId: 'fred-local' });
	const createdAt = Date.now() - 180_000;
	thread.messages.push({
		id: 'group-request',
		role: 'user',
		content: 'Can you both review it?',
		createdAt,
		updatedAt: createdAt,
		status: 'completed',
		reactions: [],
		readBy: [{ hostId: 'local-instance', botId: 'fred-local', readAt: createdAt + 60_000 }],
	});
	await openBots(page);
	await page
		.locator('.bots-sidebar .bot-inbox-row')
		.filter({ hasText: 'Cross-host council' })
		.click();
	const ownMeta = page.locator('.bot-message-row.own .bot-message-meta');
	await expect(ownMeta).toHaveText('Delivered');
	await expect(ownMeta.locator('time')).toHaveCount(0);
	const readAt = createdAt + 120_000;
	thread.messages
		.at(-1)!
		.readBy!.push(
			{ hostId: 'remote-instance', botId: 'fred-local', readAt },
			{ hostId: 'unrelated-host', botId: 'fred-local', readAt: readAt + 600_000 },
		);
	snapshots.local.revision++;
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(ownMeta).toHaveText(/^Read \d{1,2}:\d{2} [AP]M$/);
	await expect(ownMeta.locator('time')).toHaveAttribute('datetime', new Date(readAt).toISOString());
	await page.setViewportSize({ width: 760, height: 900 });
	await page.evaluate(() => {
		document.documentElement.dataset.theme = 'light';
	});
	await expect(ownMeta).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true,
	);
	await page.screenshot({ path: '/tmp/freelm-bot-read-receipt-light-narrow.png' });
});

test('thinking stays by the bot name and only reply writing shows typing dots', async ({
	page,
}) => {
	const { snapshots } = await fixture(page);
	const thread = snapshots.local.conversations[0];
	const pending = {
		id: 'active-reply',
		role: 'bot' as const,
		author: thread.participants[0],
		content: '',
		createdAt: thread.messages[0].createdAt + 40 * 60_000,
		updatedAt: Date.now(),
		status: 'pending' as const,
		reactions: [],
	};
	thread.messages.push(pending);
	await openBots(page);
	await openFred(page);
	const thinking = page.getByRole('status', { name: 'Fred is thinking', exact: true });
	const inbox = page.locator('.bots-sidebar .bot-inbox-row').filter({ hasText: 'Fred' }).first();
	// Older peers may omit activity. Pending without a phase is thinking, never writing.
	await expect(thinking).toBeVisible();
	await expect(inbox).toContainText('Thinking…');
	await expect(page.locator('.bot-typing')).toHaveCount(0);
	await expect(page.locator('.bot-message-row')).toHaveCount(1);
	await expect(page.locator('.bots-date-divider')).toHaveCount(1);
	await page.getByLabel('Message your bot', { exact: true }).fill('An unfinished follow-up.');
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
	await page.screenshot({ path: '/tmp/freelm-bot-thinking-dark.png' });
	async function phase(change: Partial<BotConversation['messages'][number]>) {
		Object.assign(pending, change);
		snapshots.local.revision++;
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	}
	await phase({ activity: 'writing', content: 'This is still being composed.' });
	await expect(thinking).toBeHidden();
	await expect(page.getByRole('status', { name: 'Fred is typing', exact: true })).toBeVisible();
	await expect(inbox).toContainText('Typing…');
	await expect(page.getByText('This is still being composed.', { exact: true })).toBeHidden();
	await expect(page.getByLabel('Message your bot', { exact: true })).toHaveValue(
		'An unfinished follow-up.',
	);
	await page.screenshot({ path: '/tmp/freelm-bot-writing-dark.png' });
	await phase({ activity: 'thinking', content: '' });
	await expect(thinking).toBeVisible();
	await expect(page.locator('.bot-typing')).toHaveCount(0);
	await phase({ activity: 'queued' });
	await expect(thinking).toBeHidden();
	await expect(inbox).toContainText('Queued');
	await expect(page.locator('.bot-message-row')).toHaveCount(1);
	await phase({ activity: 'writing' });
	await expect(page.locator('.bot-typing')).toHaveCount(1);
	await phase({ status: 'completed', content: 'I checked it. The layout looks good.' });
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('I checked it. The layout looks good.', { exact: true }),
	).toBeVisible();
	await expect(thinking).toBeHidden();
	await expect(page.locator('.bot-typing')).toHaveCount(0);
	await phase({ status: 'pending', activity: 'thinking', content: '' });
	await expect(thinking).toBeVisible();
	await phase({ status: 'failed', error: 'Connection interrupted.' });
	await expect(thinking).toBeHidden();
	await expect(page.getByText('Connection interrupted.', { exact: true })).toBeVisible();
	await phase({ status: 'unsent' });
	await expect(thinking).toBeHidden();
	await expect(page.locator('.bot-typing')).toHaveCount(0);
});

test('group activity names the correct host while another bot writes and queued bots stay quiet', async ({
	page,
}) => {
	const { snapshots } = await fixture(page);
	const thread = snapshots.local.conversations[0];
	thread.title = 'Cross-host council';
	thread.participants.push(
		{ hostId: 'remote-instance', botId: 'fred-remote' },
		{ hostId: 'local-instance', botId: 'ada-local' },
	);
	thread.messages.push(
		...thread.participants.map((author, index) => ({
			id: `pending-${index}`,
			role: 'bot' as const,
			author,
			content: '',
			status: 'pending' as const,
			activity: (['thinking', 'writing', 'queued'] as const)[index],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			reactions: [],
		})),
	);
	await openBots(page);
	await page
		.locator('.bots-sidebar .bot-inbox-row')
		.filter({ hasText: 'Cross-host council' })
		.click();
	await expect(
		page.getByRole('status', { name: 'Fred · This computer is thinking', exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole('status', { name: 'Fred · Studio Mac is typing', exact: true }),
	).toBeVisible();
	await expect(page.locator('.bots-thinking')).toHaveText('Fred · This computer · Thinking');
	await expect(page.locator('.bot-message-name')).toHaveText([
		'Fred · This computer',
		'Fred · Studio Mac',
	]);
	await expect(page.locator('.bot-typing')).toHaveCount(1);
	await expect(page.getByRole('status', { name: /Ada/ })).toHaveCount(0);
	await page.screenshot({ path: '/tmp/freelm-bot-group-activity-dark.png' });
	await page.setViewportSize({ width: 760, height: 900 });
	await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(page.locator('.bots-thinking-light')).toHaveCSS('animation-name', 'none');
	await expect(page.locator('.bot-typing span').first()).toHaveCSS('animation-name', 'none');
	await expect(page.locator('.bots-thinking')).toHaveCSS('font-size', '13px');
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true,
	);
	await page.screenshot({ path: '/tmp/freelm-bot-group-activity-light-narrow.png' });
});

// The flow under test is: Bots -> live arrivals and long replies -> a frosted
// header, restrained new-message motion, and expandable full-fidelity text.
async function observeBubbleAnimations(page: Page) {
	await page.addInitScript(() => {
		const state = window as any;
		state.__bubbleAnimations = [];
		const animate = Element.prototype.animate;
		Element.prototype.animate = function (...args: Parameters<typeof animate>) {
			if (this.matches('.bot-message-bubble-wrap')) {
				state.__bubbleAnimations.push({
					id: this.closest('[data-bot-message-id]')?.getAttribute('data-bot-message-id'),
					text: this.textContent,
				});
			}
			return animate.apply(this, args);
		};
	});
}
async function animationIds(page: Page): Promise<string[]> {
	return page.evaluate(() => (window as any).__bubbleAnimations.map((entry: any) => entry.id));
}
async function refreshBotSnapshot(page: Page, snapshots: Record<string, BotSnapshot>) {
	snapshots.local.revision++;
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

test('only new bubbles animate, including a pending reply that finishes, without replay on refresh or reactions', async ({
	page,
}) => {
	await observeBubbleAnimations(page);
	const { snapshots } = await fixture(page);
	const thread = snapshots.local.conversations[0];
	await openBots(page);
	await openFred(page);
	await expect(page.getByRole('log', { name: 'Bot messages' })).toContainText(
		'Hello from this computer.',
	);
	expect(await animationIds(page)).toEqual([]);

	thread.messages.push({
		id: 'arriving-reply',
		role: 'bot',
		author: thread.participants[0],
		content: '',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		status: 'pending',
		activity: 'thinking',
		reactions: [],
	});
	await refreshBotSnapshot(page, snapshots);
	await expect(page.getByRole('status', { name: 'Fred is thinking' })).toBeVisible();
	expect(await animationIds(page)).toEqual([]);
	Object.assign(thread.messages.at(-1)!, { activity: 'writing' });
	await refreshBotSnapshot(page, snapshots);
	await expect(page.getByRole('status', { name: 'Fred is typing' })).toBeVisible();
	await expect.poll(() => animationIds(page)).toEqual(['arriving-reply']);
	Object.assign(thread.messages.at(-1)!, {
		status: 'completed',
		content: 'A newly finished reply.',
	});
	await refreshBotSnapshot(page, snapshots);
	const fresh = page.locator('[data-bot-message-id="arriving-reply"]');
	await expect(fresh).toContainText('A newly finished reply.');
	await expect.poll(() => animationIds(page)).toEqual(['arriving-reply', 'arriving-reply']);
	await fresh.locator('.bot-message-bubble').hover();
	await fresh.getByRole('button', { name: /^Message actions:/ }).click();
	await page.getByRole('menuitem', { name: 'React ❤️', exact: true }).click();
	await expect(fresh.getByRole('button', { name: '❤️ reaction, 1' })).toBeVisible();
	expect(await animationIds(page)).toEqual(['arriving-reply', 'arriving-reply']);

	thread.messages[0].content = 'Refreshed historical content.';
	await refreshBotSnapshot(page, snapshots);
	await expect(page.getByRole('log', { name: 'Bot messages' })).toContainText(
		'Refreshed historical content.',
	);
	expect(await animationIds(page)).toEqual(['arriving-reply', 'arriving-reply']);
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	await openBots(page);
	await openFred(page);
	await expect(fresh).toContainText('A newly finished reply.');
	expect(await animationIds(page)).toEqual(['arriving-reply', 'arriving-reply']);
	await page.reload();
	await openBots(page);
	await openFred(page);
	await expect(fresh).toContainText('A newly finished reply.');
	expect(await animationIds(page)).toEqual([]);

	await page.emulateMedia({ reducedMotion: 'reduce' });
	thread.messages.push({
		id: 'reduced-motion-reply',
		role: 'bot',
		author: thread.participants[0],
		content: 'Motion stays quiet.',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		status: 'completed',
		reactions: [],
	});
	await refreshBotSnapshot(page, snapshots);
	await expect(page.getByRole('log', { name: 'Bot messages' })).toContainText(
		'Motion stays quiet.',
	);
	expect(await animationIds(page)).toEqual([]);
});

test('the translucent conversation header stays above messages scrolling beneath it in dark and light themes', async ({
	page,
}) => {
	const { snapshots } = await fixture(page);
	const thread = snapshots.local.conversations[0];
	const now = Date.now() - 60_000;
	thread.messages = Array.from({ length: 30 }, (_, index) => ({
		id: `header-message-${index}`,
		role: index % 2 ? 'bot' : 'user',
		author: index % 2 ? thread.participants[0] : undefined,
		content: `Message ${index + 1}: a conversation about new colors and a clearer layout.`,
		createdAt: now + index * 100,
		updatedAt: now + index * 100,
		status: 'completed',
		reactions: [],
	}));
	await openBots(page);
	await openFred(page);
	const header = page.locator('.bots-conversation-header');
	const log = page.getByRole('log', { name: 'Bot messages' });
	async function assertUnderlay() {
		await log.evaluate((node) => {
			node.scrollTop = 0;
		});
		const geometry = await page.evaluate(() => {
			const header = document.querySelector<HTMLElement>('.bots-conversation-header')!;
			const scroller = document.querySelector<HTMLElement>('.bots-messages')!;
			const first = document.querySelector<HTMLElement>(
				'[data-bot-message-id="header-message-0"] .bot-message-bubble',
			)!;
			const headerBox = header.getBoundingClientRect();
			const firstBox = first.getBoundingClientRect();
			scroller.scrollTop = firstBox.top - headerBox.top - 20;
			const underneath = first.getBoundingClientRect();
			const style = getComputedStyle(header);
			return {
				headerTop: headerBox.top,
				scrollerTop: scroller.getBoundingClientRect().top,
				headerBottom: headerBox.bottom,
				messageTop: underneath.top,
				messageBottom: underneath.bottom,
				filter: style.backdropFilter,
				background: style.backgroundColor,
			};
		});
		expect(geometry.scrollerTop).toBeLessThanOrEqual(geometry.headerTop + 1);
		expect(geometry.messageTop).toBeLessThan(geometry.headerBottom);
		expect(geometry.messageBottom).toBeGreaterThan(geometry.headerTop);
		expect(geometry.filter).toContain('blur(');
		expect(geometry.background).toMatch(/rgba\(|color\(/);
		await expect(header.getByRole('button', { name: 'Bot details', exact: true })).toBeVisible();
	}
	await assertUnderlay();
	await page.screenshot({ path: '/tmp/freelm-bots-frosted-header-dark.png' });
	await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
	await page.setViewportSize({ width: 760, height: 900 });
	await assertUnderlay();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true,
	);
	await page.screenshot({ path: '/tmp/freelm-bots-frosted-header-light-narrow.png' });
});

test('long bot replies expand from a ten-line preview while copy and reply preserve the complete message', async ({
	page,
}) => {
	const { snapshots, calls } = await fixture(page);
	const thread = snapshots.local.conversations[0];
	const content =
		Array.from(
			{ length: 24 },
			(_, index) =>
				`Detail ${index + 1}: This is a complete explanation of the chosen approach, with enough context to read comfortably.`,
		).join('\n\n') + '\n\n[Additional details](https://example.invalid/details)';
	thread.messages[0].content = content;
	await page.evaluate(() => {
		(window as any).__copiedBotText = '';
		(window as any).desktop.clipboardWriteText = async (value: string) => {
			(window as any).__copiedBotText = value;
		};
	});
	await openBots(page);
	await openFred(page);
	const row = page.locator('.bot-message-row').filter({ hasText: 'Detail 1:' });
	const body = row.locator('.bot-message-body-content');
	const more = row.getByRole('button', { name: 'See more', exact: true });
	await expect(more).toBeVisible();
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await body
		.locator('a')
		.last()
		.evaluate((node) => (node as HTMLElement).focus());
	await expect(body.locator('a').last()).not.toBeFocused();
	expect(
		await body
			.locator('a')
			.last()
			.evaluate((node) => node instanceof HTMLElement && node.inert),
	).toBe(true);
	const collapsed = await body.evaluate((node) => ({
		height: node.getBoundingClientRect().height,
		lineHeight: parseFloat(getComputedStyle(node).lineHeight),
		naturalHeight: node.scrollHeight,
	}));
	expect(collapsed.height).toBeLessThanOrEqual(collapsed.lineHeight * 10 + 2);
	expect(collapsed.naturalHeight).toBeGreaterThan(collapsed.height * 2);
	await page.screenshot({ path: '/tmp/freelm-bots-long-reply-dark.png' });
	await row.locator('.bot-message-bubble').hover();
	await row.getByRole('button', { name: /^Message actions:/ }).click();
	await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
	await expect.poll(() => page.evaluate(() => (window as any).__copiedBotText)).toBe(content);
	await row.locator('.bot-message-bubble').hover();
	await row.getByRole('button', { name: 'Reply to Fred', exact: true }).click();
	await expect(page.locator('.bots-reply-banner span')).toHaveText(content);
	await page
		.getByLabel('Message your bot', { exact: true })
		.fill('Replying to the complete message.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect
		.poll(() => calls.find((call) => call.command.type === 'send')?.command)
		.toMatchObject({
			type: 'send',
			replyTo: thread.messages[0].id,
		});
	await more.scrollIntoViewIfNeeded();
	const beforeExpansionTop = await body.evaluate((node) => node.getBoundingClientRect().top);
	await more.click();
	const afterExpansionTop = await body.evaluate((node) => node.getBoundingClientRect().top);
	expect(Math.abs(afterExpansionTop - beforeExpansionTop)).toBeLessThan(2);
	await expect(row.getByRole('button', { name: 'See less', exact: true })).toHaveAttribute(
		'aria-expanded',
		'true',
	);
	const expanded = await body.evaluate((node) => node.getBoundingClientRect().height);
	expect(expanded).toBeGreaterThan(collapsed.height * 2);
	await expect(body).toContainText('Detail 24:');
	await expect(body.getByRole('link', { name: 'Additional details' })).toBeVisible();
	expect(
		await body
			.locator('a')
			.last()
			.evaluate((node) => node instanceof HTMLElement && node.inert),
	).toBe(false);
	await row.getByRole('button', { name: 'See less', exact: true }).click();
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await page.setViewportSize({ width: 760, height: 900 });
	await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
	await more.scrollIntoViewIfNeeded();
	await expect(more).toHaveCSS('font-size', '13px');
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true,
	);
	await page.screenshot({ path: '/tmp/freelm-bots-long-reply-light-narrow.png' });
	// A short answer keeps the clean bubble without an unnecessary disclosure.
	const short = page
		.locator('.bot-message-row')
		.filter({ hasText: 'Reply to Replying to the complete message.' });
	await expect(short.getByRole('button', { name: 'See more', exact: true })).toHaveCount(0);
});

test('bot background work stays beside an enabled composer and approvals route to the owning host', async ({
	page,
}) => {
	const { snapshots, calls } = await fixture(page);
	const source = snapshots.local.conversations[0];
	// Same source conversation is visible on both fixture hosts; execution belongs to the remote bot.
	snapshots.remote.jobs = [
		{
			id: 'remote-approval',
			botId: 'fred-remote',
			sourceHostId: 'local-instance',
			conversationId: source.id,
			toolName: 'plugin_mail_send',
			title: 'Send the research summary',
			status: 'awaiting_approval',
			args: { to: 'team@example.test', body: 'The benchmark is ready.' },
			createdAt: Date.now(),
			updatedAt: Date.now(),
		},
	];
	snapshots.local.jobs = [
		{
			id: 'local-search',
			botId: 'fred-local',
			sourceHostId: 'local-instance',
			conversationId: source.id,
			toolName: 'plugin_archive_search',
			title: 'Search project notes',
			status: 'running',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		},
	];
	await openBots(page);
	await openFred(page);
	const drawer = page.getByRole('region', { name: 'Background work' });
	await expect(drawer).toBeVisible();
	const approval = drawer.getByRole('group', { name: 'Send the research summary: Needs approval' });
	await approval.getByRole('button', { name: /Send the research summary/ }).click();
	await expect(approval.getByText('Studio Mac', { exact: false })).toBeVisible();
	await expect(approval.locator('pre')).toContainText('team@example.test');
	const composer = page.getByLabel('Message your bot', { exact: true });
	await composer.fill('Wait, use the lab account.');
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
	await approval.getByRole('button', { name: 'Approve', exact: true }).click();
	await expect
		.poll(() =>
			calls.some(
				(entry) =>
					entry.targetId === 'remote' &&
					entry.command.type === 'job-approve' &&
					entry.command.jobId === 'remote-approval',
			),
		)
		.toBe(true);
	await expect(
		drawer.getByRole('group', { name: 'Send the research summary: Running' }),
	).toBeVisible();
	await drawer
		.getByRole('group', { name: 'Search project notes: Running' })
		.getByRole('button', { name: 'Stop job', exact: true })
		.click();
	await expect
		.poll(() =>
			calls.some(
				(entry) =>
					entry.targetId === 'local' &&
					entry.command.type === 'job-cancel' &&
					entry.command.jobId === 'local-search',
			),
		)
		.toBe(true);
	await expect(drawer.getByRole('group', { name: 'Search project notes: Stopped' })).toHaveCount(0);
	await expect(composer).toHaveValue('Wait, use the lab account.');
	await page.getByRole('button', { name: 'Bot details', exact: true }).click();
	await expect(
		page
			.getByRole('region', { name: 'Task history' })
			.getByRole('group', { name: 'Search project notes: Stopped' }),
	).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-bot-background-jobs.png' });
	await page.getByRole('button', { name: 'Close conversation details', exact: true }).click();
	await page.setViewportSize({ width: 900, height: 760 });
	await expect(drawer).toBeVisible();
	expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	expect(
		await drawer
			.locator('.bot-job-title')
			.first()
			.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
	).toBeGreaterThanOrEqual(13);
	await page.screenshot({ path: '/tmp/freelm-bot-background-jobs-narrow.png' });
});
