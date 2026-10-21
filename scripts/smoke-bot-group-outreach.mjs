import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolated native IPC -> fixture inference -> group delivery -> peer inference -> UI.
// FREELM_SMOKE_EXECUTABLE may point at a staged, signed FreeLM executable.
// No real profile, provider, bot, conversation, or remote computer is used.
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-group-outreach-native-'));
const privateDetail = 'private-fixture-detail-419';
const question = `Ask the group in #general if they need anything. Unrelated private note: ${privateDetail}.`;
const outreach = 'Does anyone in General need anything?';
const peerAnswer = 'I could use help reviewing the research outline.';
const acknowledgment = 'Got it, I’ll ask General.';
const confirmation = 'I asked General whether anyone needs anything.';
const providerErrors = [];
const pageErrors = [];
const calls = [];
let desktop;
let hostId;
let waitingAfterAcknowledgment = false;
let releaseWork;
const workGate = new Promise((resolve) => {
	releaseWork = resolve;
});

function block(instructions, tag) {
	const match = instructions.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n<\\/${tag}>`));
	return match ? JSON.parse(match[1]) : undefined;
}
function result(responses, content, tool) {
	if (responses)
		return {
			status: 'completed',
			output: tool
				? [
						{
							type: 'function_call',
							call_id: tool.id,
							name: tool.name,
							arguments: JSON.stringify(tool.args),
						},
					]
				: [
						{
							type: 'message',
							role: 'assistant',
							content: [{ type: 'output_text', text: content }],
						},
					],
		};
	return {
		choices: [
			{
				finish_reason: tool ? 'tool_calls' : 'stop',
				message: tool
					? {
							role: 'assistant',
							content: null,
							tool_calls: [
								{
									id: tool.id,
									type: 'function',
									function: { name: tool.name, arguments: JSON.stringify(tool.args) },
								},
							],
						}
					: { role: 'assistant', content },
			},
		],
	};
}
const server = createServer(async (request, response) => {
	try {
		assert(['/v1/responses', '/v1/chat/completions'].includes(request.url));
		assert.equal(request.headers.authorization, 'Bearer fixture-secret');
		let raw = '';
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		const responses = request.url.endsWith('/responses');
		const instructions = responses ? body.instructions : body.messages[0].content;
		const dialogue = responses ? body.input : body.messages.slice(1);
		const notification = block(instructions, 'freelm_notification');
		const group = block(instructions, 'freelm_group_context');
		const names = body.tools.map((tool) => (responses ? tool.name : tool.function.name));
		assert(!names.includes('bot_remember'), 'Fixture personality learning must remain disabled.');
		calls.push({ model: body.model, group: !!group, notification, names });
		assert(calls.length <= 8, 'The completed group exchange must not enter a reply loop.');
		let content = '',
			tool;
		if (group) {
			assert.equal(notification?.type, 'group_message');
			assert.equal(notification.readOnly, true);
			assert(!raw.includes(privateDetail), 'The private DM leaked into group inference.');
			assert(!names.includes('bot_groups_send'), 'Peer replies must not gain outreach authority.');
			assert(
				JSON.stringify(dialogue).includes(outreach),
				'Peer inference did not receive the outreach.',
			);
			if (body.model === 'pip-chat') {
				assert.equal(group.self.botId, 'pip');
				content = peerAnswer;
			} else {
				assert.equal(group.self.botId, 'nova');
				assert(JSON.stringify(dialogue).includes(peerAnswer));
				tool = { id: 'quiet-follow-up', name: 'bot_silence', args: {} };
			}
		} else {
			assert.equal(body.model, 'nova-responses');
			assert(names.includes('bot_groups_list') && names.includes('bot_groups_send'));
			const acknowledged = dialogue.find(
				(message) => message.type === 'function_call_output' && message.call_id === 'acknowledge',
			);
			const listed = dialogue.find(
				(message) => message.type === 'function_call_output' && message.call_id === 'find-general',
			);
			const sent = dialogue.find(
				(message) => message.type === 'function_call_output' && message.call_id === 'ask-general',
			);
			if (!acknowledged)
				tool = {
					id: 'acknowledge',
					name: 'bot_send_message',
					args: { text: acknowledgment },
				};
			else if (!listed) {
				waitingAfterAcknowledgment = true;
				await workGate;
				tool = { id: 'find-general', name: 'bot_groups_list', args: { query: '#general' } };
			} else if (!sent) {
				const groups = JSON.parse(listed.output);
				assert.equal(groups.length, 1, 'Discovery must return only the one member group.');
				assert.equal(groups[0].host_id, hostId);
				assert.equal(groups[0].conversation_id, 'general');
				tool = {
					id: 'ask-general',
					name: 'bot_groups_send',
					args: {
						host_id: groups[0].host_id,
						conversation_id: groups[0].conversation_id,
						text: outreach,
					},
				};
			} else {
				const receipt = JSON.parse(sent.output);
				assert.equal(receipt.hostId, hostId);
				assert.equal(receipt.conversationId, 'general');
				assert.equal(receipt.deduplicated, false);
				assert(receipt.messageId);
				content = confirmation;
			}
		}
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify(result(responses, content, tool)));
	} catch (error) {
		providerErrors.push(error.message);
		response.writeHead(500, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: { message: error.message } }));
	}
});

try {
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
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
	page.on('pageerror', (error) => pageErrors.push(error.message));
	await page.waitForFunction(() => !!window.desktop?.botsSnapshot);
	await page.locator('.app-shell').waitFor();
	await page.evaluate(async (baseUrl) => {
		const state = (await window.desktop.load()) || {
			version: 1,
			connections: [],
			threads: [],
			projects: [],
			generations: [],
			theme: 'dark',
		};
		const connection = structuredClone(
			state.connections[0] || {
				models: { chat: '', images: '', videos: '', speech: '', transcription: '' },
				discoveredModels: [],
			},
		);
		state.connections = ['responses', 'chat/completions'].map((chatApi, index) => ({
			...structuredClone(connection),
			id: `fixture-${index}`,
			name: `Fixture ${index}`,
			baseUrl,
			apiKey: 'fixture-secret',
			chatApi,
			models: { ...connection.models, chat: index ? 'pip-chat' : 'nova-responses' },
			catalog: [
				{
					id: index ? 'pip-chat' : 'nova-responses',
					name: index ? 'Pip test' : 'Nova test',
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
			],
		}));
		state.activeConnectionId = 'fixture-0';
		state.theme = 'dark';
		await window.desktop.save(state);
	}, baseUrl);
	await page.reload();
	await page.locator('.app-shell').waitFor();
	hostId = await page.evaluate(async () => {
		const bridge = window.desktop;
		const { host } = await bridge.botsSnapshot('local');
		for (const [id, name, model, connectionId] of [
			['nova', 'Nova', 'nova-responses', 'fixture-0'],
			['pip', 'Pip', 'pip-chat', 'fixture-1'],
		])
			await bridge.botsCommand('local', {
				type: 'create-bot',
				id,
				profile: {
					name,
					identity: 'A concise fixture companion.',
					model,
					connectionId,
					thinkingMode: 'low',
					memoryEnabled: false,
					historyAccess: false,
					personalityLearning: false,
				},
			});
		await bridge.botsCommand('local', {
			type: 'create-conversation',
			id: 'general',
			title: 'General',
			participants: ['nova', 'pip'].map((botId) => ({ hostId: host.id, botId })),
		});
		return host.id;
	});
	await page.getByRole('button', { name: 'Bots', exact: true }).click();
	await page.locator('.bots-sidebar').getByRole('button', { name: /Nova/ }).click();
	const composer = page.getByLabel('Message your bot', { exact: true });
	await composer.fill(question);
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(composer).toHaveValue('');
	await expect.poll(() => waitingAfterAcknowledgment, { timeout: 30_000 }).toBe(true);
	await expect(page.getByRole('log').getByText(acknowledgment, { exact: true })).toBeVisible();
	await expect(page.getByRole('log').getByText(confirmation, { exact: true })).toHaveCount(0);
	const earlySnapshot = await page.evaluate(() => window.desktop.botsSnapshot('local'));
	const earlyDirect = earlySnapshot.conversations.find(
		(conversation) => conversation.participants.length === 1,
	);
	assert.deepEqual(
		earlyDirect.messages
			.filter((message) => message.role === 'bot' && message.status === 'completed')
			.map((message) => message.content),
		[acknowledgment],
	);
	assert(earlyDirect.messages.some((message) => message.status === 'pending'));
	assert.equal(
		earlySnapshot.conversations.find((conversation) => conversation.id === 'general').messages
			.length,
		0,
		'The acknowledgment must be visible before group outreach begins.',
	);
	assert.equal(
		calls.length,
		2,
		'Further inference must remain blocked at the acknowledgment gate.',
	);
	await page.screenshot({
		path: '/tmp/freelm-bot-acknowledgment-native.png',
		animations: 'disabled',
	});
	releaseWork();
	await expect(page.getByRole('log').getByText(confirmation, { exact: true })).toBeVisible({
		timeout: 30_000,
	});
	await expect
		.poll(
			async () =>
				page.evaluate(async () => {
					const snapshot = await window.desktop.botsSnapshot('local');
					const group = snapshot.conversations.find(
						(conversation) => conversation.id === 'general',
					);
					return {
						count: group.messages.length,
						pending: snapshot.conversations.some((conversation) =>
							conversation.messages.some((message) => message.status === 'pending'),
						),
					};
				}),
			{ timeout: 30_000 },
		)
		.toEqual({ count: 2, pending: false });
	const snapshot = await page.evaluate(() => window.desktop.botsSnapshot('local'));
	const group = snapshot.conversations.find((conversation) => conversation.id === 'general');
	assert.deepEqual(
		group.messages.map((message) => message.content),
		[outreach, peerAnswer],
	);
	assert(
		group.messages.every((message) => message.role === 'bot' && message.status === 'completed'),
	);
	assert.equal(group.messages[0].author.botId, 'nova');
	assert.equal(group.messages[0].groupOutreach, true);
	assert.equal(group.messages[0].replyTo, group.messages[0].id);
	assert.equal(group.messages[1].author.botId, 'pip');
	assert(!JSON.stringify(group).includes(privateDetail));
	assert.deepEqual(
		snapshot.conversations
			.find((conversation) => conversation.participants.length === 1)
			.messages.map((message) => message.content),
		[question, acknowledgment, confirmation],
	);
	assert.equal(calls.length, 6);
	assert.deepEqual(
		calls.filter((entry) => entry.group).map((entry) => entry.model),
		['pip-chat', 'nova-responses'],
	);
	assert.deepEqual(providerErrors, []);
	assert.deepEqual(pageErrors, []);
	await page
		.locator('.bots-sidebar')
		.getByRole('button', { name: /^General / })
		.click();
	await expect(page.getByRole('log').getByText(outreach, { exact: true })).toBeVisible();
	await expect(page.getByRole('log').getByText(peerAnswer, { exact: true })).toBeVisible();
	await expect(page.getByRole('log').getByText(question, { exact: true })).toHaveCount(0);
	await page.screenshot({
		path: '/tmp/freelm-bot-group-outreach-native.png',
		animations: 'disabled',
	});
	await desktop.close();
	desktop = undefined;
	const store = JSON.parse(await readFile(path.join(profile, 'bots', 'workspace.json'), 'utf8'));
	const savedGroup = store.conversations.find((conversation) => conversation.id === 'general');
	assert.deepEqual(
		savedGroup.messages.map((message) => message.content),
		[outreach, peerAnswer],
	);
	assert(!JSON.stringify(savedGroup).includes(privateDetail));
	assert.deepEqual(
		store.conversations
			.find((conversation) => conversation.participants.length === 1)
			.messages.map((message) => message.content),
		[question, acknowledgment, confirmation],
	);
	assert(!JSON.stringify(store).includes('fixture-secret'));
	console.log(
		'PASS: isolated native acknowledgment visible before work, group discovery and bot-authored delivery, actual peer reply across both provider protocols, optional silence, private-context isolation, rendered group messages, and durable mailbox with acknowledgment and result exactly once.',
	);
} finally {
	releaseWork();
	await desktop?.close().catch(() => {});
	await new Promise((resolve) => {
		server.close(resolve);
		server.closeAllConnections();
	});
	await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
