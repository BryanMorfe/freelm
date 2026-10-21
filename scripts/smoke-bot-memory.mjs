import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Native IPC, actual provider transports, rendered messages, and a process restart.
// Only a temporary profile and the loopback fixture provider are used. Durable memories must work without personality notes or saved group transcripts.
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-bot-memory-'));
const decision = 'The research team selected amber-47 as the replication checkpoint.';
const outsiderDecision = 'The restricted team selected violet-93 as its private release token.';
const question = 'What checkpoint did our research group select?';
const answer = 'Our research group selected amber-47 as the replication checkpoint.';
const requests = [];
const serverErrors = [];
const pageErrors = [];
let phase = 'initial';
let desktop;
const contextBlock = (instructions, tag) => {
	const match = instructions.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n<\\/${tag}>`));
	return match ? JSON.parse(match[1]) : undefined;
};
const server = createServer(async (request, response) => {
	try {
		assert(['/v1/responses', '/v1/chat/completions'].includes(request.url));
		let raw = '';
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		const responses = request.url.endsWith('/responses');
		const instructions = responses ? body.instructions : body.messages[0].content;
		const dialogue = responses ? body.input : body.messages.slice(1);
		const group = contextBlock(instructions, 'freelm_group_context');
		const notification = contextBlock(instructions, 'freelm_notification');
		const toolNames = (body.tools ?? []).map((tool) =>
			responses ? tool.name : tool.function.name,
		);
		const extractionFormat = responses ? body.text?.format : body.response_format?.json_schema;
		const extraction = extractionFormat?.name === 'freelm_bot_memory';
		const entry = {
			extraction,
			phase,
			api: responses ? 'responses' : 'chat/completions',
			model: body.model,
			group: !!group,
			instructions,
			dialogue,
		};
		requests.push(entry);
		assert(
			!toolNames.includes('bot_remember'),
			'Personality learning is disabled for every fixture bot.',
		);
		let silent = false;
		let content;
		if (extraction) {
			assert.equal(extractionFormat.strict, true);
			assert.equal(extractionFormat.schema.additionalProperties, false);
			assert.equal(body.stream, false);
			assert.equal(toolNames.length, 0);
			const payload = JSON.parse(dialogue.find((message) => message.role === 'user').content);
			assert(payload.observer?.name && payload.observer.hostId && payload.observer.botId);
			assert(payload.participants.length >= 1);
			const sourceMessage = payload.new_messages.find(
				(message) => message.content === decision || message.content === outsiderDecision,
			);
			if (body.model.startsWith('researcher')) {
				assert(
					!JSON.stringify(payload).includes('violet-93'),
					'An outsider group leaked into memory extraction.',
				);
			}
			content = JSON.stringify({
				memories: sourceMessage
					? [
							{
								key: 'replication-checkpoint',
								content: sourceMessage.content,
								kind: 'decision',
								message_ids: [sourceMessage.id],
							},
						]
					: [],
				forget_keys: [],
			});
		} else if (group) {
			assert(
				!toolNames.includes('bot_groups_search'),
				'Private recollection tools must not be exposed in groups.',
			);
			assert(!instructions.includes('<freelm_group_recollections>'));
			silent = !!notification || body.model.endsWith('-chat');
			content = 'Agreed; that is our team decision.';
			if (body.model.startsWith('researcher')) {
				const durable = contextBlock(instructions, 'freelm_persistent_memories');
				assert(
					durable?.memories.some(
						(memory) =>
							memory.content === decision && memory.source.conversationId === 'research-group',
					),
					'Group memory must be saved before the normal reply, including silent participants.',
				);
			}
		} else {
			assert.equal(dialogue.at(-1).content, question);
			assert(
				!JSON.stringify(dialogue).includes('amber-47'),
				'A fresh DM must not already contain the answer.',
			);
			assert(
				!instructions.includes('violet-93'),
				'A nonmember group leaked into the DM provider request.',
			);
			assert(toolNames.includes('bot_groups_search') && toolNames.includes('bot_groups_read'));
			assert(toolNames.includes('bot_memory_search') && toolNames.includes('bot_memory_save'));
			const durable = contextBlock(instructions, 'freelm_persistent_memories');
			const remembered = durable?.memories.some(
				(memory) =>
					memory.content === decision &&
					memory.source.conversationId === 'research-group' &&
					memory.source.group &&
					memory.source.messageIds.includes('research-group-decision'),
			);
			if (phase === 'restarted') {
				assert(
					!instructions.includes('<freelm_group_recollections>'),
					'Deleted fixture group must not remain as prompt excerpts.',
				);
			}

			entry.remembered = !!remembered;
			// The answer is conditional on the actual system context, not fixture omniscience.
			content = remembered ? answer : 'I cannot recall the group checkpoint.';
		}
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(
			JSON.stringify(
				responses
					? {
							status: 'completed',
							output: silent
								? [
										{
											type: 'function_call',
											call_id: `silence-${requests.length}`,
											name: 'bot_silence',
											arguments: '{}',
										},
									]
								: [
										{
											type: 'message',
											role: 'assistant',
											content: [{ type: 'output_text', text: content }],
										},
									],
						}
					: {
							choices: [
								{
									finish_reason: silent ? 'tool_calls' : 'stop',
									message: silent
										? {
												role: 'assistant',
												content: null,
												tool_calls: [
													{
														id: `silence-${requests.length}`,
														type: 'function',
														function: { name: 'bot_silence', arguments: '{}' },
													},
												],
											}
										: { role: 'assistant', content },
								},
							],
						},
			),
		);
	} catch (error) {
		serverErrors.push(error.stack || String(error));
		response.writeHead(500, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: { message: error.message } }));
	}
});
async function launch() {
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
	page.on('console', (message) => {
		if (message.type() === 'error') console.error('Fixture renderer:', message.text());
	});
	desktop.on('console', (message) => {
		if (message.type() === 'error') console.error('Fixture main:', message.text());
	});
	await page.waitForFunction(() => !!window.desktop?.botsSnapshot);
	await page.locator('.app-shell').waitFor();
	return page;
}

async function closeDesktop() {
	if (!desktop) return;
	const instance = desktop;
	desktop = undefined;
	let timer, diagnostic;
	try {
		// Request normal app.quit and wait for its close event, retaining the debugger
		// connection only so a failed renderer/service shutdown can be diagnosed.
		const closed = instance.waitForEvent('close', { timeout: 0 });
		diagnostic = setTimeout(async () => {
			try {
				console.error(
					'Close diagnostic:',
					await instance.windows()[0]?.locator('body').innerText(),
				);
			} catch (error) {
				console.error('Close diagnostic failed:', error.message);
			}
		}, 8000);
		await instance.evaluate(({ app }) => {
			setImmediate(() => app.quit());
		});
		await Promise.race([
			closed,
			new Promise((_, reject) => {
				timer = setTimeout(() => {
					// This process was created above with a disposable profile, never the user's app.
					instance.process().kill('SIGKILL');
					reject(new Error('The isolated test app did not finish shutdown within 20 seconds.'));
				}, 20_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
		clearTimeout(diagnostic);
	}
}

async function waitForReplies(page) {
	await expect
		.poll(
			async () =>
				page.evaluate(async () => {
					const snapshot = await window.desktop.botsSnapshot('local');
					return snapshot.conversations
						.flatMap((conversation) => conversation.messages)
						.filter((message) => message.status === 'pending').length;
				}),
			{ timeout: 30_000 },
		)
		.toBe(0);
	assert.deepEqual(serverErrors, []);
	const snapshot = await page.evaluate(() => window.desktop.botsSnapshot('local'));
	assert(
		snapshot.conversations.every((conversation) =>
			conversation.messages.every((message) => message.status === 'completed' && message.content),
		),
		'Replies must finish without failed or empty bubbles.',
	);
	assert(
		snapshot.bots.every(
			(bot) => !bot.historyAccess && !bot.personalityLearning && bot.learnedPersonality === '',
		),
		'Recall must not depend on Chat/Code permission or learned notes.',
	);
	return snapshot;
}

async function verifyDMs(page) {
	await page.getByRole('button', { name: 'Bots', exact: true }).click();
	for (const name of ['Researcher Responses', 'Researcher Chat']) {
		await page
			.locator('.bots-sidebar')
			.getByRole('button', { name: new RegExp(name) })
			.click();
		await expect(page.locator('.bots-header-title strong')).toHaveText(name);
		const composer = page.getByLabel('Message your bot', { exact: true });
		await composer.fill(question);
		await page.getByRole('button', { name: 'Send message', exact: true }).click();
		await expect(composer).toHaveValue('');
		await expect(page.getByRole('log').getByText(answer, { exact: true })).toBeVisible({
			timeout: 30_000,
		});
		await waitForReplies(page);
	}
	const calls = requests.filter(
		(entry) => entry.phase === phase && !entry.group && !entry.extraction,
	);
	assert.deepEqual(calls.map((entry) => entry.api).sort(), ['chat/completions', 'responses']);
	assert(calls.every((entry) => entry.remembered));
}

try {
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
	let page = await launch();
	await page.evaluate(async (baseUrl) => {
		const state = (await window.desktop.load()) || {
			version: 1,
			connections: [],
			threads: [],
			projects: [],
			generations: [],
			theme: 'dark',
		};
		state.connections = ['responses', 'chat/completions'].map((chatApi, index) => ({
			id: `fixture-${index}`,
			name: `Persistent memory fixture ${index}`,
			baseUrl,
			apiKey: '',
			chatApi,
			models: {
				chat: index ? 'researcher-chat' : 'researcher-responses',
				images: '',
				videos: '',
				speech: '',
				transcription: '',
			},
			discoveredModels: [],
			catalog: ['researcher', 'outsider'].map((kind) => ({
				id: `${kind}-${index ? 'chat' : 'responses'}`,
				name: `${kind} ${index}`,
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
			})),
		}));
		state.activeConnectionId = 'fixture-0';
		state.theme = 'dark';
		await window.desktop.save(state);
	}, baseUrl);
	await page.reload();
	await page.locator('.app-shell').waitFor();
	await page.evaluate(
		async ({ decision, outsiderDecision }) => {
			const bridge = window.desktop;
			const { host } = await bridge.botsSnapshot('local');
			for (const kind of ['researcher', 'outsider'])
				for (const index of [0, 1]) {
					const protocol = index ? 'Chat' : 'Responses';
					await bridge.botsCommand('local', {
						type: 'create-bot',
						id: `${kind}-${index}`,
						profile: {
							name: `${kind === 'researcher' ? 'Researcher' : 'Outsider'} ${protocol}`,
							identity: 'A concise fixture companion.',
							connectionId: `fixture-${index}`,
							model: `${kind}-${protocol.toLowerCase()}`,
							thinkingMode: 'low',
							historyAccess: false,
							personalityLearning: false,
							learnedPersonality: '',
						},
					});
				}
			for (const [id, kind, content, title] of [
				['research-group', 'researcher', decision, 'Research team'],
				['outsider-group', 'outsider', outsiderDecision, 'Restricted team'],
			]) {
				await bridge.botsCommand('local', {
					type: 'create-conversation',
					id,
					title,
					participants: [0, 1].map((index) => ({ hostId: host.id, botId: `${kind}-${index}` })),
				});
				await bridge.botsCommand('local', {
					type: 'send',
					conversationId: id,
					messageId: `${id}-decision`,
					content,
				});
			}
		},
		{ decision, outsiderDecision },
	);
	let snapshot = await waitForReplies(page);
	for (const group of snapshot.conversations) {
		assert.equal(
			group.messages.length,
			2,
			'One answer and one silent participant should leave no extra bubbles.',
		);
		assert.equal(group.messages[0].readBy.length, 2);
	}
	await verifyDMs(page);
	console.log(
		'Verified durable memories in both provider protocols, including silent group participation. Deleting source transcripts and restarting fixture app.',
	);
	// Leave the selected fixture DM before deleting it through IPC so the renderer has no
	// stale composer to flush during its ordinary close handshake.
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	await page.reload();
	await page.locator('.app-shell').waitFor();
	// Deliberately remove both the source research group and the successful DMs. Only each
	// bot's durable profile records may provide the next answer; outsider history remains.
	await page.evaluate(async () => {
		const snapshot = await window.desktop.botsSnapshot('local');
		for (const conversation of snapshot.conversations.filter(
			(item) => item.id === 'research-group' || item.participants.length === 1,
		)) {
			await window.desktop.botsCommand('local', {
				type: 'delete-conversation',
				conversationId: conversation.id,
			});
		}
	});
	await closeDesktop();
	const stored = JSON.parse(await readFile(path.join(profile, 'bots', 'workspace.json'), 'utf8'));
	assert.equal(stored.conversations.length, 1);
	assert.equal(stored.conversations[0].id, 'outsider-group');
	for (const bot of stored.bots.filter((bot) => bot.id.startsWith('researcher'))) {
		assert.equal(bot.memoryEnabled, true);
		assert.equal(bot.learnedPersonality, '');
		assert(!bot.memoryError);
		assert(
			bot.memories.some(
				(memory) =>
					memory.content === decision &&
					memory.source.conversationId === 'research-group' &&
					memory.source.messageIds.includes('research-group-decision'),
			),
			'Physical bot storage must retain learned memory after source deletion.',
		);
		assert(!JSON.stringify(bot.memories).includes('violet-93'));
	}

	phase = 'restarted';
	page = await launch();
	snapshot = await waitForReplies(page);
	assert.equal(
		snapshot.conversations.length,
		1,
		'Only outsider history should survive; fresh DMs must use durable memory.',
	);
	await verifyDMs(page);
	await page.screenshot({
		path: '/tmp/freelm-bot-memory-native.png',
		animations: 'disabled',
	});
	assert.deepEqual(pageErrors, []);
	assert.deepEqual(serverErrors, []);
	console.log(
		`PASS: native persistent memory in Responses and Chat Completions, source-bound extraction, silent group participation, outsider exclusion, physical profile persistence, source deletion, and fresh DM recall after process restart (${requests.length} loopback provider requests).`,
	);
} catch (error) {
	console.error('Fixture provider errors:', serverErrors);
	console.error(
		'Provider request summary:',
		requests.map(({ phase, api, model, group, extraction, remembered }) => ({
			phase,
			api,
			model,
			group,
			extraction,
			remembered,
		})),
	);
	throw error;
} finally {
	try {
		await closeDesktop();
	} finally {
		await new Promise((resolve) => server.close(resolve));
		await rm(profile, { recursive: true, force: true });
	}
}
