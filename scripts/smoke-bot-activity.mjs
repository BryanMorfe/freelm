import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Real native transport and renderer; fixture gates prove phases without timing guesses.
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-bot-activity-'));
const streams = new Map();
const longReply = [
	'Here is your reply.',
	...Array.from(
		{ length: 14 },
		(_, i) =>
			`Review detail ${i + 1}: the original message remains available when expanded, copied, or used as reply context.`,
	),
].join('\n\n');
const server = createServer(async (request, response) => {
	let raw = '';
	for await (const chunk of request) raw += chunk;
	const body = JSON.parse(raw);
	assert.equal(body.stream, true);
	response.writeHead(200, { 'content-type': 'text/event-stream' });
	response.flushHeaders();
	const responses = request.url.endsWith('/responses');
	const reply = responses ? 'Here is your reply.' : longReply;
	const event = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
	if (responses) {
		event({
			type: 'response.created',
			response: { id: 'response-fixture', status: 'in_progress', output: [] },
		});
		event({
			type: 'response.reasoning_summary_text.delta',
			item_id: 'reasoning',
			output_index: 0,
			summary_index: 0,
			delta: 'Private fixture reasoning.',
		});
	} else {
		event({
			choices: [
				{
					index: 0,
					delta: { role: 'assistant', reasoning_content: 'Private fixture reasoning.' },
					finish_reason: null,
				},
			],
		});
	}
	streams.set(body.model, {
		write() {
			if (responses) {
				event({
					type: 'response.output_item.added',
					output_index: 1,
					item: {
						id: 'reply',
						type: 'message',
						role: 'assistant',
						status: 'in_progress',
						content: [],
					},
				});
				event({
					type: 'response.output_text.delta',
					item_id: 'reply',
					output_index: 1,
					content_index: 0,
					delta: reply,
				});
			} else
				event({
					choices: [{ index: 0, delta: { content: reply }, finish_reason: null }],
				});
		},
		finish() {
			if (responses)
				event({
					type: 'response.completed',
					response: {
						id: 'response-fixture',
						status: 'completed',
						output: [
							{
								id: 'reply',
								type: 'message',
								role: 'assistant',
								status: 'completed',
								content: [{ type: 'output_text', text: reply }],
							},
						],
					},
				});
			else {
				event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
				response.write('data: [DONE]\n\n');
			}
			response.end();
		},
		abort() {
			response.destroy();
		},
	});
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
	await page.locator('.app-shell').waitFor();
	await page.evaluate(async (baseUrl) => {
		const state = (await window.desktop.load()) || {
			version: 1,
			connections: [],
			activeConnectionId: 'responses',
			threads: [],
			projects: [],
			generations: [],
			theme: 'dark',
		};
		state.connections = ['responses', 'chat/completions'].map((chatApi, i) => ({
			id: `connection-${i}`,
			name: `Provider ${i}`,
			baseUrl,
			apiKey: '',
			chatApi,
			models: { chat: `model-${i}`, images: '', videos: '', speech: '', transcription: '' },
			discoveredModels: [],
			catalog: [
				{
					id: `model-${i}`,
					name: `Model ${i}`,
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
		state.activeConnectionId = 'connection-0';
		await window.desktop.save(state);
	}, baseUrl);
	await page.reload();
	await page.locator('.app-shell').waitFor();
	await page.evaluate(async () => {
		const bridge = window.desktop;
		const { host } = await bridge.botsSnapshot('local');
		for (const i of [0, 1]) {
			await bridge.botsCommand('local', {
				type: 'create-bot',
				id: `bot-${i}`,
				profile: {
					memoryEnabled: false,
					name: `Phase bot ${i}`,
					identity: 'A concise test companion.',
					connectionId: `connection-${i}`,
					model: `model-${i}`,
					thinkingMode: 'low',
				},
			});
			await bridge.botsCommand('local', {
				type: 'create-conversation',
				id: `dm-${i}`,
				participants: [{ hostId: host.id, botId: `bot-${i}` }],
			});
		}
	});
	await page.getByRole('button', { name: 'Bots', exact: true }).click();
	await page.evaluate(() => {
		window.__botActivityUpdates = 0;
		window.desktop.onBotsChanged(() => window.__botActivityUpdates++);
	});
	for (const i of [0, 1]) {
		await page
			.locator('.bots-sidebar')
			.getByRole('button', { name: new RegExp(`Phase bot ${i}`) })
			.click();
		await page
			.getByLabel('Message your bot', { exact: true })
			.fill('Show the actual reply phases.');
		await page.getByRole('button', { name: 'Send message', exact: true }).click();
		await expect.poll(() => streams.has(`model-${i}`), { timeout: 15000 }).toBe(true);
		await expect(
			page.locator('.bots-conversation-header').getByText('Thinking', { exact: true }),
		).toBeVisible();
		await expect(page.locator('.bot-typing')).toHaveCount(0);
		await expect(page.getByRole('log')).not.toContainText('Private fixture reasoning.');
		const activity = () =>
			page.evaluate(
				async (id) =>
					(await window.desktop.botsSnapshot('local')).conversations
						.find((c) => c.id === id)
						.messages.findLast((m) => m.role === 'bot')?.activity,
				`dm-${i}`,
			);
		await expect.poll(activity).toBe('thinking');
		if (i === 0) await page.screenshot({ path: '/tmp/freelm-bot-native-thinking.png' });
		streams.get(`model-${i}`).write();
		await expect.poll(activity).toBe('writing');
		await expect(page.locator('.bot-typing')).toBeVisible();
		await expect(
			page.locator('.bots-conversation-header').getByText('Thinking', { exact: true }),
		).toHaveCount(0);
		await expect(page.getByRole('log')).not.toContainText('Here is your reply.');
		if (i === 0) await page.screenshot({ path: '/tmp/freelm-bot-native-writing.png' });
		streams.get(`model-${i}`).finish();
		await expect(
			page.getByRole('log').getByText('Here is your reply.', { exact: true }),
		).toBeVisible();
		await expect(page.locator('.bot-typing')).toHaveCount(0);
		await expect(
			page.locator('.bots-conversation-header').getByText('Thinking', { exact: true }),
		).toHaveCount(0);
		await expect.poll(activity).toBe(undefined);
		if (i === 1) {
			const more = page.getByRole('log').getByRole('button', { name: 'See more', exact: true });
			await expect(more).toBeVisible();
			await expect(more).toHaveAttribute('aria-expanded', 'false');
			await more.evaluate(async (element) => {
				await Promise.all(
					element
						.closest('.bot-message-bubble-wrap')
						.getAnimations()
						.map((animation) => animation.finished),
				);
			});
			await page.screenshot({ path: '/tmp/freelm-bot-native-collapsed-reply.png' });
			await more.click();
			const less = page.getByRole('log').getByRole('button', { name: 'See less', exact: true });
			await expect(less).toHaveAttribute('aria-expanded', 'true');
			await expect(page.getByRole('log')).toContainText('Review detail 14:');
			await less.click();
			await expect(more).toHaveAttribute('aria-expanded', 'false');
			const history = (
				await page.evaluate(async () => window.desktop.botsSnapshot('local'))
			).conversations.find((item) => item.id === 'dm-1');
			assert.equal(history.messages.findLast((item) => item.role === 'bot').content, longReply);
		}
	}
	assert((await page.evaluate(() => window.__botActivityUpdates)) >= 6);
	assert.deepEqual(errors, []);
	console.log(
		'PASS: native provider streams distinguish reasoning from writing for both protocols; Thinking, typing-only dots, completed replies, and long reply expansion with intact durable content verified.',
	);
} finally {
	for (const stream of streams.values()) stream.abort();
	await desktop?.close();
	await new Promise((resolve) => server.close(resolve));
	await rm(profile, { recursive: true, force: true });
}
