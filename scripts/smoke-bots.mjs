import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Real Electron IPC, native HTTP transport, durable mailbox, and rendered UI.
// Only this temporary profile and the loopback fixture provider are used.
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-bots-native-'));
const requests = [];
const instructionsFor = (entry) =>
	entry.url.endsWith('/responses') ? entry.body.instructions : entry.body.messages[0].content;
const contextBlock = (instructions, tag) => {
	const match = instructions.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n<\\/${tag}>`));
	return match ? JSON.parse(match[1]) : undefined;
};
const server = createServer(async (request, response) => {
	let raw = '';
	for await (const chunk of request) raw += chunk;
	const body = JSON.parse(raw || '{}');
	requests.push({ url: request.url, body, authorization: request.headers.authorization });
	if (!['/v1/responses', '/v1/chat/completions'].includes(request.url)) {
		response.writeHead(404);
		response.end();
		return;
	}
	await new Promise((resolve) => setTimeout(resolve, 1800));
	response.writeHead(200, { 'content-type': 'application/json' });
	const notification = contextBlock(
		instructionsFor({ url: request.url, body }),
		'freelm_notification',
	);
	const dialogue = request.url.endsWith('/responses') ? body.input : body.messages;
	const initialSilence =
		body.model === 'chat-bot' &&
		dialogue.some(
			(message) => message.role === 'user' && message.content === 'Only Fred should answer.',
		);
	if (notification || initialSilence) {
		// Reactions and peer follow-ups need no repetitive reply in this baseline fixture.
		response.end(
			JSON.stringify(
				request.url.endsWith('/responses')
					? {
							status: 'completed',
							output: [
								{
									type: 'function_call',
									call_id: 'silent-notification',
									name: 'bot_silence',
									arguments: '{}',
								},
							],
						}
					: {
							choices: [
								{
									finish_reason: 'tool_calls',
									message: {
										role: 'assistant',
										content: null,
										tool_calls: [
											{
												id: 'silent-notification',
												type: 'function',
												function: { name: 'bot_silence', arguments: '{}' },
											},
										],
									},
								},
							],
						},
			),
		);
		return;
	}
	// Reproduce a model copying the legacy FreeLM header, including an invented ID.
	const content = `[message_id: 2a7f3c91-8844-4d2e-9f6a-3c8d1f0e5b7a]\nHello from ${body.model}. Your bot is ready.`;
	response.end(
		JSON.stringify(
			request.url.endsWith('/responses')
				? {
						status: 'completed',
						output: [
							{
								type: 'message',
								role: 'assistant',
								content: [{ type: 'output_text', text: content }],
							},
						],
					}
				: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] },
		),
	);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
let desktop;
try {
	const env = { ...process.env, FREELM_HOME: profile, FREELM_USER_DATA: profile };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
	desktop = await electron.launch({
		...(executablePath
			? { executablePath, args: [`--user-data-dir=${profile}`] }
			: { args: ['.'] }),
		env,
	});
	const page = await desktop.firstWindow();
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForFunction(() => !!window.desktop?.botsSnapshot);
	await page.locator('.app-shell').waitFor();
	await page.evaluate(async (baseUrl) => {
		const state = (await window.desktop.load()) || {
			version: 1,
			connections: [
				{
					id: 'fixture',
					name: 'Test',
					baseUrl,
					apiKey: '',
					chatApi: 'responses',
					models: { chat: '', images: '', videos: '', speech: '', transcription: '' },
					discoveredModels: [],
				},
			],
			activeConnectionId: 'fixture',
			threads: [],
			projects: [],
			generations: [],
			theme: 'dark',
		};
		const connection = state.connections[0];
		Object.assign(connection, {
			id: 'fixture',
			name: 'Native test provider',
			baseUrl,
			apiKey: 'fixture-secret',
			chatApi: 'responses',
		});
		connection.models.chat = 'responses-bot';
		connection.catalog = ['responses-bot', 'chat-bot'].map((id) => ({
			id,
			name: id,
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
		}));
		state.connections.push({
			...structuredClone(connection),
			id: 'chat-fixture',
			chatApi: 'chat/completions',
		});
		state.activeConnectionId = connection.id;
		state.theme = 'dark';
		await window.desktop.save(state);
	}, baseUrl);
	await page.reload();
	await page.waitForFunction(() => !!window.desktop?.botsCommand);
	const ids = await page.evaluate(async () => {
		const bridge = window.desktop;
		const snapshot = await bridge.botsSnapshot('local');
		for (const [id, name, model, connectionId] of [
			['fred', 'Fred', 'responses-bot', 'fixture'],
			['ada', 'Ada', 'chat-bot', 'chat-fixture'],
		]) {
			await bridge.botsCommand('local', {
				type: 'create-bot',
				id,
				profile: {
					memoryEnabled: false,
					name,
					identity: 'A friendly test companion.',
					connectionId,
					model,
					thinkingMode: 'low',
				},
			});
		}
		await bridge.botsCommand('local', {
			type: 'create-conversation',
			id: 'native-group',
			title: 'Design team',
			participants: ['fred', 'ada'].map((botId) => ({ hostId: snapshot.host.id, botId })),
		});
		return { hostId: snapshot.host.id };
	});
	await page.getByRole('button', { name: 'Bots', exact: true }).click();
	await page.getByRole('button', { name: /Design team/ }).click();
	const composer = page.getByLabel('Message your bot', { exact: true });
	await composer.fill('@Ada, help me plan my next project.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(composer).toHaveValue('');
	// Navigate away while both replies run. They must be native-host jobs, not renderer tasks.
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	await expect
		.poll(
			async () =>
				page.evaluate(
					async () =>
						(await window.desktop.botsSnapshot('local')).conversations[0].messages.filter(
							(message) => message.role === 'bot' && message.status === 'completed',
						).length,
				),
			{ timeout: 30_000 },
		)
		.toBe(2);
	await page.getByRole('button', { name: 'Bots', exact: true }).click();
	await expect(
		page
			.getByRole('log')
			.getByText('Hello from responses-bot. Your bot is ready.', { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole('log').getByText('Hello from chat-bot. Your bot is ready.', { exact: true }),
	).toBeVisible();
	await expect(page.getByRole('log').locator('.bot-message-row.own strong')).toHaveText('@Ada');
	const beforeEdit = await page.evaluate(async () => {
		const { messages } = (await window.desktop.botsSnapshot('local')).conversations[0];
		return {
			user: messages.find((message) => message.role === 'user'),
			replies: messages.filter((message) => message.role === 'bot'),
		};
	});
	assert.deepEqual(beforeEdit.user.readBy.map((receipt) => receipt.botId).sort(), ['ada', 'fred']);
	assert.deepEqual(beforeEdit.user.mentions, [
		{ hostId: ids.hostId, botId: 'ada', start: 0, end: 4, label: 'Ada' },
	]);
	for (const receipt of beforeEdit.user.readBy) {
		assert.equal(receipt.hostId, ids.hostId);
		assert(receipt.readAt >= beforeEdit.user.createdAt);
		assert(
			receipt.readAt <=
				beforeEdit.replies.find((message) => message.author.botId === receipt.botId).updatedAt,
		);
	}
	await expect(page.locator('.bot-message-row.own .bot-message-meta')).toHaveText(
		/^Read \d{1,2}:\d{2} [AP]M$/,
	);
	await expect(page.locator('.bot-message-row.own .bot-message-meta time')).toHaveAttribute(
		'datetime',
		new Date(Math.max(...beforeEdit.user.readBy.map((receipt) => receipt.readAt))).toISOString(),
	);
	await page.screenshot({ path: '/tmp/freelm-bots-native-dark.png', animations: 'disabled' });
	await page.evaluate(async (messageId) => {
		await window.desktop.botsCommand('local', {
			type: 'react',
			conversationId: 'native-group',
			messageId,
			emoji: '❤️',
		});
	}, beforeEdit.user.id);
	await expect
		.poll(
			() =>
				requests.filter(
					(entry) =>
						contextBlock(instructionsFor(entry), 'freelm_notification')?.type === 'reaction',
				).length,
			{ timeout: 30_000 },
		)
		.toBe(2);
	await expect
		.poll(
			async () =>
				page.evaluate(
					async () =>
						(await window.desktop.botsSnapshot('local')).conversations[0].messages.filter(
							(message) => message.notification,
						).length,
				),
			{ timeout: 30_000 },
		)
		.toBe(0);
	const result = await page.evaluate(async (messageId) => {
		await window.desktop.botsCommand('local', {
			type: 'edit',
			conversationId: 'native-group',
			messageId,
			content: 'Plan a calm workspace app.',
		});
		const after = await window.desktop.botsSnapshot('local');
		return {
			keys: after.connections.map((connection) => connection.apiKey),
			user: after.conversations[0].messages[0],
			hostId: after.host.id,
		};
	}, beforeEdit.user.id);
	assert.equal(result.hostId, ids.hostId);
	assert.deepEqual(result.keys, ['', '']);
	assert.equal(result.user.content, 'Plan a calm workspace app.');
	assert.equal(result.user.reactions[0].emoji, '❤️');
	assert.equal(result.user.readBy, undefined);
	const initialRequests = requests.filter(
		(entry) => !contextBlock(instructionsFor(entry), 'freelm_notification'),
	);
	const notificationRequests = requests.filter(
		(entry) => contextBlock(instructionsFor(entry), 'freelm_notification')?.type === 'reaction',
	);
	const groupRequests = requests.filter(
		(entry) =>
			contextBlock(instructionsFor(entry), 'freelm_notification')?.type === 'group_message',
	);
	assert.equal(groupRequests.length, 1);
	assert.equal(requests.length, 5);
	assert.deepEqual(
		initialRequests.map((entry) => entry.url),
		['/v1/responses', '/v1/chat/completions'],
	);
	assert.equal(initialRequests[0].body.reasoning.effort, 'low');
	assert.equal(initialRequests[1].body.reasoning_effort, 'low');
	for (const entry of initialRequests) {
		const instructions = instructionsFor(entry);
		const group = contextBlock(instructions, 'freelm_group_context');
		assert.deepEqual(
			group.participants.map((participant) => participant.botId),
			['fred', 'ada'],
		);
		assert.equal(group.self.botId, entry.body.model === 'responses-bot' ? 'fred' : 'ada');
		const context = contextBlock(instructions, 'freelm_message_context');
		assert.deepEqual(
			context.find((message) => message.messageId === beforeEdit.user.id).mentions,
			beforeEdit.user.mentions,
		);
	}
	assert.deepEqual(notificationRequests.map((entry) => entry.body.model).sort(), [
		'chat-bot',
		'responses-bot',
	]);
	for (const entry of notificationRequests) {
		const instructions = instructionsFor(entry);
		const notification = contextBlock(instructions, 'freelm_notification');
		assert.equal(notification.type, 'reaction');
		assert.equal(notification.messageId, beforeEdit.user.id);
		assert.equal(notification.emoji, '❤️');
		const context = contextBlock(instructions, 'freelm_message_context');
		assert(
			context
				.find((message) => message.messageId === beforeEdit.user.id)
				.reactions.some((reaction) => reaction.actorId === 'user' && reaction.emoji === '❤️'),
		);
	}
	assert(requests.every((entry) => entry.authorization === 'Bearer fixture-secret'));
	for (const entry of requests) {
		const responses = entry.url.endsWith('/responses');
		const dialogue = responses ? entry.body.input : entry.body.messages.slice(1);
		const instructions = responses ? entry.body.instructions : entry.body.messages[0].content;
		assert(instructions.includes('<freelm_message_context>'));
		assert(dialogue.every((message) => !message.content.startsWith('[message_id:')));
	}
	const store = JSON.parse(await readFile(path.join(profile, 'bots', 'workspace.json'), 'utf8'));
	assert.equal(store.bots.length, 2);
	assert.equal(store.conversations[0].messages[0].content, result.user.content);
	assert(!JSON.stringify(store).includes('fixture-secret'));
	assert(
		store.conversations[0].messages
			.filter((message) => message.role === 'bot')
			.every((message) => message.content.startsWith('Hello from ')),
	);
	assert.deepEqual(errors, []);
	// Every participant can read a new human turn without all of them posting a bubble.
	await page.evaluate(async () => {
		const { host } = await window.desktop.botsSnapshot('local');
		await window.desktop.botsCommand('local', {
			type: 'create-conversation',
			id: 'native-quiet-group',
			title: 'Quiet team',
			participants: ['fred', 'ada'].map((botId) => ({ hostId: host.id, botId })),
		});
		await window.desktop.botsCommand('local', {
			type: 'send',
			conversationId: 'native-quiet-group',
			messageId: 'quiet-request',
			content: 'Only Fred should answer.',
		});
	});
	await expect
		.poll(
			async () =>
				page.evaluate(async () => {
					const conversation = (await window.desktop.botsSnapshot('local')).conversations.find(
						(item) => item.id === 'native-quiet-group',
					);
					return conversation.messages.some((message) => message.status === 'pending');
				}),
			{ timeout: 30_000 },
		)
		.toBe(false);
	const quiet = await page.evaluate(async () =>
		(await window.desktop.botsSnapshot('local')).conversations.find(
			(item) => item.id === 'native-quiet-group',
		),
	);
	assert.deepEqual(
		quiet.messages.map((message) => message.content),
		['Only Fred should answer.', 'Hello from responses-bot. Your bot is ready.'],
	);
	assert.deepEqual(quiet.messages[0].readBy.map((receipt) => receipt.botId).sort(), [
		'ada',
		'fred',
	]);
	assert(quiet.messages.every((message) => message.status === 'completed' && message.content));
	assert.equal(requests.length, 7);
	assert.deepEqual(errors, []);
	console.log(
		'PASS: native Bots IPC, both provider protocols, resolved group mentions and rosters, peer notifications, optional initial silence without empty bubbles, separated message metadata, envelope cleanup, background replies, timed read receipts, editing, silent reaction notifications to both bots, and durable host storage.',
	);
} finally {
	await desktop?.close();
	await new Promise((resolve) => server.close(resolve));
	await rm(profile, { recursive: true, force: true });
}
